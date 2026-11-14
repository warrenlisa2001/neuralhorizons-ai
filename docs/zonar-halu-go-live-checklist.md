# ZONAR + HALU staging go-live checklist

Order matters. Nothing here has been done yet; no Cloudflare or Entra changes have been made. Known values come from `wrangler.zonar-staging.jsonc` and the Cloudflare dashboard (13-14 Nov 2026).

| Known | Value |
|---|---|
| Entra directory (tenant) ID | `c6993c9c-10dd-4cfe-ba91-157272624bd6` |
| ZONAR API app (client) ID / token audience | `68673793-9332-440b-ab12-d181b1128a17` |
| ZONAR delegated scope | `access_as_user` |
| ZONAR staging D1 | `zonar-staging-db`, `67a07ade-3b53-4960-b169-a9e1440994f1` |
| ZONAR staging bucket | `zonar-staging-files` |

## Part A. Entra (can be done any time; no Cloudflare needed)

**A1. Make sure ZONAR accepts v2 tokens.** ZONAR checks `iss = https://login.microsoftonline.com/<dir>/v2.0`. In Entra admin centre: App registrations > the ZONAR API app > Manifest > confirm `requestedAccessTokenVersion` (Microsoft Graph app manifest) / `accessTokenAcceptedVersion` (AAD Graph manifest) is `2`. If it is `null` or `1`, tokens carry a different issuer and every request is rejected.

**A2. Add the app role HALU needs.** Same app > App roles > Create app role:
- Display name: `Read ZONAR findings`
- Allowed member types: **Applications**
- Value: `Zonar.Findings.Read` (must match exactly; override with `ZONAR_SERVICE_ROLE` only if you choose another)
- Description: `Read verified reconciliation findings`
- Enable this app role: checked

**A3. Register HALU.** App registrations > New registration: name `HALU staging`, supported account types **single tenant**, no redirect URI. Note its Application (client) ID.

**A4. Give HALU a secret.** HALU app > Certificates & secrets > New client secret (6 months). **Copy the Value immediately.** Keep it only in a password manager; you will paste it into `wrangler secret put` on Monday. Never put it in chat, git or a config file.

**A5. Grant the permission.** HALU app > API permissions > Add a permission > APIs my organisation uses > ZONAR API app > **Application permissions** > `Zonar.Findings.Read` > Add. Then **Grant admin consent for <directory>**. The status column must show a green tick.

**A6. Check a real token (optional but worth it).** With the secret in an environment variable, request a token and decode the payload at jwt.ms or locally:
```bash
curl -s -X POST "https://login.microsoftonline.com/c6993c9c-10dd-4cfe-ba91-157272624bd6/oauth2/v2.0/token" \
  -d grant_type=client_credentials -d client_id=<HALU client id> \
  --data-urlencode "client_secret=$HALU_CLIENT_SECRET" \
  --data-urlencode "scope=api://68673793-9332-440b-ab12-d181b1128a17/.default"
```
Expect: `iss` ends `/v2.0`, `aud` = `68673793-...`, `azp` = HALU client id, `roles` contains `Zonar.Findings.Read`, **no `scp`**. If `aud` is an `api://` URI or `iss` starts `sts.windows.net`, A1 is not set to 2.

## Part B. Monday: Cloudflare (needs Workers Paid)

1. **Upgrade the account to Workers Paid.** (Free allows 50 D1 queries and 10 ms CPU per invocation; the staged pipeline cannot run inside that.)
2. **Check what is already in `zonar-staging-db`** before applying anything. Run in D1 Console: `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;` and, if present, `SELECT name FROM d1_migrations ORDER BY id;`. 9 tables suggests only `0001`-`0002` ran. Migration `0004` uses `ALTER TABLE ... ADD COLUMN`, which is not re-runnable, so apply only the migrations that are missing, in order, up to `0011`. Do not blindly re-run `0001`-`0003`.
3. **Create the queues:** `zonar-staging-reconciliation` and `zonar-staging-reconciliation-dlq`.
4. **Put the real D1 id** (`67a07ade-3b53-4960-b169-a9e1440994f1`) into `wrangler.zonar-staging.jsonc` and deploy with both flags still `"false"`.
5. **Smoke test:** an unauthenticated call to `/api/zonar/tenants/x/verified-runs` returns `401`, not `5xx`.
6. **Seed synthetic data** per the provisioning runbook (a synthetic tenant, a synthetic user with a real token `iss`/`sub`).
7. **Register HALU for the tenant** (runbook, "HALU service principal"): one `service_principals` row with the HALU client id.
8. **Turn the flags on** (`ZONAR_ASYNC_ENABLED`, `ZONAR_RESUMABLE_UPLOADS_ENABLED` = `"true"`) and run the three-dataset journey and negative tests from the runbook.
9. **Confirm HALU can read:** a token from A6 returns `200` on `.../tenants/<tenant>/verified-runs` and `403` for any other tenant; an `audit_events` row `verified_runs.read` appears.

## Part C. HALU deploy (after Part B step 9)
HALU will deliver nothing until the readiness gate is open for the tenant: apply `halu/migrations/0001` and `0002`, then seed the gate rows (see "The readiness gate" in `halu/README.md`) with the real definition owner, evidence and a boundary letter signed by the business owner. A closed gate is the expected first state, not a fault.

Follow "Deploying HALU to staging" in `halu/README.md`. Still to fill: HALU D1 id, ZONAR staging host, HALU client id, tenant id. The Worker refuses to start while any `REPLACE_WITH_...` remains.

## Rollback
Set both ZONAR flags back to `"false"`; revoke HALU with `UPDATE service_principals SET status='revoked' ...`; delete the HALU client secret in Entra. Data and migrations are additive and can stay.
