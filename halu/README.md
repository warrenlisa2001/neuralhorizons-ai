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
| `src/worker.js`, `src/d1-store.js` | Cloudflare cron Worker: polls each configured tenant, stores briefings once in HALU's own D1, optional summary-only webhook |
| `migrations/0001_halu.sql`, `wrangler.halu-staging.jsonc` | HALU database schema and staging config (placeholders must be filled; the Worker refuses to run with any left) |
| `src/api.js` | Read API for people: `/api/halu/workspaces`, `/api/halu/tenants/:t/briefings[/:run]`. Delegates sign-in to ZONAR's identity endpoint |
| `src/readiness.js`, `migrations/0002_governance.sql` | The four-condition gate (data, defined, governance, free), boundary letters, definitions register and decision log |
| `src/views/finance.js` | Finance view: over/under-invoiced totals, uninvoiced orders, invoices without orders, with evidence |
| `tests/halu.test.mjs`, `tests/watcher.test.mjs` | Unit tests (no network) |

## Not built yet
- Deployment: nothing is deployed. The Worker, config and schema exist and are tested, but no HALU database, secret or Entra app exists yet.
- A web page for the read API (the API exists and is tested; a front end with Entra sign-in does not). Reads by people are not yet access-logged.
- The language-model explanation layer, and delivery to departments.
- Operations and procurement views (finance exists).
- Other data sources beyond ZONAR.

## Connecting HALU to a ZONAR tenant
See "HALU service principal" in `docs/zonar-staging-provisioning-runbook.md`.

## How a run reaches HALU
1. ZONAR finishes a run and writes its completion audit; the run now appears in `GET /api/zonar/tenants/:t/verified-runs`.
2. `createRunWatcher(...).pollOnce()` lists runs after its saved cursor, reads each run's findings, builds the briefing and finance view, and calls `deliver`.
3. Delivery is at-least-once: key on `idempotency_key` (`tenant:run`). A run that can never be read (not verified, legacy result) is skipped and reported; auth or network failures stop the poll and are retried next time.

## Deploying HALU to staging (after ZONAR staging works)
1. `wrangler d1 create halu-staging-db`, then put its id in `halu/wrangler.halu-staging.jsonc`.
2. `wrangler d1 migrations apply halu-staging-db --remote --config halu/wrangler.halu-staging.jsonc`
3. Fill the `REPLACE_WITH_*` vars (ZONAR host, ZONAR app id, Entra directory id, HALU client id, tenant ids).
4. `wrangler secret put HALU_CLIENT_SECRET --config halu/wrangler.halu-staging.jsonc`
5. Optional: `HALU_WEBHOOK_URL` (https only). The webhook receives headline and totals, never row-level evidence.
6. `wrangler deploy --config halu/wrangler.halu-staging.jsonc`. It runs every 5 minutes; check `halu_briefings` and `halu_cursors`.
Uses a cron trigger, so the account needs room for it (Free allows 5 cron triggers per account; ZONAR staging already uses one).

## Read API (for people)
The caller sends their own ZONAR access token (`Authorization: Bearer ...`, scope `access_as_user`). HALU forwards it to ZONAR's `/api/zonar/me`, which verifies it and returns the person's active workspaces and roles. HALU then serves only workspaces it is configured for (`HALU_TENANTS`) where the role may read (`HALU_READER_ROLES`, default all five). Consequences: no user table or signing keys in HALU; removing someone's ZONAR membership removes their HALU access on the next request; another tenant's data is unreachable (403, or 404 for a guessed run id). Responses are `no-store`; CORS allows one configured origin only (`HALU_ALLOWED_ORIGIN`), never a wildcard.

## The readiness gate
**Opt-in.** Off by default so staging and pilots deliver immediately. Set `HALU_REQUIRE_READINESS=true` to enforce it for a client rollout. When on, HALU delivers nothing for a tenant until four conditions hold for the use case (`reconciliation_briefing` today):

