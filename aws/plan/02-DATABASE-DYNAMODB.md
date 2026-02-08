# Part 2: Database — DynamoDB

## Goal

Set up DynamoDB tables to store all application data (users, recordings, tags), design access patterns using single-table design principles, and configure Lambda access via IAM — no VPC required.

---

## Current State (Legacy)

- **Database**: PostgreSQL (local or external, connected via `DATABASE_URL` env var)
- **ORM**: Prisma with `@prisma/client`
- **Schema**: 3 models — `User`, `Recording`, `Tag` (with implicit many-to-many between Recording and Tag)
- **Migrations**: Managed via `prisma migrate dev`
- **Connection**: Single long-lived connection from the Express server

### Current Schema Summary

```
User: id (cuid), email (unique), password, isVerified, emailVerificationToken (unique),
      emailVerificationTokenExpires, passwordResetToken (unique), passwordResetTokenExpires,
      plan (FREE|PREMIUM), role (USER|ADMIN), createdAt, updatedAt

Recording: id (cuid), title, description?, fileUrl (unique), fileKey (unique),
           metadata (Json?), tags[], createdAt, updatedAt

Tag: id (cuid), name (unique), recordings[]

Implicit many-to-many: Recording <-> Tag (Prisma manages the join table `_RecordingToTag`)
```

---

## Target State

| Aspect          | Decision                                                                         |
| --------------- | -------------------------------------------------------------------------------- |
| Engine          | Amazon DynamoDB (fully managed NoSQL)                                            |
| Capacity mode   | **On-demand** (dev and prod) — pay-per-request, no capacity planning             |
| Networking      | No VPC required — DynamoDB is accessed via HTTPS endpoints over IAM              |
| Access          | Lambda functions use the AWS SDK with IAM execution roles                        |
| Connection mgmt | None needed — HTTP-based API, no persistent connections                          |
| ORM             | AWS SDK v3 `@aws-sdk/lib-dynamodb` (DocumentClient) — replaces Prisma            |
| Migrations      | Schema-less — table structure defined in CDK; data shape enforced in application |
| Secrets         | None — IAM roles grant access, no database credentials to manage                 |

### Why DynamoDB?

- **Serverless-native**: No connections to manage, no VPC required, no cold start penalty from VPC attachment.
- **Cost**: On-demand pricing with a generous free tier (25 GB storage, 25 WRU/25 RRU always free). For dev traffic, effectively **$0/month**.
- **Eliminates VPC complexity**: Lambdas don't need to be in a VPC for database access. This removes the need for NAT devices (fck-nat / NAT Gateway), private subnets for the database, RDS security groups, and the 2-5s VPC cold start penalty.
- **No credentials**: IAM-based access — no database passwords, no Secrets Manager secret for DB credentials, no connection strings.
- **Scaling**: Automatically scales to handle any traffic level with no provisioning.
- **Single-digit millisecond latency**: Consistent performance regardless of data size.
- **Fully managed**: No patching, no backups to configure (continuous backups available), no storage management.

### Why Not RDS PostgreSQL?

The original plan used RDS db.t4g.micro (dev) / Aurora Serverless v2 (prod). DynamoDB is a better fit because:

| Concern            | RDS                                                     | DynamoDB                                            |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------- |
| Cost (dev)         | ~$0 free tier → ~$12/month after                        | ~$0 (free tier covers dev traffic indefinitely)     |
| VPC required       | Yes (adds NAT cost, cold start latency)                 | No                                                  |
| Connection pooling | Needed (RDS Proxy in prod, connection_limit in dev)     | Not applicable (HTTP API)                           |
| Cold starts        | +2-5s from VPC attachment                               | No VPC penalty                                      |
| Credentials        | Secrets Manager secret, rotation                        | IAM roles (zero secrets)                            |
| Scaling            | Manual instance sizing or Aurora ACU config             | Automatic, unlimited                                |
| Prisma engine      | ~40MB Lambda Layer needed                               | Not needed (SDK is lightweight)                     |
| Schema migrations  | Prisma migrate in CI/CD or migration Lambda             | Schema-less; CDK defines tables, app defines shapes |
| Operational burden | Backups, patching, storage monitoring, proxy management | Near-zero                                           |

### Trade-offs to Accept

- **No SQL**: Queries must follow DynamoDB access patterns. Complex ad-hoc queries (JOINs, aggregations) are not possible.
- **Data modeling upfront**: Access patterns must be designed before implementation. Changes to access patterns may require table restructuring.
- **Many-to-many relationships**: Require denormalization or adjacency list patterns instead of implicit join tables.
- **No transactions across tables**: DynamoDB supports transactions within a single table (up to 100 items), which is sufficient for our use case with single-table design.

