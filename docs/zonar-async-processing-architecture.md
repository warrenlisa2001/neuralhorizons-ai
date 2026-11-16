# ZONAR asynchronous processing architecture

## Purpose

Move reconciliation off the HTTP request path while preserving tenant isolation, verifiable source provenance, idempotency, and recoverability. This document is an implementation contract, not a claim that queue infrastructure is deployed.

## Current baseline

- Reconciliation is executed synchronously by `handleZonarReconciliationRun`.
- Each source CSV is limited by `ZONAR_CSV_LIMITS` to 2 MiB, 10,000 rows, and 100 columns.
- Source files and results use R2; run state and tenant metadata use D1.
- `reconciliation_runs` already has queued/running/succeeded/failed states and tenant-scoped source-file foreign keys.
- `processing_jobs` exists for single-file processing, but it is not the orchestration record for three-dataset reconciliation.
- `wrangler.jsonc` currently declares only the static-assets binding. D1, R2, Queue, identity-provider, and production bindings are not configured in this repository's Worker config.

## Target execution model

1. **Authenticated request** — validate the tenant access token and `jobs:run` permission. Accept only three distinct file IDs and an optional client idempotency key. Never accept object keys, tenant IDs, processor versions, or result paths from the body.
2. **Atomic job + outbox write** — use D1 batch/transaction semantics to insert a tenant-scoped `reconciliation_runs` row in `queued` state and a corresponding outbox row. Enforce a unique tenant/idempotency-key constraint so retries of the same client request return the original run.
3. **Outbox dispatcher** — a scheduled Worker task claims a bounded batch of pending outbox rows, sends small messages containing only the run ID and schema/version marker to Cloudflare Queues, then marks the outbox delivery attempt. Queue send and D1 cannot be one distributed transaction; therefore delivery is at-least-once, not exactly-once.
4. **Queue consumer** — validate the message shape, load the run by ID, and claim it with a compare-and-set update and expiring lease. Resolve tenant and source file metadata from D1, verify each R2 object's byte size and SHA-256, then process only the server-selected objects.
5. **Bounded processing** — process in bounded chunks/batches with explicit limits for input bytes, rows, columns, memory, output bytes, wall-clock time, and per-tenant concurrency. The first asynchronous release may retain the current CSV limits; asynchronous execution alone does not make larger files safe.
6. **Durable result** — write the result to a tenant-scoped R2 key, calculate and persist its checksum and summary, persist operational events, then mark the run succeeded. Keep provenance and output writes idempotent.
7. **Retry and recovery** — queue retries use bounded attempts and backoff. Expired leases are recoverable. A scheduled reconciler re-enqueues queued runs whose outbox delivery is stale and marks exhausted jobs failed with a safe error code. Duplicate messages must not create duplicate events or overwrite a completed result.
8. **Status API** — return `202 Accepted` with a run ID and status URL from the request route. Clients poll the tenant-scoped run endpoint; status includes queued/running/succeeded/failed, timestamps, safe error code, and progress where it is genuinely measured.

## D1 model additions required

Add an additive migration for:
- A tenant-scoped idempotency key and request fingerprint on reconciliation runs.
- Attempt count, maximum attempts, lease token/expiry, last-attempt timestamp, and updated timestamp.
- An outbox table with unique run association, pending/sent/dead-letter state, attempt count, next-attempt time, and timestamps.
- Indexes for pending outbox dispatch and stale running-lease recovery.
- Constraints and triggers preserving tenant/source ownership and valid state transitions.

Do not store raw CSV rows, bearer tokens, customer PII, or source object contents in queue messages or outbox rows.

## Queue and Worker configuration

The deployment must explicitly provision and bind:
- A Cloudflare Queue producer and consumer with a dead-letter queue.
- A D1 binding for the ZONAR database.
- An R2 binding for tenant source and result objects.
- A scheduled trigger for outbox dispatch and lease recovery.

Queue names, D1 database IDs, R2 bucket names, concurrency, retry limits, and schedules must come from the actual Cloudflare environment. Do not invent IDs or imply the resources exist. Keep local/test configuration separate from production.

## Security and operational requirements

- Authenticate and authorize at enqueue time; re-check tenant, file ownership, active membership, and tenant status in the consumer.
- Treat queue messages as untrusted, even when produced by this Worker.
- Use tenant-scoped SQL predicates for every read and write.
- Use a random lease token and compare-and-set updates to prevent stale workers from completing a reclaimed run.
- Keep source provenance immutable; never derive financial exposure from a mismatch without a validated calculation and currency.
- Record actor attribution for user-requested work and system attribution for dispatcher/consumer activity.
- Make cleanup idempotent; do not delete a successful result because a duplicate message arrives.
- Emit operational telemetry for queue age, dispatch lag, processing duration, retries, dead letters, and per-tenant backlog without exposing tenant data.

## Delivery sequence

### A. Durable job contract
Migration, enqueue endpoint, outbox dispatcher, queue consumer, leases, idempotency, status endpoint, and tests using fake D1/R2/Queue bindings.

### B. Resumable ingestion
Replace whole-object `arrayBuffer()` and whole-file string parsing with streaming or chunked ingestion. Define supported formats, encoding, compression, row/column limits, malformed-row handling, and per-tenant quotas. Profile memory and CPU under realistic large-file fixtures.

### C. Production infrastructure
Provision D1/R2/Queues/DLQ and scheduled triggers in a non-production environment, apply migrations deliberately, configure the identity provider, and run authenticated end-to-end tests with isolated tenants.

### D. Dashboard integration and release
Connect the workspace to the status and event APIs, display measured progress and timestamps, test failure/retry states, then deploy only after explicit release approval.

## Release boundary

This design document does not provision Cloudflare resources, apply migrations, configure identity, deploy a Worker, increase the current file limits, or enable a customer-facing feed. The existing synchronous route remains the active implementation until the asynchronous path is implemented, tested, and deliberately released.
