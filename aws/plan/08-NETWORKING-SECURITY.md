# Part 8: Networking, Security & Monitoring

## Goal

Define the VPC topology, security group rules, IAM boundaries, logging, monitoring, and alerting that tie all previous parts together into a production-ready, secure system.

---

## VPC Architecture

### Why a VPC?

RDS must live in a VPC. Lambda functions that access RDS must also be in the VPC. This is non-negotiable for database security.

### Topology

```
VPC: voces-{env}-vpc (CIDR: 10.0.0.0/16)
│
├── Public Subnets (2 AZs)
│   ├── 10.0.1.0/24 (AZ-a)
│   └── 10.0.2.0/24 (AZ-b)
│   └── NAT Gateway (one per AZ in prod, one shared in dev)
│
├── Private Subnets — Application (2 AZs)
│   ├── 10.0.10.0/24 (AZ-a)
│   └── 10.0.20.0/24 (AZ-b)
│   └── Lambda functions run here
│
└── Private Subnets — Database (2 AZs)
    ├── 10.0.100.0/24 (AZ-a)
    └── 10.0.200.0/24 (AZ-b)
    └── RDS Aurora cluster runs here
```

### Subnet Purposes

| Subnet Type   | Contains                              | Internet Access                 |
| ------------- | ------------------------------------- | ------------------------------- |
| Public        | NAT Gateway, (Bastion host if needed) | Direct (Internet Gateway)       |
| Private — App | Lambda functions                      | Outbound only (via NAT Gateway) |
| Private — DB  | RDS Aurora, RDS Proxy                 | None                            |

### Why Lambda needs outbound internet (NAT Gateway)

Lambda functions in a VPC have **no internet access** by default. They need NAT Gateway to reach:

- AWS Cognito APIs (sign up, auth)
- AWS SES APIs (if sending custom emails)
- AWS Secrets Manager / SSM (to fetch secrets)
- Any external service

**Alternative**: Use **VPC Endpoints** for AWS services to avoid NAT Gateway costs:

| Service             | VPC Endpoint Type         | Eliminates NAT for      |
| ------------------- | ------------------------- | ----------------------- |
| Secrets Manager     | Interface                 | Fetching DB credentials |
| SSM Parameter Store | Interface                 | Fetching config         |
| S3                  | Gateway (free)            | S3 uploads/deletes      |
| SES                 | Interface                 | Sending emails          |
| Cognito             | Not available (needs NAT) | —                       |

**Recommendation**: Use S3 Gateway Endpoint (free) + NAT Gateway for everything else. Add interface endpoints later to reduce NAT costs if they become significant.

### NAT Gateway Cost Consideration

NAT Gateway costs ~$32/month (fixed) + data transfer. For dev:

- Consider a **single NAT Gateway** (not HA) to save costs
- Or use **NAT Instance** (t3.nano ~$3/month) for dev

For prod:

- One NAT Gateway per AZ for high availability

---

## CDK Stack Design

The `network-stack.ts` will create:

### 1. VPC

```
Configuration:
- CIDR: 10.0.0.0/16
- Max AZs: 2
- Subnet groups:
  - Public (for NAT Gateway)
  - Private with egress (for Lambda — routes through NAT)
  - Private isolated (for RDS — no internet)
- NAT Gateways: 1 (dev) / 2 (prod)
```

CDK's `Vpc` construct handles most of this automatically:

```typescript
new ec2.Vpc(this, "VocesVpc", {
  maxAzs: 2,
  natGateways: isProd ? 2 : 1,
  subnetConfiguration: [
    { name: "Public", subnetType: ec2.SubnetType.PUBLIC },
    { name: "Application", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    { name: "Database", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  ],
});
```

### 2. Security Groups