These trade-offs are acceptable because our data model is simple (3 entities, well-known access patterns) and the operational/cost benefits are significant.

---

## Data Model Design

### Approach: Single-Table Design

All entities (User, Recording, Tag, and their relationships) live in a **single DynamoDB table** per environment. This is the recommended pattern for DynamoDB because:

- Minimizes the number of tables to manage
- Enables fetching related items in a single query
- Reduces costs (one table = one set of on-demand capacity)
- Simplifies IAM policies

### Table Structure

**Table name**: `voces-{env}-main`

**Primary key**:

- **Partition key (PK)**: `String` — entity-prefixed identifier
- **Sort key (SK)**: `String` — entity type or relationship qualifier

**Global Secondary Indexes (GSIs)**:

| GSI Name | Partition Key | Sort Key | Purpose                                             |
| -------- | ------------- | -------- | --------------------------------------------------- |
| GSI1     | GSI1PK        | GSI1SK   | Email lookup (users), tag name lookup, tag listings |
| GSI2     | GSI2PK        | GSI2SK   | Recordings by creation date, free recordings        |

### Entity Schemas

#### User

| Attribute | PK           | SK           | GSI1PK              | GSI1SK       | Example Value                |
| --------- | ------------ | ------------ | ------------------- | ------------ | ---------------------------- |
| PK        | `USER#<sub>` |              |                     |              | `USER#a1b2c3d4-...`          |
| SK        |              | `USER#<sub>` |                     |              | `USER#a1b2c3d4-...`          |
| GSI1PK    |              |              | `USEREMAIL#<email>` |              | `USEREMAIL#john@example.com` |
| GSI1SK    |              |              |                     | `USER#<sub>` | `USER#a1b2c3d4-...`          |
| email     |              |              |                     |              | `john@example.com`           |
| plan      |              |              |                     |              | `FREE` or `PREMIUM`          |
| role      |              |              |                     |              | `USER` or `ADMIN`            |
| createdAt |              |              |                     |              | `2025-01-15T10:30:00.000Z`   |
| updatedAt |              |              |                     |              | `2025-01-15T10:30:00.000Z`   |
| entity    |              |              |                     |              | `USER`                       |

**Access patterns**:

- Get user by ID: `PK = USER#<sub>, SK = USER#<sub>`
- Get user by email: GSI1 query `GSI1PK = USEREMAIL#<email>`
- List all users (admin, paginated): Scan with `entity = USER` filter (acceptable for admin-only, low-frequency operation)

#### Recording

| Attribute   | PK         | SK         | GSI1PK     | GSI1SK          | GSI2PK       | GSI2SK              |
| ----------- | ---------- | ---------- | ---------- | --------------- | ------------ | ------------------- |
| PK          | `REC#<id>` |            |            |                 |              |                     |
| SK          |            | `REC#<id>` |            |                 |              |                     |
| GSI1PK      |            |            | `REC#<id>` |                 |              |                     |
| GSI1SK      |            |            |            | `TAG#<tagName>` |              |                     |
| GSI2PK      |            |            |            |                 | `RECORDINGS` |                     |
| GSI2SK      |            |            |            |                 |              | `<createdAt>#<id>`  |
| title       |            |            |            |                 |              |                     |
| description |            |            |            |                 |              |                     |
| fileKey     |            |            |            |                 |              |                     |
| metadata    |            |            |            |                 |              |                     |
| isFree      |            |            |            |                 |              |                     |
| tags        |            |            |            |                 |              | (list of tag names) |
| createdAt   |            |            |            |                 |              |                     |
| updatedAt   |            |            |            |                 |              |                     |
| entity      |            |            |            |                 |              | `RECORDING`         |

**Access patterns**:

- Get recording by ID: `PK = REC#<id>, SK = REC#<id>`
- List all recordings (paginated, sorted by date): GSI2 query `GSI2PK = RECORDINGS`, sorted by GSI2SK (descending)
- List free recordings: GSI2 query `GSI2PK = RECORDINGS` with filter `isFree = true`
- Search recordings by title: GSI2 query with `contains(title, searchTerm)` filter
- Get tags for a recording: Stored as a `tags` list attribute on the recording item (denormalized)

#### Tag

