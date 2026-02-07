# Part 5: Email — AWS SES

## Goal

Replace Gmail OAuth 2.0 (Nodemailer) with AWS Simple Email Service (SES) for all transactional emails: verification codes, password reset codes, and any future notifications.

---

## Current State (Legacy)

### How email works today

- **Service**: Gmail via Nodemailer with OAuth 2.0
- **Credentials**: `EMAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `EMAIL_FROM`
- **Email types**:
  1. **Verification email**: Sent on registration, contains a clickable link with a 32-byte hex token
  2. **Password reset email**: Sent on forgot-password, contains a clickable link with a 32-byte hex token
- **Format**: Both plain text and HTML versions
- **Sender**: `Voces de la Extinción <email@gmail.com>`

### Legacy email utility (`src/utils/email.ts`)

```typescript
sendEmail({ to, subject, text, html }) → void
// Creates a Nodemailer transporter with Gmail OAuth 2.0
// Sends via transporter.sendMail()
```

### Pain points

- Gmail OAuth tokens expire and need manual refresh
- Gmail has sending limits (500/day for regular accounts)
- Depends on Google Cloud (violates AWS-only principle)
- OAuth 2.0 setup is complex and fragile

---

## Target State

| Aspect | Decision |
|---|---|
| Service | AWS SES |
| Integration | Cognito uses SES for verification/reset emails; Lambda uses SES SDK for custom emails |
| Sender identity | Verified domain (e.g., `vocesdelaextincion.com`) or verified email address |
| Templates | SES email templates for consistent branding |
| Region | Same as primary region (`us-east-1`) |

### Two email paths

1. **Cognito-managed emails**: Verification codes and password reset codes are sent automatically by Cognito through SES. No Lambda code needed.
2. **Custom emails (future)**: Any additional transactional emails (welcome, notifications) sent via Lambda using the SES SDK.

---

## CDK Stack Design

The `email-stack.ts` will create:

### 1. SES Email Identity

**Option A: Domain identity (recommended for production)**
- Verify the domain `vocesdelaextincion.com` (or whatever domain is used)
- Requires adding DNS records (DKIM, SPF, DMARC)
- Allows sending from any address `@vocesdelaextincion.com`

**Option B: Email address identity (simpler for dev)**
- Verify a single email address (e.g., `noreply@vocesdelaextincion.com`)
- Only requires clicking a verification link sent to that address
- Good enough for development

**Recommendation**: Use email address identity for dev, domain identity for prod.

### 2. SES Configuration Set (Optional)

- Track delivery, bounces, complaints
- Send events to CloudWatch or SNS
- Useful for monitoring email health in production

### 3. Cognito SES Integration

Configure the Cognito User Pool (from Part 3) to use SES instead of Cognito's default email:

```
User Pool → Email configuration:
  - Email sending account: SES
  - FROM address: noreply@vocesdelaextincion.com
  - Reply-to: support@vocesdelaextincion.com
  - SES verified identity ARN: arn:aws:ses:...
