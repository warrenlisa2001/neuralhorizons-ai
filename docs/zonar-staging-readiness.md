# ZONAR staging infrastructure readiness

> **Update (13 Nov 2026):** the "Current repository facts" below describe the original synchronous design and are out of date. The current stack (PRs #26, #29, #31) adds migrations `0001`-`0010`, queue-backed asynchronous processing with streaming staging, and a findings feed, and that code is **not on `main`**. For the up-to-date, ordered procedure see [`zonar-staging-provisioning-runbook.md`](zonar-staging-provisioning-runbook.md). The gates below remain valid as a checklist of intent.

## Purpose and release boundary

This checklist defines the prerequisites for the first isolated, non-production end-to-end ZONAR test. It does not provision Cloudflare resources, select an identity provider, create credentials or deploy a Worker.

The asynchronous upload, reconciliation and findings code lives on the open ZONAR PR stack, not on `main`. Neither location is evidence that the live service is configured or ready for customer data.

## Current repository facts

- `wrangler.jsonc` currently declares the Worker entry point, static assets and observability only.
- It does not declare a `ZONAR_DB` D1 binding or a `ZONAR_FILES` R2 binding.
- The authentication implementation expects `ZONAR_ISSUER`, `ZONAR_AUDIENCE`, `ZONAR_JWKS_URL` and `ZONAR_DB`.
- Tenant file storage and reconciliation processing additionally require `ZONAR_FILES`.
- Migrations `0001` through `0010` exist on the PR stack (tenant foundation, runs, operational events, outbox, upload sessions, file integrity, staging, engine outputs). None is evidenced as applied to a live database.
- The synchronous endpoint remains; the queue-backed job service (outbox, queue consumer, lease recovery) exists on the PR stack but its Wrangler staging bindings are only declared, not provisioned.
- No live resource IDs, provider-specific identity values, migration execution records or staging test evidence are stored in this repository.

## Gate 1 — decisions and resource creation

- [ ] Select an OIDC identity provider that issues RS256-signed access tokens and publishes a trusted HTTPS JWKS endpoint.
- [ ] Record and independently verify the exact issuer, API audience and JWKS URL from that provider.
- [ ] Create a dedicated non-production Cloudflare D1 database for ZONAR.
- [ ] Create a dedicated private non-production R2 bucket for ZONAR files and results.
- [ ] Confirm the staging Worker/environment and its permitted operators.
- [ ] Confirm data retention, test-data handling and deletion rules. Use synthetic data only.

Do not copy production customer data into staging.

## Gate 2 — Worker configuration

Configure the staging Worker only, using actual resource identifiers from Cloudflare:

- [ ] D1 binding name: `ZONAR_DB`, pointing to the dedicated staging database.
- [ ] R2 binding name: `ZONAR_FILES`, pointing to the private staging bucket.
- [ ] `ZONAR_ISSUER`: exact verified issuer.
- [ ] `ZONAR_AUDIENCE`: exact API audience.
- [ ] `ZONAR_JWKS_URL`: exact verified HTTPS JWKS URL.

Keep provider credentials and any client secrets in the appropriate Cloudflare secret store. Never commit credentials, private keys, tokens, resource IDs that are treated as sensitive, or customer data to Git.

Do not add fake IDs or guessed provider values to the production `wrangler.jsonc`. Keep staging and production resources separate and explicitly named.

## Gate 3 — database migration and identity provisioning

- [ ] Apply `0001_tenant_foundation.sql` to the staging D1 database.
- [ ] Apply `0002_reconciliation_runs.sql` after the foundation migration.
- [ ] Verify expected tables, indexes, foreign keys and triggers in D1.
- [ ] Create one synthetic staging tenant and an explicitly provisioned test user/membership through an approved administrative process.
- [ ] Verify the test identity's issuer/subject exactly matches the access token claims.
- [ ] Confirm no user or membership is created automatically from an untrusted token claim.

Record migration timestamps and environment identity in the staging change record.

## Gate 4 — end-to-end and negative testing

Use synthetic orders, invoices and deliveries only.

- [ ] Verify unauthenticated requests are rejected.
- [ ] Verify invalid issuer, audience, signature, expired token and unknown signing key are rejected.
- [ ] Verify inactive users, inactive memberships and suspended tenants are rejected.
- [ ] Verify a user in tenant A cannot list, upload, process or retrieve resources belonging to tenant B.
- [ ] Upload three distinct CSV files and verify their D1 metadata, R2 objects, byte sizes and SHA-256 values.
- [ ] Run reconciliation using the three tenant-owned file IDs.
- [ ] Verify the run metadata and source-file provenance in D1.
- [ ] Verify the result object exists in R2 and its checksum matches the D1 record.
- [ ] Retrieve the run and verify the result is returned only to an authorized member of the same tenant.
- [ ] Tamper with a test object in the isolated environment and verify integrity failure is detected.
- [ ] Verify audit events do not contain raw CSV data or full result rows.
- [ ] Verify discrepancy and calculated exposure labels are not presented as confirmed financial loss or recovered revenue.
- [ ] Capture request IDs, test evidence and observed failures without retaining tokens or source customer data.

## Gate 5 — recovery and operational controls

- [ ] Confirm private bucket access and least-privilege Worker bindings.
- [ ] Define staging retention and deletion behavior.
- [ ] Verify D1 export and R2 backup procedures.
- [ ] Complete a restore into an isolated destination and verify checksums and tenant separation.
- [ ] Configure monitoring and alerting for failed uploads, failed runs, integrity mismatches and unavailable dependencies.
- [ ] Document the rollback procedure and responsible operator.

A successful unit-test run or Cloudflare preview build does not satisfy this gate.

## Release decision

Staging may be marked **passed** only when all applicable gates have evidence and the live end-to-end test succeeds. Production enablement requires a separate review and explicit approval; it is not implied by a successful staging run.

## Information required to proceed with live configuration

The following must be supplied or confirmed by the Cloudflare and identity-provider administrators:

1. The selected OIDC provider and its verified issuer, audience and JWKS URL.
2. The staging D1 database identifier.
3. The staging R2 bucket name.
4. The intended staging Worker/environment name and deployment method.
5. Confirmation that synthetic test data and a test identity can be provisioned.

Do not send access tokens, passwords, private keys or API secrets in chat or commit them to GitHub.
