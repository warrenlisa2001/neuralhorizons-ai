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

This is the permission policy module and its unit tests. It does not yet protect existing routes automatically, because the existing CSV profiler is a temporary shared-token, memory-only endpoint and there are no persistent tenant data routes. The policy must be wired into every tenant-scoped handler before customer data is stored or processed.

Role names and permissions are an initial product policy and should be reviewed before enabling external customer accounts.
