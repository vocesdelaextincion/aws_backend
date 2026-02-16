# Part 3: Authentication — AWS Cognito

## Goal

Replace the custom JWT + bcrypt authentication system with AWS Cognito, handling user registration, login, email verification, password reset, and role-based access control — all managed by AWS.

---

## Current State (Legacy)

### What the legacy auth does

| Feature                    | Implementation                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Registration               | Custom: bcrypt hash password, store in DB, generate verification token, send email via Gmail                                           |
| Email verification         | Custom: 32-byte hex token stored in DB, 1-hour expiry                                                                                  |
| Login                      | Custom: bcrypt compare, generate JWT (7-day expiry) with `{ id, role }` payload                                                        |
| Password reset             | Custom: 32-byte hex token stored in DB, 1-hour expiry, email via Gmail                                                                 |
| Token validation           | Custom middleware: verify JWT, query DB for user, attach to request                                                                    |
| Authorization              | Custom middleware: check `user.role === "ADMIN"`                                                                                       |
| User model fields for auth | `password`, `isVerified`, `emailVerificationToken`, `emailVerificationTokenExpires`, `passwordResetToken`, `passwordResetTokenExpires` |

### Pain points being solved

- Custom password hashing and token management = security liability
- JWT secret management = operational burden
- Email verification/reset flows = custom code that Cognito handles natively
- No token refresh mechanism in legacy

---

## Target State

### Cognito User Pool

A single Cognito User Pool replaces all custom auth logic.

| Feature               | Cognito Handling                                                           |
| --------------------- | -------------------------------------------------------------------------- |
| Registration          | `SignUp` API — Cognito hashes and stores password                          |
| Email verification    | Built-in: Cognito sends verification code/link automatically               |
| Login                 | `InitiateAuth` API — Returns ID token, access token, refresh token         |
| Password reset        | `ForgotPassword` / `ConfirmForgotPassword` APIs — Cognito sends reset code |
| Token validation      | API Gateway Cognito authorizer validates tokens automatically              |
| Token refresh         | Built-in: Cognito refresh tokens (30-day default)                          |
| Authorization (roles) | Custom attribute `custom:role` or Cognito Groups                           |

### What changes in the API contract

The **API routes and response shapes stay the same** for frontend compatibility. The Lambda handlers will translate between the existing API contract and Cognito's APIs.

| Endpoint                     | Before                | After                                                               |
| ---------------------------- | --------------------- | ------------------------------------------------------------------- |
| `POST /auth/register`        | Custom bcrypt + DB    | Lambda calls `cognito.signUp()`, also creates User item in DynamoDB |
| `POST /auth/verify-email`    | Custom token lookup   | Lambda calls `cognito.confirmSignUp()` with code from request body  |
| `POST /auth/login`           | Custom bcrypt + JWT   | Lambda calls `cognito.initiateAuth()`, returns Cognito tokens       |
| `POST /auth/forgot-password` | Custom token + email  | Lambda calls `cognito.forgotPassword()`                             |
| `POST /auth/reset-password`  | Custom token lookup   | Lambda calls `cognito.confirmForgotPassword()` with code from body  |
| `GET /auth/me`               | Custom JWT middleware | API Gateway Cognito authorizer + Lambda reads user from DynamoDB    |

---

## CDK Stack Design

The `auth-stack.ts` will create:

### 1. Cognito User Pool

- **Sign-in**: Email only (no username)
- **Password policy**: Minimum 8 characters (matching legacy), require at least one number
- **Email verification**: Required, via Cognito-managed email (or SES in prod — see Part 5)
- **Custom attributes**:
  - `custom:role` (String, **admin-only writable**) — `USER` or `ADMIN`
  - `custom:plan` (String, **admin-only writable**) — `FREE` or `PREMIUM`
  - **CRITICAL**: These attributes must NOT be included in the app client's writable attributes list. Only admins via `AdminUpdateUserAttributes` can modify them. If users can call `UpdateUserAttributes` on these, they could escalate to ADMIN or PREMIUM.
- **Account recovery**: Email-based
- **Token validity**:
  - Access token: 1 hour
  - ID token: 1 hour
  - Refresh token: 30 days

### 2. Cognito User Pool Client (App Client)

- **Auth flows**: `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`
- **No client secret** (for public client / SPA compatibility)
- **Token revocation**: Enabled
- **Prevent user existence errors**: Enabled (prevents email enumeration, matching legacy behavior)

### 3. Cognito User Pool Domain (Optional)

- For hosted UI (if ever needed for admin tools)
- Not required for API-only usage

### Stack Outputs

- `UserPoolId`
- `UserPoolClientId`
- `UserPoolArn` (for API Gateway authorizer)

---

## User Data Strategy: Dual Storage

Cognito manages **authentication** (credentials, tokens, verification). DynamoDB manages **application data** (plan, recordings, relationships).

### Why keep the User entity in DynamoDB?

- Cognito is not a general-purpose database — it's optimized for auth.
- Application queries like "count users", "list users with pagination", "get user by ID for admin panel" are better served by DynamoDB.
- The `Recording` model doesn't reference `User` currently, but it might in the future.
- Admin operations (list users, update plan/role) benefit from having a dedicated data store alongside Cognito.

### Sync Strategy

1. **On registration**: Lambda calls `cognito.signUp()` AND creates a `User` item in DynamoDB (without password fields).
2. **On login**: Lambda calls `cognito.initiateAuth()`, returns tokens. No DynamoDB write needed.
3. **On role/plan change**: Admin Lambda updates both Cognito custom attributes AND the DynamoDB User item.
4. **User ID**: Use the Cognito `sub` (UUID) as the user ID in DynamoDB (`PK = USER#<sub>`), replacing the current CUID.

