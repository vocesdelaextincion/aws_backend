# Part 6: API Gateway

## Goal

Create a fully managed API layer using AWS API Gateway HTTP API that acts as the single entry point for all client requests. It replaces the Express.js router, handles CORS, authorization, throttling, request routing, and presents the backend as a clean, versioned REST API.

---

## Current State (Legacy)

### How routing works today

Express.js acts as both the HTTP server and the router:

```
Client → Express (port 3001)
  ├── cors() middleware
  ├── express.json() middleware
  ├── app.use('/auth', authRoutes)
  ├── app.use('/users', userRoutes)
  ├── app.use('/recordings', recordingRoutes)
  ├── app.use('/admin', adminRoutes)
  ├── app.use('/tags', tagRoutes)
  └── app.use('/metrics', metricsRoutes)
```

Each route file defines sub-routes and chains middleware (validators, `protect`, `admin`) before the controller.

### What Express handles that API Gateway will replace

| Concern                    | Express                                       | API Gateway                        |
| -------------------------- | --------------------------------------------- | ---------------------------------- |
| HTTP listener              | `app.listen(3001)`                            | Managed endpoint                   |
| Routing                    | `router.get('/path', handler)`                | Route definitions                  |
| CORS                       | `cors()` middleware                           | Built-in CORS config               |
| Auth check                 | `protect` middleware (JWT verify + DB lookup) | Cognito JWT Authorizer (zero-code) |
| JSON parsing               | `express.json()`                              | Automatic (event body)             |
| Error responses (401, 403) | Custom middleware                             | Gateway default responses          |

---

## Target State

### Why API Gateway HTTP API (not REST API)

| Feature                | HTTP API                               | REST API                          |
| ---------------------- | -------------------------------------- | --------------------------------- |
| Cost                   | $1.00 / million requests               | $3.50 / million requests          |
| Latency                | Lower                                  | Higher                            |
| JWT authorizer         | Native (Cognito, any OIDC)             | Requires custom Lambda authorizer |
| Request validation     | No (validate in Lambda)                | Yes (JSON Schema)                 |
| WAF integration        | No (add CloudFront in front if needed) | Yes                               |
| Usage plans / API keys | No                                     | Yes                               |
| Caching                | No                                     | Yes                               |

**Verdict**: HTTP API is the right choice. It's cheaper, faster, and the native JWT authorizer is exactly what we need for Cognito. We don't need REST API features like caching or WAF at the gateway level.

---

## API Design

### Base URL

```
Dev:  https://{api-id}.execute-api.{region}.amazonaws.com
Prod: https://api.vocesdelaextincion.com  (custom domain)
```

### Full Route Table

| Method   | Route                          | Lambda Target            | Authorizer  | Notes                                        |
| -------- | ------------------------------ | ------------------------ | ----------- | -------------------------------------------- |
| `POST`   | `/auth/register`               | `voces-{env}-auth`       | None        | Public                                       |
| `POST`   | `/auth/login`                  | `voces-{env}-auth`       | None        | Public                                       |
| `POST`   | `/auth/verify-email/{token}`   | `voces-{env}-auth`       | None        | Public                                       |
| `POST`   | `/auth/forgot-password`        | `voces-{env}-auth`       | None        | Public                                       |
| `POST`   | `/auth/reset-password/{token}` | `voces-{env}-auth`       | None        | Public                                       |
| `GET`    | `/auth/me`                     | `voces-{env}-auth`       | Cognito JWT | Protected                                    |
| `GET`    | `/users/me`                    | `voces-{env}-users`      | Cognito JWT | Protected                                    |
| `GET`    | `/recordings`                  | `voces-{env}-recordings` | Cognito JWT | Protected                                    |
| `POST`   | `/recordings`                  | `voces-{env}-recordings` | Cognito JWT | Protected (admin enforced in Lambda)         |
| `GET`    | `/recordings/{id}`             | `voces-{env}-recordings` | Cognito JWT | Protected                                    |
| `POST`   | `/recordings/download`         | `voces-{env}-recordings` | Cognito JWT | Protected (plan-based access in Lambda)      |
| `POST`   | `/recordings/download-all`     | `voces-{env}-recordings` | Cognito JWT | Protected (PREMIUM only, enforced in Lambda) |
| `PUT`    | `/recordings/{id}`             | `voces-{env}-recordings` | Cognito JWT | Protected (admin enforced in Lambda)         |
| `DELETE` | `/recordings/{id}`             | `voces-{env}-recordings` | Cognito JWT | Protected (admin enforced in Lambda)         |
| `GET`    | `/tags`                        | `voces-{env}-tags`       | Cognito JWT | Protected (admin enforced in Lambda)         |
| `POST`   | `/tags`                        | `voces-{env}-tags`       | Cognito JWT | Protected (admin enforced in Lambda)         |
| `GET`    | `/tags/{id}`                   | `voces-{env}-tags`       | Cognito JWT | Protected (admin enforced in Lambda)         |
| `PUT`    | `/tags/{id}`                   | `voces-{env}-tags`       | Cognito JWT | Protected (admin enforced in Lambda)         |
| `DELETE` | `/tags/{id}`                   | `voces-{env}-tags`       | Cognito JWT | Protected (admin enforced in Lambda)         |
| `GET`    | `/admin/users`                 | `voces-{env}-admin`      | Cognito JWT | Protected (admin enforced in Lambda)         |
| `GET`    | `/admin/users/{id}`            | `voces-{env}-admin`      | Cognito JWT | Protected (admin enforced in Lambda)         |
| `PUT`    | `/admin/users/{id}`            | `voces-{env}-admin`      | Cognito JWT | Protected (admin enforced in Lambda)         |
| `DELETE` | `/admin/users/{id}`            | `voces-{env}-admin`      | Cognito JWT | Protected (admin enforced in Lambda)         |
| `GET`    | `/metrics`                     | `voces-{env}-metrics`    | None        | Public                                       |