| Attribute | PK         | SK         | GSI1PK           | GSI1SK     |
| --------- | ---------- | ---------- | ---------------- | ---------- |
| PK        | `TAG#<id>` |            |                  |            |
| SK        |            | `TAG#<id>` |                  |            |
| GSI1PK    |            |            | `TAGNAME#<name>` |            |
| GSI1SK    |            |            |                  | `TAG#<id>` |
| name      |            |            |                  |            |
| createdAt |            |            |                  |            |
| updatedAt |            |            |                  |            |
| entity    |            |            |                  | `TAG`      |

**Access patterns**:

- Get tag by ID: `PK = TAG#<id>, SK = TAG#<id>`
- Get tag by name: GSI1 query `GSI1PK = TAGNAME#<name>`
- List all tags: Scan with `entity = TAG` filter (small dataset, acceptable)

#### Recording-Tag Relationship (Adjacency List Items)

To support "get all recordings for a tag" (inverse lookup), we store relationship items:

| Attribute | PK         | SK            | GSI1PK        | GSI1SK          |
| --------- | ---------- | ------------- | ------------- | --------------- |
| PK        | `TAG#<id>` |               |               |                 |
| SK        |            | `REC#<recId>` |               |                 |
| GSI1PK    |            |               | `REC#<recId>` |                 |
| GSI1SK    |            |               |               | `TAG#<tagName>` |
| entity    |            |               |               | `TAG_RECORDING` |

**Access patterns**:

- Get all recordings for a tag: Query `PK = TAG#<id>` with `SK begins_with REC#`
- Get all tags for a recording (alternative to denormalized list): GSI1 query `GSI1PK = REC#<id>` with `GSI1SK begins_with TAG#`

### Complete Access Pattern Summary

| Access Pattern                       | Operation | Key Condition                                      | Index |
| ------------------------------------ | --------- | -------------------------------------------------- | ----- |
| Get user by ID                       | GetItem   | `PK = USER#<sub>, SK = USER#<sub>`                 | Table |
| Get user by email                    | Query     | `GSI1PK = USEREMAIL#<email>`                       | GSI1  |
| List users (admin, paginated)        | Scan      | Filter `entity = USER`                             | Table |
| Get recording by ID                  | GetItem   | `PK = REC#<id>, SK = REC#<id>`                     | Table |
| List recordings (paginated, by date) | Query     | `GSI2PK = RECORDINGS`, sort by GSI2SK desc         | GSI2  |
| List free recordings                 | Query     | `GSI2PK = RECORDINGS`, filter `isFree = true`      | GSI2  |
| Search recordings by title           | Query     | `GSI2PK = RECORDINGS`, filter `contains(title, q)` | GSI2  |
| Get tag by ID                        | GetItem   | `PK = TAG#<id>, SK = TAG#<id>`                     | Table |
| Get tag by name                      | Query     | `GSI1PK = TAGNAME#<name>`                          | GSI1  |
| List all tags                        | Scan      | Filter `entity = TAG`                              | Table |
| Get recordings for a tag             | Query     | `PK = TAG#<id>, SK begins_with REC#`               | Table |
| Get tags for a recording             | Query     | `GSI1PK = REC#<id>, GSI1SK begins_with TAG#`       | GSI1  |
| Count users / recordings / tags      | Scan      | Filter by `entity`, count only                     | Table |

---

## CDK Stack Design

The `database-stack.ts` will create:

### 1. DynamoDB Table

```typescript
const table = new dynamodb.Table(this, "MainTable", {
  tableName: `voces-${env}-main`,
  partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  deletionProtection: isProd,
  pointInTimeRecovery: true,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
});
```

### 2. Global Secondary Indexes

```typescript
table.addGlobalSecondaryIndex({
  indexName: "GSI1",
  partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

table.addGlobalSecondaryIndex({
  indexName: "GSI2",
  partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```

### 3. No Security Groups, No VPC, No Secrets

Unlike RDS, DynamoDB requires:

- No security groups (access controlled by IAM)
- No VPC placement (accessed over HTTPS)
- No database credentials (IAM roles authenticate)

### Stack Outputs (exported for other stacks)

- `TableName` — The DynamoDB table name
- `TableArn` — The table ARN (for IAM policies)
- `GSI1Arn` — GSI1 ARN (for IAM policies on index queries)
- `GSI2Arn` — GSI2 ARN (for IAM policies on index queries)

---

## Schema Evolution Strategy

### No Migrations Needed

DynamoDB is schema-less at the table level. The table structure (partition key, sort key, GSIs) is defined in CDK and rarely changes. The data shape is enforced in application code.

### How schema changes work

