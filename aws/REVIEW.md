# Infrastructure Review — Parts 4–8

Reviewed files: all 6 CDK stacks, `bin/app.ts`, `cdk.json`, all 7 Lambda handlers, `shared/response.ts`.

---

## Bugs

### 1. S3 CORS missing PUT method
**File:** [storage-stack.ts](infra/lib/stacks/storage-stack.ts#L58-L67)

`allowedMethods` is `[GET, HEAD]` only. If the frontend uploads recordings directly to S3 via presigned PUT URLs (which is the intended design per `api-stack.ts` comments: "PutObject (upload)"), the browser will be blocked by CORS preflight. S3 CORS needs `PUT` in `allowedMethods`.

### 2. SES ConfigurationSet is never associated with the identity
**File:** [email-stack.ts](infra/lib/stacks/email-stack.ts#L38-L44)

The `CfnConfigurationSet` is created in prod but never linked to the `CfnEmailIdentity`. Without setting `configurationSetAttributes: { configurationSetName: 'voces-prod-email' }` on the identity, the configuration set exists in SES but no emails flow through it. Bounce/complaint suppression and reputation metrics won't work.

### 3. No CDK-enforced dependency between EmailStack and AuthStack
**File:** [bin/app.ts](infra/bin/app.ts#L48-L65)

The comment says "EmailStack must come before AuthStack" but `authStack` doesn't receive any CDK token from `emailStack` — it only receives primitive strings from `cdk.json` context. CDK has no explicit dependency and CloudFormation may deploy the two stacks in parallel. If Cognito validates the SES identity at deploy time, deploying auth before email could fail. Needs `authStack.addDependency(emailStack)` or a token reference.

### 4. `customMessageFn` missing log retention
**File:** [auth-stack.ts](infra/lib/stacks/auth-stack.ts#L29-L70)

The Cognito Custom Message Lambda is created without a `logRetention` prop. All 6 API Lambdas set `logRetention` explicitly. The Cognito trigger Lambda's CloudWatch log group will grow indefinitely with no expiration.

### 5. `emailStack.sesIdentityArn` is exposed but never consumed
**File:** [email-stack.ts](infra/lib/stacks/email-stack.ts#L14), [bin/app.ts](infra/bin/app.ts)

`EmailStack` computes and exports `sesIdentityArn` as a public property and as a CloudFormation output. No other stack reads it. The SES identity ARN is only needed if you want to scope an IAM grant to that specific identity (e.g., `ses:SendEmail` on that resource). CDK's `UserPoolEmail.withSES()` handles its own IAM internally, so this may be intentional, but the property is dead weight as-is.

### 6. API Gateway HTTP API access logging grant may be ineffective
**File:** [api-stack.ts](infra/lib/stacks/api-stack.ts#L299)

`accessLogGroup.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'))` adds a CloudWatch log group resource policy. For HTTP API (v2) access logging, AWS actually relies on the account-level API Gateway CloudWatch Logs role (set once per account/region via the REST API account settings), not a log group resource policy. The grant is likely a no-op. The correct fix is either setting `@aws-cdk/aws-apigateway:disableCloudWatchRole: false` in `cdk.json` (already `true`, which is correct to avoid conflicts) or using the account-level role — but for HTTP APIs specifically, access logging works without a special role, so the grant may simply be unnecessary rather than broken. Needs verification after first deploy.

---

## Inconsistencies

### 7. CORS origins list is duplicated
**Files:** [storage-stack.ts](infra/lib/stacks/storage-stack.ts#L19-L21), [api-stack.ts](infra/lib/stacks/api-stack.ts#L40-L43)

Both stacks independently define `corsOrigins` with the same two dev (`localhost:3000`, `localhost:5173`) and two prod (`vocesdelaextincion.com`, `www.vocesdelaextincion.com`) values. If the domain changes, it must be updated in two places.

### 8. Environment variable naming is inconsistent
**File:** [api-stack.ts](infra/lib/stacks/api-stack.ts#L69-L73)

DynamoDB table name is `TABLE_NAME` (no service prefix). S3 bucket name is `S3_BUCKET_NAME` (has service prefix). Should either both be plain (`TABLE_NAME`, `BUCKET_NAME`) or both prefixed (`DYNAMO_TABLE_NAME`, `S3_BUCKET_NAME`).

### 9. `userVerification` email config is redundant
**File:** [auth-stack.ts](infra/lib/stacks/auth-stack.ts#L107-L111)

`userVerification.emailSubject` and `emailBody` are set but the `customMessage` Lambda trigger overrides these for every relevant trigger source (`CustomMessage_SignUp`, `CustomMessage_ResendCode`). The `userVerification` values are never used when a custom message Lambda is present.

### 10. Stack dependency comment is misleading
**File:** [bin/app.ts](infra/bin/app.ts#L48-L49)

`// EmailStack must come before AuthStack — AuthStack needs SES configured before Cognito can be told to route emails through it.` — the real reason is that SES must be manually verified before the user pool sends emails. This is an operational/runtime constraint, not a CDK synthesis or deployment dependency. The comment implies CDK enforces the order, which it doesn't (see bug #3).

### 11. `users` Lambda has no path to equality with `auth/me`
**File:** [api-stack.ts](infra/lib/stacks/api-stack.ts#L104-L110), [users/handler.ts](../lambdas/users/handler.ts)

`/users/me` is described as a "deprecated alias for /auth/me". The `usersFn` gets `TABLE_NAME` and DynamoDB read access, but no Cognito access. The `authFn` reads user data from both Cognito (`GetUser`) and DynamoDB. If the two routes should return identical responses, `usersFn` will need Cognito access too — or the route should forward to the same Lambda integration instead of a separate function.

---

## Style / Minor

### 12. Lambda stubs don't set `Content-Type` header
**Files:** all handlers under [lambdas/](../lambdas/)

The 501 stub responses return `JSON.stringify({ error: 'Not implemented' })` without a `Content-Type: application/json` header. The `shared/response.ts` helpers always set this header. When the stubs are replaced with real implementations, they should use the shared helpers consistently.

### 13. `esbuild` version range vs exact pin
**Files:** [infra/package.json](infra/package.json#L26), [lambdas/package.json](../lambdas/package.json#L29)

Both list `"esbuild": "^0.28.0"`. CDK 2.175.0 was verified to work with exactly 0.28.0 during the session. The caret allows patch-level upgrades (0.28.x), which should be safe, but if CDK does peer-version checks it could warn. Pinning to `"0.28.0"` (exact) is more defensive.

### 14. `as const` on `commonFnProps` narrows types broadly
**File:** [api-stack.ts](infra/lib/stacks/api-stack.ts#L54-L73)

`as const` makes all values readonly literal types. The spread `...commonFnProps.environment` works because the individual function override merges a new object. This compiled successfully (`synth` passes), but the `as const` is overly aggressive — `satisfies` or explicit typing would be cleaner and less surprising.

### 15. `PRESIGNED_URL_TTL_*` are strings, not numbers
**File:** [api-stack.ts](infra/lib/stacks/api-stack.ts#L122-L123)

`PRESIGNED_URL_TTL_FREE: '900'` and `PRESIGNED_URL_TTL_PREMIUM: '3600'` — environment variables are always strings, so this is correct. Just a reminder that the Lambda code will need `parseInt(process.env.PRESIGNED_URL_TTL_FREE, 10)`.

### 16. `noContent()` in `shared/response.ts` has no body field
**File:** [shared/response.ts](../lambdas/shared/response.ts#L19-L21)

`{ statusCode: 204 }` with no `body` key is technically valid for 204, but API Gateway v2 may or may not require an empty string body. Worth testing at integration time.
