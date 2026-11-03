# Zonar role-based access control

## Role policy

Authorization is deny-by-default and is implemented in `src/zonar-permissions.js`. Handlers must first authenticate the identity and resolve an active tenant membership with `authenticateZonarTenant`, then call `authorizeZonarAction` with the required permission.

| Role | Intended access |
|---|---|
| tenant_owner | Full tenant administration, including tenant-level management |
| tenant_admin | Manage members, files, jobs, exports, audit and settings; cannot perform owner-only tenant management |
| analyst | Read tenant data and create exports; cannot upload, run jobs or administer members |
| operator | Read and upload files, run processing jobs; cannot export or administer members |
| viewer | Read-only access |

## Permission keys

- `tenant:read`, `tenant:manage`
- `members:read`, `members:invite`, `members:revoke`
- `files:read`, `files:upload`, `files:delete`
- `jobs:read`, `jobs:run`
- `exports:create`
- `audit:read`
- `settings:read`, `settings:manage`

## Handler contract

1. Authenticate the bearer token.
2. Resolve active membership and tenant using the server-side D1 query.
3. Check the exact permission required for the operation.
4. Use only the authenticated `tenantId` for every subsequent data access.
5. Return 401 for missing authentication and 403 for an authenticated user lacking permission.

Never trust a role, tenant ID, user ID or permission supplied by the client. Every new API route, export, queue consumer, scheduled task and agent tool must apply the same checks before accessing tenant data.

## Limits

A first protected route is now wired at `GET /api/zonar/tenants/{tenantId}/access`. It verifies the bearer JWT, checks active membership in the requested tenant, applies `tenant:read`, and returns only the verified tenant ID and role. Cross-tenant access is denied. The route is currently fail-closed because no identity provider or D1 binding has been configured. The existing CSV profiler remains a separate temporary shared-token, memory-only endpoint. Every future tenant-scoped handler must repeat the authentication and permission checks before accessing customer data.

Role names and permissions are an initial product policy and should be reviewed before enabling external customer accounts.
