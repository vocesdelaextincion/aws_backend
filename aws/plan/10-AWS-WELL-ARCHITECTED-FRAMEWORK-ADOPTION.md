# AWS Well-Architected Framework Adoption Plan

## Purpose

This document tracks how the Voces de la Extinción AWS migration aligns with the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html) across its six pillars. Items are divided into actions to take **before writing code** and actions that can be **deferred to post-launch or future iterations**.

This is a living checklist — mark items as they are addressed in the relevant plan documents or CDK code.

---

## Immediate Actions (Address Before or During Implementation)

### Security

- [ ] **Restrict Cognito custom attributes to admin-only writes.** Ensure `custom:role` and `custom:plan` are NOT included in the app client's writable attributes. If a user can call `UpdateUserAttributes` on themselves, they could escalate to ADMIN. Configure this explicitly in `auth-stack.ts`.
  - _Relevant doc: 03-AUTH-COGNITO.md_

- [ ] **Ensure DynamoDB IAM policies are scoped to specific table/index ARNs.** Avoid wildcard `*` resource permissions on DynamoDB actions. Each Lambda should only have access to the operations it needs (read-only for users/metrics, read/write for recordings/tags/admin).
  - _Relevant doc: 02-DATABASE-DYNAMODB.md_

- [ ] **Use scoped IAM for GitHub Actions from the start.** Replace the initial `AdministratorAccess` approach with the scoped policy already listed in 09-MANUAL-AWS-SETUP.md step 12. "Scope down later" tends to never happen.
  - _Relevant doc: 09-MANUAL-AWS-SETUP.md_

- [ ] **Scope SES IAM policy to specific identity ARN.** Change `Resource: "arn:aws:ses:{region}:{account}:identity/*"` to `Resource: "arn:aws:ses:{region}:{account}:identity/vocesdelaextincion.com"` (or the specific verified identity).
  - _Relevant doc: 05-EMAIL-SES.md_

### Reliability

- [ ] **Handle Cognito + DynamoDB dual-write failure on registration.** If `cognito.signUp()` succeeds but the DynamoDB `User` PutItem fails, implement a compensation pattern: delete the Cognito user on DynamoDB failure. Document this in the auth Lambda implementation.
  - _Relevant doc: 03-AUTH-COGNITO.md_

- [ ] **Add a `/health` endpoint.** Create a lightweight public endpoint that verifies DynamoDB connectivity (e.g., a simple GetItem or DescribeTable call). Useful for monitoring and as a CloudWatch Synthetics target.
  - _Relevant docs: 06-API-GATEWAY.md, 07-LAMBDAS.md_

- [ ] **Add a DLQ for the Cognito Custom Message Lambda trigger.** If the trigger fails, the event is lost and the user never receives their email. An SQS dead letter queue provides visibility into failures.
  - _Relevant doc: 05-EMAIL-SES.md, 07-LAMBDAS.md_

### Cost Optimization (Budget: max $15/month)

- [x] **Use DynamoDB instead of RDS.** DynamoDB on-demand has an always-free tier (25 GB, 25 WRU/RRU). Eliminates RDS cost (~$12/month after free tier), VPC/NAT cost (~$3/month fck-nat), Secrets Manager cost (~$0.40/month), and VPC cold start penalty. Dev cost drops to ~$2/month.
  - _Relevant doc: 02-DATABASE-DYNAMODB.md_

- [x] **No VPC needed in dev.** With DynamoDB (IAM-based access over HTTPS), Lambdas don't need a VPC for database access. Eliminates fck-nat/NAT Gateway cost and 2-5s cold start penalty.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

### Operational Excellence

- [ ] **Document a rollback strategy for Lambda deployments.** Define how to revert a bad Lambda deploy — e.g., redeploy the previous commit via GitHub Actions, or use Lambda versioning + aliases for instant rollback.
  - _Relevant doc: 01-IAC-GITHUB-ACTIONS.md_

---

## Future Actions (Post-Launch or When Justified by Scale)

### Security

- [ ] **Add S3 bucket policy denying non-SSL access.** Add a condition `"aws:SecureTransport": "false"` → Deny on the bucket policy as a defense-in-depth measure alongside `BlockPublicAccess`.
  - _Relevant doc: 04-STORAGE-S3.md_

- [ ] **Add WAF via CloudFront.** HTTP API doesn't support WAF directly. When abuse or DDoS becomes a concern, place CloudFront in front of API Gateway and attach a WAF WebACL.
  - _Relevant doc: 06-API-GATEWAY.md, 08-NETWORKING-SECURITY.md_

