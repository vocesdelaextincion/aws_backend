# Migration Plan Review — Full Document Set Analysis

**Date**: 2025-02-08
**Scope**: Documents 00 through 10 in `/aws/plan/`
**Reviewer**: Cascade (AI pair programmer)

---

## Executive Summary

The plan set is **remarkably well-structured**. The 11 documents are coherent, internally consistent, and follow a clear logical progression. The DynamoDB pivot is thoroughly reflected across all documents — no stale RDS references remain. The plan is realistic for a $15/month budget and a solo/small-team project.

That said, the review found **several gaps and inconsistencies** worth addressing before implementation begins. None are blockers, but some could cause confusion or rework during coding.

---

## 1. Coherence & Consistency

### What works well

- **Consistent terminology**: Entity names (User, Recording, Tag), key formats (`USER#<sub>`, `REC#<id>`, `TAG#<id>`), environment naming (`voces-{env}-*`), and service references are uniform across all documents.
- **Cross-references are accurate**: Documents reference each other correctly (e.g., 07-LAMBDAS references Part 4 for presigned uploads, Part 6 for payload format).
- **DynamoDB pivot is complete**: The switch from RDS to DynamoDB is consistently reflected in 00, 02, 07, 08, and 10. No orphaned RDS references found.
- **Budget constraint is respected**: The $15/month limit is referenced in 00, 08, and 10, and all cost-bearing decisions (no VPC in dev, no provisioned concurrency, no NAT) align with it.
- **Deployment order is consistent**: The order in 00 (table) matches 08's deployment order section, and dependency declarations are correct.

### Inconsistencies found

| Issue | Location | Detail |
|---|---|---|
| **Route count mismatch** | 00 vs 06 vs 07 | 00-OVERVIEW says "24 total endpoints" in the memory/context. 06-API-GATEWAY lists 24 routes and says "24 routes → 6 Lambda targets". 07-LAMBDAS says "24 endpoints" in the Definition of Done but the route table in 06 actually lists **25 rows** (count the table). The `/users/me` route is listed separately from `/auth/me`, which is correct, but the count should be verified. |
| **Verification flow: token vs code** | 06-API-GATEWAY | Routes use `{token}` as path parameter for verify-email and reset-password (`/auth/verify-email/{token}`, `/auth/reset-password/{token}`). But 03-AUTH-COGNITO recommends using **6-digit codes** (not URL tokens). If using codes, these should be POST body parameters, not path parameters. The route design contradicts the Cognito recommendation. |
| **`/auth/me` vs `/users/me` duplication** | 00, 06, 07 | Both `GET /auth/me` and `GET /users/me` exist. 00-OVERVIEW lists `/auth` group with "me" and `/users` group with "me". They appear to do the same thing (return current user profile). This is presumably for backward compatibility, but it's worth explicitly noting that one should be deprecated or that they're intentional aliases. |
| **Tags auth inconsistency** | 00 vs 06 | 00-OVERVIEW says tags are "Protected + Admin". 06-API-GATEWAY marks ALL tag routes (including `GET /tags` and `GET /tags/{id}`) as "admin enforced in Lambda". In many apps, reading tags is available to all authenticated users (e.g., for filtering recordings). Clarify whether tag reads are admin-only or available to all authenticated users. |
| **Budget alert amounts** | 09-MANUAL-AWS-SETUP | Step 11 sets the dev budget alert at **$150** with alerts at $120/$150. This contradicts the $15/month budget constraint stated everywhere else. Likely a typo — should be $15 with alerts at $12/$15. |
| **Secrets management: SSM vs env vars** | 01 vs 08 | 01-IAC says "JWT Secret" is stored in SSM Parameter Store. But with Cognito handling auth, there is no custom JWT secret anymore — Cognito manages its own signing keys. This row in the secrets table (01, line 176) is a leftover from the pre-Cognito design. |
| **`network-stack.ts` in stack list** | 01 vs 08 | 01-IAC lists `network-stack.ts` as a stack to create. 08-NETWORKING says it's a "no-op or skipped in dev". This is fine, but the CDK project structure in 01 should note that this stack is conditional (prod-only). |
| **Custom domain appears in two documents** | 06 vs 08 | Both 06-API-GATEWAY and 08-NETWORKING-SECURITY have custom domain setup sections with CDK code. This creates ambiguity about which stack owns the custom domain resource. Should be in one place only (likely 06 or a dedicated domain stack). |

---

## 2. Gaps Identified

### Gap 1: No testing strategy document

The plan mentions Jest in the legacy stack and "unit tests" in CI, but there is **no document defining the testing strategy** for the new architecture. Key questions unanswered:

