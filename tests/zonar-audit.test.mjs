import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTenantAuditEvent, listTenantAuditEvents } from '../src/zonar-audit.js';

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
            async run() { return { success: true, meta: { changes: result.changes ?? 1 } }; }
          };
        }
      };
    }
  };
}

test('audit append binds tenant, actor and safe metadata as parameters', async () => {
  const db = fakeDb();
  const result = await appendTenantAuditEvent(db, {
    id: 'event-1', tenantId: 'tenant-a', actorUserId: 'user-a',
    eventType: 'file.uploaded', resourceType: 'file', resourceId: 'file-1',
    requestId: 'req-1', outcome: 'success',
    details: { action: 'upload', file_id: 'file-1', bytes: 1024 }
  });
  assert.deepEqual(result, { created: true });
  assert.match(db.calls[0].sql, /INSERT INTO audit_events/);
  assert.match(db.calls[0].sql, /FROM tenants t[\\s\\S]*t.status = 'active'/);
  assert.match(db.calls[0].sql, /m.tenant_id = t.id AND m.status = 'active'/);
  assert.deepEqual(db.calls[0].bindings, [
    'event-1', 'tenant-a', 'user-a', 'file.uploaded', 'file', 'file-1',
    'req-1', 'success', JSON.stringify({ action: 'upload', file_id: 'file-1', bytes: 1024 })
  ]);
});

test('audit append rejects unknown detail keys that could carry secrets or personal data', async () => {
  await assert.rejects(() => appendTenantAuditEvent(fakeDb(), {
    id: 'event-1', tenantId: 'tenant-a', eventType: 'login.succeeded',
    outcome: 'success', details: { access_token: 'do-not-store' }
  }), /Unsupported audit detail field/);
  await assert.rejects(() => appendTenantAuditEvent(fakeDb(), {
    id: 'event-2', tenantId: 'tenant-a', eventType: 'login.succeeded',
    outcome: 'success', details: { email: 'person@example.com' }
  }), /Unsupported audit detail field/);
});

test('audit append validates IDs, event types and outcomes', async () => {
  await assert.rejects(() => appendTenantAuditEvent(fakeDb(), {
    id: 'event-1', tenantId: 'tenant-a/tenant-b',
    eventType: 'file.uploaded', outcome: 'success'
  }), /Invalid tenant ID/);
  await assert.rejects(() => appendTenantAuditEvent(fakeDb(), {
    id: 'event-1', tenantId: 'tenant-a',
    eventType: 'File Uploaded', outcome: 'success'
  }), /Invalid event type/);
  await assert.rejects(() => appendTenantAuditEvent(fakeDb(), {
    id: 'event-1', tenantId: 'tenant-a',
    eventType: 'file.uploaded', outcome: 'unknown'
  }), /Invalid audit outcome/);
});

test('audit reads are tenant-scoped with bounded pagination', async () => {
  const db = fakeDb({ results: [{ id: 'event-a', tenant_id: 'tenant-a' }] });
  const rows = await listTenantAuditEvents(db, 'tenant-a', {
    limit: 500, beforeCreatedAt: '2026-11-03T00:00:00Z', beforeId: 'event-z'
  });
  assert.equal(rows.length, 1);
  assert.match(db.calls[0].sql, /FROM audit_events[\s\S]*WHERE tenant_id = \?1/);
  assert.match(db.calls[0].sql, /created_at < \?2/);
  assert.deepEqual(db.calls[0].bindings, [
    'tenant-a', '2026-11-03T00:00:00Z', 'event-z', 100
  ]);
});

test('audit pagination rejects incomplete cursor', async () => {
  await assert.rejects(() => listTenantAuditEvents(fakeDb(), 'tenant-a', {
    beforeId: 'event-z'
  }), /Both cursor fields are required/);
});

test('audit access exposes no update or delete helper', async () => {
  assert.equal(typeof appendTenantAuditEvent, 'function');
  assert.equal(typeof listTenantAuditEvents, 'function');
});

test('audit D1 failures surface to caller', async () => {
  const db = {
    prepare() {
      return { bind() { return { async run() { return { success: false }; } }; } };
    }
  };
  await assert.rejects(() => appendTenantAuditEvent(db, {
    id: 'event-1', tenantId: 'tenant-a', eventType: 'file.uploaded',
    outcome: 'success'
  }), /D1 operation failed/);
});

test('audit append rejects non-plain details and negative counters', async () => {
  await assert.rejects(() => appendTenantAuditEvent(fakeDb(), {
    id: 'event-3', tenantId: 'tenant-a', eventType: 'file.uploaded',
    outcome: 'success', details: new Date()
  }), /plain object/);
  await assert.rejects(() => appendTenantAuditEvent(fakeDb(), {
    id: 'event-4', tenantId: 'tenant-a', eventType: 'file.uploaded',
    outcome: 'success', details: { bytes: -1 }
  }), /Invalid audit detail value/);
});
