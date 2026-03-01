# Part 9: Manual AWS Setup — Prerequisites & One-Time Steps

## Goal

Document every action that must be performed **manually** in the AWS Console (or CLI) before or alongside the CDK-automated infrastructure. These are steps that CDK cannot do for you, or that must happen once before CDK can run.

---

## Overview

The entire migration is designed to be IaC-first, but some things require manual intervention:

| Category                | Steps                                                  | When                                |
| ----------------------- | ------------------------------------------------------ | ----------------------------------- |
| AWS Account             | Account setup, region selection, billing               | Before anything                     |
| CDK Bootstrap           | One-time CDK staging resources                         | Before first `cdk deploy`           |
| GitHub OIDC             | IAM identity provider + role for CI/CD                 | Before first GitHub Actions deploy  |
| GitHub Repo Config      | Secrets and environment variables                      | Before first GitHub Actions deploy  |
| SES Sandbox Exit        | Request production email access                        | Before prod deployment (takes ~24h) |
| SES Domain Verification | DNS records for email deliverability                   | Before prod deployment              |
| Custom Domain (API)     | ACM certificate + DNS for `api.vocesdelaextincion.com` | Before prod deployment              |
| AWS Budget Alerts       | Cost monitoring                                        | After first deployment              |

---

## Phase 1: Before Any Deployment

These must be done before the first `cdk deploy` can run.

### 1. AWS Account Preparation

**Where**: AWS Console

- [ ] Ensure you have an active AWS account with billing configured
- [ ] Choose a primary region: **`us-east-1`** (recommended — broadest service availability, required for some global services like ACM for CloudFront)
- [ ] Enable MFA on the root account (security best practice)
- [ ] Create an IAM user or SSO profile for local development (avoid using root)

### 2. Install Local Tooling

**Where**: Your machine

