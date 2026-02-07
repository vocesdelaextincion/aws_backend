# AWS Well-Architected Framework Adoption Plan

## Purpose

This document tracks how the Voces de la Extinción AWS migration aligns with the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html) across its six pillars. Items are divided into actions to take **before writing code** and actions that can be **deferred to post-launch or future iterations**.

This is a living checklist — mark items as they are addressed in the relevant plan documents or CDK code.

---

## Immediate Actions (Address Before or During Implementation)

### Security

- [ ] **Restrict Cognito custom attributes to admin-only writes.** Ensure `custom:role` and `custom:plan` are NOT included in the app client's writable attributes. If a user can call `UpdateUserAttributes` on themselves, they could escalate to ADMIN. Configure this explicitly in `auth-stack.ts`.
  - *Relevant doc: 03-AUTH-COGNITO.md*

- [ ] **Enforce SSL/TLS on RDS connections.** Set `rds.force_ssl = 1` in the RDS parameter group, or append `sslmode=require` to the Prisma connection string. Without this, Lambda-to-RDS traffic inside the VPC is unencrypted.
  - *Relevant doc: 02-DATABASE-RDS.md*

- [ ] **Use scoped IAM for GitHub Actions from the start.** Replace the initial `AdministratorAccess` approach with the scoped policy already listed in 09-MANUAL-AWS-SETUP.md step 12. "Scope down later" tends to never happen.
  - *Relevant doc: 09-MANUAL-AWS-SETUP.md*

- [ ] **Scope SES IAM policy to specific identity ARN.** Change `Resource: "arn:aws:ses:{region}:{account}:identity/*"` to `Resource: "arn:aws:ses:{region}:{account}:identity/vocesdelaextincion.com"` (or the specific verified identity).
  - *Relevant doc: 05-EMAIL-SES.md*

### Reliability

- [ ] **Handle Cognito + RDS dual-write failure on registration.** If `cognito.signUp()` succeeds but the RDS `User` insert fails, implement a compensation pattern: delete the Cognito user on RDS failure. Document this in the auth Lambda implementation.
  - *Relevant doc: 03-AUTH-COGNITO.md*

- [ ] **Add a `/health` endpoint.** Create a lightweight public endpoint that verifies DB connectivity (e.g., `SELECT 1` through Prisma). Useful for monitoring and as a CloudWatch Synthetics target.
  - *Relevant docs: 06-API-GATEWAY.md, 07-LAMBDAS.md*

- [ ] **Add a DLQ for the Cognito Custom Message Lambda trigger.** If the trigger fails, the event is lost and the user never receives their email. An SQS dead letter queue provides visibility into failures.
  - *Relevant doc: 05-EMAIL-SES.md, 07-LAMBDAS.md*

### Operational Excellence

- [ ] **Document a rollback strategy for Lambda deployments.** Define how to revert a bad Lambda deploy — e.g., redeploy the previous commit via GitHub Actions, or use Lambda versioning + aliases for instant rollback.
  - *Relevant doc: 01-IAC-GITHUB-ACTIONS.md*

---

## Future Actions (Post-Launch or When Justified by Scale)

### Security

- [ ] **Add S3 bucket policy denying non-SSL access.** Add a condition `"aws:SecureTransport": "false"` → Deny on the bucket policy as a defense-in-depth measure alongside `BlockPublicAccess`.
  - *Relevant doc: 04-STORAGE-S3.md*

- [ ] **Add WAF via CloudFront.** HTTP API doesn't support WAF directly. When abuse or DDoS becomes a concern, place CloudFront in front of API Gateway and attach a WAF WebACL.
  - *Relevant doc: 06-API-GATEWAY.md, 08-NETWORKING-SECURITY.md*

- [ ] **Enable Cognito Advanced Security (adaptive authentication) in prod.** Adds risk-based adaptive challenges for suspicious login attempts.
  - *Relevant doc: 03-AUTH-COGNITO.md*

### Reliability

- [ ] **Document RPO/RTO targets.** Define Recovery Point Objective and Recovery Time Objective (e.g., RPO: 5 minutes via Aurora PITR, RTO: 1 hour). Even informal targets help guide decisions.
  - *Relevant doc: 02-DATABASE-RDS.md*

- [ ] **Consider cross-region backups for Aurora.** If `us-east-1` has a regional outage, all data is lost. Aurora supports cross-region read replicas and backup replication. Evaluate when data becomes critical.
  - *Relevant doc: 02-DATABASE-RDS.md*

