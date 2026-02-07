# Migration Plan Overview

## From: Express.js Monolith → To: AWS Serverless

This document is the index for the full migration plan of the **Voces de la Extinción** backend from a Node.js/Express monolith to a fully serverless AWS architecture, managed entirely through Infrastructure as Code (IaC) via GitHub Actions.

---

## Current Architecture (Legacy)

| Component    | Technology                   | Location               |
| ------------ | ---------------------------- | ---------------------- |
| Runtime      | Node.js + TypeScript         | Single Express server  |
| Framework    | Express.js 5.x               | `src/index.ts`         |
| Database     | PostgreSQL                   | Local / external       |
| ORM          | Prisma                       | `prisma/schema.prisma` |
| Auth         | JWT (jsonwebtoken) + bcrypt  | Custom middleware      |
| File Storage | AWS S3                       | Already on AWS         |
| Email        | Gmail OAuth 2.0 (Nodemailer) | Google Cloud           |
| Validation   | express-validator            | Custom middleware      |
| Testing      | Jest + ts-jest               | `tests/unit/`          |

### Legacy API Surface

| Route Group   | Endpoints                                                          | Auth                        | Notes                                         |
| ------------- | ------------------------------------------------------------------ | --------------------------- | --------------------------------------------- |
| `/auth`       | register, login, verify-email, forgot-password, reset-password, me | Public + Protected          | Email verification + password reset flows     |
| `/users`      | me                                                                 | Protected                   | User profile                                  |
| `/recordings` | CRUD + bulk download, download-all                                 | Protected (admin for write) | S3 file upload via multer, pagination, search |
| `/tags`       | CRUD (list, get, create, update, delete)                           | Protected + Admin           | Simple CRUD                                   |
| `/admin`      | users CRUD                                                         | Protected + Admin           | User management with pagination/search        |
| `/metrics`    | get                                                                | Public                      | Aggregate counts                              |

### Data Models

- **User**: id (Cognito sub), email, plan (FREE/PREMIUM), role (USER/ADMIN), createdAt, updatedAt
- **Recording**: id, title, description, fileKey, metadata (JSON), isFree, tags (many-to-many)
- **Tag**: id, name, recordings (many-to-many)

### Access Control

- **FREE users**: Can access 10 curated recordings (marked `isFree`), with short-lived presigned download URLs (15 min)
- **PREMIUM users**: Can access all recordings, with presigned download URLs (1 hour). Can bulk-download or download all recordings
- **No permanent download URLs**: S3 bucket is fully private; all file access via presigned URLs to prevent link sharing

---

## Target Architecture (AWS)

| Component    | AWS Service                               | Replaces            |
| ------------ | ----------------------------------------- | ------------------- |
| Compute      | AWS Lambda                                | Express.js server   |
| API Layer    | API Gateway (HTTP API)                    | Express router      |
| Database     | RDS PostgreSQL (Serverless v2)            | Local PostgreSQL    |
| ORM          | Prisma (Lambda layer)                     | Prisma (same)       |
| Auth         | AWS Cognito                               | Custom JWT + bcrypt |
| File Storage | S3                                        | S3 (already there)  |
| Email        | AWS SES                                   | Gmail OAuth 2.0     |
| Secrets      | AWS Secrets Manager / SSM Parameter Store | .env file           |
| IaC          | AWS CDK (TypeScript)                      | None                |
| CI/CD        | GitHub Actions                            | None                |
| Monitoring   | CloudWatch                                | Console logs        |
| Networking   | VPC + Subnets                             | None                |

---

## Migration Parts (Execution Order)

Each part is a self-contained document with detailed steps, decisions, and rationale.

| Part | Document                                                 | Description                                                           | Dependencies      |
| ---- | -------------------------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| 1    | [01-IAC-GITHUB-ACTIONS.md](./01-IAC-GITHUB-ACTIONS.md)   | IaC foundation with AWS CDK + GitHub Actions CI/CD                    | None (first step) |
| 2    | [02-DATABASE-RDS.md](./02-DATABASE-RDS.md)               | RDS PostgreSQL setup, schema migration, Prisma config                 | Part 1            |
| 3    | [03-AUTH-COGNITO.md](./03-AUTH-COGNITO.md)               | Cognito User Pool replacing custom JWT auth                           | Part 1            |
| 4    | [04-STORAGE-S3.md](./04-STORAGE-S3.md)                   | S3 bucket formalization with proper IAM policies                      | Part 1            |
| 5    | [05-EMAIL-SES.md](./05-EMAIL-SES.md)                     | SES replacing Gmail OAuth 2.0                                         | Part 1            |
| 6    | [06-API-GATEWAY.md](./06-API-GATEWAY.md)                 | API Gateway HTTP API — routing, auth, CORS, throttling, custom domain | Parts 1, 3        |
| 7    | [07-LAMBDAS.md](./07-LAMBDAS.md)                         | Lambda functions — business logic, validation, internal routing       | Parts 1-6         |
| 8    | [08-NETWORKING-SECURITY.md](./08-NETWORKING-SECURITY.md) | VPC, security groups, monitoring, final hardening                     | Parts 1-7         |

---

## Guiding Principles

1. **IaC first**: No resource is created manually. Everything goes through CDK stacks deployed via GitHub Actions.
2. **AWS-only**: No external services (no Google Cloud, no third-party auth providers).
3. **Environment separation**: `dev` and `prod` environments from day one.
4. **Secrets management**: No hardcoded secrets. SSM Parameter Store or Secrets Manager for all sensitive values.
5. **Least privilege**: IAM roles scoped to exactly what each Lambda needs.
6. **Incremental delivery**: Each part is deployable and testable independently.
7. **Preserve API contract**: The API surface (routes, request/response shapes) stays the same for frontend compatibility.

---

## Project Structure (Target)

```
aws/
├── plan/                          # Migration plan documents (this folder)
│   ├── 00-OVERVIEW.md
│   ├── 01-IAC-GITHUB-ACTIONS.md
│   ├── 02-DATABASE-RDS.md
│   ├── 03-AUTH-COGNITO.md
│   ├── 04-STORAGE-S3.md
│   ├── 05-EMAIL-SES.md
│   ├── 06-API-GATEWAY.md
│   ├── 07-LAMBDAS.md
│   └── 08-NETWORKING-SECURITY.md
├── infra/                         # CDK infrastructure code
│   ├── bin/
│   ├── lib/
│   │   ├── stacks/
│   │   └── constructs/
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── lambdas/                       # Lambda function source code
│   ├── auth/
│   ├── recordings/
│   ├── tags/
│   ├── admin/
│   ├── metrics/
│   ├── shared/                    # Shared utilities (prisma, response helpers)
│   └── layers/                    # Lambda layers (prisma engine, etc.)
├── .github/
│   └── workflows/
│       ├── deploy-infra.yml
│       ├── deploy-lambdas.yml
│       └── ci.yml
└── prisma/
    ├── schema.prisma
    └── migrations/
```
