import test from 'node:test';
import assert from 'node:assert/strict';
import { handleZonarResumableUpload } from '../src/zonar-resumable-uploads.js';

test('resumable upload rejects unsafe tenant identifiers', async () => {
  const response = await handleZonarResumableUpload(
    new Request('https://api.example/api/zonar/tenants/../files/uploads', { method: 'POST' }),
    {}, '../other'
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_TENANT' });
});

test('resumable upload fails closed unless D1 and R2 multipart bindings exist', async () => {
  const response = await handleZonarResumableUpload(
    new Request('https://api.example/api/zonar/tenants/tenant-a/files/uploads', { method: 'POST' }),
    { ZONAR_DB: { prepare() {} }, ZONAR_FILES: { put() {} } }, 'tenant-a'
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'RESUMABLE_UPLOAD_NOT_CONFIGURED' });
});

test('resumable upload requires tenant authentication configuration', async () => {
  const env = {
    ZONAR_DB: { prepare() {}, batch() {} },
    ZONAR_FILES: { createMultipartUpload() {}, resumeMultipartUpload() {} }
  };
  const response = await handleZonarResumableUpload(
    new Request('https://api.example/api/zonar/tenants/tenant-a/files/uploads', { method: 'POST', body: '{}' }),
    env, 'tenant-a'
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'TENANT_AUTH_NOT_CONFIGURED' });
});