### Plan Change Workflow

**How subscription plans are managed**:

This is a **non-commercial project** with no payment system. Plan changes are **admin-driven only**:

1. Admin calls `PUT /admin/users/{id}` with `{ "plan": "PREMIUM" }` in the request body
2. Admin Lambda validates the request (admin role check)
3. Admin Lambda updates Cognito: `AdminUpdateUserAttributes` to set `custom:plan = PREMIUM`
4. Admin Lambda updates DynamoDB: `UpdateItem` to set `plan = PREMIUM`
5. Both updates must succeed (use try/catch to handle partial failures)

**No automatic plan changes** from payment webhooks, subscriptions, or user self-service. If a payment system is added later, the workflow would be:

- Payment webhook → Lambda → Update Cognito + DynamoDB
- Same dual-write pattern as admin updates

### Schema Impact

Since we're building from scratch with Cognito, the User entity in DynamoDB will **not** include auth-related fields that Cognito manages. These legacy fields are excluded from the new schema:

- `password` (Cognito stores credentials)
- `emailVerificationToken` / `emailVerificationTokenExpires` (Cognito handles verification)
- `passwordResetToken` / `passwordResetTokenExpires` (Cognito handles reset)
- `isVerified` (Cognito tracks this)

The DynamoDB User item will only contain: `PK/SK` (from Cognito `sub`), `email`, `plan`, `role`, `createdAt`, `updatedAt`. See Part 2 for the full DynamoDB schema.

---

## API Gateway Authorization

### Cognito Authorizer

API Gateway can validate Cognito tokens **without invoking a Lambda**:

- **Public routes** (`/auth/register`, `/auth/login`, `/auth/verify-email`, `/auth/forgot-password`, `/auth/reset-password`, `/metrics`): No authorizer.
- **Protected routes** (`/auth/me`, `/users/me`, `/recordings/*`, `/tags/*`, `/admin/*`): Cognito JWT authorizer.

The authorizer:

1. Extracts the token from the `Authorization: Bearer <token>` header
2. Validates signature against Cognito's JWKS
3. Checks expiration
4. Passes decoded claims to the Lambda via `event.requestContext.authorizer.jwt.claims`

### Admin Authorization

For admin-only routes, the Lambda checks the `custom:role` claim from the decoded token:

```typescript
const role = event.requestContext.authorizer.jwt.claims["custom:role"];
if (role !== "ADMIN") {
  return {
    statusCode: 403,
    body: JSON.stringify({ message: "Not authorized as an admin" }),
  };
}
```

This replaces the legacy `admin` middleware.

---

## Verification Flow Changes

### Legacy

1. Register → Server generates token → Server sends email via Gmail → User clicks link with token → Server verifies token in DB

### With Cognito

1. Register → Lambda calls `cognito.signUp()` → Cognito sends verification code via email (SES) → User submits code via `POST /auth/verify-email` → Lambda calls `cognito.confirmSignUp()`

**Frontend change needed**: The verification flow changes from a link-based token to a **6-digit code**. The frontend will need to:

1. Remove the `{token}` path parameter from the verify-email route
2. Change from `POST /auth/verify-email/:token` to `POST /auth/verify-email`
3. Send the code in the request body: `{ "email": "user@example.com", "code": "123456" }`
4. Provide a code input form instead of just clicking a link

The same applies to password reset:

- Change from `POST /auth/reset-password/:token` to `POST /auth/reset-password`
- Send `{ "email": "user@example.com", "code": "123456", "newPassword": "..." }` in the request body

**Recommendation**: Use verification **codes** (simpler, no callback endpoint needed, more secure than URL tokens). This is a **breaking change** for the frontend that must be coordinated.

---

## Environment-Specific Configuration

| Parameter           | Dev                   | Prod                               |
| ------------------- | --------------------- | ---------------------------------- |
| Email sending       | Cognito default email | SES (custom domain, higher limits) |
| MFA                 | Off                   | Optional (can enable later)        |
| Advanced security   | Off                   | On (adaptive authentication)       |
| Deletion protection | Off                   | On                                 |

---

## Risks and Mitigations

| Risk                                                         | Mitigation                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Cognito email sending limits (50/day in sandbox)             | Move to SES early (Part 5); request production access                      |
| Custom attributes can't be required after pool creation      | Define all custom attributes upfront in CDK                                |
| Cognito `sub` differs from legacy CUID user IDs              | Use Cognito `sub` as new user ID in DynamoDB (`USER#<sub>`)                |
| Frontend needs to handle verification codes instead of links | Document as a known frontend change; can use links if preferred            |
| Dual storage (Cognito + DynamoDB) can get out of sync        | Registration Lambda writes to both atomically; admin updates write to both |

---

## Definition of Done

- [ ] Cognito User Pool deployed via CDK with correct configuration
- [ ] App Client created with appropriate auth flows
- [ ] API Gateway Cognito authorizer configured for protected routes
- [ ] Registration Lambda creates user in both Cognito and DynamoDB
- [ ] Login Lambda returns Cognito tokens in the existing API response format
- [ ] Email verification flow works end-to-end
- [ ] Password reset flow works end-to-end
- [ ] Admin authorization works via `custom:role` claim
- [ ] `GET /auth/me` returns user data from DynamoDB using Cognito `sub`
