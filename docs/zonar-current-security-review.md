# Zonar current code security review

Review target: branch `zonar/security-hardening`, source `src/index.js`, Worker config `wrangler.jsonc`, and `tests/zonar-profile.test.mjs`.

This is a repository code review, not a penetration test, production account inspection or deployment verification.

## Verified findings

### 1. Current profile endpoint is not customer login

`POST /api/zonar/profile` uses one shared Worker secret, `ZONAR_UPLOAD_TOKEN`, as a bearer credential. This is suitable only as a controlled temporary integration gate. It does not identify individual users, businesses, roles or tenant memberships. It cannot enforce multi-business data isolation because the endpoint currently stores no data and has no tenant model.

**Action:** retain the endpoint's fail-closed behavior during the transition, but do not expose the shared secret in browser code or build a public upload form around it. Replace it with verified user identity and tenant authorization before customer-facing ingestion.

### 2. Current CSV endpoint is memory-only

The handler returns `storage: not_stored`. It does not write uploads or profiles to R2/D1. This reduces persistence exposure today, but it also means there is no stored customer dataset to back up from this endpoint.

**Action:** keep this behavior until identity, tenant-scoped persistence and recovery controls are ready.

### 3. Worker config has no customer-data storage bindings

The checked-in `wrangler.jsonc` declares the static `ASSETS` binding only. It does not declare an R2 bucket or D1 database.

**Action:** do not add guessed binding names or deploy storage code until the actual Cloudflare resources exist and their IDs/bindings have been confirmed.

### 4. News API has wildcard CORS

The `/api/news` response sets `Access-Control-Allow-Origin: *`. This endpoint returns public news content and does not expose customer data in the reviewed implementation. It should remain separate from authenticated Zonar APIs. Do not copy this permissive CORS policy to customer-data routes.

### 5. Security headers are not set by the Worker API helper

The `zonarJson` helper sets JSON content type and `Cache-Control: no-store`, but does not set API response security headers such as `X-Content-Type-Options: nosniff`. Static-site headers may be configured elsewhere, but that has not been established by this source review.

**Action:** before customer-facing API release, define and test a consistent security-header policy for API responses and static pages. Do not assume static-host headers cover Worker-generated responses.

### 6. CSV parser enforces basic structure, not business correctness

It limits request bytes, rows and columns; rejects invalid UTF-8 and unclosed quotes; and flags blank/duplicate headers and row-width mismatches. It does not yet validate numeric/date fields, duplicate transactions, formula injection in later exports, business rules or cross-file relationships.

**Action:** treat profiling as structural validation only. Add domain validation as a separately versioned processing stage. Escape spreadsheet formula-leading values when generating downloadable CSV/XLSX outputs.

## Recommended next engineering milestone

Implement a testable security foundation without connecting customer storage yet:
1. Add response security headers to Worker-generated API responses.
2. Add request correlation IDs without logging credentials or customer payloads.
3. Add explicit content-length pre-check where present while retaining streaming byte enforcement.
4. Add tests for oversized streaming bodies, invalid UTF-8, missing secret configuration, and security headers.
5. Keep customer identity/tenant authorization as a separate next stage after the identity provider decision.

## Not verified

- Production Worker source and current deployed version.
- Cloudflare account MFA, members, API tokens, WAF, rate limits, DNS and access logs.
- GitHub branch protection, collaborator permissions, secret scanning and Actions configuration.
- Any live R2/D1 resource, backup policy, retention lock or recovery exercise.
- Any external penetration test, vulnerability scan or compliance certification.

No production changes were made by this review.
