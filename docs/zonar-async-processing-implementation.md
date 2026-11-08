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
- `ZONAR_DB`: the intended D1 database, with migrations 0001–0006 applied in order.
- `ZONAR_FILES`: the tenant source/result R2 bucket.
- `ZONAR_RECONCILIATION_QUEUE`: a Cloudflare Queue producer binding, with a consumer configured to invoke the Worker's exported `queue` handler.
- `ZONAR_ASYNC_ENABLED=true`: an explicit feature flag. The enqueue endpoint returns `503` unless the flag, D1, R2 and Queue producer are all present; the scheduled handler is also gated by this flag.
- A scheduled trigger invoking the Worker's exported `scheduled` handler (recommended every minute). Set the feature flag only after the trigger and queue consumer are configured and verified.

The actual queue name, D1 database ID, R2 bucket, consumer retry/DLQ policy, concurrency, cron schedule, and production identity-provider values must be taken from the real Cloudflare environment. This PR does not invent or provision them.

## Deliberate limits and release boundary

- Source processing still uses the existing 2 MiB / 10,000-row / 100-column CSV parser limits. Async execution does not remove those limits.
- This increment still reads each bounded source object into memory. Resumable streaming/chunked ingestion and materially larger production limits are a separate required phase.
- No migration is applied to a live D1 database; no production binding, Queue, DLQ, scheduled trigger or identity provider is configured here.
- No production deployment or customer-facing release is authorized by this code change.
- The synchronous route remains available until the async route has passed isolated-tenant end-to-end tests and a deliberate cutover decision.

## Verification still required

CI unit/schema tests must pass, including bounded dispatch retries and exclusion of non-queued runs. Before production use, provision a non-production D1/R2/Queue environment, apply migrations deliberately, configure authentication, and run end-to-end tests for idempotency, duplicate delivery, queue-send failure, lease expiry, retry exhaustion, stale-worker fencing, tenant isolation, result integrity, and status polling.
