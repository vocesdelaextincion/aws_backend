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

| Aspect             | Decision                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Engine             | PostgreSQL 16 (latest stable on RDS)                                                            |
| Instance type      | **RDS db.t4g.micro** (dev — free tier eligible) / **Aurora Serverless v2** (prod — auto-scales) |
| Networking         | Inside a VPC, private subnets only (no public access)                                           |
| Access             | Lambda functions connect via VPC; no internet-facing DB endpoint                                |
| Connection pooling | **Direct connections** (dev) / **RDS Proxy** (prod only)                                        |
| ORM                | Prisma (same as legacy, with Lambda-specific config)                                            |
| Migrations         | Run via a dedicated CI/CD step or a one-off Lambda                                              |
| Secrets            | Database credentials in AWS Secrets Manager                                                     |

### Why db.t4g.micro for Dev?

- **Cost**: Free tier eligible — 750 hours/month free for 12 months. After free tier: ~$12/month.
- **ARM64 (Graviton2)**: Same architecture as our Lambda functions — cheaper than x86 equivalents.
- **Sufficient for dev**: 2 vCPUs, 1 GB RAM — more than enough for development and testing.
- **Compatibility**: Standard RDS PostgreSQL — Prisma works unchanged.
- **Managed**: Automated backups, patching, same as any RDS instance.

### Why Aurora Serverless v2 for Prod?

- **Scaling**: Automatically scales compute based on load.
- **High availability**: Multi-AZ with fast failover.
- **Compatibility**: Full PostgreSQL compatibility.

### Why RDS Proxy in Prod Only?

Lambda functions are ephemeral. Each invocation may open a new database connection. In production with concurrent users, this can exhaust the DB connection limit.

RDS Proxy:

- Pools and reuses connections
- Handles connection draining during Lambda scaling
- Integrates with Secrets Manager for credential rotation
- Adds ~1ms latency (negligible)

**In dev**, traffic is low enough that direct Lambda-to-RDS connections with `connection_limit=1` per Lambda instance work fine. The db.t4g.micro supports ~80 connections — far more than dev will ever need. This saves ~$22/month.

---

## CDK Stack Design

The `database-stack.ts` will create:

1. **RDS PostgreSQL Instance** (dev) or **Aurora Serverless v2 Cluster** (prod)
   - **Dev**: db.t4g.micro, PostgreSQL 16, single-AZ, 20 GB gp3 storage
   - **Prod**: Aurora Serverless v2, min 2 ACU / max 16 ACU, multi-AZ
   - Private subnets only
   - Encryption at rest (default KMS key)
   - Automated backups: 7 days (dev) / 35 days (prod)
   - Deletion protection: off (dev) / on (prod)

2. **RDS Proxy** (prod only)
   - Attached to the Aurora cluster
   - IAM authentication enabled
   - Secrets Manager integration for credentials
   - Idle timeout: 30 minutes
   - Not created in dev (direct connections instead)

3. **Security Group**
   - Inbound: PostgreSQL port (5432) from Lambda security group only
   - Outbound: None needed

4. **Secrets Manager Secret**
   - Auto-generated master credentials
   - Rotation enabled (30-day cycle in prod), off in dev

### Stack Outputs (exported for other stacks)

- `DatabaseEndpoint` — The RDS instance endpoint (dev) or RDS Proxy endpoint (prod)
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
postgresql://<username>:<password>@<db-endpoint>:5432/<dbname>?connection_limit=1&sslmode=require
```

- `connection_limit=1` — Each Lambda instance should use only 1 connection. In prod, RDS Proxy handles pooling. In dev, the db.t4g.micro supports ~80 connections which is more than sufficient.
- `sslmode=require` — Enforces encrypted connections between Lambda and RDS (see Well-Architected Framework adoption plan).
- `<db-endpoint>` — Points to the RDS Proxy endpoint in prod, or directly to the RDS instance endpoint in dev.

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

| Parameter           | Dev                                      | Prod                                |
| ------------------- | ---------------------------------------- | ----------------------------------- |
| Instance type       | db.t4g.micro (free tier)                 | Aurora Serverless v2 (2-16 ACU)     |
| Storage             | 20 GB gp3                                | Aurora-managed                      |
| Backup retention    | 7 days                                   | 35 days                             |
| Deletion protection | Off                                      | On                                  |
| Multi-AZ            | No                                       | Yes                                 |
| RDS Proxy           | No (direct connections)                  | Yes (idle timeout: 30 min)          |
| Secret rotation     | Off                                      | 30 days                             |
| Estimated cost      | ~$0 (free tier) / ~$12 (after 12 months) | ~$44 (Aurora) + ~$22 (Proxy) = ~$66 |

---

## Risks and Mitigations

| Risk                                      | Mitigation                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Lambda cold start + DB connection latency | Prisma client reuse across warm invocations; RDS Proxy in prod pre-warms connections        |
| Connection exhaustion in dev (no Proxy)   | `connection_limit=1` per Lambda + db.t4g.micro supports ~80 connections; dev traffic is low |
| Connection exhaustion in prod             | RDS Proxy pools connections; `connection_limit=1` per Lambda                                |
| Prisma engine size bloats Lambda          | Use Lambda Layer for Prisma engine                                                          |
| Migration failures in CI/CD               | Run `prisma migrate deploy` (safe, never auto-generates); test in dev first                 |
| Dev/prod DB engine mismatch               | Both are standard PostgreSQL 16; Prisma abstracts engine differences                        |

---

## Definition of Done

- [ ] RDS db.t4g.micro instance deployed via CDK in dev
- [ ] Database credentials stored in Secrets Manager
- [ ] SSL/TLS enforced on database connections (`sslmode=require`)
- [ ] Prisma schema deployed to RDS via CI/CD migration step
- [ ] A test Lambda can connect directly to RDS and query the database
- [ ] No connection leaks under concurrent invocations (`connection_limit=1` verified)
- [ ] (Prod) Aurora Serverless v2 cluster + RDS Proxy configured and accessible
