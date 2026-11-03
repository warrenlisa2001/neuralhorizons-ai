# Zonar tenant-scoped data access

## Purpose

`src/zonar-tenant-data.js` provides the first D1 repository primitives for tenant-owned file metadata and processing jobs. It is deliberately separate from HTTP routes and storage providers.

## Security contract

- The caller must authenticate the request and check the required role permission before calling this module.
- The tenant ID must come from the successful server-side authentication result, never from a request body or browser-supplied role.
- Every file/job read is constrained by both `tenant_id` and resource ID.
- File listings exclude deleted rows and use parameterized, bounded pagination.
- Job creation uses a single `INSERT ... SELECT` statement that verifies the file belongs to the same tenant and is in an eligible state at insert time.
- Job status transitions are allow-listed and compare-and-set against the expected prior state, with tenant ID included in the update predicate.
- No dynamic user-provided SQL is accepted.

## Exposed functions

- `listTenantFiles(db, tenantId, options)`
- `getTenantFile(db, tenantId, fileId)`
- `getTenantProcessingJob(db, tenantId, jobId)`
- `createTenantProcessingJob(db, input)`
- `transitionTenantJob(db, input)`

## Not enabled yet

This module is not wired into a customer-facing file or job API. No D1 database is provisioned or bound in `wrangler.jsonc`; these operations cannot run against a live database yet. No file bytes are stored, no R2 bucket is configured, and no background processor or queue is active.

Before enabling these functions in an API route:
1. Authenticate with `authenticateZonarTenant`.
2. Enforce the exact action using `authorizeZonarAction`.
3. Pass only the returned `tenantId` to this repository.
4. Verify the tenant boundary for every new read, write, export, delete, queue consumer and agent tool.
5. Run integration tests against a real disposable D1 database, including cross-tenant negative cases.

Unit tests here inspect query construction and parameter binding using a D1-shaped test double. They are not a substitute for integration tests against Cloudflare D1.