1. **Adding a new attribute**: Just start writing it. No migration needed. Old items won't have it — handle `undefined` in code.
2. **Adding a new GSI**: Add it in CDK and deploy. DynamoDB backfills the index automatically (may take time for large tables).
3. **Removing a GSI**: Remove from CDK and deploy.
4. **Changing key schema**: Not possible on an existing table. Requires creating a new table and migrating data (rare, plan access patterns carefully upfront).

### Data Shape Validation

Since DynamoDB doesn't enforce schemas, use **Zod** in application code to validate data before writes and after reads:

```typescript
import { z } from "zod";

const RecordingSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  title: z.string(),
  description: z.string().optional(),
  fileKey: z.string(),
  metadata: z.record(z.unknown()).optional(),
  isFree: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  entity: z.literal("RECORDING"),
});
```

---

## DynamoDB in Lambda — Specific Considerations

### 1. AWS SDK v3 (Lightweight)

Unlike Prisma (~40MB engine binary), the DynamoDB SDK is lightweight (~1MB bundled with esbuild):

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
```

No Lambda Layer needed for the database client. This significantly reduces deployment size and cold start times.

### 2. No Connection Management

DynamoDB uses HTTP requests — no persistent connections, no connection pooling, no connection limits. Each Lambda invocation simply makes HTTP calls to the DynamoDB endpoint.

### 3. Client Instantiation

Reuse the DynamoDB client across invocations within the same Lambda container (same pattern as before, but simpler):

```typescript
// Instantiate outside the handler for reuse across warm invocations
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const TABLE_NAME = process.env.TABLE_NAME!;
```

### 4. IAM-Based Access (No Credentials)

Lambda functions access DynamoDB via their execution role. No database URL, no passwords:

```typescript
// No credentials needed — SDK uses the Lambda execution role automatically
const result = await docClient.send(
  new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: `USER#${userId}` },
  }),
);
```

### 5. Shared Database Utility

```typescript
// aws/lambdas/shared/db.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAME = process.env.TABLE_NAME!;
```

---

## Environment-Specific Configuration

| Parameter              | Dev                                | Prod                                 |
| ---------------------- | ---------------------------------- | ------------------------------------ |
| Capacity mode          | On-demand (pay-per-request)        | On-demand (pay-per-request)          |
| Point-in-time recovery | Enabled                            | Enabled                              |
| Deletion protection    | Off                                | On                                   |
| Removal policy         | DESTROY (easy cleanup)             | RETAIN (never auto-delete)           |
| Encryption             | AWS-managed key                    | AWS-managed key (or CMK if required) |
| Estimated cost         | ~$0 (free tier covers dev traffic) | ~$0-5 (depends on traffic)           |

### Cost Breakdown

DynamoDB on-demand pricing:

- **Write**: $1.25 per million write request units
- **Read**: $0.25 per million read request units
- **Storage**: $0.25 per GB/month
- **Free tier** (always free, not 12-month limited): 25 GB storage, 25 WRU, 25 RRU

For a non-professional project with low traffic, DynamoDB will cost effectively **$0/month** — both in dev and prod. This is a massive improvement over the RDS-based plan (~$12-17/month dev, ~$66/month prod).

---

## Risks and Mitigations

| Risk                                               | Mitigation                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Access patterns not anticipated upfront            | Document all access patterns before implementation; GSIs can be added later                                  |
| Complex queries (JOINs, aggregations) not possible | Our data model is simple; denormalize where needed; use Scan with filters for admin-only operations          |
| Many-to-many (Recording ↔ Tag) complexity          | Use adjacency list pattern + denormalized `tags` list on Recording items; keep both in sync via transactions |
| Hot partition (all recordings under one GSI2PK)    | Acceptable for our scale; DynamoDB adaptive capacity handles moderate hotspots; shard if needed later        |
| No full-text search                                | Use `contains()` filter for simple title search; add OpenSearch/Algolia later if needed                      |
| Schema-less means data inconsistency risk          | Enforce shapes with Zod validation on all writes; add `entity` discriminator attribute                       |
| GSI eventual consistency                           | GSI reads are eventually consistent by default; acceptable for our use case (no financial transactions)      |

---

## Definition of Done

- [ ] DynamoDB table created via CDK with PK/SK and both GSIs
- [ ] On-demand billing mode configured
- [ ] Point-in-time recovery enabled
- [ ] A test Lambda can write and read items using the AWS SDK
- [ ] All access patterns verified (user CRUD, recording CRUD, tag CRUD, relationships)
- [ ] Zod schemas defined for all entity types
- [ ] No VPC attachment needed for database access (confirmed)
- [ ] IAM policies scoped to the specific table and index ARNs
- [ ] (Prod) Deletion protection enabled