- [ ] **Enable Cognito deletion protection in dev.** Cognito user pools cannot be backed up. Accidental deletion loses all users. Deletion protection is low-cost insurance even in dev.
  - *Relevant doc: 03-AUTH-COGNITO.md*

### Performance Efficiency

- [ ] **Run Lambda Power Tuning post-launch.** Use the [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) tool to find the optimal memory/cost/speed balance for each function.
  - *Relevant doc: 07-LAMBDAS.md*

- [ ] **Consider moving the metrics Lambda outside the VPC.** If `/metrics` only reads aggregate counts, it could use a cached data source (or a read replica endpoint) outside the VPC to avoid the 2-5s cold start penalty.
  - *Relevant doc: 07-LAMBDAS.md*

- [ ] **Add a caching layer for read-heavy endpoints.** `/metrics` (public, rarely changes) and `GET /recordings` (list) are candidates. Options: Lambda in-memory cache with TTL, CloudFront for public endpoints, or ElastiCache if scale demands it.
  - *Relevant doc: 07-LAMBDAS.md*

- [ ] **Implement presigned upload URLs for large files.** Already documented as a future improvement — client uploads directly to S3 instead of streaming through Lambda. Needed when files exceed the 10MB API Gateway limit.
  - *Relevant doc: 04-STORAGE-S3.md*

### Cost Optimization

- [ ] **Use a NAT Instance instead of NAT Gateway in dev.** A `t4g.nano` NAT instance (~$3/month) or `fck-nat` AMI replaces the NAT Gateway (~$32/month), saving ~$29/month (29% of dev budget).
  - *Relevant doc: 08-NETWORKING-SECURITY.md*

- [ ] **Skip RDS Proxy in dev.** With low dev traffic, direct Lambda-to-Aurora connections with `connection_limit=1` work fine. RDS Proxy adds $22/month that isn't justified until prod-level concurrency.
  - *Relevant doc: 02-DATABASE-RDS.md*

- [ ] **Add cost allocation tags.** Beyond `Environment = dev | prod`, add `Project = voces` and `Service = auth|recordings|tags|admin|metrics` tags. Enables per-service cost breakdown in AWS Cost Explorer.
  - *Relevant doc: 08-NETWORKING-SECURITY.md*

- [ ] **Validate provisioned concurrency ROI before enabling.** The plan estimates ~$60/month for 4 provisioned instances. Measure actual cold start frequency and impact before committing — it may not be needed at launch traffic levels.
  - *Relevant doc: 07-LAMBDAS.md*

### Operational Excellence

- [ ] **Add a CloudWatch Synthetics canary.** A simple canary hitting `GET /metrics` (or `GET /health`) every 5 minutes provides uptime monitoring and catches outages before users do.
  - *Relevant doc: 08-NETWORKING-SECURITY.md*

- [ ] **Create a basic incident runbook.** Document what to do when alarms fire: check Lambda logs → check RDS connections → check Secrets Manager rotation → escalate. Even a simple decision tree helps.
  - *Relevant doc: 08-NETWORKING-SECURITY.md*

- [ ] **Instrument X-Ray tracing end-to-end.** The plan enables X-Ray in prod but doesn't detail how traces correlate across API Gateway → Lambda → RDS Proxy → Aurora. Prisma doesn't natively support X-Ray — may need manual trace segments.
  - *Relevant doc: 07-LAMBDAS.md, 08-NETWORKING-SECURITY.md*

### Sustainability

- [ ] **Right-size Lambda memory based on actual usage.** After launch, review CloudWatch metrics for memory utilization and adjust. Over-provisioned memory wastes compute and energy.
  - *Relevant doc: 07-LAMBDAS.md*

- [ ] **Consider S3 Intelligent-Tiering.** Instead of manual lifecycle rules (IA after 90 days), Intelligent-Tiering automatically moves objects to the most efficient storage class based on access patterns.
  - *Relevant doc: 04-STORAGE-S3.md*

---

## Pillar Coverage Summary

| Pillar | Current Coverage | Key Gap |
|---|---|---|
| Operational Excellence | ✅ Strong (IaC, CI/CD, logging, dashboards) | Rollback strategy, runbooks |
| Security | ✅✅ Very strong | Cognito attribute writability, RDS SSL |
| Reliability | ✅ Good (Multi-AZ, backups, RDS Proxy) | Dual-write atomicity, DR plan |
| Performance Efficiency | ✅ Good (ARM64, esbuild, connection reuse) | No caching, Lambda tuning |
| Cost Optimization | ✅ Good (Serverless, lifecycle rules, budgets) | NAT Gateway cost in dev |
| Sustainability | 🟡 Implicit only | Not explicitly addressed |
