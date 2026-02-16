# Part 1: Infrastructure as Code with AWS CDK + GitHub Actions

## Goal

Establish the foundational IaC pipeline so that every AWS resource created in subsequent parts is defined in code, version-controlled, and deployed automatically through GitHub Actions.

---

## Technology Choice: AWS CDK (TypeScript)

### Why CDK over CloudFormation / Terraform / SAM?

| Option                   | Pros                                                                                                   | Cons                                                      | Verdict               |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------- |
| Raw CloudFormation       | Native AWS, no extra tooling                                                                           | Verbose YAML/JSON, hard to maintain                       | Too low-level         |
| Terraform                | Multi-cloud, mature ecosystem                                                                          | Not AWS-native, HCL learning curve, state management      | Overkill for AWS-only |
| SAM                      | Good for Lambda, simpler                                                                               | Limited for non-Lambda resources (DynamoDB, Cognito, VPC) | Too narrow            |
| **AWS CDK (TypeScript)** | Same language as our Lambdas, high-level constructs, generates CloudFormation, great for complex infra | Requires Node.js                                          | **Best fit**          |

CDK lets us write infrastructure in TypeScript (same as our Lambda code), provides L2/L3 constructs that handle best practices by default, and synthesizes to CloudFormation for deployment.

---

## CDK Project Structure

```
aws/infra/
├── bin/
│   └── app.ts                     # CDK app entry point
├── lib/
│   ├── stacks/
│   │   ├── network-stack.ts       # VPC, subnets, security groups (PROD ONLY - no-op in dev)
│   │   ├── database-stack.ts      # DynamoDB table + GSIs
│   │   ├── auth-stack.ts          # Cognito User Pool
│   │   ├── storage-stack.ts       # S3 bucket
│   │   ├── email-stack.ts         # SES configuration
│   │   └── api-stack.ts           # Lambda functions + API Gateway + custom domain
│   └── constructs/                # Reusable CDK constructs
│       └── ...
├── cdk.json
├── package.json
└── tsconfig.json
```

**Note**: The `network-stack.ts` is conditional — it creates VPC resources only in prod (if VPC is desired). In dev, the stack is a no-op or skipped entirely. See Part 8 for details.

### Stack Separation Strategy

Each major AWS service gets its own stack. This allows:

- **Independent deployment**: Update the API stack without touching the database.
- **Clear dependency graph**: CDK handles cross-stack references automatically.
- **Easier debugging**: A failed deployment is scoped to one stack.

---

## Environment Strategy

Two environments from day one: `dev` and `prod`.

### How environments are differentiated

- **CDK context**: Pass environment name via `-c env=dev` or `-c env=prod`.
- **Resource naming**: All resources include the environment prefix, e.g., `voces-dev-recordings-bucket`, `voces-prod-api`.
- **Separate AWS accounts** (recommended) or **same account with naming/tagging** (simpler start).
- **Configuration**: Environment-specific values stored in `cdk.json` context or SSM Parameter Store.

### Recommended starting approach

Start with a **single AWS account** using naming conventions and tags to separate environments. Migrate to multi-account later if needed.

```
Resource naming pattern: voces-{env}-{resource-name}
Tag: Environment = dev | prod
```

---

## GitHub Actions CI/CD Pipeline

### Workflows

#### 1. `ci.yml` — Runs on every PR

- Lint and type-check CDK infra code
- Lint and type-check Lambda code
- Run unit tests
- `cdk synth` to validate templates (no deploy)
- `cdk diff` to show what would change (comment on PR)

#### 2. `deploy-infra.yml` — Deploys infrastructure

- **Trigger**: Push to `main` (dev) or tag/release (prod)
- **Steps**:
  1. Checkout code
  2. Setup Node.js
  3. Install dependencies
  4. Configure AWS credentials (via OIDC — no long-lived keys)
  5. `cdk deploy --all` for the target environment
- **Environments**: Uses GitHub Environments for approval gates on prod

#### 3. `deploy-lambdas.yml` — Deploys Lambda code only

- **Trigger**: Push to `main` when only `lambdas/` files changed
- **Steps**:
  1. Checkout code
  2. Bundle Lambda code
  3. Update Lambda functions (via CDK or direct S3 upload + update-function-code)
- This is a fast path for code-only changes that don't touch infrastructure.

### AWS Authentication from GitHub Actions

**Use OIDC federation** (no long-lived access keys):

