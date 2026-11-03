import test from 'node:test';
import assert from 'node:assert/strict';
import { handleZonarTenantFiles } from '../src/zonar-file-storage.js';

test('tenant file endpoint fails closed when D1 or R2 is not configured', async () => {
  const response = await handleZonarTenantFiles(
    new Request('https://api.example/api/zonar/tenants/tenant-a/files'),
    {},
    'tenant-a'
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'FILE_STORAGE_NOT_CONFIGURED' });
});

test('tenant file endpoint rejects unsupported methods', async () => {
  const env = { ZONAR_DB: { prepare() {} }, ZONAR_FILES: { put() {} } };
  const response = await handleZonarTenantFiles(
    new Request('https://api.example/api/zonar/tenants/tenant-a/files', { method: 'DELETE' }),
    env,
    'tenant-a'
  );
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: 'METHOD_NOT_ALLOWED' });
});

test('tenant file endpoint rejects unsafe tenant identifiers', async () => {
  const response = await handleZonarTenantFiles(
    new Request('https://api.example/api/zonar/tenants/tenant-a/files'),
    {},
    '../other'
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_TENANT' });
});
