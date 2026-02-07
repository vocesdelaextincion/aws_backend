# AWS Well-Architected Framework Adoption Plan

## Purpose

This document tracks how the Voces de la Extinción AWS migration aligns with the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html) across its six pillars. Items are divided into actions to take **before writing code** and actions that can be **deferred to post-launch or future iterations**.

This is a living checklist — mark items as they are addressed in the relevant plan documents or CDK code.

---

## Immediate Actions (Address Before or During Implementation)

### Security

- [ ] **Restrict Cognito custom attributes to admin-only writes.** Ensure `custom:role` and `custom:plan` are NOT included in the app client's writable attributes. If a user can call `UpdateUserAttributes` on themselves, they could escalate to ADMIN. Configure this explicitly in `auth-stack.ts`.
  - _Relevant doc: 03-AUTH-COGNITO.md_

- [ ] **Enforce SSL/TLS on RDS connections.** Set `rds.force_ssl = 1` in the RDS parameter group, or append `sslmode=require` to the Prisma connection string. Without this, Lambda-to-RDS traffic inside the VPC is unencrypted.
  - _Relevant doc: 02-DATABASE-RDS.md_

- [ ] **Use scoped IAM for GitHub Actions from the start.** Replace the initial `AdministratorAccess` approach with the scoped policy already listed in 09-MANUAL-AWS-SETUP.md step 12. "Scope down later" tends to never happen.
  - _Relevant doc: 09-MANUAL-AWS-SETUP.md_

- [ ] **Scope SES IAM policy to specific identity ARN.** Change `Resource: "arn:aws:ses:{region}:{account}:identity/*"` to `Resource: "arn:aws:ses:{region}:{account}:identity/vocesdelaextincion.com"` (or the specific verified identity).
  - _Relevant doc: 05-EMAIL-SES.md_

### Reliability

- [ ] **Handle Cognito + RDS dual-write failure on registration.** If `cognito.signUp()` succeeds but the RDS `User` insert fails, implement a compensation pattern: delete the Cognito user on RDS failure. Document this in the auth Lambda implementation.
  - _Relevant doc: 03-AUTH-COGNITO.md_

- [ ] **Add a `/health` endpoint.** Create a lightweight public endpoint that verifies DB connectivity (e.g., `SELECT 1` through Prisma). Useful for monitoring and as a CloudWatch Synthetics target.
  - _Relevant docs: 06-API-GATEWAY.md, 07-LAMBDAS.md_

- [ ] **Add a DLQ for the Cognito Custom Message Lambda trigger.** If the trigger fails, the event is lost and the user never receives their email. An SQS dead letter queue provides visibility into failures.
  - _Relevant doc: 05-EMAIL-SES.md, 07-LAMBDAS.md_

### Cost Optimization (Budget: max $15/month)

- [x] **Use fck-nat instead of NAT Gateway in dev.** A `t4g.nano` fck-nat instance (~$3/month) replaces the NAT Gateway (~$32/month), saving ~$29/month. Already adopted in 08-NETWORKING-SECURITY.md.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

- [x] **Use RDS db.t4g.micro instead of Aurora Serverless v2 in dev.** Free tier eligible (12 months), ~$12/month after. Saves ~$44/month vs Aurora. Already adopted in 02-DATABASE-RDS.md.
  - _Relevant doc: 02-DATABASE-RDS.md_

- [x] **Skip RDS Proxy in dev.** Direct Lambda-to-RDS connections with `connection_limit=1` work fine at dev traffic levels. Saves ~$22/month. Already adopted in 02-DATABASE-RDS.md.
  - _Relevant doc: 02-DATABASE-RDS.md_

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

- [ ] **Document RPO/RTO targets.** Define Recovery Point Objective and Recovery Time Objective (e.g., RPO: 5 minutes via Aurora PITR, RTO: 1 hour). Even informal targets help guide decisions.
  - _Relevant doc: 02-DATABASE-RDS.md_