| Condition | What must be true | Where it lives |
|---|---|---|
| Data | Recorded evidence that the data exists and is trustworthy | `halu_readiness.data_ok` + `data_evidence` |
| Defined | Every linked term has one agreed definition, a named owner and a signer | `halu_definitions`, `halu_use_case_definitions` |
| Governance | An active boundary letter: signed by the business owner, names an escalation owner, permits `deliver_briefing`, not expired | `halu_boundaries` |
| Free | No blocking dependency recorded (another system or migration in progress) | `halu_readiness.blocked_by` empty |

Behaviour: the gate is checked before any ZONAR call and again before every run is delivered. If it is closed, nothing is delivered, the cursor does not move, a `withheld` decision is logged once per distinct reason, and the backlog flows when it opens. Every delivery is logged with the boundary letter that permitted it. Anything missing counts as closed: an unregistered tenant is never open by default. HALU never writes these rows itself; an operator does, so the people accountable are the ones who sign.

Verdicts, first failing condition wins: `on_data`, `blocked_by_dependency`, `once_defined`, `on_governance`, `build_now`.

### Opening the gate for a tenant (staging seed)
Use real names and real evidence. Values below are placeholders.
```sql
INSERT INTO halu_use_cases (tenant_id, use_case_key, title) VALUES ('<tenant>', 'reconciliation_briefing', 'Reconciliation briefing');
INSERT INTO halu_definitions (id, tenant_id, term, definition, owner, agreed_by, agreed_at, status)
  VALUES ('def_1', '<tenant>', '<term>', '<one agreed meaning>', '<named owner>', '<who signed>', datetime('now'), 'agreed');
INSERT INTO halu_use_case_definitions (tenant_id, use_case_key, definition_id) VALUES ('<tenant>', 'reconciliation_briefing', 'def_1');
INSERT INTO halu_readiness (tenant_id, use_case_key, data_ok, data_evidence, blocked_by, assessed_by)
  VALUES ('<tenant>', 'reconciliation_briefing', 1, '<what was checked, against what, by whom>', NULL, '<assessor>');
INSERT INTO halu_boundaries (id, tenant_id, use_case_key, allowed_actions, escalation_owner, signed_by)
  VALUES ('bl_1', '<tenant>', 'reconciliation_briefing', 'deliver_briefing', '<escalation owner>', '<business owner>');
```
Close it at any time with `UPDATE halu_boundaries SET status='revoked' WHERE id='bl_1';`.

## The HALU page and Ask HALU
`GET /` on the HALU Worker serves the page: sign in with Microsoft, pick a workspace, see the latest verified runs with the finance view and findings by type, and (when enabled) ask questions.
- **Sign-in** is the authorisation-code flow with PKCE straight to Entra. No secret, no library, nothing stored but the access token in `sessionStorage` for the tab. Access is still decided by ZONAR: the token is forwarded to ZONAR's identity endpoint, so removing someone from ZONAR removes them from HALU.
- **Entra setup (one-off):** register a *Single-page application* whose redirect URI is the Worker URL (e.g. `https://halu-staging.<account>.workers.dev/`), grant it the delegated permission `access_as_user` on the ZONAR API, and put its id in `HALU_SPA_CLIENT_ID`. Make sure the ZONAR API's access-token version is 2.
- **Ask HALU:** `POST /api/halu/tenants/:t/ask` sends the stored briefing and finance view for that tenant and run to Claude with instructions to answer only from that data. Switch on with the secret `HALU_ANTHROPIC_API_KEY`. Questions are logged in `halu_ask_log` (per-tenant limit `HALU_ASK_LIMIT_PER_HOUR`, default 60). Without the key the box is hidden and the API answers 503.
- **What the model sees:** one run's briefing and finance view for the caller's own workspace. Not other tenants, not ZONAR credentials, not raw files. The text of findings is treated as data.