- [ ] **Enable Cognito Advanced Security (adaptive authentication) in prod.** Adds risk-based adaptive challenges for suspicious login attempts.
  - _Relevant doc: 03-AUTH-COGNITO.md_

### Reliability

- [ ] **Document RPO/RTO targets.** Define Recovery Point Objective and Recovery Time Objective. DynamoDB point-in-time recovery (PITR) provides continuous backups with 35-day retention and per-second granularity. RPO can be near-zero.
  - _Relevant doc: 02-DATABASE-DYNAMODB.md_

- [ ] **Consider DynamoDB global tables for cross-region resilience.** If `us-east-1` has a regional outage, a global table replica in another region provides automatic failover. Evaluate when data becomes critical.
  - _Relevant doc: 02-DATABASE-DYNAMODB.md_

- [ ] **Enable Cognito deletion protection in dev.** Cognito user pools cannot be backed up. Accidental deletion loses all users. Deletion protection is low-cost insurance even in dev.
  - _Relevant doc: 03-AUTH-COGNITO.md_

### Performance Efficiency

- [ ] **Run Lambda Power Tuning post-launch.** Use the [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) tool to find the optimal memory/cost/speed balance for each function.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Cache metrics results.** Since `/metrics` only reads aggregate counts (via DynamoDB Scan), consider caching the result in Lambda memory with a short TTL (e.g., 5 minutes) to avoid repeated Scans.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Add a caching layer for read-heavy endpoints.** `/metrics` (public, rarely changes) and `GET /recordings` (list) are candidates. Options: Lambda in-memory cache with TTL, CloudFront for public endpoints, or DynamoDB Accelerator (DAX) if sub-millisecond reads are needed.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Implement presigned upload URLs for large files.** Already documented as a future improvement — client uploads directly to S3 instead of streaming through Lambda. Needed when files exceed the 10MB API Gateway limit.
  - _Relevant doc: 04-STORAGE-S3.md_

### Cost Optimization

- [ ] **Add cost allocation tags.** Beyond `Environment = dev | prod`, add `Project = voces` and `Service = auth|recordings|tags|admin|metrics` tags. Enables per-service cost breakdown in AWS Cost Explorer.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

- [ ] **Validate provisioned concurrency ROI before enabling.** The plan estimates ~$60/month for 4 provisioned instances. With DynamoDB (no VPC cold start), cold starts should be well under 1 second. Measure actual impact before committing.
  - _Relevant doc: 07-LAMBDAS.md_

### Operational Excellence

- [ ] **Add a CloudWatch Synthetics canary.** A simple canary hitting `GET /metrics` (or `GET /health`) every 5 minutes provides uptime monitoring and catches outages before users do.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

- [ ] **Create a basic incident runbook.** Document what to do when alarms fire: check Lambda logs → check DynamoDB throttling → check IAM permissions → escalate. Even a simple decision tree helps.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

- [ ] **Instrument X-Ray tracing end-to-end.** The plan enables X-Ray in prod but doesn't detail how traces correlate across API Gateway → Lambda → DynamoDB. The AWS SDK v3 supports X-Ray tracing natively.
  - _Relevant doc: 07-LAMBDAS.md, 08-NETWORKING-SECURITY.md_

### Sustainability

- [ ] **Right-size Lambda memory based on actual usage.** After launch, review CloudWatch metrics for memory utilization and adjust. Over-provisioned memory wastes compute and energy.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Consider S3 Intelligent-Tiering.** Instead of manual lifecycle rules (IA after 90 days), Intelligent-Tiering automatically moves objects to the most efficient storage class based on access patterns.
  - _Relevant doc: 04-STORAGE-S3.md_

---

## Pillar Coverage Summary

| Pillar                 | Current Coverage                                                          | Key Gap                       |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------- |
| Operational Excellence | ✅ Strong (IaC, CI/CD, logging, dashboards)                               | Rollback strategy, runbooks   |
| Security               | ✅✅ Very strong                                                          | Cognito attribute writability |
| Reliability            | ✅ Good (DynamoDB PITR, multi-region option)                              | Dual-write atomicity, DR plan |
| Performance Efficiency | ✅✅ Very good (ARM64, esbuild, no VPC penalty, DynamoDB single-digit ms) | No caching, Lambda tuning     |
| Cost Optimization      | ✅✅✅ Excellent (DynamoDB free tier, no VPC, no NAT — ~$2/month)         | Provisioned concurrency ROI   |
| Sustainability         | 🟡 Implicit only                                                          | Not explicitly addressed      |