1. Create an IAM OIDC identity provider for GitHub in AWS.
2. Create an IAM role that trusts the GitHub OIDC provider, scoped to this repository.
3. The GitHub Action assumes this role using `aws-actions/configure-aws-credentials`.

This is the most secure approach — no AWS secrets stored in GitHub.

### Required GitHub Secrets / Variables

| Name                | Type     | Description                       |
| ------------------- | -------- | --------------------------------- |
| `AWS_ACCOUNT_ID`    | Variable | AWS account ID                    |
| `AWS_REGION`        | Variable | Target region (e.g., `us-east-1`) |
| `AWS_ROLE_ARN_DEV`  | Secret   | IAM role ARN for dev deployments  |
| `AWS_ROLE_ARN_PROD` | Secret   | IAM role ARN for prod deployments |

---

## Bootstrap Steps (One-Time Manual Setup)

These are the only manual steps in the entire migration. Everything after this is automated.

### 1. AWS Account Preparation

- [ ] Ensure AWS account is active with billing configured
- [ ] Choose a primary region (recommend `us-east-1` for broadest service availability)
- [ ] Enable CloudTrail for audit logging (optional but recommended)

### 2. CDK Bootstrap

CDK needs a one-time bootstrap per account/region to create its staging resources (S3 bucket for assets, IAM roles for deployment).

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION> --profile <your-profile>
```

### 3. GitHub OIDC Provider Setup

Create the OIDC provider in AWS IAM (one-time):

- **Provider URL**: `https://token.actions.githubusercontent.com`
- **Audience**: `sts.amazonaws.com`

Then create an IAM role with:

- Trust policy scoped to this GitHub repo
- Permissions: `AdministratorAccess` for initial setup (scope down later)

### 4. GitHub Repository Configuration

- [ ] Add `AWS_ACCOUNT_ID` and `AWS_REGION` as repository variables
- [ ] Add `AWS_ROLE_ARN_DEV` as a repository secret
- [ ] Create GitHub Environment `production` with required reviewers
- [ ] Add `AWS_ROLE_ARN_PROD` as a secret in the `production` environment

---

## Secrets Management Strategy

All application configuration values will be stored in **AWS SSM Parameter Store** (SecureString type for sensitive values). Note: DynamoDB uses IAM-based access, so no database credentials are needed. Cognito manages its own JWT signing keys, so no custom JWT secret is required.

| Configuration       | Storage                | Accessed By      | Notes                                      |
| ------------------- | ---------------------- | ---------------- | ------------------------------------------ |
| DynamoDB Table Name | CDK outputs / env vars | Lambda functions | Injected as environment variable           |
| Cognito User Pool   | CDK outputs / env vars | Lambda functions | Pool ID and Client ID as env vars          |
| S3 bucket name      | CDK outputs / env vars | Recording Lambda | Injected as environment variable           |
| SES From Address    | SSM Parameter Store    | Email Lambda     | Plain parameter (not sensitive)            |
| API Keys (future)   | Secrets Manager        | Lambda functions | Only if third-party integrations are added |

**No `.env` files in production.** Lambdas receive configuration as environment variables injected by CDK at deployment time.

---

## Deliverables for Part 1

1. **CDK project initialized** in `aws/infra/` with TypeScript config
2. **GitHub Actions workflows** in `.github/workflows/`:
   - `ci.yml` for PR validation
   - `deploy-infra.yml` for infrastructure deployment
3. **OIDC setup documentation** for the one-time manual AWS configuration
4. **Empty stack shells** for each service (to be filled in subsequent parts)
5. **Environment configuration** in `cdk.json` for dev/prod

---

## Risks and Mitigations

| Risk                        | Mitigation                                                          |
| --------------------------- | ------------------------------------------------------------------- |
| CDK bootstrap fails         | Ensure correct AWS credentials and region; bootstrap is idempotent  |
| OIDC trust policy too broad | Scope to specific repo and branch patterns                          |
| Stack dependency cycles     | Keep stacks independent; use SSM for cross-stack values when needed |
| CDK version drift           | Pin CDK version in `package.json`; use `npm ci` in CI               |

---

## Definition of Done

- [ ] `cdk synth` produces valid CloudFormation for an empty app
- [ ] `ci.yml` runs successfully on a PR
- [ ] `deploy-infra.yml` deploys empty stacks to dev environment
- [ ] OIDC authentication works from GitHub Actions to AWS
- [ ] No manual AWS console actions required after bootstrap