- [ ] Install AWS CLI v2: `brew install awscli` or [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [ ] Configure a named profile: `aws configure --profile voces`
  - Access Key ID + Secret Access Key (from IAM user)
  - Default region: `us-east-1`
  - Default output: `json`
- [ ] Install Node.js 20.x (matches Lambda runtime)
- [ ] Install AWS CDK CLI: `npm install -g aws-cdk`
- [ ] Verify: `cdk --version`

### 3. CDK Bootstrap

**Where**: Terminal (one-time per account/region)

CDK needs staging resources (an S3 bucket for assets, IAM roles for deployment) before it can deploy any stack.

```bash
cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --profile voces
```

- This creates a CloudFormation stack called `CDKToolkit` in your account
- It's idempotent — safe to run multiple times
- Must be done for each region you deploy to (we only use `us-east-1`)

**Verify**: In CloudFormation console, you should see a `CDKToolkit` stack in `CREATE_COMPLETE` state.

### 4. GitHub OIDC Identity Provider

**Where**: AWS Console → IAM → Identity providers

This allows GitHub Actions to assume an AWS role without long-lived access keys.

**Step 1: Create the OIDC provider**

- [ ] Go to IAM → Identity providers → Add provider
- [ ] Provider type: **OpenID Connect**
- [ ] Provider URL: `https://token.actions.githubusercontent.com`
- [ ] Audience: `sts.amazonaws.com`
- [ ] Click "Add provider"

**Step 2: Create the IAM role for GitHub Actions (dev)**

- [ ] Go to IAM → Roles → Create role
- [ ] Trusted entity type: **Web identity**
- [ ] Identity provider: `token.actions.githubusercontent.com`
- [ ] Audience: `sts.amazonaws.com`
- [ ] Scope to your repo (AWS now shows individual fields instead of raw condition inputs):
  - **GitHub organization**: `vocesdelaextincion`
  - **GitHub repository**: `aws_backend`
  - **GitHub branch**: `dev`
- [ ] Permissions: Attach `AdministratorAccess` for initial setup
  - **Important**: Scope this down later to only the permissions CDK needs
- [ ] Role name: `voces-github-actions-dev`
- [ ] Note the Role ARN: `arn:aws:iam::<ACCOUNT_ID>:role/voces-github-actions-dev`
- [ ] Verify the trust policy `StringLike` block looks like this (AWS may auto-generate it correctly):
  ```json
  "StringLike": {
    "token.actions.githubusercontent.com:sub": "repo:vocesdelaextincion/aws_backend:ref:refs/heads/dev"
  }
  ```

**Step 3: Create the IAM role for GitHub Actions (prod)**

- [ ] Repeat Step 2 with these differences:
  - **GitHub organization**: `vocesdelaextincion`
  - **GitHub repository**: `aws_backend`
  - **GitHub branch**: `main` (we'll tighten this to tags after creation)
  - Role name: `voces-github-actions-prod`
  - Note the Role ARN
- [ ] After role creation, edit the trust policy to restrict to tag releases only:
  - In IAM → Roles → `voces-github-actions-prod` → Trust relationships → Edit trust policy
  - Find the `StringLike` block and replace its contents so it looks like this:
    ```json
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:vocesdelaextincion/aws_backend:ref:refs/tags/v*"
    }
    ```
  - This restricts prod deploys to tags matching `v*` (e.g. `v1.0.0`, `v2.3.1`)
  - AWS will warn about the wildcard in `v*` — this is safe to ignore; the repo path is already fully scoped

### 5. GitHub Repository Configuration

**Where**: GitHub → Repository → Settings

**Repository Variables** (Settings → Secrets and variables → Actions → Variables):

- [ ] `AWS_ACCOUNT_ID` = your 12-digit AWS account ID
- [ ] `AWS_REGION` = `us-east-1`

**Repository Secrets** (Settings → Secrets and variables → Actions → Secrets):

- [ ] `AWS_ROLE_ARN_DEV` = `arn:aws:iam::<ACCOUNT_ID>:role/voces-github-actions-dev`

**GitHub Environment for Production** (Settings → Environments → New environment):

- [ ] Create environment named `production`
- [ ] Enable "Required reviewers" — add yourself (prevents accidental prod deploys)
- [ ] Add environment secret: `AWS_ROLE_ARN_PROD` = `arn:aws:iam::<ACCOUNT_ID>:role/voces-github-actions-prod`

---

## Phase 2: Before Production Deployment

These can be done in parallel with dev environment work. Some take time (DNS propagation, SES approval), so start early.

### 6. SES: Request Production Access

**Where**: AWS Console → SES → Account dashboard

SES starts in **sandbox mode** (can only send to verified addresses, 200 emails/day). You need production access to send to real users.

- [ ] Go to SES → Account dashboard → "Request production access"
- [ ] Fill in:
  - **Mail type**: Transactional
  - **Website URL**: `https://vocesdelaextincion.com`
  - **Use case description**: "Transactional emails for user account verification and password reset. Expected volume: under 1000 emails/day."
  - **Additional contacts**: Your email for bounce/complaint notifications
- [ ] Submit and wait for approval (usually 24 hours, sometimes up to 72 hours)

**Timing**: Do this as soon as you start working on the email stack. Don't wait until you need it.

### 7. SES: Verify Email Address (Dev)

**Where**: AWS Console → SES → Verified identities

For dev, you only need a verified email address (not a full domain).

- [ ] Go to SES → Verified identities → Create identity
- [ ] Identity type: **Email address**
- [ ] Email: `noreply@vocesdelaextincion.com` (or whatever dev sender address you want)
- [ ] Click "Create identity"
- [ ] Check inbox and click the verification link

### 8. SES: Verify Domain + DNS Records (Prod)

**Where**: AWS Console → SES + Your DNS provider

For production, verify the full domain for better deliverability.

- [ ] Go to SES → Verified identities → Create identity
- [ ] Identity type: **Domain**
- [ ] Domain: `vocesdelaextincion.com`
- [ ] Enable "Use a custom MAIL FROM domain" (optional but recommended)
- [ ] Click "Create identity"

SES will provide DNS records you need to add:

**In your DNS provider** (Route 53, Cloudflare, Namecheap, etc.):

- [ ] Add **3 CNAME records** for DKIM:
  - Name: `{token1}._domainkey.vocesdelaextincion.com` → Value: `{token1}.dkim.amazonses.com`
  - Name: `{token2}._domainkey.vocesdelaextincion.com` → Value: `{token2}.dkim.amazonses.com`
  - Name: `{token3}._domainkey.vocesdelaextincion.com` → Value: `{token3}.dkim.amazonses.com`
- [ ] Add **TXT record** for SPF:
  - Name: `vocesdelaextincion.com`
  - Value: `v=spf1 include:amazonses.com ~all`
- [ ] Add **TXT record** for DMARC:
  - Name: `_dmarc.vocesdelaextincion.com`
  - Value: `v=DMARC1; p=quarantine; rua=mailto:admin@vocesdelaextincion.com`

**Verification time**: DKIM verification usually takes 15 minutes to 72 hours depending on DNS propagation.

### 9. Custom API Domain: ACM Certificate

**Where**: AWS Console → Certificate Manager (ACM)

To use `api.vocesdelaextincion.com` instead of the default API Gateway URL.

- [ ] Go to ACM → Request certificate
- [ ] Certificate type: **Public**
- [ ] Domain name: `api.vocesdelaextincion.com`
- [ ] Validation method: **DNS validation** (recommended)
- [ ] Click "Request"

ACM will provide a CNAME record for validation:

- [ ] Add the **CNAME record** in your DNS provider:
  - Name: `_<hash>.api.vocesdelaextincion.com`
  - Value: `_<hash>.acm-validations.aws`

**Verification time**: Usually 5-30 minutes after DNS record is added.

- [ ] Wait until certificate status shows **"Issued"**
- [ ] Note the Certificate ARN — CDK will reference it

### 10. Custom API Domain: DNS Record

**Where**: Your DNS provider

After CDK deploys the API Gateway custom domain, you need to point your DNS to it.

- [ ] CDK will output the API Gateway domain name (e.g., `d-abc123.execute-api.us-east-1.amazonaws.com`)
- [ ] Add a **CNAME record** (or alias if using Route 53):
  - Name: `api.vocesdelaextincion.com`
  - Value: the API Gateway domain name from CDK output

**Note**: This step happens **after** the first prod CDK deploy, not before.

---

## Phase 3: Post-Deployment Housekeeping

### 11. AWS Budget Alerts

**Where**: AWS Console → Billing → Budgets

- [ ] Create a budget:
  - Name: `voces-dev-monthly`
  - Amount: $15 (dev environment)
  - Alert at 80% ($12) and 100% ($15)
  - Notification email: your email
- [ ] Create a budget:
  - Name: `voces-prod-monthly`
  - Amount: $500 (prod environment, adjust as needed)
  - Alert at 80% ($400) and 100% ($500)

### 12. Scope Down GitHub Actions IAM Role

**Where**: AWS Console → IAM → Roles

After the initial setup is working, replace `AdministratorAccess` with a scoped policy:

- [ ] Create a custom policy `voces-github-actions-policy` with only:
  - `cloudformation:*` (for CDK stacks)
  - `s3:*` (for CDK assets bucket and recordings bucket)
  - `lambda:*`
  - `apigateway:*`
  - `cognito-idp:*`
  - `dynamodb:*`
  - `ec2:*` (for VPC/subnets/security groups — prod only)
  - `iam:*` (for creating Lambda execution roles)
  - `ssm:*`
  - `ses:*`
  - `logs:*`
  - `sts:AssumeRole` (for CDK)
- [ ] Attach this policy to both `voces-github-actions-dev` and `voces-github-actions-prod` roles
- [ ] Remove `AdministratorAccess`

### 13. Enable CloudTrail (Recommended)

**Where**: AWS Console → CloudTrail

- [ ] Create a trail:
  - Name: `voces-audit-trail`
  - Apply to all regions: Yes
  - S3 bucket: auto-create
  - Log file validation: Enabled
- [ ] This logs all API calls to your AWS account for security auditing

---

## Phase 4: Initial Data Seeding

After the infrastructure is deployed, you need to seed initial data to make the system usable.

### 14. Create First Admin User

**Where**: AWS Console → Cognito + Manual script

Since this is a **greenfield deployment** (no data migration from legacy), you need to create the first admin user manually.

**Option A: Via AWS Console (Quick start)**

1. Go to Cognito → User Pools → `voces-dev-user-pool`
2. Click "Create user"
3. Username type: Email
4. Email: `admin@vocesdelaextincion.com`
5. Temporary password: (auto-generate)
6. Mark email as verified: Yes
7. Click "Create user"
8. Note the user's `sub` (UUID)
9. Go to "Users" → Select the user → "Actions" → "Edit attributes"
10. Add custom attributes:
    - `custom:role` = `ADMIN`
    - `custom:plan` = `PREMIUM`
11. Create corresponding DynamoDB item via AWS CLI:

```bash
aws dynamodb put-item \
  --table-name voces-dev-main \
  --item '{
    "PK": {"S": "USER#<sub-from-cognito>"},
    "SK": {"S": "USER#<sub-from-cognito>"},
    "GSI1PK": {"S": "USEREMAIL#admin@vocesdelaextincion.com"},
    "GSI1SK": {"S": "USER#<sub-from-cognito>"},
    "email": {"S": "admin@vocesdelaextincion.com"},
    "plan": {"S": "PREMIUM"},
    "role": {"S": "ADMIN"},
    "createdAt": {"S": "2025-01-15T10:00:00.000Z"},
    "updatedAt": {"S": "2025-01-15T10:00:00.000Z"},
    "entity": {"S": "USER"}
  }'
```

**Option B: Via Seeding Script (Recommended for repeatability)**

Create a script in `aws/scripts/seed-admin.ts`:

```typescript
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const cognitoClient = new CognitoIdentityProviderClient({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const userPoolId = process.env.USER_POOL_ID!;
const tableName = process.env.TABLE_NAME!;
const adminEmail = "admin@vocesdelaextincion.com";

// 1. Create user in Cognito
const createResult = await cognitoClient.send(
  new AdminCreateUserCommand({
    UserPoolId: userPoolId,
    Username: adminEmail,
    UserAttributes: [
      { Name: "email", Value: adminEmail },
      { Name: "email_verified", Value: "true" },
      { Name: "custom:role", Value: "ADMIN" },
      { Name: "custom:plan", Value: "PREMIUM" },
    ],
    MessageAction: "SUPPRESS", // Don't send welcome email
  }),
);

const sub = createResult.User?.Attributes?.find(
  (attr) => attr.Name === "sub",
)?.Value!;

// 2. Create user in DynamoDB
await docClient.send(
  new PutCommand({
    TableName: tableName,
    Item: {
      PK: `USER#${sub}`,
      SK: `USER#${sub}`,
      GSI1PK: `USEREMAIL#${adminEmail}`,
      GSI1SK: `USER#${sub}`,
      email: adminEmail,
      plan: "PREMIUM",
      role: "ADMIN",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entity: "USER",
    },
  }),
);

