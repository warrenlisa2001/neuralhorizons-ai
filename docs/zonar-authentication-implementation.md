# Zonar authentication and tenant authorization implementation

## Implemented

`src/zonar-auth.js` provides a provider-neutral authentication boundary for Cloudflare Workers:

- Accepts bearer JWTs signed with RS256 only.
- Verifies the signature against a configured JWKS document.
- Checks exact issuer, configured audience, subject, expiry and optional not-before time.
- Resolves the verified issuer/subject pair against the D1 users table.
- Requires an active user, active membership and active tenant.
- Restricts the membership lookup to the tenant ID supplied by the server-side route.
- Returns only the authenticated user ID, tenant ID and role.
- Fails closed when configuration, database access, identity verification or membership lookup fails.

No identity-provider SDK is required by this boundary. A provider must issue standard OIDC JWT access tokens with an RS256 signing key published in JWKS.

## Required Worker configuration before use

Set these values only after an identity provider has been selected and its exact values verified:

- `ZONAR_ISSUER`: exact issuer claim expected in access tokens.
- `ZONAR_AUDIENCE`: exact API audience expected in access tokens.
- `ZONAR_JWKS_URL`: HTTPS URL for the provider's signing-key JWKS.
- `ZONAR_DB`: D1 binding to the Zonar database.
- `ZONAR_FILES`: private R2 bucket binding used for tenant uploads and reconciliation results.

These values and bindings are not configured in the repository's current `wrangler.jsonc`. Do not use guessed values. The JWKS URL should be controlled by the selected identity provider; redirects are rejected. The Worker caches the JWKS for five minutes in its isolate.

## Tenant authorization contract

Every tenant-scoped handler must:

1. Determine the requested tenant from a trusted route/resource context.
2. Call `authenticateZonarTenant(request, env, requestedTenantId)`.
3. Stop unless `ok === true`.
4. Use the returned `tenantId` for every database query, object key, export, queue message and agent/tool operation.
5. Enforce role permissions separately for each operation.

Never accept a tenant ID from an untrusted request body as proof of access. Never auto-create a membership from a JWT claim. Provision user and membership rows through a separately authorized onboarding process.

## Current implementation status

- The protected tenant-access route is implemented at `GET /api/zonar/tenants/{tenantId}/access`.
- Tenant-scoped CSV upload/list handling is implemented at `/api/zonar/tenants/{tenantId}/files`; it uses the D1 and R2 bindings and the shared OIDC tenant-authentication boundary.
- Reconciliation run creation and result retrieval are implemented at `/api/zonar/tenants/{tenantId}/reconciliation-runs` and `/api/zonar/tenants/{tenantId}/reconciliation-runs/{runId}`.
- Role-to-action policy is implemented in `src/zonar-permissions.js`; tenant-scoped D1 repository primitives and audit helpers are used by the routes.
- Unit tests validate token verification, tenant membership and route behavior using mocked JWKS/D1/R2 dependencies. They are not a live identity-provider integration test or penetration test.

## Not yet enabled / remaining limitations

- No identity provider has been selected, connected or configured.
- No live D1 database or R2 bucket is declared in the current Worker configuration.
- The tenant schema and reconciliation-run migrations exist in the repository but have not been applied to a live ZONAR database.
- No production or staging user/membership provisioning process has been executed.
- No live Cloudflare staging end-to-end test has been evidenced.
- The legacy `/api/zonar/profile` endpoint remains a separate shared-token profile/preview path and is not the tenant-scoped persistent ingestion workflow.
- Login UI, invitation acceptance, MFA policy, session management and user provisioning workflows are not implemented here.
- Queue-based processing, retries, cancellation, idempotency, progress polling, HALU integration and production observability remain future work.
- Unit tests do not replace cross-tenant negative testing against a live isolated environment, a security review or a backup/restore exercise.

Do not enable customer data ingestion until a real identity provider and isolated D1/R2 resources are configured, migrations are applied and verified, every tenant-scoped route has passed live cross-tenant negative tests, and backup/restore controls have passed an actual restore exercise.
