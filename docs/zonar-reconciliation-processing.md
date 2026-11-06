# ZONAR reconciliation processing

## Scope

The reconciliation run API connects three previously uploaded tenant files to the deterministic CSV ingestion and reconciliation pipeline:

- Orders CSV
- Invoices CSV
- Deliveries CSV

It is a synchronous, bounded first implementation. It is not a queue worker and must not be treated as a production-ready long-running job service.

## Required runtime configuration

The Worker must have these bindings configured before the endpoints can process customer data:

- `ZONAR_DB`: Cloudflare D1 binding containing the tenant foundation schema and migration `0002_reconciliation_runs.sql`.
- `ZONAR_FILES`: Cloudflare R2 bucket binding used by tenant file upload and reconciliation result storage.
- `ZONAR_ISSUER`, `ZONAR_AUDIENCE`, `ZONAR_JWKS_URL`: OIDC verification configuration used by `zonar-auth.js`.

The repository's current `wrangler.jsonc` does not declare the D1 or R2 bindings. Do not deploy these routes for customer use until real resource IDs, environment-specific bindings, secrets and migration state have been reviewed and configured. Never put credentials in this document or in source control.

Apply migrations in order to the intended D1 environment:

1. `migrations/0001_tenant_foundation.sql`
2. `migrations/0002_reconciliation_runs.sql`

The second migration adds the `reconciliation_runs` table with three composite tenant/file foreign keys, a same-tenant requester trigger, immutable tenant/source provenance and a tenant/created index.

## API

All routes require a valid bearer access token and active membership in the tenant identified by the URL. Tenant IDs and file IDs are validated server-side. The caller's role must include `jobs:run` to start a run and `jobs:read` to retrieve one.

### Start a run

`POST /api/zonar/tenants/{tenantId}/reconciliation-runs`

Content type: `application/json`

Request body:

```json
{
  "orders_file_id": "file-id-for-orders",
  "invoices_file_id": "file-id-for-invoices",
  "deliveries_file_id": "file-id-for-deliveries"
}
```

The three IDs must be distinct. Each must identify a non-deleted file in the authenticated tenant. The server retrieves object keys from D1; clients cannot supply R2 object keys.

Before parsing, the handler verifies each object's byte size and SHA-256 checksum against D1 metadata, then decodes UTF-8 and runs the strict CSV parser and reconciliation engine.

A successful response returns the run ID, processor version, summary, result checksum and whether the audit event was recorded. The full result is not embedded in the start response.

### Retrieve a run

`GET /api/zonar/tenants/{tenantId}/reconciliation-runs/{runId}`

The handler scopes the D1 lookup to the authenticated tenant. For completed runs it retrieves the R2 result, verifies its SHA-256 checksum against D1 and returns the parsed result. Non-completed runs return their current status without a result.

## Persistence and audit

- D1 stores the run ID, tenant, requester, three source file IDs, processor version, status, result object key, result checksum, summary and timestamps.
- R2 stores the full JSON reconciliation result under a server-generated tenant-scoped key.
- The result object is checksum-verified again when retrieved.
- Audit events record completion or failure without copying raw CSV content or full result rows.
- If the result is persisted but the audit write is unavailable, the API returns `audit_recorded: false` rather than deleting a valid result or misreporting the run as failed.

## Limits and known follow-on work

- Each source CSV retains the parser's independent 2 MB, 10,000-row and 100-column limits.
- The JSON request body is limited to 4 KB.
- The serialized result is limited to 4 MB.
- Processing currently runs synchronously in the request. Queue-based execution, retries, cancellation, idempotency keys, progress polling, result exports, HALU integration and production observability are not included.
- The current API does not automatically infer or mark confirmed financial loss or recovered revenue. Reconciliation discrepancies and calculated exposure must remain distinct from verified financial outcomes.
- Production enablement requires real D1/R2 binding configuration, migration application, OIDC configuration, security review and end-to-end tests using a dedicated non-production tenant.
