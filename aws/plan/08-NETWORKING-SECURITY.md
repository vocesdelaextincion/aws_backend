# Part 8: Networking, Security & Monitoring

## Goal

Define the VPC topology, security group rules, IAM boundaries, logging, monitoring, and alerting that tie all previous parts together into a production-ready, secure system.

---

## VPC Architecture

### Why a VPC?

With DynamoDB (accessed via IAM over HTTPS, no VPC required), Lambdas **do not need to be in a VPC for database access**. However, a VPC may still be needed if Lambdas call AWS services that lack VPC endpoints and require NAT (e.g., Cognito APIs). If all AWS service calls can be handled via VPC endpoints or don't require VPC, the VPC can be simplified or eliminated entirely.

**Recommendation for dev**: Start **without a VPC** for Lambda functions. DynamoDB, S3, SES, and Cognito are all accessible over the public internet via IAM. Only add a VPC if a specific requirement demands it.

**Recommendation for prod**: Evaluate whether a VPC adds security value. For a serverless-only architecture with DynamoDB, a VPC is optional — not mandatory.

### Topology (Simplified — No VPC for Dev)

With DynamoDB replacing RDS, the VPC topology is dramatically simplified:

**Dev environment**: No VPC. Lambda functions run outside a VPC and access all AWS services (DynamoDB, S3, Cognito, SES) directly via IAM over HTTPS.

**Prod environment** (if VPC is desired for defense-in-depth):

```
VPC: voces-prod-vpc (CIDR: 10.0.0.0/16)
│
├── Public Subnets (2 AZs)
│   ├── 10.0.1.0/24 (AZ-a)
│   └── 10.0.2.0/24 (AZ-b)
│   └── NAT Gateway (one per AZ)
│
└── Private Subnets — Application (2 AZs)
    ├── 10.0.10.0/24 (AZ-a)
    └── 10.0.20.0/24 (AZ-b)
    └── Lambda functions run here (if VPC is used)
```

Note: **No database subnets needed.** DynamoDB is a fully managed service accessed over HTTPS — it doesn't live in a VPC.

### Subnet Purposes (Prod Only, If VPC Is Used)

| Subnet Type   | Contains                           | Internet Access                 |
| ------------- | ---------------------------------- | ------------------------------- |
| Public        | NAT Gateway (prod only)            | Direct (Internet Gateway)       |
| Private — App | Lambda functions (if VPC-attached) | Outbound only (via NAT Gateway) |

### Why Lambda May NOT Need a VPC (Dev)

With DynamoDB replacing RDS, the primary reason for putting Lambdas in a VPC is gone. All AWS services used by our Lambdas are accessible without a VPC:

| Service         | VPC Required? | Access Method                    |
| --------------- | ------------- | -------------------------------- |
| DynamoDB        | No            | IAM over HTTPS (public endpoint) |
| S3              | No            | IAM over HTTPS (public endpoint) |
| Cognito         | No            | IAM over HTTPS (public endpoint) |
| SES             | No            | IAM over HTTPS (public endpoint) |
| SSM Param Store | No            | IAM over HTTPS (public endpoint) |

**For dev**: No VPC. This eliminates:

- fck-nat / NAT Gateway cost (~$3-32/month)
- VPC cold start penalty (2-5s)
- Security group management
- Subnet configuration

**For prod**: A VPC can be added later for defense-in-depth if needed. VPC endpoints for DynamoDB (Gateway, free) and S3 (Gateway, free) can be used to keep traffic on the AWS backbone.

### NAT Device Strategy

**For dev**: Not needed. No VPC = no NAT.

**For prod** (if VPC is used): Use **NAT Gateway** (one per AZ) for managed high availability. VPC Gateway Endpoints for DynamoDB and S3 are free and keep that traffic off the NAT.

---

## CDK Stack Design

The `network-stack.ts` will create:

### 1. VPC (Prod Only — Dev Has No VPC)

**Dev**: No VPC created. The `network-stack.ts` is a no-op or skipped in dev.

**Prod** (if VPC is desired):

```typescript
if (isProd) {
  const vpc = new ec2.Vpc(this, "VocesVpc", {
    maxAzs: 2,
    natGateways: 2,
    subnetConfiguration: [
      { name: "Public", subnetType: ec2.SubnetType.PUBLIC },
      { name: "Application", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    ],
  });
}
```

