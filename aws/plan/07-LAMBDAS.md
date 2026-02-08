# Part 7: Lambda Functions

## Goal

Migrate all Express.js controllers to AWS Lambda functions. Each route group becomes a single Lambda that handles internal routing, input validation, and business logic — replacing the Express middleware chain.

---

## Current State (Legacy)

### Express Server Architecture

```
index.ts (Express app)
  ├── cors()                        → Handled by API Gateway (Part 6)
  ├── express.json()                → Handled by API Gateway (Part 6)
  ├── /auth       → auth.routes.ts       → auth.controller.ts
  ├── /users      → user.routes.ts       → user.controller.ts
  ├── /recordings → recording.routes.ts  → recording.controller.ts
  ├── /admin      → admin.routes.ts      → admin.controller.ts
  ├── /tags       → tag.routes.ts        → tag.controller.ts
  └── /metrics    → metrics.routes.ts    → metrics.controller.ts
```

### What moves to Lambda vs API Gateway

| Concern                              | Stays in Lambda          | Moves to API Gateway (Part 6) |
| ------------------------------------ | ------------------------ | ----------------------------- |
| Business logic (controllers)         | Yes                      | —                             |
| Input validation (express-validator) | Yes (replaced by Zod)    | —                             |
| Admin role check                     | Yes                      | —                             |
| File upload parsing (multer)         | Yes (replaced by busboy) | —                             |
| HTTP routing                         | —                        | Yes                           |
| CORS                                 | —                        | Yes                           |
| JWT validation (protect middleware)  | —                        | Yes (Cognito Authorizer)      |
| JSON body parsing                    | —                        | Yes (automatic)               |

---

## Lambda Function Inventory

### Granularity: One Lambda per route group

| Lambda Function                      | Handles                          | Endpoint Count |
| ------------------------------------ | -------------------------------- | -------------- |
| `voces-{env}-auth`                   | All `/auth/*` routes             | 6              |
| `voces-{env}-users`                  | All `/users/*` routes            | 1              |
| `voces-{env}-recordings`             | All `/recordings/*` routes       | 7              |
| `voces-{env}-tags`                   | All `/tags/*` routes             | 5              |
| `voces-{env}-admin`                  | All `/admin/*` routes            | 4              |
| `voces-{env}-metrics`                | All `/metrics` routes            | 1              |
| `voces-{env}-cognito-custom-message` | Cognito trigger (email branding) | N/A (trigger)  |

### Why one-per-group (not one-per-endpoint)?

- 22 individual Lambdas is excessive management overhead
- Functions within a group share dependencies (DynamoDB client, S3 client)
- Warm containers serve multiple endpoints within the group
- Still isolated enough that a recording bug doesn't affect auth

### Why not a single monolith Lambda?

- Different IAM permissions per group (recordings need S3, auth needs Cognito, etc.)
- Independent scaling
- Smaller deployment packages
- Clearer ownership and debugging

---

## Internal Routing Pattern

Each Lambda receives the HTTP event from API Gateway and routes internally based on method + path:

```typescript
// Example: recordings Lambda handler
export const handler = async (event: APIGatewayProxyEventV2) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  switch (true) {
    case method === "GET" && path === "/recordings":
      return getRecordings(event);
    case method === "POST" && path === "/recordings":
      return createRecording(event);
    case method === "POST" && path === "/recordings/download":
      return bulkDownload(event);
    case method === "POST" && path === "/recordings/download-all":
      return downloadAll(event);
    case method === "GET" && path.match(/^\/recordings\/[\w-]+$/):
      return getRecordingById(event);
    case method === "PUT" && path.match(/^\/recordings\/[\w-]+$/):
      return updateRecording(event);
    case method === "DELETE" && path.match(/^\/recordings\/[\w-]+$/):
      return deleteRecording(event);
    default:
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Not found" }),
      };
  }
};
```

---

## Lambda Configuration

### Per-Function Settings

```
Common configuration:
- Runtime: Node.js 20.x
- Architecture: arm64 (Graviton2 — cheaper, faster)
- Memory: 256 MB (default, tune per function)
- Timeout: 30 seconds (default, tune per function)
- VPC: No (DynamoDB is accessed via IAM, no VPC needed for DB) — see Part 8 for VPC discussion
- Layers: None required (DynamoDB SDK is lightweight, bundled with esbuild)
- Environment variables:
  - TABLE_NAME (from database stack)
  - S3_BUCKET_NAME (from storage stack)
  - PRESIGNED_URL_TTL_FREE (e.g., 900 = 15 min)
  - PRESIGNED_URL_TTL_PREMIUM (e.g., 3600 = 1 hour)
  - COGNITO_USER_POOL_ID (from auth stack)
  - COGNITO_CLIENT_ID (from auth stack)
  - ENV (dev/prod)
```

### IAM Roles (Per Function)

