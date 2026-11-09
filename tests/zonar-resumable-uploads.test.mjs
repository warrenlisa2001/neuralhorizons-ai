import test from 'node:test';
import assert from 'node:assert/strict';
import { handleZonarResumableUpload, verifyCompletedObjectParts } from '../src/zonar-resumable-uploads.js';
import { webcrypto } from 'node:crypto';

globalThis.crypto ||= webcrypto;

async function hash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function bucketFor(parts) {
  const bytes = parts.flatMap(part => Array.from(part));
  return { get: async () => ({ size: bytes.length, body: new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes.slice(0, 2)));
      controller.enqueue(Uint8Array.from(bytes.slice(2)));
      controller.close();
    }
  }) }) };
}

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
    ZONAR_RESUMABLE_UPLOADS_ENABLED: 'true',
    ZONAR_DB: { prepare() {}, batch() {} },
    ZONAR_FILES: { createMultipartUpload() {}, resumeMultipartUpload() {} }
  };
  const response = await handleZonarResumableUpload(
    new Request('https://api.example/api/zonar/tenants/tenant-a/files/uploads', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer test-token' } }),
    env, 'tenant-a'
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'TENANT_AUTH_NOT_CONFIGURED' });
});

test('expired upload cleanup remains idle until explicitly enabled', async () => {
  const { expireZonarUploadSessions } = await import('../src/zonar-resumable-uploads.js');
  assert.deepEqual(await expireZonarUploadSessions({}), { expired: 0, deferred: 0 });
});


test('completed R2 object is verified against each persisted multipart SHA-256', async () => {
  const chunks = [new TextEncoder().encode('abc'), new TextEncoder().encode('defg')];
  const parts = chunks.map((bytes, index) => ({
    part_number: index + 1, byte_size: bytes.byteLength, sha256_hex: null
  }));
  for (let i = 0; i < parts.length; i++) parts[i].sha256_hex = await hash(chunks[i]);
  const result = await verifyCompletedObjectParts(bucketFor(chunks), 'object-key', parts, 7);
  assert.equal(result.byte_size, 7);
  assert.equal(result.part_count, 2);
  assert.match(result.manifest_sha256_hex, /^[a-f0-9]{64}$/);
});

test('completed R2 object rejects a part whose bytes differ from the upload manifest', async () => {
  const bytes = new TextEncoder().encode('actual');
  const expected = new TextEncoder().encode('expect');
  const expectedHash = await hash(expected);
  await assert.rejects(
    () => verifyCompletedObjectParts(bucketFor([bytes]), 'object-key', [{
      part_number: 1, byte_size: expected.byteLength, sha256_hex: expectedHash
    }], bytes.byteLength),
    error => error.message === 'COMPLETED_PART_INTEGRITY_FAILED'
  );
});

test('completed R2 object rejects a manifest with incomplete byte coverage', async () => {
  const bytes = new TextEncoder().encode('abc');
  const firstTwoHash = await hash(bytes.subarray(0, 2));
  await assert.rejects(
    () => verifyCompletedObjectParts(bucketFor([bytes]), 'object-key', [{
      part_number: 1, byte_size: 2, sha256_hex: firstTwoHash
    }], 3),
    error => error.message === 'COMPLETED_OBJECT_SIZE_MISMATCH'
  );
});
