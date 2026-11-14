# HALU

Cross-department intelligence agent. HALU consumes ZONAR's **verified** findings and turns them into briefings for department heads. ZONAR is the system of record; HALU never writes to it.

## Boundaries (non-negotiable)
- **Verified data only.** HALU reads `zonar.findings.v1`, which ZONAR serves only for runs that are `succeeded` and have their completion audit. Anything else is a hard error (`RUN_NOT_VERIFIED`, `RUN_NOT_COMPLETE`), never a partial answer.
- **Every statement traces to a source.** Each finding carries file id, dataset, CSV row number and record/order ids. Briefings keep that evidence; a future language-model layer may explain facts but must not introduce unreferenced ones.
- **One tenant per credential.** The service principal is bound to a single tenant in ZONAR's registry. Cross-tenant reads are impossible by construction and return 403.
- **Read-only, least privilege.** The only permission is `findings:read`. A HALU token cannot call any user route (upload, run, manage).
- **Every read is audited** in ZONAR (`findings.read`, with the calling app id). If the audit write fails, no data is returned.

## Layout
| File | Purpose |
|---|---|
| `src/entra-token.js` | Entra client-credentials token provider (cached, early refresh, no secret in errors) |
| `src/zonar-findings-client.js` | Paged, typed, retrying client for the findings feed |
| `src/briefing.js` | Deterministic briefing: counts by severity/code/dataset with capped evidence |
| `src/run-watcher.js` | Polls ZONAR's `verified-runs` feed, delivers each new run at-least-once (cursor advances only after delivery) |
| `src/views/finance.js` | Finance view: over/under-invoiced totals, uninvoiced orders, invoices without orders, with evidence |
| `tests/halu.test.mjs`, `tests/watcher.test.mjs` | Unit tests (no network) |

## Not built yet
- A runtime (Worker cron or scheduled job) that calls `pollOnce()` and a durable cursor store (today only an in-memory one exists).
- A delivery target for the finance view (email, Teams, dashboard); `deliver` is a plug-in function.
- The language-model explanation layer, and delivery to departments.
- Operations and procurement views (finance exists).
- Other data sources beyond ZONAR.

## Connecting HALU to a ZONAR tenant
See "HALU service principal" in `docs/zonar-staging-provisioning-runbook.md`.

## How a run reaches HALU
1. ZONAR finishes a run and writes its completion audit; the run now appears in `GET /api/zonar/tenants/:t/verified-runs`.
2. `createRunWatcher(...).pollOnce()` lists runs after its saved cursor, reads each run's findings, builds the briefing and finance view, and calls `deliver`.
3. Delivery is at-least-once: key on `idempotency_key` (`tenant:run`). A run that can never be read (not verified, legacy result) is skipped and reported; auth or network failures stop the poll and are retried next time.