| Lambda     | Permissions                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth       | `cognito-idp:SignUp`, `cognito-idp:InitiateAuth`, `cognito-idp:ConfirmSignUp`, `cognito-idp:ForgotPassword`, `cognito-idp:ConfirmForgotPassword`, DynamoDB read/write |
| users      | DynamoDB read                                                                                                                                                         |
| recordings | DynamoDB read/write, `s3:PutObject`, `s3:DeleteObject`, `s3:GetObject` (for presigned URLs)                                                                           |
| tags       | DynamoDB read/write                                                                                                                                                   |
| admin      | DynamoDB read/write, `cognito-idp:AdminUpdateUserAttributes`, `cognito-idp:AdminDeleteUser`                                                                           |
| metrics    | DynamoDB read (Scan with count)                                                                                                                                       |

---

## Code Structure

```
aws/lambdas/
├── auth/
│   ├── handler.ts          # Entry point with internal routing
│   ├── register.ts         # Register handler
│   ├── login.ts            # Login handler
│   ├── verify-email.ts     # Email verification handler
│   ├── forgot-password.ts  # Forgot password handler
│   ├── reset-password.ts   # Reset password handler
│   └── me.ts               # Get current user handler
├── recordings/
│   ├── handler.ts          # Entry point with internal routing
│   ├── list.ts             # Get recordings (with pagination/search)
│   ├── get.ts              # Get recording by ID (includes presigned download URL)
│   ├── create.ts           # Create recording (with S3 upload)
│   ├── update.ts           # Update recording (with optional S3 upload)
│   ├── delete.ts           # Delete recording (with S3 delete)
│   ├── bulk-download.ts    # Generate presigned URLs for selected recordings
│   └── download-all.ts     # Generate presigned URLs for all recordings (PREMIUM only)
├── tags/
│   ├── handler.ts
│   ├── list.ts
│   ├── get.ts
│   ├── create.ts
│   ├── update.ts
│   └── delete.ts
├── admin/
│   ├── handler.ts
│   ├── list-users.ts
│   ├── get-user.ts
│   ├── update-user.ts
│   └── delete-user.ts
├── users/
│   ├── handler.ts
│   └── me.ts
├── metrics/
│   ├── handler.ts
│   └── get.ts
├── triggers/
│   └── cognito-custom-message.ts
└── shared/
    ├── db.ts               # DynamoDB DocumentClient singleton (reused across invocations)
    ├── response.ts         # Standard response helpers (200, 400, 404, etc.)
    ├── validation.ts       # Input validation (replaces express-validator)
    ├── auth.ts             # Extract user claims from API Gateway event
    └── s3.ts               # S3 upload/delete utilities
```

---

## Key Implementation Details

### 1. Request/Response Adaptation

Express handlers use `(req, res, next)`. Lambda handlers use `(event) → response`.

**Shared response helper:**

```typescript
// aws/lambdas/shared/response.ts
export const success = (body: any, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const error = (message: string, statusCode = 400) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message }),
});
```

### 2. Extracting User from Cognito Authorizer

The JWT authorizer (configured in API Gateway — Part 6) passes decoded claims to Lambda:

```typescript
// aws/lambdas/shared/auth.ts
export function getUserFromEvent(event: APIGatewayProxyEventV2) {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (!claims) return null;
  return {
    id: claims.sub as string,
    email: claims.email as string,
    role: claims["custom:role"] as string,
    plan: claims["custom:plan"] as string,
  };
}

export function requireAdmin(event: APIGatewayProxyEventV2) {
  const user = getUserFromEvent(event);
  if (!user || user.role !== "ADMIN") {
    return error("Not authorized as an admin", 403);
  }
  return null; // No error, proceed
}
```

### 3. Input Validation (Replacing express-validator)

Since we no longer have Express middleware, validation moves into the handler logic.

**Decision: Use Zod** for consistency and type safety.

```typescript
import { z } from "zod";

const registerSchema = z.object({
  email: z.string().email("Please provide a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters long."),
});

// In handler:
const parsed = registerSchema.safeParse(JSON.parse(event.body || "{}"));
if (!parsed.success) {
  return {
    statusCode: 400,
    body: JSON.stringify({ errors: parsed.error.issues }),
  };
}
```

### 4. File Upload Handling

The legacy app uses multer (memory storage) to parse multipart form data. In Lambda:

- Use `busboy` or `lambda-multipart-parser` to parse the multipart body
- Extract the file buffer and metadata fields
- Upload buffer to S3 (same as legacy)

```typescript
// Simplified flow
const { file, fields } = await parseMultipart(event);
const fileKey = `${randomUUID()}${extname(file.filename)}`;
await uploadToS3(bucketName, fileKey, file.content);
```

API Gateway has a **10MB payload limit** — files larger than that require the presigned URL pattern (documented in Part 4).

### 5. S3 Utility (No Credentials Needed)

```typescript
// aws/lambdas/shared/s3.ts
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";

const s3Client = new S3Client({});

export const uploadToS3 = async (bucket: string, key: string, body: Buffer) => {
  const upload = new Upload({
    client: s3Client,
    params: { Bucket: bucket, Key: key, Body: body },
  });
  await upload.done();
  return { fileKey: key };
};

export const deleteS3Object = async (bucket: string, key: string) => {
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

export const getPresignedDownloadUrl = async (
  bucket: string,
  key: string,
  expiresIn: number, // seconds
) => {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn });
};
```