- How to test Lambdas locally? (e.g., SAM local, direct invocation, or a test harness)
- How to run integration tests against DynamoDB? (DynamoDB Local? Real table in dev?)
- How to test the Cognito auth flow locally?
- What test coverage is expected before deploying?
- How to test API Gateway routing + authorizer locally?

**Recommendation**: Add a section to 07-LAMBDAS or create a dedicated testing document.

### Gap 2: No data seeding / initial data strategy

09-MANUAL-AWS-SETUP covers infrastructure prerequisites but says nothing about:

- How to create the first ADMIN user in Cognito + DynamoDB
- How to seed initial tags
- How to seed the 10 "free" recordings (upload files + create DynamoDB items)
- Whether there's a seed script or if this is manual

The project structure in 00 shows `aws/scripts/` for "seed data, etc." but no document describes what goes there.

**Recommendation**: Add a seeding section to 09-MANUAL-AWS-SETUP or 07-LAMBDAS.

### Gap 3: No error response format specification

07-LAMBDAS shows `{ message }` for errors and `{ errors: [...] }` for Zod validation failures. 08-NETWORKING shows `{ message }` for gateway errors. But there's no single document defining the **complete error response contract** that the frontend expects.

Legacy likely has a specific format. If the goal is "preserve API contract" (Guiding Principle #7), the exact error shapes should be documented — especially for validation errors, which change format when moving from express-validator to Zod.

**Recommendation**: Add an error response specification to 07-LAMBDAS or 06-API-GATEWAY.

### Gap 4: Pagination response format not specified

00-OVERVIEW mentions "pagination, search" for recordings and admin users. 07-LAMBDAS mentions "pagination and search work" in Definition of Done. But **no document specifies the pagination response shape** (offset vs cursor, page/limit params, response envelope).

DynamoDB uses cursor-based pagination (LastEvaluatedKey), which differs from the SQL offset/limit the legacy app likely uses. This is a potential **breaking change** for the frontend if not handled carefully.

**Recommendation**: Document the pagination strategy in 02-DATABASE-DYNAMODB or 07-LAMBDAS. Decide whether to translate DynamoDB cursors into page numbers for frontend compatibility or change the frontend.

### Gap 5: Recording search limitations not fully addressed

02-DATABASE-DYNAMODB mentions `contains(title, searchTerm)` filter for search. This is a **filter expression** applied after the query, meaning DynamoDB reads all items matching the key condition and then filters — it's not an index-based search. For a small dataset this is fine, but:

- It's case-sensitive by default
- It scans all recordings on every search request (consumes read capacity)
- No relevance ranking

The plan acknowledges "add OpenSearch/Algolia later if needed" but doesn't discuss the case-sensitivity issue or whether the legacy search is case-insensitive.

**Recommendation**: Note in 02-DATABASE-DYNAMODB that search will be case-sensitive unless titles are stored in a normalized form (e.g., lowercase copy for searching).

### Gap 6: No CORS for S3 presigned URL downloads

04-STORAGE-S3 configures CORS on the S3 bucket for "frontend domain(s)". But presigned URL downloads are direct GET requests to S3 — if the frontend triggers these via `fetch()` or XHR (rather than `<a>` tag navigation), S3 CORS must allow the frontend origin with `GET` method and appropriate headers.

The S3 CORS configuration is mentioned but the specific rules (allowed origins, methods, headers) are not detailed.

**Recommendation**: Add explicit S3 CORS rules to 04-STORAGE-S3.

### Gap 7: Cognito `custom:plan` sync on subscription change

03-AUTH-COGNITO describes dual storage (Cognito + DynamoDB) and says "admin Lambda updates both Cognito custom attributes AND the DynamoDB User item" for role/plan changes. But:

- What triggers a plan change? (Admin action? Payment webhook? Manual?)
- Is there a subscription/payment system at all, or is plan assignment purely admin-driven?
- If admin-driven, the admin Lambda needs `cognito-idp:AdminUpdateUserAttributes` — this is listed in 07-LAMBDAS and 08-NETWORKING, which is correct.

This isn't a gap in the plan per se, but the **plan-change workflow** is implicit. If it's always admin-driven, that should be stated explicitly.

### Gap 8: No mention of Cognito user migration or "building from scratch" confirmation

The memory/context says "building from scratch (no existing data)". This is critical because it means no user migration from legacy PostgreSQL to Cognito is needed. However, **none of the plan documents explicitly state this**. If someone reads the plan without that context, they might wonder about data migration.

**Recommendation**: Add a brief note in 00-OVERVIEW or 02-DATABASE-DYNAMODB: "This is a greenfield deployment — no data migration from the legacy database is required."

### Gap 9: `isFree` field — who sets it and when?

04-STORAGE-S3 and 02-DATABASE-DYNAMODB define `isFree` as a boolean on recordings. 07-LAMBDAS uses it for access control. But:

- Only admins can create recordings (per 00-OVERVIEW and 06-API-GATEWAY)
- Is `isFree` set at creation time? Can it be toggled later via update?
- The recording create/update Zod schema should include `isFree`

This is an implementation detail, but since it's central to the business model, it's worth a brief note.

### Gap 10: No `users` Lambda in the project structure for `/users/me`

07-LAMBDAS lists `voces-{env}-users` handling `/users/me` (1 endpoint). The code structure shows `aws/lambdas/users/handler.ts` and `me.ts`. But this Lambda does the same thing as `GET /auth/me` — fetch user from DynamoDB by Cognito sub. Consider whether a dedicated Lambda for a single endpoint that duplicates auth's `/me` is justified, or whether `/users/me` should route to the auth Lambda.

---

## 3. Structural Quality

### Document organization: Excellent

Each document follows a consistent template:
1. Goal
2. Current State (Legacy)
3. Target State
4. CDK Stack Design
5. Environment-Specific Configuration
6. Risks and Mitigations
7. Definition of Done

This makes the set easy to navigate and review.

### Dependency graph: Sound

```
01 (IaC) ← foundation for all
02 (DB)  ← depends on 01
03 (Auth) ← depends on 01
04 (S3)  ← depends on 01
05 (SES) ← depends on 01, references 03
06 (API GW) ← depends on 01, 03
07 (Lambdas) ← depends on 01-06
08 (Network) ← depends on 01-07
09 (Manual) ← standalone reference
10 (Well-Arch) ← standalone checklist
```

The only concern: 05-EMAIL-SES references Cognito's Custom Message Lambda trigger, which is defined in 07-LAMBDAS. This creates a soft circular dependency (05 needs to know about 07's trigger, 07 depends on 05). In practice this is fine — the trigger Lambda is deployed as part of the auth stack or email stack, not the main lambdas stack.

