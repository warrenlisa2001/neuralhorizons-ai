# Zonar identity and tenant-access design

## Product decision

Zonar is a business-to-business multi-tenant application. Use a shared identity pool: one person can have one login and memberships in one or more business workspaces. Each business workspace is a tenant with its own users, roles, files, records, integrations and audit history.

## Recommended identity approach

Evaluate Clerk Organizations as the preferred managed identity provider for the first customer-facing implementation, subject to account ownership, pricing, data-processing terms, regional/data-residency review and Lisa's approval before connection.

Reasons it is a plausible fit:
- Organizations model business workspaces and memberships.
- A user can belong to multiple organizations and hold different roles in each.
- Organization switching and invitations are supported.
- MFA and enterprise identity connections are available on supported plans.
- Clerk documents a shared-user-pool B2B SaaS model.

Official product documentation:
- https://clerk.com/docs/guides/organizations/overview
- https://clerk.com/docs/guides/how-clerk-works/multi-tenant-architecture

This is a recommendation, not a connected service or implemented integration. Do not create an account, configure production credentials, or add a provider SDK until the provider and plan have been approved.

## Application authorization model

The identity provider proves who the user is. Zonar's backend remains responsible for deciding what that user may do.

Minimum entities:
- `tenants`: one row per business workspace; immutable internal ID and status.
- `users`: local profile keyed to the provider's immutable user subject.
- `memberships`: user-to-tenant relationship and tenant-specific role.
- `invitations`: tenant-scoped invitations with expiry and single-use acceptance.
- `audit_events`: append-only record of security-sensitive actions.

Initial roles:
- `tenant_owner`: manage business workspace, billing contact, members and all tenant data.
- `tenant_admin`: manage members and tenant configuration, but not transfer ownership.
- `analyst`: view and analyse permitted tenant data; no member administration.
- `operator`: upload and process permitted operational files; no user administration.
- `viewer`: read-only access to explicitly permitted reports.

A future Neural Horizons platform-support role must be separate from tenant roles, require MFA, be time-bound where practical, and log every access to customer data.

## Backend authorization rules

1. Verify the identity-provider token on the server: signature, approved algorithm, issuer, audience, expiry and not-before claims.
2. Resolve the user's active tenant from a verified organization claim and confirm an active local membership.
3. Check the required permission for every API action; frontend hiding of controls is not authorization.
4. Derive tenant ID from verified identity and server-side membership, never trust a browser-supplied tenant ID.
5. Scope every database query, object-storage key, export, background job and agent task to that tenant.
6. Deny by default if tenant, membership, role or token claims are missing or inconsistent.
7. Do not let a cached authorization decision outlive the token or membership revocation policy.
8. Test cross-tenant ID substitution, direct object access, exports, background jobs and agent tool calls.

## Session and credential requirements

- Prefer short-lived signed access tokens and asymmetric signature verification.
- Keep provider secret keys in Cloudflare Worker secrets, never in GitHub or browser code.
- Use secure, HttpOnly, SameSite cookies if cookie sessions are selected; add CSRF protection to state-changing requests.
- Enforce MFA for tenant owners/admins and all platform-support accounts.
- Provide immediate user deactivation, membership revocation and provider session revocation.
- Rotate secrets and document emergency credential rotation.
- Avoid logging tokens, cookies, passwords, CSV content or sensitive personal/business data.

## Build sequence

1. Approve identity provider and account/plan.
2. Create schema and migration for tenants, users, memberships, invitations and audit events.
3. Implement server-side token verification and tenant/role authorization middleware.
4. Add tenant-scoped APIs and storage access helpers.
5. Add login, invitations, workspace switching and member-management UI.
6. Add negative security tests proving cross-tenant access is denied.
7. Complete independent security review before production release.

## Current status

No identity provider is connected. No user login or multi-tenant authorization has been implemented. The existing shared upload token is only a temporary endpoint credential and must not be treated as the final customer access model.
