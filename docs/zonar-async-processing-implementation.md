# ZONAR asynchronous reconciliation implementation

This increment adds the first executable asynchronous job lifecycle on top of migration `0005_async_reconciliation_outbox.sql`. It is code-only and remains gated on explicit Cloudflare infrastructure configuration.

## API

Submit a reconciliation job:

`POST /api/zonar/tenants/{tenantId}/reconciliation-jobs`

The request requires a verified tenant access token with `jobs:run` permission and three distinct, tenant-owned file IDs:

```json
{
  "orders_file_id": "orders-file-id",
  "invoices_file_id": "invoices-file-id",
  "deliveries_file_id": "deliveries-file-id"
}
```

An optional `Idempotency-Key` header (or `idempotency_key` body field) makes retries return the original run. Reusing a key with different file IDs returns `409`. The server resolves object keys, tenant identity and processor version; clients cannot supply storage paths.

A successful enqueue returns `202 Accepted`, a run ID, and the existing tenant-scoped reconciliation-run status URL. The existing synchronous `POST /reconciliation-runs` route is intentionally unchanged during this rollout.

## Resumable source uploads

Migration `0007_resumable_upload_sessions.sql` adds tenant-owned upload sessions and unique per-part checkpoints. The new API is separate from the legacy bounded upload route:

- `POST /api/zonar/tenants/{tenantId}/files/uploads` creates a 24-hour session. The JSON body contains `filename` and `byte_size`.
- `PUT /api/zonar/tenants/{tenantId}/files/uploads/{uploadId}/parts/{partNumber}` uploads one part.
- `POST /api/zonar/tenants/{tenantId}/files/uploads/{uploadId}/complete` finalises the R2 multipart object and creates the tenant file record.
- `DELETE /api/zonar/tenants/{tenantId}/files/uploads/{uploadId}/abort` aborts an unfinished multipart upload.

The current deliberately conservative envelope is 1 GiB per file, 8 MiB per part, up to 128 parts, and 24-hour session expiry. Every part is size-checked and SHA-256 hashed in the Worker; D1 stores the part number, byte count, digest and R2 ETag. Part reservations prevent duplicate concurrent part numbers from silently overwriting one another. Finalisation requires a contiguous complete part set and verifies the completed R2 object size before creating the tenant file record. Repeating a completion request after a successful database commit returns the same tenant-owned file record rather than creating a duplicate. A request handles at most one 8 MiB part in memory; it does not assemble the entire file in Worker memory.

The endpoint requires the existing verified tenant identity and `files:upload` permission. Upload sessions are scoped to the initiating user and tenant. The current async reconciliation enqueue deliberately rejects files without a server-verified whole-object SHA-256 or files larger than its existing 2 MiB processing ceiling. This prevents newly uploaded multipart files from being queued into a consumer that cannot yet validate or stream them. This API is not yet wired into the browser workspace, and no live D1 migration or R2 multipart configuration has been applied. The 1 GiB ceiling is an implementation guardrail, not a production capacity or throughput guarantee.

## Runtime lifecycle

1. D1 batch writes the queued reconciliation run and its outbox row together. Migration 0006 bounds dispatch attempts (default 10); exhausted or orphaned outbox items are marked dead-letter for operator review.
2. The scheduled handler recovers expired consumer leases and dispatches a bounded batch of pending outbox rows.
3. The dispatcher leases rows with compare-and-set updates and sends only `{ version: 1, run_id }` to the Queue. Delivery is at-least-once.
4. The Queue consumer claims queued runs with a random lease token, resolves file ownership in D1, verifies R2 size and SHA-256, and runs the existing deterministic reconciliation pipeline.
5. The result is written to a lease-specific R2 object key. The run becomes successful only if the lease token is still current and unexpired. Operational events are persisted idempotently.
6. Transient processing failures are retried with bounded attempts. Deterministic source/data failures are terminal. Expired worker leases are recovered by the scheduled handler.

Queue messages and outbox rows contain no CSV rows, customer PII, object keys, bearer tokens, or other source contents.

## Required Cloudflare bindings (not provisioned by this change)

The Worker code expects:
- `ZONAR_DB`: the intended D1 database, with migrations 0001–0007 applied in order.
- `ZONAR_FILES`: the tenant source/result R2 bucket.
- `ZONAR_RECONCILIATION_QUEUE`: a Cloudflare Queue producer binding, with a consumer configured to invoke the Worker's exported `queue` handler.
- `ZONAR_ASYNC_ENABLED=true`: an explicit feature flag. The enqueue endpoint returns `503` unless the flag, D1, R2 and Queue producer are all present; the scheduled handler is also gated by this flag.
- A scheduled trigger invoking the Worker's exported `scheduled` handler (recommended every minute). Set the feature flag only after the trigger and queue consumer are configured and verified.

The actual queue name, D1 database ID, R2 bucket, consumer retry/DLQ policy, concurrency, cron schedule, and production identity-provider values must be taken from the real Cloudflare environment. This PR does not invent or provision them.

## Deliberate limits and release boundary

- The legacy upload and source-processing paths still use the existing 2 MiB / 10,000-row / 100-column CSV limits. The new multipart API stores large files in R2 but does not yet stream them through reconciliation; async execution does not remove those limits.
- The new upload endpoint is chunked and resumable at the storage boundary, but large-file parsing, bounded batch persistence, resumable row checkpoints and end-to-end reconciliation remain outstanding. The current reconciliation worker still reads bounded source objects into memory.
- No migration is applied to a live D1 database; no production binding, Queue, DLQ, scheduled trigger or identity provider is configured here.
- No production deployment or customer-facing release is authorized by this code change.
- The synchronous route remains available until the async route has passed isolated-tenant end-to-end tests and a deliberate cutover decision.

## Verification still required

CI unit/schema tests must pass, including bounded dispatch retries and exclusion of non-queued runs. Before production use, provision a non-production D1/R2/Queue environment, apply migrations deliberately, configure authentication, and run end-to-end tests for idempotency, duplicate delivery, queue-send failure, lease expiry, retry exhaustion, stale-worker fencing, tenant isolation, result integrity, and status polling.
