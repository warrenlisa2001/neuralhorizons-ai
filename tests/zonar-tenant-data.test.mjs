import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listTenantFiles,
  getTenantFile,
  getTenantProcessingJob,
  createTenantProcessingJob,
  transitionTenantJob
} from '../src/zonar-tenant-data.js';

function fakeDb(result = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      return {
        bind(...bindings) {
          call.bindings = bindings;
          return {
            async all() { return { success: true, results: result.results || [] }; },
            async first() { return result.first || null; },
            async run() { return { success: true, meta: { changes: result.changes ?? 0 } }; }
          };
        }
      };
    }
  };
}

test('file listing always scopes by tenant and excludes deleted records', async () => {
  const db = fakeDb({ results: [{ id: 'f1', tenant_id: 'tenant-a' }] });
  const rows = await listTenantFiles(db, 'tenant-a', { limit: 20 });
  assert.equal(rows.length, 1);
  assert.match(db.calls[0].sql, /WHERE tenant_id = \?1/);
  assert.match(db.calls[0].sql, /status <> 'deleted'/);
  assert.deepEqual(db.calls[0].bindings, ['tenant-a', 20]);
});

test('file listing cursor is parameterized and bounded', async () => {
  const db = fakeDb();
  await listTenantFiles(db, 'tenant-a', {
    limit: 500, beforeCreatedAt: '2026-11-01T00:00:00Z', beforeId: 'file-z'
  });
  assert.match(db.calls[0].sql, /created_at < \?2/);
  assert.deepEqual(db.calls[0].bindings, ['tenant-a', '2026-11-01T00:00:00Z', 'file-z', 100]);
});

test('partial pagination cursor is rejected', async () => {
  await assert.rejects(() => listTenantFiles(fakeDb(), 'tenant-a', {
    beforeId: 'file-z'
  }), /Both cursor fields/);
});

test('file and job reads always bind tenant and resource IDs', async () => {
  const db = fakeDb();
  await getTenantFile(db, 'tenant-a', 'file-a');
  await getTenantProcessingJob(db, 'tenant-a', 'job-a');
  assert.match(db.calls[0].sql, /tenant_id = \?1 AND id = \?2/);
  assert.deepEqual(db.calls[0].bindings, ['tenant-a', 'file-a']);
  assert.match(db.calls[1].sql, /tenant_id = \?1 AND id = \?2/);
  assert.deepEqual(db.calls[1].bindings, ['tenant-a', 'job-a']);
});

test('job creation checks file ownership in the same INSERT statement', async () => {
  const db = fakeDb({ changes: 1 });
  const result = await createTenantProcessingJob(db, {
    id: 'job-a', tenantId: 'tenant-a', fileId: 'file-a',
    requestedByUserId: 'user-a', processorVersion: '0.1.0'
  });
  assert.equal(result.created, true);
  assert.match(db.calls[0].sql, /INSERT INTO processing_jobs[\s\S]*SELECT[\s\S]*f\.tenant_id = \?2/);
  assert.match(db.calls[0].sql, /f\.status IN \('received', 'processed'\)/);
  assert.deepEqual(db.calls[0].bindings, ['job-a', 'tenant-a', 'file-a', '0.1.0', 'user-a']);
});

test('job creation reports no insert for a missing or other-tenant file', async () => {
  const db = fakeDb({ changes: 0 });
  const result = await createTenantProcessingJob(db, {
    id: 'job-a', tenantId: 'tenant-a', fileId: 'file-b',
    processorVersion: '0.1.0'
  });
  assert.deepEqual(result, { created: false, changes: 0 });
});

test('job transitions are tenant-scoped and compare-and-set', async () => {
  const db = fakeDb({ changes: 1 });
  const result = await transitionTenantJob(db, {
    tenantId: 'tenant-a', jobId: 'job-a', fromStatus: 'queued', toStatus: 'running'
  });
  assert.deepEqual(result, { updated: true, changes: 1 });
  assert.match(db.calls[0].sql, /WHERE tenant_id = \?3 AND id = \?4 AND status = \?5/);
  assert.deepEqual(db.calls[0].bindings, ['running', null, 'tenant-a', 'job-a', 'queued']);
});

test('illegal job transitions and unsafe identifiers are rejected', async () => {
  await assert.rejects(() => transitionTenantJob(fakeDb(), {
    tenantId: 'tenant-a', jobId: 'job-a', fromStatus: 'succeeded', toStatus: 'running'
  }), /Invalid job status transition/);
  await assert.rejects(() => getTenantFile(fakeDb(), 'tenant-a/other', 'file-a'), /Invalid tenant ID/);
});

test('database failures are not silently treated as empty data', async () => {
  const db = {
    prepare() {
      return { bind() { return { async all() { return { success: false }; } }; } };
    }
  };
  await assert.rejects(() => listTenantFiles(db, 'tenant-a'), /D1 operation failed/);
});