### 6. Plan-Based Access Control

The recordings Lambda enforces subscription-based access:

```typescript
// Determine which recordings the user can access
function canAccessRecording(user: UserClaims, recording: Recording): boolean {
  if (user.plan === "PREMIUM") return true;
  return recording.isFree; // FREE users only access recordings marked isFree
}

// Determine presigned URL TTL based on plan
function getUrlTtl(plan: string): number {
  return plan === "PREMIUM"
    ? parseInt(process.env.PRESIGNED_URL_TTL_PREMIUM || "3600")
    : parseInt(process.env.PRESIGNED_URL_TTL_FREE || "900");
}
```

This logic applies to:

- `GET /recordings` — list only accessible recordings, include presigned URL per item
- `GET /recordings/:id` — return 403 if user can't access, include presigned URL
- `POST /recordings/download` — validate all requested IDs are accessible
- `POST /recordings/download-all` — reject FREE users with 403

---

## Bundling and Deployment

### Bundling Strategy: esbuild

Each Lambda function is bundled with **esbuild** (fast, tree-shakes, handles TypeScript natively):

- CDK's `NodejsFunction` construct uses esbuild by default
- Bundles only the code each function needs
- No externals needed (DynamoDB SDK is lightweight)
- Output: Single `.js` file per function

### Lambda Layers

No Lambda Layers are required. The DynamoDB SDK (`@aws-sdk/lib-dynamodb`) is lightweight (~1MB bundled) and is included directly in each function's esbuild bundle. This is a significant simplification over the previous Prisma-based plan, which required a ~40MB Lambda Layer for the Prisma query engine.

### Deployment

- CDK handles Lambda deployment automatically
- On `cdk deploy`, CDK:
  1. Bundles each function with esbuild
  2. Uploads to S3 (CDK staging bucket)
  3. Updates Lambda function code

---

## Cold Start Optimization

| Technique                       | Impact                                          |
| ------------------------------- | ----------------------------------------------- |
| arm64 (Graviton2)               | ~20% faster cold starts vs x86                  |
| 256MB+ memory                   | More memory = more CPU = faster init            |
| DynamoDB client outside handler | Reused across warm invocations                  |
| No VPC needed for DB            | Eliminates 2-5s VPC cold start penalty entirely |
| esbuild tree-shaking            | Smaller bundles = faster load                   |

### Provisioned Concurrency (Future, Prod Only)

For latency-sensitive endpoints (e.g., `/auth/login`, `/recordings`), provisioned concurrency keeps warm instances ready:

```
voces-prod-auth: 2 provisioned instances
voces-prod-recordings: 2 provisioned instances
```

Cost: ~$15/month per provisioned instance (~$60/month total). **Do not enable until actual cold start frequency and impact are measured post-launch.** This is a prod-only optimization that exceeds the dev budget on its own.

---

## Environment-Specific Configuration

| Parameter               | Dev            | Prod                                         |
| ----------------------- | -------------- | -------------------------------------------- |
| Memory                  | 256 MB         | 512 MB (tune based on metrics)               |
| Timeout                 | 30 sec         | 30 sec                                       |
| Provisioned concurrency | 0              | 0 (enable later if cold starts are an issue) |
| Logging level           | DEBUG          | INFO                                         |
| X-Ray tracing           | Off            | On                                           |
| DB access               | DynamoDB (IAM) | DynamoDB (IAM)                               |

---

## Risks and Mitigations

| Risk                        | Mitigation                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| Cold starts                 | No VPC penalty for DB; only relevant if Lambda needs VPC for other reasons |
| Multipart parsing in Lambda | Use `busboy` or `lambda-multipart-parser`; well-tested libraries           |
| express-validator removal   | Replace with Zod; same validation rules, different syntax                  |
| Many Lambdas to manage      | One-per-group keeps it to 6-8 functions; CDK abstracts deployment          |
| DynamoDB SDK size           | Lightweight (~1MB bundled); no Lambda Layer needed                         |

---

## Definition of Done

- [ ] All 6 Lambda functions deployed and responding to API Gateway events
- [ ] Internal routing works correctly for all 24 endpoints
- [ ] Auth flow works end-to-end (register → verify → login → access protected route)
- [ ] Recording CRUD works including S3 upload/delete
- [ ] Presigned download URLs generated with correct TTL per plan
- [ ] FREE users can only access recordings marked `isFree`
- [ ] Bulk download returns presigned URLs for selected recordings
- [ ] Download-all returns presigned URLs for all recordings (PREMIUM only, 403 for FREE)
- [ ] Tag CRUD works
- [ ] Admin user management works
- [ ] Metrics endpoint returns correct counts
- [ ] Pagination and search work on recordings, tags, and admin users
- [ ] Input validation returns proper error responses matching legacy format
- [ ] All existing API response shapes preserved (frontend compatibility)
- [ ] DynamoDB client reused across warm invocations
- [ ] Cold starts under 1 second (no VPC attachment for DB access)

```

```