**Total: 24 routes → 6 Lambda targets.**

### Authorization Strategy (Two Layers)

1. **API Gateway layer** (Cognito JWT Authorizer): Validates the token is present and valid. Rejects unauthenticated requests with `401` before they reach Lambda. Applied to all protected routes.
2. **Lambda layer** (role check): For admin-only operations, the Lambda inspects the `custom:role` claim from the decoded token and returns `403` if the user is not an admin.

This two-layer approach means:

- Invalid/missing tokens never reach Lambda (saves cost and compute)
- Role-based authorization stays flexible in application code

---

## CDK Stack Design

The `api-gateway-stack.ts` will create:

### 1. HTTP API

```typescript
const api = new HttpApi(this, "VocesApi", {
  apiName: `voces-${env}-api`,
  corsPreflight: {
    allowOrigins: corsOrigins, // env-specific
    allowMethods: [
      CorsHttpMethod.GET,
      CorsHttpMethod.POST,
      CorsHttpMethod.PUT,
      CorsHttpMethod.DELETE,
    ],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: Duration.hours(24),
  },
  disableExecuteApiEndpoint: isProd, // Use custom domain only in prod
});
```

### 2. Cognito JWT Authorizer

```typescript
const authorizer = new HttpJwtAuthorizer("CognitoAuthorizer", issuerUrl, {
  jwtAudience: [userPoolClientId],
  identitySource: "$request.header.Authorization",
});
```

The authorizer:

1. Extracts the `Bearer` token from the `Authorization` header
2. Validates the JWT signature against Cognito's JWKS endpoint
3. Checks token expiration
4. Passes decoded claims to Lambda via `event.requestContext.authorizer.jwt.claims`

No Lambda invocation, no database query — pure gateway-level validation.

### 3. Route Definitions

Each route maps a method + path to a Lambda integration with or without the authorizer:

```typescript
// Public route example
api.addRoutes({
  path: "/auth/register",
  methods: [HttpMethod.POST],
  integration: authIntegration,
});

// Protected route example
api.addRoutes({
  path: "/recordings",
  methods: [HttpMethod.GET],
  integration: recordingsIntegration,
  authorizer: cognitoAuthorizer,
});
```

### 4. Lambda Integrations

Each Lambda function gets an `HttpLambdaIntegration`:

```typescript
const authIntegration = new HttpLambdaIntegration(
  "AuthIntegration",
  authFunction,
);
const recordingsIntegration = new HttpLambdaIntegration(
  "RecordingsIntegration",
  recordingsFunction,
);
// ... etc
```

API Gateway uses **payload format version 2.0** by default with HTTP APIs, which provides a cleaner event structure than v1.0.

### 5. Stage Configuration

```typescript
const stage = new HttpStage(this, "DefaultStage", {
  httpApi: api,
  stageName: "$default",
  autoDeploy: true,
  throttle: {
    burstLimit: isProd ? 1000 : 100,
    rateLimit: isProd ? 500 : 50,
  },
});
```

### Stack Outputs

- `ApiEndpoint` — The base URL of the API
- `ApiId` — The API Gateway ID

---

## CORS Configuration

### Why CORS matters

The frontend (SPA) runs on a different domain than the API. Browsers enforce CORS and will block requests unless the API responds with proper headers.

### Configuration per environment

