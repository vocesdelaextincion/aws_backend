# Pre-Deployment Checklist

Items required before running `cdk deploy` for the first time.
Ordered by phase: complete Phase 1 before attempting dev, Phase 2 before prod.

---

## Phase 1 — Before Dev Deployment

### 1. Create your local `.env` file
**File:** `src/infra/.env` (gitignored — never committed)

Copy the example and fill in your values:

```bash
cp src/infra/.env.example src/infra/.env
```

Then edit `src/infra/.env`:
```
AWS_ACCOUNT_ID=123456789012
ALERT_EMAIL=your@email.com   # prod only, can leave empty for now
```

`AWS_ACCOUNT_ID` is also needed in CI — add it as a GitHub Actions variable in step 6.

---

### 2. CDK Bootstrap
**Where:** Terminal (one-time per account/region)

CDK needs a staging S3 bucket and IAM roles in your account before it can deploy anything.

```bash
cd src/infra
cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --profile <your-aws-profile>
```

Verify: CloudFormation console should show a `CDKToolkit` stack in `CREATE_COMPLETE`.

---

### 3. GitHub OIDC Identity Provider
**Where:** AWS Console → IAM → Identity providers → Add provider

Allows GitHub Actions to assume an AWS role without storing long-lived keys.

- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

Only needs to be created once per AWS account.

---

### 4. GitHub Actions IAM Role — Dev
**Where:** AWS Console → IAM → Roles → Create role

- Trusted entity: **Web identity**
- Identity provider: `token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- GitHub org: your org
- GitHub repo: `aws_backend`
- GitHub branch: the branch you deploy from (e.g. `main` or `dev/infra-groundwork`)
- Permissions: `AdministratorAccess` (scope this down after setup — see Phase 3)
- Role name: `voces-github-actions-dev`

Note the Role ARN — you'll need it in step 6.

---

### 5. GitHub Actions IAM Role — Prod
**Where:** AWS Console → IAM → Roles → Create role

Same as step 4, but:
- Role name: `voces-github-actions-prod`
- Branch: `main`

After creating, edit the trust policy to restrict to version tags only:
```json
"StringLike": {
  "token.actions.githubusercontent.com:sub": "repo:<org>/aws_backend:ref:refs/tags/v*"
}
```

Note the Role ARN — you'll need it in step 6.

---

### 6. GitHub Repository Configuration
**Where:** GitHub → Repository → Settings → Secrets and variables → Actions

**Variables** (not secrets — visible in logs):
- `AWS_ACCOUNT_ID` = your 12-digit account ID
- `AWS_REGION` = `us-east-1`

**Secrets:**
- `AWS_ROLE_ARN_DEV` = `arn:aws:iam::<ACCOUNT_ID>:role/voces-github-actions-dev`

**GitHub Environment for Production** (Settings → Environments → New environment):
- Name: `production`
- Enable "Required reviewers" — add yourself (prevents accidental prod deploys)
- Add environment secret: `AWS_ROLE_ARN_PROD` = `arn:aws:iam::<ACCOUNT_ID>:role/voces-github-actions-prod`

---

### 7. SES — Verify Dev Email Identity
**Where:** AWS Console → SES → Verified identities → Create identity

CDK creates the SES identity resource, but AWS still requires you to confirm ownership.

- Identity type: **Email address**
- Email: `noreply@vocesdelaextincion.com`
- After creating: check inbox and click the verification link

This must be done **after the first CDK deploy** (which creates the identity), then **before Cognito is used** (so emails can be sent for registration).

---

## Phase 2 — Before Production Deployment

Start these early — DNS propagation and SES approval can each take up to 72 hours.

### 8. SES — Request Production Access (Exit Sandbox)
**Where:** AWS Console → SES → Account dashboard → "Request production access"

Sandbox mode limits you to verified addresses only and 200 emails/day.

- Mail type: **Transactional**
- Website URL: `https://vocesdelaextincion.com`
- Description: "Transactional emails for user account verification and password reset. Under 1,000 emails/day."

Approval usually takes 24 hours.

---

### 9. SES — Verify Domain + Add DNS Records (Prod)
**Where:** AWS Console → SES → Verified identities, then your DNS provider

- Create identity, type: **Domain**, value: `vocesdelaextincion.com`

SES will provide DNS records to add. In your DNS provider:

| Type  | Name                                          | Value                                     |
|-------|-----------------------------------------------|-------------------------------------------|
| CNAME | `{token1}._domainkey.vocesdelaextincion.com`  | `{token1}.dkim.amazonses.com`             |
| CNAME | `{token2}._domainkey.vocesdelaextincion.com`  | `{token2}.dkim.amazonses.com`             |
| CNAME | `{token3}._domainkey.vocesdelaextincion.com`  | `{token3}.dkim.amazonses.com`             |
| TXT   | `vocesdelaextincion.com`                      | `v=spf1 include:amazonses.com ~all`       |
| TXT   | `_dmarc.vocesdelaextincion.com`               | `v=DMARC1; p=quarantine; rua=mailto:admin@vocesdelaextincion.com` |

---

### 10. Add `ALERT_EMAIL` as a GitHub Actions secret (prod)
**Where:** GitHub → Repository → Settings → Environments → `production` → Secrets

Add secret `ALERT_EMAIL` = the address that should receive CloudWatch alarm notifications.
Also add it to your local `src/infra/.env` for local prod synths.

---

### 11. ACM Certificate for Custom API Domain (Optional for initial prod deploy)
**Where:** AWS Console → Certificate Manager → Request certificate

Required only if you want `api.vocesdelaextincion.com` instead of the default API Gateway URL.

- Type: **Public**
- Domain: `api.vocesdelaextincion.com`
- Validation: **DNS**

Add the CNAME record ACM provides to your DNS. Wait for status: **Issued**.
Note the Certificate ARN — it will be needed in the CDK stack.

---

## Phase 3 — After First Deploy (Housekeeping)

### 12. Scope Down IAM Roles
Replace `AdministratorAccess` on both GitHub Actions roles with a minimal policy covering only what CDK needs: `cloudformation:*`, `s3:*`, `lambda:*`, `apigateway:*`, `cognito-idp:*`, `dynamodb:*`, `iam:*`, `ssm:*`, `ses:*`, `logs:*`, `sts:AssumeRole`.

### 13. Set Up Budget Alerts
**Where:** AWS Console → Billing → Budgets

- `voces-dev-monthly` — $15 budget, alert at 80%
- `voces-prod-monthly` — set to a comfortable ceiling, alert at 80%

### 14. Create First Admin User
After dev is up and lambdas are implemented, create the first user manually:
1. Cognito console → User Pools → `voces-dev-users` → Create user
2. Set `custom:role = ADMIN` and `custom:plan = PREMIUM`
3. Create matching DynamoDB item with `PK/SK = USER#<sub>`, `GSI1PK = USEREMAIL#<email>`

---

## Confirm Before Proceeding

- [ ] `src/infra/.env` created with `AWS_ACCOUNT_ID` (and `ALERT_EMAIL` for prod)
- [ ] CDK bootstrap complete
- [ ] GitHub OIDC provider created
- [ ] `voces-github-actions-dev` role created
- [ ] `voces-github-actions-prod` role created
- [ ] GitHub variables set (`AWS_ACCOUNT_ID`, `AWS_REGION`)
- [ ] GitHub secret set (`AWS_ROLE_ARN_DEV`)
- [ ] GitHub `production` environment created with reviewer gate
- [ ] GitHub environment secret set (`AWS_ROLE_ARN_PROD`)
- [ ] *(post-deploy)* SES dev email identity verified
