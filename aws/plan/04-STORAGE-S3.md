# Part 4: Storage — AWS S3

## Goal

Create a CDK-managed S3 bucket with proper IAM policies, lifecycle rules, and Lambda-compatible access patterns for storing audio recordings.

---

## Current State (Legacy)

### How S3 is used today

- **Bucket**: Manually created, name stored in `AWS_S3_BUCKET_NAME` env var
- **Authentication**: IAM access keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) hardcoded in `.env`
- **Upload**: `@aws-sdk/lib-storage` `Upload` class — streams buffer to S3
- **Delete**: `@aws-sdk/client-s3` `DeleteObjectCommand`
- **Key format**: `{UUID}{extension}` (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890.mp3`)
- **Public access**: Bucket appears to allow public read (file URLs are stored and served directly)
- **No lifecycle rules, versioning, or encryption configuration**

### Legacy S3 utility (`src/utils/s3.ts`)

```typescript
// S3Client with hardcoded credentials from env
const s3Client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });

// Upload: Upload class from @aws-sdk/lib-storage
uploadToS3(bucketName, key, body) → { fileUrl, fileKey }

// Delete: DeleteObjectCommand
deleteS3Object(bucketName, key) → void
```

---

## Target State

| Aspect          | Decision                                                |
| --------------- | ------------------------------------------------------- |
| Bucket creation | CDK-managed, one bucket per environment                 |
| Naming          | `voces-{env}-recordings` (e.g., `voces-dev-recordings`) |
| Access          | Lambda IAM roles (no access keys)                       |
| Public read     | **No public access** — all reads via presigned URLs     |
| Encryption      | SSE-S3 (server-side encryption, default)                |
| Versioning      | Enabled (allows recovery of accidentally deleted files) |
| Lifecycle rules | Transition to Infrequent Access after 90 days           |
| CORS            | Configured for frontend domain(s)                       |

---

## CDK Stack Design

The `storage-stack.ts` will create:

### 1. S3 Bucket

```
Configuration:
- Bucket name: voces-{env}-recordings
- Encryption: S3-managed (SSE-S3)
- Versioning: Enabled
- Block all public access: YES (serve via CloudFront instead)
- Removal policy: RETAIN (never auto-delete the bucket)
- Auto-delete objects: false
```

### 2. Lifecycle Rules

| Rule                     | Condition                                | Action                       |
| ------------------------ | ---------------------------------------- | ---------------------------- |
| Transition to IA         | Objects older than 90 days               | Move to S3 Infrequent Access |
| Delete old versions      | Non-current versions older than 180 days | Delete                       |
| Abort incomplete uploads | Multipart uploads older than 7 days      | Abort                        |

### 3. IAM Policy for Lambda Access

Each Lambda that needs S3 access gets a scoped IAM policy:

| Lambda           | S3 Permissions                              |
| ---------------- | ------------------------------------------- |
| Create Recording | `s3:PutObject`                              |
| Update Recording | `s3:PutObject`, `s3:DeleteObject`           |
| Delete Recording | `s3:DeleteObject`                           |
| Read Recording   | `s3:GetObject` (to generate presigned URLs) |

### Stack Outputs

- `BucketName`
- `BucketArn`

---

## Changes to Lambda Code (vs Legacy)

### No more access keys

Legacy uses explicit credentials:

```typescript
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
```

Lambda version uses the **execution role** (no credentials needed):

```typescript
const s3Client = new S3Client({});
// SDK automatically uses the Lambda's IAM role
```

### File access via presigned URLs (replaces public URLs)

Legacy stores a permanent public `fileUrl` in the database. The new setup uses **presigned URLs** generated on demand:

- The database stores only the `fileKey` (S3 object key) — the `fileUrl` field is removed
- When a user requests a recording, the Lambda generates a short-lived presigned URL
- The URL expires after the configured TTL — sharing it is useless after expiry

See the **Presigned URL Access Control** section below for full details.

---

## Presigned URL Access Control

### Why presigned URLs?

Premium users pay for access to recordings. If download URLs are permanent, users can share them freely, bypassing the subscription model. Presigned URLs solve this:

- URLs expire after a short TTL
- Each URL is unique (signed with request-specific parameters)
- Sharing an expired URL gives the recipient nothing
- No public bucket access needed

### How it works

```
1. Client: GET /recordings/abc123
2. Lambda: Query DB for recording metadata + fileKey
3. Lambda: Check user plan (FREE or PREMIUM) and access rules
4. Lambda: Generate presigned URL with TTL
   → s3.getSignedUrl('getObject', { Bucket, Key: fileKey, Expires: ttl })