| Parameter     | Dev                                              | Prod                                                                   |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| Allow Origins | `http://localhost:3000`, `http://localhost:5173` | `https://vocesdelaextincion.com`, `https://www.vocesdelaextincion.com` |
| Allow Methods | GET, POST, PUT, DELETE                           | GET, POST, PUT, DELETE                                                 |
| Allow Headers | Content-Type, Authorization                      | Content-Type, Authorization                                            |
| Max Age       | 24 hours                                         | 24 hours                                                               |

API Gateway HTTP API handles preflight `OPTIONS` requests automatically — no need to define OPTIONS routes or handle them in Lambda.

---

## Custom Domain (Production)

### Setup

1. **ACM Certificate**: Request a certificate for `api.vocesdelaextincion.com` in the same region as the API.
2. **API Gateway Domain Name**: Map the custom domain to the HTTP API.
3. **DNS Record**: Create a Route 53 (or external DNS) CNAME/alias pointing to the API Gateway domain.

### CDK

```typescript
const domainName = new DomainName(this, "ApiDomain", {
  domainName: "api.vocesdelaextincion.com",
  certificate: certificate,
});

new ApiMapping(this, "ApiMapping", {
  api: httpApi,
  domainName: domainName,
});
```

### API Versioning (Future)

If API versioning is needed later, it can be done via:

- **Path prefix**: `/v1/recordings`, `/v2/recordings`
- **Stage**: `v1.api.vocesdelaextincion.com`
- **Header**: `X-API-Version: 2`

Not needed for the initial migration — the current API is v1 implicitly.

---

## Throttling and Rate Limiting

### Default Throttling (Stage Level)

| Environment | Burst Limit  | Rate Limit  |
| ----------- | ------------ | ----------- |
| Dev         | 100 req/sec  | 50 req/sec  |
| Prod        | 1000 req/sec | 500 req/sec |

### Per-Route Throttling (Future)

Sensitive endpoints can have tighter limits:

| Route                        | Burst | Rate | Reason                    |
| ---------------------------- | ----- | ---- | ------------------------- |
| `POST /auth/register`        | 10    | 5    | Prevent registration spam |
| `POST /auth/login`           | 20    | 10   | Prevent brute force       |
| `POST /auth/forgot-password` | 5     | 2    | Prevent email spam        |

Per-route throttling requires REST API or a Lambda-based rate limiter. For HTTP API, stage-level throttling is the starting point. Per-route can be added later if needed.

---

## Request/Response Flow

### Complete request lifecycle

```
1. Client sends HTTP request
   → https://api.vocesdelaextincion.com/recordings?page=1&limit=10
   → Headers: Authorization: Bearer <cognito-access-token>

2. API Gateway receives request
   → Matches route: GET /recordings
   → CORS check: Origin allowed? Yes → add CORS headers

3. Cognito JWT Authorizer
   → Extract token from Authorization header
   → Fetch JWKS from Cognito (cached)
   → Validate signature, expiration, audience
   → If invalid → 401 response (never reaches Lambda)
   → If valid → decode claims, attach to event

4. Lambda Integration
   → Invoke voces-{env}-recordings Lambda
   → Pass event (payload format v2.0):
     {
       requestContext: {
         http: { method: "GET", path: "/recordings" },
         authorizer: { jwt: { claims: { sub: "user-id", email: "...", "custom:role": "USER" } } }
       },
       queryStringParameters: { page: "1", limit: "10" },
       headers: { ... }
     }

5. Lambda processes request
   → Internal routing: GET /recordings → getRecordings()
   → Query RDS via Prisma
   → Return response object

6. API Gateway returns response
   → Add CORS headers
   → Forward Lambda response to client
   → { statusCode: 200, body: "{ data: [...], pagination: {...} }" }
```

### Payload Format v2.0 Event Structure

```typescript
interface APIGatewayProxyEventV2 {
  version: "2.0";
  routeKey: "GET /recordings";
  rawPath: "/recordings";
  rawQueryString: "page=1&limit=10";
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  pathParameters?: Record<string, string>; // e.g., { id: 'abc123' }
  body?: string;
  isBase64Encoded: boolean;
  requestContext: {
    http: { method: string; path: string; sourceIp: string };
    authorizer?: {
      jwt: {
        claims: Record<string, string>;
        scopes: string[];
      };
    };
    requestId: string;
    time: string;
  };
}
```

---

## Access Logging

### Configuration

Enable access logging to CloudWatch:

```
Log Group: /aws/apigateway/voces-{env}-api
Format (JSON):
{
  "requestId": "$context.requestId",
  "ip": "$context.identity.sourceIp",
  "method": "$context.httpMethod",
  "path": "$context.path",
  "status": "$context.status",
  "latency": "$context.responseLatency",
  "userAgent": "$context.identity.userAgent",
  "integrationLatency": "$context.integrationLatency",
  "authorizerError": "$context.authorizer.error"
}
```