console.log(`Admin user created: ${adminEmail} (sub: ${sub})`);
```

Run the script:

```bash
cd aws/scripts
USER_POOL_ID=<pool-id> TABLE_NAME=voces-dev-main npx ts-node seed-admin.ts
```

### 15. Upload Initial Free Recordings

**Where**: Manual upload via admin panel (after it's built) or script

The 10 free recordings that non-premium users can access need to be uploaded and marked with `isFree: true`.

**Steps**:

1. Prepare 10 audio files (MP3, WAV, etc.)
2. Use the admin account to upload via `POST /recordings` with `isFree: true`
3. Or use a seeding script that uploads to S3 and creates DynamoDB items

**Note**: This step happens **after** the API is deployed and functional. It's not a prerequisite for deployment.

### Seeding Checklist

- [ ] First admin user created in Cognito
- [ ] First admin user created in DynamoDB (with matching `sub`)
- [ ] Admin user can log in via `POST /auth/login`
- [ ] (Optional) Initial free recordings uploaded
- [ ] Tags will be created by users via `POST /tags` as needed

---

## Complete Checklist (Ordered)

### Before first deploy

- [ ] AWS account active with billing
- [ ] Primary region chosen (`us-east-1`)
- [ ] Root account MFA enabled
- [ ] IAM user/profile created for local dev
- [ ] AWS CLI installed and configured
- [ ] Node.js 20.x installed
- [ ] CDK CLI installed
- [ ] `cdk bootstrap` run
- [ ] GitHub OIDC provider created in IAM
- [ ] GitHub Actions IAM role created (dev)
- [ ] GitHub Actions IAM role created (prod)
- [ ] GitHub repo variables set (`AWS_ACCOUNT_ID`, `AWS_REGION`)
- [ ] GitHub repo secret set (`AWS_ROLE_ARN_DEV`)
- [ ] GitHub `production` environment created with reviewer gate
- [ ] GitHub `production` secret set (`AWS_ROLE_ARN_PROD`)

### Before prod deploy (start early, can overlap with dev work)

- [ ] SES production access requested
- [ ] SES email identity verified (dev)
- [ ] SES domain identity created (prod)
- [ ] DNS records added for DKIM (3 CNAMEs)
- [ ] DNS record added for SPF (TXT)
- [ ] DNS record added for DMARC (TXT)
- [ ] ACM certificate requested for `api.vocesdelaextincion.com`
- [ ] DNS record added for ACM validation (CNAME)
- [ ] ACM certificate issued

### After first prod deploy

- [ ] DNS record added for custom API domain (CNAME → API Gateway)
- [ ] Budget alerts configured
- [ ] GitHub Actions IAM roles scoped down
- [ ] CloudTrail enabled