### Completeness: Very good

The plan covers infrastructure, application code patterns, security, monitoring, cost, and operational concerns. The Well-Architected Framework document (10) is a particularly strong addition that catches several items the other documents miss.

---

## 4. Recommendations Summary

### Must fix before implementation

| # | Issue | Severity | Action |
|---|---|---|---|
| 1 | Verification route uses `{token}` path param but Cognito uses codes | **High** | Change routes to accept code in POST body, not URL path |
| 2 | Budget alert typo ($150 instead of $15) | **Medium** | Fix in 09-MANUAL-AWS-SETUP step 11 |
| 3 | Stale "JWT Secret" in secrets table | **Low** | Remove from 01-IAC-GITHUB-ACTIONS secrets table |
| 4 | Pagination strategy undefined | **High** | Document DynamoDB cursor → page number translation |

### Should address before implementation

| # | Issue | Action |
|---|---|---|
| 5 | No testing strategy | Add testing approach (local DynamoDB, Lambda test harness) |
| 6 | No data seeding strategy | Document how to create first admin + seed data |
| 7 | Error response contract not specified | Define exact error shapes for frontend compatibility |
| 8 | No "greenfield" statement | Add explicit note that no data migration is needed |
| 9 | Tags read access ambiguity | Clarify if `GET /tags` is admin-only or all-authenticated |
| 10 | Custom domain ownership ambiguity (06 vs 08) | Pick one document to own it |

### Nice to have

| # | Issue | Action |
|---|---|---|
| 11 | S3 CORS rules for presigned downloads | Detail in 04-STORAGE-S3 |
| 12 | Search case-sensitivity note | Add to 02-DATABASE-DYNAMODB |
| 13 | `/auth/me` vs `/users/me` duplication | Document intent or deprecate one |
| 14 | Plan-change workflow | State explicitly that it's admin-driven |
| 15 | `isFree` field lifecycle | Note in recording CRUD documentation |

---

## 5. Overall Assessment

| Dimension | Rating | Notes |
|---|---|---|
| **Coherence** | 9/10 | Minor inconsistencies (route params, counts) but overall very tight |
| **Cohesion** | 10/10 | Each document has a clear, focused scope with no overlap issues |
| **Completeness** | 8/10 | Missing testing strategy, pagination spec, and error contract |
| **Accuracy** | 9/10 | One typo (budget), one stale reference (JWT secret), routes vs codes mismatch |
| **Actionability** | 9/10 | Clear Definitions of Done, CDK code snippets, and checklists throughout |
| **Cost awareness** | 10/10 | Every decision is evaluated against the $15/month constraint |

**Verdict**: This is a high-quality migration plan ready for implementation, with a short list of items to clarify first. The most important fix is aligning the verification/reset routes with Cognito's code-based flow, and defining the pagination strategy before coding begins.
