import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeZonarAction, hasZonarPermission, ZONAR_ROLE_NAMES } from '../src/zonar-permissions.js';

const auth = role => ({ ok: true, userId: 'user-1', tenantId: 'tenant-1', role });

test('all five defined roles have explicit permission sets', () => {
  assert.deepEqual(ZONAR_ROLE_NAMES, ['tenant_owner', 'tenant_admin', 'analyst', 'operator', 'viewer']);
});

test('owner and admin can manage members, but only owner can manage tenant ownership', () => {
  for (const role of ['tenant_owner', 'tenant_admin']) {
    assert.equal(hasZonarPermission(role, 'members:invite'), true);
    assert.equal(hasZonarPermission(role, 'members:revoke'), true);
  }
  assert.equal(hasZonarPermission('tenant_owner', 'tenant:manage'), true);
  assert.equal(hasZonarPermission('tenant_admin', 'tenant:manage'), false);
});

test('analyst can read and export but cannot upload, run jobs or administer users', () => {
  assert.equal(hasZonarPermission('analyst', 'files:read'), true);
  assert.equal(hasZonarPermission('analyst', 'exports:create'), true);
  assert.equal(hasZonarPermission('analyst', 'files:upload'), false);
  assert.equal(hasZonarPermission('analyst', 'jobs:run'), false);
  assert.equal(hasZonarPermission('analyst', 'members:invite'), false);
});

test('operator can upload and run jobs but cannot export or manage members', () => {
  assert.equal(hasZonarPermission('operator', 'files:upload'), true);
  assert.equal(hasZonarPermission('operator', 'jobs:run'), true);
  assert.equal(hasZonarPermission('operator', 'exports:create'), false);
  assert.equal(hasZonarPermission('operator', 'members:invite'), false);
});

test('viewer is read-only', () => {
  for (const permission of ['tenant:read', 'files:read', 'jobs:read', 'settings:read']) {
    assert.equal(hasZonarPermission('viewer', permission), true);
  }
  for (const permission of ['files:upload', 'files:delete', 'jobs:run', 'exports:create', 'members:invite', 'settings:manage']) {
    assert.equal(hasZonarPermission('viewer', permission), false);
  }
});

test('authorization returns only the verified tenant context on success', () => {
  assert.deepEqual(authorizeZonarAction(auth('operator'), 'jobs:run'), {
    ok: true, userId: 'user-1', tenantId: 'tenant-1', role: 'operator', permission: 'jobs:run'
  });
});

test('authorization denies missing authentication and unknown roles', () => {
  assert.deepEqual(authorizeZonarAction(null, 'tenant:read'), {
    ok: false, status: 401, error: 'UNAUTHORISED'
  });
  assert.deepEqual(authorizeZonarAction(auth('superuser'), 'tenant:manage'), {
    ok: false, status: 403, error: 'PERMISSION_DENIED'
  });
});

test('authorization rejects unknown permissions and malformed input', () => {
  assert.equal(hasZonarPermission('tenant_owner', 'root:everything'), false);
  assert.equal(hasZonarPermission(null, 'tenant:read'), false);
  assert.equal(authorizeZonarAction(auth('tenant_owner'), null).status, 403);
});
