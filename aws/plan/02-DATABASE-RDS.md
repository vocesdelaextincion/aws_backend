# Part 2: Database — RDS PostgreSQL

## Goal

Set up a PostgreSQL database on AWS RDS from scratch, configure it for Lambda access within a VPC, and adapt Prisma to work in the serverless context.

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

| Aspect             | Decision                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| Engine             | PostgreSQL 16 (latest stable on RDS)                                    |
| Instance type      | **RDS Aurora Serverless v2** (scales to zero in dev, scales up in prod) |
| Networking         | Inside a VPC, private subnets only (no public access)                   |
| Access             | Lambda functions connect via VPC; no internet-facing DB endpoint        |
| Connection pooling | **RDS Proxy** to handle Lambda connection bursts                        |
| ORM                | Prisma (same as legacy, with Lambda-specific config)                    |
| Migrations         | Run via a dedicated CI/CD step or a one-off Lambda                      |
| Secrets            | Database credentials in AWS Secrets Manager (auto-rotated)              |

### Why Aurora Serverless v2?

- **Cost**: Scales to near-zero ACUs in dev when idle. No paying for an always-on instance during development.
- **Scaling**: Automatically scales compute based on load in prod.
- **Compatibility**: Full PostgreSQL compatibility — Prisma works unchanged.
- **Managed**: Automated backups, patching, failover.

### Why RDS Proxy?

Lambda functions are ephemeral. Each invocation may open a new database connection. Without pooling, you can exhaust the DB connection limit quickly.

RDS Proxy:

- Pools and reuses connections
- Handles connection draining during Lambda scaling
- Integrates with Secrets Manager for credential rotation
- Adds ~1ms latency (negligible)

---

## CDK Stack Design

The `database-stack.ts` will create:

1. **Aurora Serverless v2 Cluster** (PostgreSQL 16)
   - Minimum ACU: 0.5 (dev) / 2 (prod)
   - Maximum ACU: 2 (dev) / 16 (prod)
   - Private subnets only
   - Encryption at rest (default KMS key)
   - Automated backups: 7 days (dev) / 35 days (prod)
   - Deletion protection: off (dev) / on (prod)

2. **RDS Proxy**
   - Attached to the Aurora cluster
   - IAM authentication enabled
   - Secrets Manager integration for credentials
   - Idle timeout: 30 minutes

3. **Security Group**
   - Inbound: PostgreSQL port (5432) from Lambda security group only
   - Outbound: None needed

4. **Secrets Manager Secret**
   - Auto-generated master credentials
   - Rotation enabled (30-day cycle in prod)

### Stack Outputs (exported for other stacks)

- `DatabaseProxyEndpoint` — The RDS Proxy endpoint URL
- `DatabaseSecretArn` — ARN of the Secrets Manager secret
- `DatabaseSecurityGroupId` — SG ID for Lambda to reference
- `DatabaseName` — The database name

---

## Schema Migration Strategy

### Approach: Prisma Migrate via CI/CD

Prisma migrations will be run as a step in the GitHub Actions deployment pipeline, not from Lambda at runtime.

#### How it works

1. The `prisma/` folder (schema + migrations) lives in the repo under `aws/prisma/`.
2. During deployment, a GitHub Actions step:
   - Connects to the RDS instance (via a bastion or VPC-enabled runner)
   - Runs `npx prisma migrate deploy` (applies pending migrations, never creates new ones)
3. New migrations are created locally by developers with `npx prisma migrate dev`.

#### Alternative: Migration Lambda

If VPC-enabled GitHub runners are not available, create a small Lambda function that:

- Is triggered manually or as a CDK custom resource
- Runs `prisma migrate deploy`
- Reports success/failure

This is a fallback — the CI/CD approach is preferred.

### Schema Design

The Prisma schema will be based on the legacy schema but adapted for Cognito from the start — password and verification token fields will be removed since Cognito handles authentication (see Part 3). The schema will be created fresh via `prisma migrate deploy`.

---

## Prisma in Lambda — Specific Considerations

### 1. Prisma Engine Binary

Prisma uses a query engine binary. For Lambda, we need the `rhel-openssl-3.0.x` target.

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "rhel-openssl-3.0.x"]
}
```

### 2. Connection String

The connection string will be constructed at runtime from Secrets Manager:

```
postgresql://<username>:<password>@<rds-proxy-endpoint>:5432/<dbname>?connection_limit=1
```

Key: `connection_limit=1` — Each Lambda instance should use only 1 connection since RDS Proxy handles pooling.

### 3. Prisma Client Instantiation

Reuse the Prisma client across invocations within the same Lambda container:

```typescript
// Instantiate outside the handler for connection reuse
let prisma: PrismaClient;

function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: {
        db: { url: process.env.DATABASE_URL },
      },
    });
  }
  return prisma;
}
```

### 4. Lambda Layer for Prisma

The Prisma engine binary (~40MB) should be packaged as a **Lambda Layer** shared across all functions. This:

- Reduces individual function package size
- Speeds up deployments (layer is cached)
- Keeps cold starts manageable

---

## Environment-Specific Configuration

| Parameter           | Dev    | Prod    |
| ------------------- | ------ | ------- |
| Min ACU             | 0.5    | 2       |
| Max ACU             | 2      | 16      |
| Backup retention    | 7 days | 35 days |
| Deletion protection | Off    | On      |
| Multi-AZ            | No     | Yes     |
| Proxy idle timeout  | 15 min | 30 min  |
| Secret rotation     | Off    | 30 days |

---

## Risks and Mitigations

| Risk                                           | Mitigation                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| Lambda cold start + DB connection latency      | RDS Proxy pre-warms connections; Prisma client reuse                        |
| Connection exhaustion                          | RDS Proxy pools connections; `connection_limit=1` per Lambda                |
| Prisma engine size bloats Lambda               | Use Lambda Layer for Prisma engine                                          |
| Migration failures in CI/CD                    | Run `prisma migrate deploy` (safe, never auto-generates); test in dev first |
| Aurora Serverless v2 cold start (scale from 0) | Set minimum ACU to 0.5 (not true zero) to keep cluster warm                 |

---

## Definition of Done

- [ ] Aurora Serverless v2 cluster deployed via CDK in dev
- [ ] RDS Proxy configured and accessible from Lambda security group
- [ ] Database credentials stored in Secrets Manager
- [ ] Prisma schema deployed to RDS via CI/CD migration step
- [ ] A test Lambda can connect through RDS Proxy and query the database
- [ ] Connection pooling verified (no connection leaks under concurrent invocations)