### Log Retention

| Environment | Retention |
| ----------- | --------- |
| Dev         | 14 days   |
| Prod        | 90 days   |

---

## Error Responses

### Gateway-Level Errors

API Gateway returns these before Lambda is invoked:

| Status | When                                        | Response Body                        |
| ------ | ------------------------------------------- | ------------------------------------ |
| `401`  | Missing or invalid token on protected route | `{ "message": "Unauthorized" }`      |
| `403`  | Token valid but insufficient scopes         | `{ "message": "Forbidden" }`         |
| `404`  | No matching route                           | `{ "message": "Not Found" }`         |
| `429`  | Throttle limit exceeded                     | `{ "message": "Too Many Requests" }` |

### Gateway Response Customization

Default API Gateway error messages can be customized to match the legacy API's response format:

```typescript
// Ensure error responses match { "message": "..." } format
// HTTP API uses default responses; customize via Lambda@Edge or response mapping if needed
```

For HTTP API, the default error format is already `{ "message": "..." }` which matches our legacy format.

---

## Payload Size Limits

| Limit            | Value            | Impact                                  |
| ---------------- | ---------------- | --------------------------------------- |
| Request payload  | 10 MB            | Affects file uploads via multipart form |
| Response payload | 10 MB            | Unlikely to hit for JSON responses      |
| Header size      | 10 KB            | Standard                                |
| URL length       | 10 KB            | Standard                                |
| Timeout          | 30 seconds (max) | Matches Lambda timeout                  |

### File Upload Consideration

The legacy API uploads files through the server (multer → buffer → S3). With the 10MB API Gateway limit:

- Files under 10MB: Work as-is through API Gateway → Lambda → S3
- Files over 10MB: Require presigned URL pattern (client uploads directly to S3)

The presigned URL pattern is documented as a future improvement in Part 4 (Storage).

---

## Monitoring

### CloudWatch Metrics (Automatic)

API Gateway automatically publishes:

| Metric               | Description          |
| -------------------- | -------------------- |
| `Count`              | Total API requests   |
| `4XXError`           | Client error count   |
| `5XXError`           | Server error count   |
| `Latency`            | End-to-end latency   |
| `IntegrationLatency` | Time spent in Lambda |

### Alarms (Prod)

| Alarm         | Condition                        | Action           |
| ------------- | -------------------------------- | ---------------- |
| High 5XX rate | > 10 in 5 minutes                | SNS notification |
| High latency  | p99 > 5 seconds                  | SNS notification |
| Throttling    | > 0 `429` responses in 5 minutes | SNS notification |

---

## Environment-Specific Configuration

| Parameter            | Dev                        | Prod                               |
| -------------------- | -------------------------- | ---------------------------------- |
| Custom domain        | No (use execute-api URL)   | Yes (`api.vocesdelaextincion.com`) |
| CORS origins         | `localhost:*`              | Production frontend domain(s)      |
| Burst limit          | 100 req/sec                | 1000 req/sec                       |
| Rate limit           | 50 req/sec                 | 500 req/sec                        |
| Access logging       | Enabled (14-day retention) | Enabled (90-day retention)         |
| Execute API endpoint | Enabled                    | Disabled (custom domain only)      |

---

## Risks and Mitigations

| Risk                                         | Mitigation                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| 10MB payload limit blocks large file uploads | Implement presigned URL pattern for large files (future)                         |
| JWT authorizer doesn't check admin role      | Admin check in Lambda; gateway only validates token presence/validity            |
| No per-route throttling in HTTP API          | Stage-level throttling sufficient initially; add CloudFront + WAF if needed      |
| Custom domain requires ACM certificate       | Request cert early; DNS validation is straightforward                            |
| Cold start latency visible in API metrics    | Distinguish integration latency from gateway latency in dashboards               |
| CORS misconfiguration blocks frontend        | Test CORS in dev with actual frontend; API Gateway handles OPTIONS automatically |

---

## Definition of Done

- [ ] HTTP API created via CDK with all 22 routes mapped
- [ ] Cognito JWT Authorizer attached to all protected routes
- [ ] Public routes accessible without token
- [ ] Protected routes return `401` without valid token
- [ ] CORS preflight works for frontend origins
- [ ] Access logging enabled and writing to CloudWatch
- [ ] Throttling configured at stage level
- [ ] Custom domain configured (prod only)
- [ ] Gateway error responses match legacy `{ "message": "..." }` format
- [ ] All routes forward correct path parameters and query strings to Lambda
- [ ] Payload format v2.0 events received correctly by Lambda functions