| Security Group             | Inbound Rules                            | Outbound Rules                             | Used By              |
| -------------------------- | ---------------------------------------- | ------------------------------------------ | -------------------- |
| `voces-{env}-lambda-sg`    | None (Lambda initiates, doesn't receive) | All traffic (needed for NAT/VPC endpoints) | All Lambda functions |
| `voces-{env}-rds-sg`       | TCP 5432 from `lambda-sg`                | None                                       | RDS Aurora cluster   |
| `voces-{env}-rds-proxy-sg` | TCP 5432 from `lambda-sg`                | TCP 5432 to `rds-sg`                       | RDS Proxy            |

### 3. VPC Endpoints

| Endpoint        | Type      | Cost             |
| --------------- | --------- | ---------------- |
| S3              | Gateway   | Free             |
| Secrets Manager | Interface | ~$7/month per AZ |
| SSM             | Interface | ~$7/month per AZ |

Start with S3 Gateway only. Add interface endpoints if NAT costs justify it.

### Stack Outputs

- `VpcId`
- `ApplicationSubnetIds`
- `DatabaseSubnetIds`
- `LambdaSecurityGroupId`

---

## IAM Strategy

### Principle: Least Privilege Per Function

Each Lambda function gets its own IAM execution role with only the permissions it needs.

### Role Definitions

| Lambda                     | IAM Permissions                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **auth**                   | `cognito-idp:SignUp`, `cognito-idp:InitiateAuth`, `cognito-idp:ConfirmSignUp`, `cognito-idp:ForgotPassword`, `cognito-idp:ConfirmForgotPassword`, `secretsmanager:GetSecretValue` (DB secret), VPC execution (`ec2:CreateNetworkInterface`, etc.) |
| **users**                  | `secretsmanager:GetSecretValue` (DB secret), VPC execution                                                                                                                                                                                        |
| **recordings**             | `s3:PutObject`, `s3:DeleteObject`, `s3:GetObject` (scoped to recordings bucket, GetObject for presigned URLs), `secretsmanager:GetSecretValue` (DB secret), VPC execution                                                                         |
| **tags**                   | `secretsmanager:GetSecretValue` (DB secret), VPC execution                                                                                                                                                                                        |
| **admin**                  | `cognito-idp:AdminUpdateUserAttributes`, `cognito-idp:AdminDeleteUser`, `secretsmanager:GetSecretValue` (DB secret), VPC execution                                                                                                                |
| **metrics**                | `secretsmanager:GetSecretValue` (DB secret), VPC execution                                                                                                                                                                                        |
| **cognito-custom-message** | None (receives event, returns response)                                                                                                                                                                                                           |

### VPC Execution Permissions

All VPC-attached Lambdas need the `AWSLambdaVPCAccessExecutionRole` managed policy, which grants:

- `ec2:CreateNetworkInterface`
- `ec2:DescribeNetworkInterfaces`
- `ec2:DeleteNetworkInterface`

CDK adds this automatically when you attach a Lambda to a VPC.

### Resource-Level Scoping

All IAM policies are scoped to specific resource ARNs:

- S3: `arn:aws:s3:::voces-{env}-recordings/*`
- Secrets Manager: `arn:aws:secretsmanager:{region}:{account}:secret:voces-{env}-db-*`
- Cognito: `arn:aws:cognito-idp:{region}:{account}:userpool/{poolId}`

No wildcard `*` resource permissions.

---

## Secrets Management

### Where secrets live

| Secret                                                    | Service                     | Accessed By               |
| --------------------------------------------------------- | --------------------------- | ------------------------- |
| Database credentials (user, password, host, port, dbname) | Secrets Manager             | All DB-accessing Lambdas  |
| Cognito User Pool ID                                      | SSM Parameter Store (plain) | Auth Lambda, Admin Lambda |
| Cognito Client ID                                         | SSM Parameter Store (plain) | Auth Lambda               |
| S3 Bucket Name                                            | SSM Parameter Store (plain) | Recordings Lambda         |
| File URL Prefix (CloudFront domain)                       | SSM Parameter Store (plain) | Recordings Lambda         |
| SES From Address                                          | SSM Parameter Store (plain) | Email-sending Lambdas     |

### Why Secrets Manager for DB credentials?

- Automatic rotation support
- RDS Proxy integrates natively with Secrets Manager
- Structured secret (JSON with host, port, user, password, dbname)

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

| Metric              | Source                    | Alarm Threshold         |
| ------------------- | ------------------------- | ----------------------- |
| Lambda errors       | CloudWatch Lambda metrics | > 5 errors in 5 minutes |
| Lambda duration     | CloudWatch Lambda metrics | p99 > 10 seconds        |
| Lambda throttles    | CloudWatch Lambda metrics | > 0 in 5 minutes        |
| API Gateway 5xx     | CloudWatch API GW metrics | > 10 in 5 minutes       |
| API Gateway latency | CloudWatch API GW metrics | p99 > 5 seconds         |
| RDS CPU utilization | CloudWatch RDS metrics    | > 80% for 10 minutes    |
| RDS connections     | CloudWatch RDS metrics    | > 80% of max            |
| RDS free storage    | CloudWatch RDS metrics    | < 20%                   |

### Alarms

CDK creates CloudWatch Alarms for critical metrics. Alarms notify via **SNS topic** → email (or Slack webhook via Lambda).

### CloudWatch Dashboard (Prod)

A single dashboard showing:

- API request count and latency (by endpoint)
- Lambda invocations, errors, duration
- RDS connections, CPU, storage
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

| Parameter         | Dev             | Prod                               |
| ----------------- | --------------- | ---------------------------------- |
| NAT Gateways      | 1               | 2 (HA)                             |
| VPC Endpoints     | S3 Gateway only | S3 Gateway + Secrets Manager + SSM |
| Log retention     | 14 days         | 90 days                            |
| CloudWatch alarms | Minimal         | Full suite                         |
| Dashboard         | None            | Yes                                |
| Custom domain     | No              | Yes                                |
| X-Ray tracing     | Off             | On                                 |
| Rate limiting     | 100 burst       | 1000 burst                         |
| WAF               | Off             | Consider (future)                  |

---

## Deployment Order (Full Stack)

When deploying all stacks together, the order matters due to dependencies:

```
1. network-stack       (VPC, subnets, security groups)
2. database-stack      (RDS Aurora, RDS Proxy — needs VPC)
3. auth-stack          (Cognito User Pool — independent but logical order)
4. storage-stack       (S3 bucket — independent)
5. email-stack         (SES identity — independent)
6. api-gateway-stack   (HTTP API, routes, authorizer — needs auth-stack)
7. lambdas-stack       (Lambda functions — needs all of the above)
```

CDK handles this automatically if you declare dependencies between stacks.

---

## Cost Estimate (Monthly, Dev Environment)

| Service                                | Estimated Cost                     |
| -------------------------------------- | ---------------------------------- |
| Lambda (low traffic)                   | ~$0 (free tier: 1M requests/month) |
| API Gateway                            | ~$0 (free tier: 1M requests/month) |
| RDS Aurora Serverless v2 (0.5 ACU min) | ~$44/month                         |
| RDS Proxy                              | ~$22/month                         |
| NAT Gateway (1)                        | ~$32/month + data transfer         |
| S3 (small storage)                     | ~$1/month                          |
| Secrets Manager (1 secret)             | ~$0.40/month                       |
| CloudWatch Logs                        | ~$1/month                          |
| SES (low volume)                       | ~$0                                |
| **Total (Dev)**                        | **~$100/month**                    |

### Cost Optimization Options for Dev

- Use **NAT Instance** (t3.nano) instead of NAT Gateway: saves ~$29/month
- Use **RDS t3.micro** instead of Aurora Serverless: saves ~$20/month but loses auto-scaling
- Shut down dev environment outside business hours via scheduled CDK destroy/deploy

---

## Risks and Mitigations

| Risk                                              | Mitigation                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| NAT Gateway is a single point of failure (dev)    | Acceptable for dev; prod uses 2 NAT Gateways                                    |
| VPC adds cold start latency to Lambda             | Provisioned concurrency for critical paths; VPC endpoints reduce external calls |
| CloudWatch costs grow with log volume             | Set retention policies; use log level filtering                                 |
| Security group misconfiguration blocks Lambda→RDS | CDK manages SG rules declaratively; test connectivity in CI                     |
| IAM too restrictive breaks functionality          | Start with broader permissions in dev; tighten for prod                         |
| Cost overruns                                     | Set AWS Budget alerts at $100 (dev) and $500 (prod)                             |

---

## Definition of Done

- [ ] VPC deployed with correct subnet topology
- [ ] Security groups allow Lambda → RDS Proxy → RDS traffic
- [ ] NAT Gateway provides outbound internet for Lambda
- [ ] S3 Gateway VPC Endpoint configured
- [ ] All Lambda IAM roles follow least privilege
- [ ] Secrets stored in Secrets Manager / SSM Parameter Store
- [ ] CloudWatch log groups created with retention policies
- [ ] CloudWatch alarms configured for critical metrics (prod)
- [ ] API Gateway access logging enabled
- [ ] Structured JSON logging in all Lambda functions
- [ ] Full stack deploys successfully in correct order via `cdk deploy --all`
- [ ] End-to-end test: register → verify → login → create recording → search → delete
