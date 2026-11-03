# Zonar authentication and tenant authorization implementation

## Implemented in this change

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

These are not configured by this code change. Do not use guessed values. The JWKS URL should be controlled by the selected identity provider; redirects are rejected. The Worker caches the JWKS for five minutes in its isolate.

## Tenant authorization contract

Every future tenant-scoped handler must:

1. Determine the requested tenant from a trusted route/resource context.
2. Call `authenticateZonarTenant(request, env, requestedTenantId)`.
3. Stop unless `ok === true`.
4. Use the returned `tenantId` for every database query, object key, export, queue message and agent/tool operation.
5. Enforce role permissions separately for each operation.

Never accept a tenant ID from an untrusted request body as proof of access. Never auto-create a membership from a JWT claim. Provision user and membership rows through a separately authorized onboarding process.

## Current limitations / not yet enabled

- No identity provider has been selected, connected or configured.
- No D1 database has been created or bound.
- The existing CSV profile endpoint still uses its temporary shared upload token and remains memory-only.
- This helper is not yet wired into a customer-facing route.
- It does not implement login, invitation acceptance, MFA policy, role-to-action policy, session management or user provisioning.
- No R2 storage, tenant file persistence, backup or restore has been enabled.
- Unit tests validate token verification and cross-tenant membership denial with a mocked JWKS endpoint and database; they are not a penetration test or live provider integration test.

Do not enable customer data ingestion until a real provider and D1 binding are configured, the helper is integrated into every tenant-scoped operation, cross-tenant negative tests cover every resource/action, and backup/restore controls have passed an actual restore exercise.
