# ZONAR staging provisioning runbook

Scope: create an isolated, non-production staging environment and prove the three-dataset journey end to end. **Synthetic data only. Nothing here touches production.** This runbook is evidence-oriented: every step says what to record, because a green unit-test run is not proof of a working deployment.

Config file: `wrangler.zonar-staging.jsonc` (Worker `zonar-staging`). All commands pass `--config wrangler.zonar-staging.jsonc`.

## 0. Preconditions

- Deploy from the head commit of the ZONAR PR stack (record the full SHA). Do not deploy from an older preview.
- The async and upload flags in the config are `"false"`. They are switched on only in step 5.
- Entra values in `vars` (issuer, audience, JWKS URL, scope) are present in the config. Confirm them against the Entra app registration before relying on them.

## 1. Create resources

```
npx wrangler d1 create zonar-staging-db
npx wrangler r2 bucket create zonar-staging-files
npx wrangler queues create zonar-staging-reconciliation
npx wrangler queues create zonar-staging-reconciliation-dlq
```

Put the real D1 `database_id` into `wrangler.zonar-staging.jsonc` in place of `REPLACE_WITH_STAGING_D1_DATABASE_ID`. Decide whether to commit it: a D1 ID is an identifier, not a credential, but the readiness checklist treats resource IDs conservatively. If you prefer not to commit it, keep it in a local, uncommitted copy of the config.

**Record:** the database ID, bucket name, queue names, account, and who created them.

## 2. Apply migrations in order

```
npx wrangler d1 migrations apply zonar-staging-db --remote --config wrangler.zonar-staging.jsonc
npx wrangler d1 migrations list  zonar-staging-db --remote --config wrangler.zonar-staging.jsonc
```

Expected: `0001` through `0010`, all applied. Migrations `0005`-`0010` add the async outbox, upload sessions, file integrity columns, staging tables and engine outputs.

**Record:** the `migrations list` output and timestamp. A migration file existing in a branch is not evidence it ran.

## 3. Verify the schema

Run in the D1 console or via `wrangler d1 execute ... --command`:

```
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
PRAGMA foreign_key_check;
```

Expect these tables at least: `tenants, users, memberships, invitations, tenant_files, processing_jobs, reconciliation_runs, reconciliation_outbox, audit_events, tenant_upload_sessions, tenant_upload_parts, reconciliation_dataset_progress, reconciliation_staging_rows, reconciliation_engine_progress, reconciliation_order_results, reconciliation_result_links, reconciliation_exceptions, operational_events`. `foreign_key_check` should return no rows.

Note: `PRAGMA integrity_check` returned `SQLITE_AUTH` in the D1 console in an earlier session. Do not report it as passed; report only `foreign_key_check`.

## 4. Provision a synthetic tenant and user

Use the **issuer and subject exactly as they appear in a real access token** (`iss`, `sub`). Nothing is auto-provisioned from token claims.

```sql
INSERT INTO tenants (id, name) VALUES ('stg_tenant_a', 'Staging Tenant A');
INSERT INTO users (id, identity_issuer, identity_subject) VALUES ('stg_user_a', '<iss>', '<sub>');
INSERT INTO memberships (tenant_id, user_id, role) VALUES ('stg_tenant_a', 'stg_user_a', 'tenant_owner');
-- second tenant + user for the cross-tenant test
INSERT INTO tenants (id, name) VALUES ('stg_tenant_b', 'Staging Tenant B');
INSERT INTO users (id, identity_issuer, identity_subject) VALUES ('stg_user_b', '<iss-b>', '<sub-b>');
INSERT INTO memberships (tenant_id, user_id, role) VALUES ('stg_tenant_b', 'stg_user_b', 'tenant_owner');
```

## 5. Deploy, then enable

1. Deploy with flags still `"false"`: `npx wrangler deploy --config wrangler.zonar-staging.jsonc`. Record the version ID and the git SHA.
2. Check `GET /api/zonar/me` with no token returns 401 (negative path), and with a valid access token returns your identity.
3. Set `ZONAR_ASYNC_ENABLED` and `ZONAR_RESUMABLE_UPLOADS_ENABLED` to `"true"` and redeploy. Confirm in the Cloudflare dashboard that the queue producer, consumer and cron trigger are attached.

## 6. Three-dataset journey (maps to the report's acceptance gates)

Use small synthetic CSVs (orders, invoices, deliveries). Example headers: `order_id,quantity_ordered,order_value` / `invoice_id,order_id,quantity_invoiced,invoice_value` / `delivery_id,order_id,quantity_delivered`. Include a missing delivery, a quantity mismatch, an invoice for an unknown order and a duplicate ID.

| Gate | Action | Pass condition |
|---|---|---|
| 1 Auth / tenant | Call `/api/zonar/tenants/stg_tenant_a/access` with user A's token; repeat with user B's token against tenant A | A: 200 with role. B: denied. Expired / wrong-audience / no-scope tokens: 401 |
| 2 R2 retrieval | `POST /api/zonar/tenants/stg_tenant_a/files` (raw CSV body, `Content-Type: text/csv`, `X-Filename`) three times | Three file IDs; objects under `tenants/stg_tenant_a/files/<id>` in R2; D1 `tenant_files` rows with size and SHA-256 |
| 3 Job lifecycle | `POST .../reconciliation-jobs` with the three IDs and an `Idempotency-Key`; repeat the same request | First: 202 with run ID. Repeat: same run ID, no second run. Run goes `queued -> running -> succeeded` |
| 4 Streaming ingestion | Inspect `reconciliation_dataset_progress` | All three datasets `complete`; row counts match the CSVs |
| 5 Reconciliation | Inspect `reconciliation_order_results` and `reconciliation_exceptions` | Expected exceptions present, once each |
| 6 Results / audit | Query `audit_events` for `rc_<run_id>` | One `reconciliation.completed` event; run only `succeeded` because it exists |
| 7 HALU feed | `GET .../reconciliation-runs/<run>/findings` as user A; then as user B against tenant A | A: findings with source file ID and row numbers. B: denied. Query a queued run: 409 |
| 8 Operational proof | Re-run with a tampered R2 object (edit one byte of a test object) | Run `failed` with `SOURCE_INTEGRITY_FAILED`; no `reconciliation.completed` audit event |

Also test the multipart path (`/files/uploads`) with a file larger than 2 MiB, and an interrupted upload resumed.

## 7. Evidence to keep

Git SHA and Worker version ID; `migrations list` output; token claims used (never the tokens); run IDs and final D1 statuses; the findings response for run A; the denial responses for cross-tenant; the tampered-object failure; request IDs. Do not retain tokens or any non-synthetic data.

## 8. Known limits to measure here (not assumed)

- Source cap defaults to 64 MiB / 10,000 rows (`ZONAR_MAX_SOURCE_BYTES`, `ZONAR_MAX_SOURCE_ROWS`). Real D1 latency and per-invocation subrequest limits are unmeasured. Time a 5,000-row and a 10,000-row dataset before raising the caps.
- Findings feed requires a signed-in tenant user with `jobs:read`. A service identity for HALU is not yet designed.

## 9. Rollback

Set both flags back to `"false"` and redeploy (stops dispatch, recovery and uploads), detach the queue consumer if needed, and delete the staging D1 database, R2 bucket and queues. Staging holds synthetic data only.