5. Response: { title, tags, metadata, downloadUrl: "https://bucket.s3...?X-Amz-Signature=..." }
```

The presigned URL is generated using `@aws-sdk/s3-request-presigner` with the `GetObjectCommand`.

### Access rules by subscription plan

| User Plan       | Recordings Visible    | Download URL     | URL TTL    |
| --------------- | --------------------- | ---------------- | ---------- |
| FREE            | 10 curated recordings | Presigned S3 URL | 15 minutes |
| PREMIUM         | All recordings        | Presigned S3 URL | 1 hour     |
| Unauthenticated | None                  | None             | —          |

The set of 10 free recordings can be defined by:

- A `isFree` boolean flag on the Recording model, or
- A curated list of recording IDs stored in config (SSM Parameter Store), or
- The first 10 recordings by creation date

**Recommendation**: Add an `isFree` boolean to the Recording model — simplest, most flexible, admin-controllable.

### Bulk Download

Users can download multiple recordings at once.

**Endpoint**: `POST /recordings/download`

**Request body**:

```json
{
  "recordingIds": ["id1", "id2", "id3"]
}
```

**How it works**:

1. Lambda validates the user has access to all requested recordings (plan check)
2. Lambda generates a presigned URL for each recording
3. Returns an array of `{ id, title, downloadUrl }` objects
4. The frontend initiates downloads for each URL

**Response**:

```json
{
  "downloads": [
    { "id": "id1", "title": "Recording 1", "downloadUrl": "https://..." },
    { "id": "id2", "title": "Recording 2", "downloadUrl": "https://..." },
    { "id": "id3", "title": "Recording 3", "downloadUrl": "https://..." }
  ]
}
```

**Limits**:

- FREE users: Can only bulk-download from the 10 free recordings
- PREMIUM users: No limit on selection
- Max recordings per request: 50 (to keep response time reasonable)

### Download All Recordings

Premium users can download the entire set of recordings.

**Endpoint**: `POST /recordings/download-all`

**How it works**:

1. Lambda verifies user is PREMIUM (returns 403 for FREE users)
2. Lambda queries all recordings from DB
3. Generates a presigned URL for each recording
4. Returns the full list of `{ id, title, downloadUrl }` objects

**Response**: Same shape as bulk download, but includes all recordings.

**Considerations**:

- If the recording set is large (hundreds+), paginate the response
- Presigned URLs are lightweight to generate (~1ms each) — generating hundreds is fast
- All URLs share the same TTL (1 hour for premium)
- The frontend handles the actual downloading (sequential or parallel, with progress UI)

### Schema Impact

The `Recording` model changes:

- **Remove**: `fileUrl` field (no longer stored — generated on demand)
- **Keep**: `fileKey` field (the S3 object key, used to generate presigned URLs)
- **Add**: `isFree` boolean field (default `false`) — marks recordings available to free users

```
Recording: id, title, description?, fileKey (unique), metadata (Json?),
           isFree (default false), tags[], createdAt, updatedAt
```

---

## Environment-Specific Configuration

| Parameter                   | Dev                    | Prod                             |
| --------------------------- | ---------------------- | -------------------------------- |
| Bucket name                 | `voces-dev-recordings` | `voces-prod-recordings`          |
| Versioning                  | Enabled                | Enabled                          |
| Lifecycle (IA transition)   | 90 days                | 90 days                          |
| Presigned URL TTL (FREE)    | 15 minutes             | 15 minutes                       |
| Presigned URL TTL (PREMIUM) | 1 hour                 | 1 hour                           |
| CORS origins                | `http://localhost:*`   | `https://vocesdelaextincion.com` |
| Removal policy              | RETAIN                 | RETAIN                           |

---

## Risks and Mitigations

| Risk                                   | Mitigation                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Presigned URL shared before expiry     | Short TTL (15 min FREE, 1 hour PREMIUM); acceptable risk window                          |
| Generating many presigned URLs is slow | Presigned URLs are computed locally (~1ms each, no S3 API call); hundreds are fine       |
| Accidental bucket deletion             | `removalPolicy: RETAIN` in CDK; versioning enabled for object recovery                   |
| Large file uploads timeout Lambda      | Lambda has 15-min max; use presigned upload URLs for direct client-to-S3 upload (future) |
| S3 costs for large audio files         | Lifecycle rules move to IA after 90 days; monitor with Cost Explorer                     |
| Download-all response too large        | Paginate if recording set grows beyond hundreds; presigned URLs are small strings        |

---

## Future Improvement: Presigned Upload URLs

The current flow uploads files **through** the server (multer → buffer → S3). In Lambda, this means:

1. API Gateway has a 10MB payload limit (configurable to 10MB max).
2. Lambda memory is consumed holding the file buffer.

A better pattern for large files:

1. Client requests a presigned upload URL from the API.
2. Client uploads directly to S3 using the presigned URL.
3. Client notifies the API that the upload is complete.
4. Lambda creates the database record.

This is a **future improvement**, not part of the initial migration. The current multer-based flow will work for files under 10MB.

---

## Definition of Done

- [ ] S3 bucket created via CDK with encryption, versioning, and lifecycle rules
- [ ] All public access blocked (no public bucket policy, no CloudFront)
- [ ] Lambda IAM roles have scoped S3 permissions including `s3:GetObject` for presigned URLs
- [ ] Upload and delete operations work from Lambda without explicit credentials
- [ ] Presigned download URLs generated correctly with appropriate TTL
- [ ] FREE users can only get presigned URLs for recordings marked `isFree`
- [ ] PREMIUM users can get presigned URLs for all recordings
- [ ] Bulk download endpoint returns presigned URLs for multiple recordings
- [ ] Download-all endpoint returns presigned URLs for all recordings (PREMIUM only)
- [ ] CORS configured for frontend domains