```

This removes the 50 emails/day limit of Cognito's default email sender.

### 4. SES Email Templates

Create templates for consistent branding:

| Template | Used By | Content |
|---|---|---|
| `voces-verification` | Cognito (custom message Lambda trigger) | Verification code with branding |
| `voces-password-reset` | Cognito (custom message Lambda trigger) | Password reset code with branding |
| `voces-welcome` | Custom Lambda (future) | Welcome email after verification |

### Stack Outputs

- `SesIdentityArn`
- `SesConfigurationSetName` (if created)

---

## SES Sandbox vs Production

### Sandbox mode (default)

When you first set up SES, it's in **sandbox mode**:
- Can only send to **verified** email addresses
- Limited to 200 emails/day, 1 email/second
- Good enough for development and testing

### Production access

To send to any email address, you must **request production access**:
1. Go to AWS SES console → Account dashboard → Request production access
2. Provide:
   - Website URL
   - Use case description ("Transactional emails for user verification and password reset")
   - Expected sending volume
3. AWS reviews and approves (usually within 24 hours)

**Timing**: Request production access early in the migration process. It's a manual step that takes time.

---

## Cognito Custom Message Lambda Trigger

To customize the email content that Cognito sends (instead of the default plain text), use a **Custom Message Lambda Trigger**:

### How it works

1. Cognito is about to send a verification or reset email.
2. It invokes the Custom Message Lambda with the event type and code.
3. The Lambda returns customized email subject and body (HTML).
4. Cognito sends the customized email via SES.

### Event types handled

| Event | Trigger Source | Use |
|---|---|---|
| Sign-up verification | `CustomMessage_SignUp` | Branded verification code email |
| Forgot password | `CustomMessage_ForgotPassword` | Branded password reset code email |
| Resend code | `CustomMessage_ResendCode` | Branded resend verification email |
| Admin create user | `CustomMessage_AdminCreateUser` | Welcome email for admin-created users |

### Example Lambda response

```typescript
// The Lambda receives the code in event.request.codeParameter
// and returns customized email content
event.response.emailSubject = 'Voces de la Extinción — Verify Your Email';
event.response.emailMessage = `
  <h1>Welcome to Voces de la Extinción!</h1>
  <p>Your verification code is: <strong>${event.request.codeParameter}</strong></p>
  <p>This code expires in 1 hour.</p>
`;
return event;
```

---

## Custom Email Utility for Lambda (Future)

For any emails not handled by Cognito (e.g., welcome emails, notifications), a shared utility:

```typescript
// aws/lambdas/shared/email.ts
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const sesClient = new SESv2Client({});
// No credentials needed — uses Lambda execution role

async function sendEmail({ to, subject, html, text }) {
  await sesClient.send(new SendEmailCommand({
    FromEmailAddress: process.env.EMAIL_FROM,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject },
        Body: {
          Html: { Data: html },
          Text: { Data: text },
        },
      },
    },
  }));
}
```

### IAM Policy for Lambda

```json
{
  "Effect": "Allow",
  "Action": ["ses:SendEmail", "ses:SendTemplatedEmail"],
  "Resource": "arn:aws:ses:{region}:{account}:identity/*"
}
```

---

## DNS Records Required (Production)

For domain verification and email deliverability:

| Record Type | Name | Value | Purpose |
|---|---|---|---|
| CNAME (x3) | `{token}._domainkey.vocesdelaextincion.com` | `{token}.dkim.amazonses.com` | DKIM signing |
| TXT | `_dmarc.vocesdelaextincion.com` | `v=DMARC1; p=quarantine; rua=mailto:...` | DMARC policy |
| TXT | `vocesdelaextincion.com` | `v=spf1 include:amazonses.com ~all` | SPF record |
| MX | `mail.vocesdelaextincion.com` | `10 feedback-smtp.us-east-1.amazonses.com` | Bounce handling |

These are created manually in the domain's DNS provider (or via Route 53 if the domain is there).

---

## Environment-Specific Configuration

| Parameter | Dev | Prod |
|---|---|---|
| SES mode | Sandbox | Production |
| Identity type | Email address | Domain |
| Cognito email source | SES verified email | SES verified domain |
| Configuration set | None | Enabled (with CloudWatch events) |
| Custom message Lambda | Yes (for branding) | Yes (for branding) |
| Sending rate | 1/sec (sandbox limit) | Based on SES reputation |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| SES sandbox blocks emails to unverified addresses | Request production access early; use verified test addresses in dev |
| SES production access request denied | Provide clear use case; appeal if needed; usually approved quickly |
| Email deliverability issues (spam) | Configure DKIM, SPF, DMARC; use SES configuration set to monitor |
| Cognito default email limit (50/day) | Configure Cognito to use SES from the start |
| Custom message Lambda adds latency to auth flows | Lambda is lightweight (string templating only); cold start is minimal |

---

## Definition of Done

- [ ] SES email identity verified (email for dev, domain for prod)
- [ ] Cognito User Pool configured to send emails via SES
- [ ] Custom Message Lambda trigger deployed for branded emails
- [ ] Verification code email works end-to-end
- [ ] Password reset code email works end-to-end
- [ ] SES production access requested (for prod deployment)
- [ ] DNS records configured for domain verification (prod)
- [ ] No Gmail/Google Cloud dependencies remain
