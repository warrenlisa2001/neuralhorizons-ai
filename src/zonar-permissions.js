// Server-side Zonar role-to-permission policy.
// Keep this as the single authorization policy used by tenant-scoped handlers.
// Never trust a role supplied by the browser or request body.

const ROLE_PERMISSIONS = Object.freeze({
  tenant_owner: Object.freeze([
    'tenant:read', 'tenant:manage',
    'members:read', 'members:invite', 'members:revoke',
    'files:read', 'files:upload', 'files:delete',
    'jobs:read', 'jobs:run',
    'exports:create',
    'audit:read',
    'settings:read', 'settings:manage'
  ]),
  tenant_admin: Object.freeze([
    'tenant:read',
    'members:read', 'members:invite', 'members:revoke',
    'files:read', 'files:upload', 'files:delete',
    'jobs:read', 'jobs:run',
    'exports:create',
    'audit:read',
    'settings:read', 'settings:manage'
  ]),
  analyst: Object.freeze([
    'tenant:read',
    'files:read',
    'jobs:read',
    'exports:create',
    'settings:read'
  ]),
  operator: Object.freeze([
    'tenant:read',
    'files:read', 'files:upload',
    'jobs:read', 'jobs:run',
    'settings:read'
  ]),
  viewer: Object.freeze([
    'tenant:read',
    'files:read',
    'jobs:read',
    'settings:read'
  ])
});

export function hasZonarPermission(role, permission) {
  if (typeof role !== 'string' || typeof permission !== 'string') return false;
  const permissions = ROLE_PERMISSIONS[role];
  return Array.isArray(permissions) && permissions.includes(permission);
}

/**
 * Apply the permission policy to a successful authenticateZonarTenant result.
 * This function deliberately fails closed for missing/unknown roles.
 */
export function authorizeZonarAction(authentication, permission) {
  if (!authentication || authentication.ok !== true ||
      !authentication.tenantId || !authentication.userId) {
    return { ok: false, status: 401, error: 'UNAUTHORISED' };
  }
  if (!hasZonarPermission(authentication.role, permission)) {
    return { ok: false, status: 403, error: 'PERMISSION_DENIED' };
  }
  return {
    ok: true,
    userId: authentication.userId,
    tenantId: authentication.tenantId,
    role: authentication.role,
    permission
  };
}

export const ZONAR_ROLE_NAMES = Object.freeze(Object.keys(ROLE_PERMISSIONS));