Note: No `PRIVATE_ISOLATED` (database) subnets needed — DynamoDB doesn't live in a VPC.

### 2. Security Groups (Prod Only)

| Security Group         | Inbound Rules                            | Outbound Rules                             | Used By              |
| ---------------------- | ---------------------------------------- | ------------------------------------------ | -------------------- |
| `voces-prod-lambda-sg` | None (Lambda initiates, doesn't receive) | All traffic (needed for NAT/VPC endpoints) | All Lambda functions |

No database security groups needed — DynamoDB access is controlled entirely by IAM policies.

### 3. VPC Endpoints (Prod Only)

| Endpoint | Type    | Cost |
| -------- | ------- | ---- |
| DynamoDB | Gateway | Free |
| S3       | Gateway | Free |

Gateway endpoints for DynamoDB and S3 are free and keep traffic on the AWS backbone. Interface endpoints for other services can be added if NAT data transfer costs become significant.

### Stack Outputs

- `VpcId` (prod only)
- `ApplicationSubnetIds` (prod only)
- `LambdaSecurityGroupId` (prod only)

---

## IAM Strategy

### Principle: Least Privilege Per Function

Each Lambda function gets its own IAM execution role with only the permissions it needs.

### Role Definitions

| Lambda                     | IAM Permissions                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **auth**                   | `cognito-idp:SignUp`, `cognito-idp:InitiateAuth`, `cognito-idp:ConfirmSignUp`, `cognito-idp:ForgotPassword`, `cognito-idp:ConfirmForgotPassword`, DynamoDB R/W |
| **users**                  | DynamoDB read (scoped to table + GSIs)                                                                                                                         |
| **recordings**             | `s3:PutObject`, `s3:DeleteObject`, `s3:GetObject` (scoped to recordings bucket), DynamoDB R/W (scoped to table + GSIs)                                         |
| **tags**                   | DynamoDB R/W (scoped to table + GSIs)                                                                                                                          |
| **admin**                  | `cognito-idp:AdminUpdateUserAttributes`, `cognito-idp:AdminDeleteUser`, DynamoDB R/W (scoped to table + GSIs)                                                  |
| **metrics**                | DynamoDB read (scoped to table — Scan with count)                                                                                                              |
| **cognito-custom-message** | None (receives event, returns response)                                                                                                                        |

### VPC Execution Permissions

In dev (no VPC), Lambdas do not need VPC execution permissions.

In prod (if VPC is used), VPC-attached Lambdas need the `AWSLambdaVPCAccessExecutionRole` managed policy. CDK adds this automatically when you attach a Lambda to a VPC.

### Resource-Level Scoping

All IAM policies are scoped to specific resource ARNs:

- DynamoDB: `arn:aws:dynamodb:{region}:{account}:table/voces-{env}-main` and `arn:aws:dynamodb:{region}:{account}:table/voces-{env}-main/index/*`
- S3: `arn:aws:s3:::voces-{env}-recordings/*`
- Cognito: `arn:aws:cognito-idp:{region}:{account}:userpool/{poolId}`

No wildcard `*` resource permissions.

---

## Secrets Management

### Where secrets live

| Secret               | Service                     | Accessed By               |
| -------------------- | --------------------------- | ------------------------- |
| DynamoDB Table Name  | CDK output / env var        | All DB-accessing Lambdas  |
| Cognito User Pool ID | SSM Parameter Store (plain) | Auth Lambda, Admin Lambda |
| Cognito Client ID    | SSM Parameter Store (plain) | Auth Lambda               |
| S3 Bucket Name       | SSM Parameter Store (plain) | Recordings Lambda         |
| SES From Address     | SSM Parameter Store (plain) | Email-sending Lambdas     |

### No Database Secrets Needed

With DynamoDB, there are no database credentials to manage. Access is controlled entirely by IAM roles attached to each Lambda function. This eliminates the need for Secrets Manager for database access, saving ~$0.40/month and removing credential rotation complexity.

### Why SSM Parameter Store for non-sensitive config?

- Free (standard parameters)
- Simple key-value store
- CDK can write outputs directly to SSM

### How Lambdas access secrets

**Option A: Environment variables (CDK resolves at deploy time)**

- CDK reads from SSM/Secrets Manager and injects as Lambda env vars
- Fastest (no runtime API call)
- Downside: Requires redeployment to pick up rotated secrets

**Option B: Runtime fetch (Lambda reads at cold start)**

- Lambda calls Secrets Manager / SSM at initialization
- Picks up rotated secrets without redeployment
- Adds ~50-100ms to cold start

**Recommendation**: Use **environment variables** for non-sensitive config (SSM params). Use **runtime fetch with caching** for database credentials (to support rotation).

---

## Logging

### CloudWatch Logs

Every Lambda automatically logs to CloudWatch. Structure:

```
Log Group: /aws/lambda/voces-{env}-{function-name}
Retention: 14 days (dev) / 90 days (prod)
```

### Structured Logging

Use JSON-formatted logs for queryability:

```typescript
console.log(
  JSON.stringify({
    level: "INFO",
    message: "Recording created",
    recordingId: "abc123",
    userId: "user456",
    timestamp: new Date().toISOString(),
  }),
);
```

### API Gateway Access Logs

Enable access logging on the HTTP API:

```
Format: { requestId, ip, method, path, status, latency, userAgent }
Log Group: /aws/apigateway/voces-{env}-api
Retention: 14 days (dev) / 90 days (prod)
```

---

## Monitoring & Alerting

### CloudWatch Metrics to Monitor

| Metric                      | Source                      | Alarm Threshold         |
| --------------------------- | --------------------------- | ----------------------- |
| Lambda errors               | CloudWatch Lambda metrics   | > 5 errors in 5 minutes |
| Lambda duration             | CloudWatch Lambda metrics   | p99 > 10 seconds        |
| Lambda throttles            | CloudWatch Lambda metrics   | > 0 in 5 minutes        |
| API Gateway 5xx             | CloudWatch API GW metrics   | > 10 in 5 minutes       |
| API Gateway latency         | CloudWatch API GW metrics   | p99 > 5 seconds         |
| DynamoDB throttled requests | CloudWatch DynamoDB metrics | > 0 in 5 minutes        |
| DynamoDB user errors        | CloudWatch DynamoDB metrics | > 10 in 5 minutes       |
| DynamoDB system errors      | CloudWatch DynamoDB metrics | > 0 in 5 minutes        |

### Alarms

CDK creates CloudWatch Alarms for critical metrics. Alarms notify via **SNS topic** → email (or Slack webhook via Lambda).

### CloudWatch Dashboard (Prod)

A single dashboard showing:

- API request count and latency (by endpoint)
- Lambda invocations, errors, duration
- DynamoDB consumed read/write capacity, throttled requests, latency
- S3 request count

---

## Error Handling Strategy

### Lambda Error Handling

```typescript
// Every handler wrapped in try/catch
export const handler = async (event) => {
  try {
    // ... business logic
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: error.message,
        stack: error.stack,
        event: {
          method: event.requestContext.http.method,
          path: event.requestContext.http.path,
        },
      }),
    );
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
```

### API Gateway Default Error Responses

Configure default responses for:

- `401`: `{ "message": "Not authorized, no token" }`
- `403`: `{ "message": "Forbidden" }`
- `429`: `{ "message": "Too many requests" }`
- `500`: `{ "message": "Internal server error" }`

---

## Rate Limiting

API Gateway HTTP API supports throttling:

| Environment | Burst        | Sustained   |
| ----------- | ------------ | ----------- |
| Dev         | 100 req/sec  | 50 req/sec  |
| Prod        | 1000 req/sec | 500 req/sec |

Per-route throttling can be added later for sensitive endpoints (e.g., `/auth/login`, `/auth/register`).

---

## Custom Domain (Production)

### Setup

1. Register/verify domain in Route 53 (or external DNS)
2. Request ACM certificate for `api.vocesdelaextincion.com`
3. Configure API Gateway custom domain mapping
4. Create Route 53 alias record pointing to API Gateway

### CDK

```typescript
const certificate = acm.Certificate.fromCertificateArn(this, "Cert", certArn);
const domainName = new apigatewayv2.DomainName(this, "Domain", {
  domainName: "api.vocesdelaextincion.com",
  certificate,
});
```

This is optional for initial deployment — the default API Gateway URL works fine for development.

---

## Environment-Specific Configuration Summary

| Parameter         | Dev           | Prod                                 |
| ----------------- | ------------- | ------------------------------------ |
| VPC               | None          | Optional (defense-in-depth)          |
| NAT device        | None (no VPC) | NAT Gateway (if VPC is used)         |
| VPC Endpoints     | None (no VPC) | DynamoDB Gateway + S3 Gateway (free) |
| Log retention     | 14 days       | 90 days                              |
| CloudWatch alarms | Minimal       | Full suite                           |
| Dashboard         | None          | Yes                                  |
| Custom domain     | No            | Yes                                  |
| X-Ray tracing     | Off           | On                                   |
| Rate limiting     | 100 burst     | 1000 burst                           |
| WAF               | Off           | Consider (future)                    |

---

## Deployment Order (Full Stack)

When deploying all stacks together, the order matters due to dependencies:

```
1. database-stack      (DynamoDB table + GSIs — no VPC dependency)
2. auth-stack          (Cognito User Pool — independent)
3. storage-stack       (S3 bucket — independent)
4. email-stack         (SES identity — independent)
5. network-stack       (VPC — prod only, optional)
6. api-gateway-stack   (HTTP API, routes, authorizer — needs auth-stack)
7. lambdas-stack       (Lambda functions — needs all of the above)
```

Note: With DynamoDB, the database stack has **no dependency on the network stack**. Steps 1-4 can be deployed in parallel.

CDK handles this automatically if you declare dependencies between stacks.

---

## Cost Estimate (Monthly, Dev Environment)

| Service                   | Estimated Cost (free tier) | Estimated Cost (after 12 months) |
| ------------------------- | -------------------------- | -------------------------------- |
| Lambda (low traffic)      | ~$0                        | ~$0                              |
| API Gateway (low traffic) | ~$0                        | ~$0                              |
| DynamoDB (on-demand)      | **~$0** (always free tier) | **~$0** (always free tier)       |
| S3 (small storage)        | ~$1/month                  | ~$1/month                        |
| CloudWatch Logs           | ~$1/month                  | ~$1/month                        |
| SES (low volume)          | ~$0                        | ~$0                              |
| **Total (Dev)**           | **~$2/month**              | **~$2/month**                    |

### What changed from the RDS-based plan

| Change                                    | Savings          |
| ----------------------------------------- | ---------------- |
| RDS db.t4g.micro → DynamoDB (always free) | -$12/month       |
| fck-nat removed (no VPC needed)           | -$3/month        |
| Secrets Manager (DB secret) removed       | -$0.40/month     |
| No VPC = no cold start penalty            | (perf, not cost) |
| **Total savings vs RDS plan**             | **~$15/month**   |

### Budget constraint

This is a non-professional project with a **maximum budget of $15/month**. With DynamoDB and no VPC, the dev environment costs **~$2/month** — well within budget, with room to spare. Cost-intensive features (NAT Gateway, provisioned concurrency) are reserved for prod only if needed.

---

## Risks and Mitigations

| Risk                                          | Mitigation                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| No VPC means no network-level isolation (dev) | Acceptable for dev; IAM provides access control; add VPC in prod if needed |
| CloudWatch costs grow with log volume         | Set retention policies; use log level filtering                            |
| IAM too restrictive breaks functionality      | Start with broader permissions in dev; tighten for prod                    |
| Cost overruns                                 | Set AWS Budget alerts at $15 (dev) and $500 (prod)                         |
| DynamoDB throttling under unexpected load     | On-demand mode auto-scales; monitor ThrottledRequests metric               |

---

## Definition of Done

- [ ] Dev: Lambda functions work without VPC (DynamoDB, S3, Cognito all accessible via IAM)
- [ ] All Lambda IAM roles follow least privilege (scoped to specific DynamoDB table/index ARNs)
- [ ] Config stored in SSM Parameter Store (no DB secrets needed)
- [ ] CloudWatch log groups created with retention policies
- [ ] CloudWatch alarms configured for critical metrics (prod)
- [ ] API Gateway access logging enabled
- [ ] Structured JSON logging in all Lambda functions
- [ ] Full stack deploys successfully in correct order via `cdk deploy --all`
- [ ] End-to-end test: register → verify → login → create recording → search → delete
- [ ] (Prod) VPC deployed with correct subnet topology (if used)
- [ ] (Prod) DynamoDB and S3 Gateway VPC Endpoints configured (if VPC is used)
