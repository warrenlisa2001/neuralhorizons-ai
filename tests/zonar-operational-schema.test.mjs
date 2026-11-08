import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = [
  '0001_tenant_foundation.sql',
  '0002_reconciliation_runs.sql',
  '0003_operational_intelligence.sql'
].map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');

function seededDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run('tenant-a', 'Business A');
  db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run('tenant-b', 'Business B');
  db.prepare('INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)').run('user-a', 'https://issuer.example', 'subject-a');
  db.prepare('INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)').run('tenant-a', 'user-a', 'tenant_owner');
  const insertFile = db.prepare(`INSERT INTO tenant_files
    (id, tenant_id, uploaded_by_user_id, original_filename, object_key, content_type, byte_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const id of ['orders', 'invoices', 'deliveries']) {
    insertFile.run(id, 'tenant-a', 'user-a', id + '.csv', 'tenant-a/' + id, 'text/csv', 10);
  }
  db.prepare(`INSERT INTO reconciliation_runs
    (id, tenant_id, requested_by_user_id, processor_version, orders_file_id, invoices_file_id, deliveries_file_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('run-a', 'tenant-a', 'user-a', '0.2.0', 'orders', 'invoices', 'deliveries');
  return db;
}

test('operational intelligence migration creates event and metric history with tenant indexes', () => {
  const db = seededDb();
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.ok(tables.includes('operational_events'));
    assert.ok(tables.includes('metric_snapshots'));
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name);
    assert.ok(indexes.includes('idx_operational_events_tenant_recorded'));
    assert.ok(indexes.includes('idx_metric_snapshots_tenant_computed'));
  } finally { db.close(); }
});

test('operational events must reference a reconciliation run in the same tenant', () => {
  const db = seededDb();
  try {
    const insert = db.prepare(`INSERT INTO operational_events
      (id, tenant_id, source_kind, source_run_id, event_code, severity, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run('event-a', 'tenant-a', 'reconciliation', 'run-a', 'ORDER_NOT_DELIVERED', 'high', 'Order has no matching delivery');
    assert.throws(() => insert.run('event-cross', 'tenant-b', 'reconciliation', 'run-a', 'ORDER_NOT_DELIVERED', 'high', 'Cross-tenant run reference'), /FOREIGN KEY/);
  } finally { db.close(); }
});

test('operational event financial exposure uses non-negative integer minor units and currency', () => {
  const db = seededDb();
  try {
    const insert = db.prepare(`INSERT INTO operational_events
      (id, tenant_id, source_kind, source_run_id, event_code, severity, summary, exposure_minor_units, currency_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('event-valid', 'tenant-a', 'reconciliation', 'run-a', 'VALUE_MISMATCH', 'medium', 'Invoice value differs', 12345, 'AED');
    assert.throws(() => insert.run('event-float', 'tenant-a', 'reconciliation', 'run-a', 'VALUE_MISMATCH', 'medium', 'Invalid fractional minor units', 12.5, 'AED'));
    assert.throws(() => insert.run('event-negative', 'tenant-a', 'reconciliation', 'run-a', 'VALUE_MISMATCH', 'medium', 'Negative exposure', -10, 'AED'));
    assert.throws(() => insert.run('event-currency', 'tenant-a', 'reconciliation', 'run-a', 'VALUE_MISMATCH', 'medium', 'Invalid currency', 100, 'US'));
    assert.throws(() => insert.run('event-missing-currency', 'tenant-a', 'reconciliation', 'run-a', 'VALUE_MISMATCH', 'medium', 'Missing currency', 100, null));
  } finally { db.close(); }
});

test('event provenance is immutable while status transitions retain timestamps', () => {
  const db = seededDb();
  try {
    db.prepare(`INSERT INTO operational_events
      (id, tenant_id, source_kind, source_run_id, event_code, severity, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('event-a', 'tenant-a', 'reconciliation', 'run-a', 'ORDER_NOT_DELIVERED', 'high', 'Order has no matching delivery');
    assert.throws(() => db.prepare('UPDATE operational_events SET tenant_id = ? WHERE id = ?').run('tenant-b', 'event-a'), /provenance is immutable/);
    assert.throws(() => db.prepare('UPDATE operational_events SET event_code = ? WHERE id = ?').run('OTHER_CODE', 'event-a'), /provenance is immutable/);
    db.prepare("UPDATE operational_events SET status = 'acknowledged', acknowledged_at = '2026-11-08T10:00:00Z' WHERE id = 'event-a'").run();
    const event = db.prepare('SELECT status, acknowledged_at FROM operational_events WHERE id = ?').get('event-a');
    assert.equal(event.status, 'acknowledged');
    assert.equal(event.acknowledged_at, '2026-11-08T10:00:00Z');
    assert.throws(() => db.prepare("UPDATE operational_events SET status = 'resolved' WHERE id = 'event-a'").run(), /CHECK constraint failed/);
  } finally { db.close(); }
});

test('metric snapshots are tenant-scoped and immutable', () => {
  const db = seededDb();
  try {
    db.prepare(`INSERT INTO metric_snapshots
      (id, tenant_id, source_run_id, snapshot_type, metrics_json, currency_code)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('snapshot-a', 'tenant-a', 'run-a', 'reconciliation', '{"exception_count":3}', 'AED');
    assert.throws(() => db.prepare(`INSERT INTO metric_snapshots
      (id, tenant_id, source_run_id, snapshot_type, metrics_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run('snapshot-cross', 'tenant-b', 'run-a', 'reconciliation', '{}'), /FOREIGN KEY/);
    assert.throws(() => db.prepare("UPDATE metric_snapshots SET metrics_json = '{}' WHERE id = 'snapshot-a'").run(), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM metric_snapshots WHERE id = 'snapshot-a'").run(), /immutable/);
  } finally { db.close(); }
});