- [ ] **Consider cross-region backups for Aurora.** If `us-east-1` has a regional outage, all data is lost. Aurora supports cross-region read replicas and backup replication. Evaluate when data becomes critical.
  - _Relevant doc: 02-DATABASE-RDS.md_

- [ ] **Enable Cognito deletion protection in dev.** Cognito user pools cannot be backed up. Accidental deletion loses all users. Deletion protection is low-cost insurance even in dev.
  - _Relevant doc: 03-AUTH-COGNITO.md_

### Performance Efficiency

- [ ] **Run Lambda Power Tuning post-launch.** Use the [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) tool to find the optimal memory/cost/speed balance for each function.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Consider moving the metrics Lambda outside the VPC.** If `/metrics` only reads aggregate counts, it could use a cached data source (or a read replica endpoint) outside the VPC to avoid the 2-5s cold start penalty.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Add a caching layer for read-heavy endpoints.** `/metrics` (public, rarely changes) and `GET /recordings` (list) are candidates. Options: Lambda in-memory cache with TTL, CloudFront for public endpoints, or ElastiCache if scale demands it.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Implement presigned upload URLs for large files.** Already documented as a future improvement — client uploads directly to S3 instead of streaming through Lambda. Needed when files exceed the 10MB API Gateway limit.
  - _Relevant doc: 04-STORAGE-S3.md_

### Cost Optimization

- [ ] **Add cost allocation tags.** Beyond `Environment = dev | prod`, add `Project = voces` and `Service = auth|recordings|tags|admin|metrics` tags. Enables per-service cost breakdown in AWS Cost Explorer.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

- [ ] **Validate provisioned concurrency ROI before enabling.** The plan estimates ~$60/month for 4 provisioned instances. Measure actual cold start frequency and impact before committing — it may not be needed at launch traffic levels. This single feature exceeds the entire dev budget.
  - _Relevant doc: 07-LAMBDAS.md_

### Operational Excellence

- [ ] **Add a CloudWatch Synthetics canary.** A simple canary hitting `GET /metrics` (or `GET /health`) every 5 minutes provides uptime monitoring and catches outages before users do.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

- [ ] **Create a basic incident runbook.** Document what to do when alarms fire: check Lambda logs → check RDS connections → check Secrets Manager rotation → escalate. Even a simple decision tree helps.
  - _Relevant doc: 08-NETWORKING-SECURITY.md_

- [ ] **Instrument X-Ray tracing end-to-end.** The plan enables X-Ray in prod but doesn't detail how traces correlate across API Gateway → Lambda → RDS Proxy → Aurora. Prisma doesn't natively support X-Ray — may need manual trace segments.
  - _Relevant doc: 07-LAMBDAS.md, 08-NETWORKING-SECURITY.md_

### Sustainability

- [ ] **Right-size Lambda memory based on actual usage.** After launch, review CloudWatch metrics for memory utilization and adjust. Over-provisioned memory wastes compute and energy.
  - _Relevant doc: 07-LAMBDAS.md_

- [ ] **Consider S3 Intelligent-Tiering.** Instead of manual lifecycle rules (IA after 90 days), Intelligent-Tiering automatically moves objects to the most efficient storage class based on access patterns.
  - _Relevant doc: 04-STORAGE-S3.md_

---

## Pillar Coverage Summary

| Pillar                 | Current Coverage                                                 | Key Gap                                |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Operational Excellence | ✅ Strong (IaC, CI/CD, logging, dashboards)                      | Rollback strategy, runbooks            |
| Security               | ✅✅ Very strong                                                 | Cognito attribute writability, RDS SSL |
| Reliability            | ✅ Good (Multi-AZ, backups, RDS Proxy)                           | Dual-write atomicity, DR plan          |
| Performance Efficiency | ✅ Good (ARM64, esbuild, connection reuse)                       | No caching, Lambda tuning              |
| Cost Optimization      | ✅✅ Strong (fck-nat, db.t4g.micro, no Proxy in dev — ~$5/month) | Provisioned concurrency ROI            |
| Sustainability         | 🟡 Implicit only                                                 | Not explicitly addressed               |
