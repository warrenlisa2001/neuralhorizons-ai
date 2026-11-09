import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../migrations/0001_tenant_foundation.sql', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('../migrations/0002_reconciliation_runs.sql', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('../migrations/0007_resumable_upload_sessions.sql', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('../migrations/0009_reconciliation_staging.sql', import.meta.url), 'utf8');

test('tenant foundation migration creates required tables and indexes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name);
    for (const name of ['tenants', 'users', 'memberships', 'invitations', 'tenant_files', 'processing_jobs', 'audit_events', 'reconciliation_runs', 'tenant_upload_sessions', 'tenant_upload_parts', 'reconciliation_dataset_progress', 'reconciliation_staging_rows']) {
      assert.ok(tables.includes(name), `missing table: ${name}`);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(x => x.name);
    assert.ok(indexes.includes('idx_audit_events_tenant_created'));
    assert.ok(indexes.includes('idx_tenant_files_tenant_created'));
  } finally {
    db.close();
  }
});

test('tenant memberships enforce valid roles and tenant/user references', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'tenant_owner');
    assert.throws(() => db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'superuser'));
    assert.throws(() => db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('missing-tenant', 'user-a', 'viewer'));
    assert.throws(() => db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'missing-user', 'viewer'));
  } finally {
    db.close();
  }
});

test('identity subjects and invitation token hashes are unique', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    assert.throws(() => db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-b', 'https://issuer.example', 'subject-a'));
    db.prepare("INSERT INTO invitations (id, tenant_id, email, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run('invite-a', 'tenant-a', 'person@example.com', 'viewer', 'hash-a', '2099-01-01T00:00:00Z');
    assert.throws(() => db.prepare("INSERT INTO invitations (id, tenant_id, email, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run('invite-b', 'tenant-a', 'other@example.com', 'viewer', 'hash-a', '2099-01-01T00:00:00Z'));
    assert.throws(() => db.prepare("INSERT INTO invitations (id, tenant_id, email, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run('invite-c', 'tenant-a', 'owner@example.com', 'tenant_owner', 'hash-c', '2099-01-01T00:00:00Z'));
  } finally {
    db.close();
  }
});

test('audit events require a tenant and an active same-tenant actor', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-b', 'Business B');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-b', 'https://issuer.example', 'subject-b');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'tenant_owner');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-b', 'user-b', 'tenant_owner');

    const insert = db.prepare("INSERT INTO audit_events (id, tenant_id, actor_user_id, event_type, outcome) VALUES (?, ?, ?, ?, ?)");
    insert.run('event-a', 'tenant-a', 'user-a', 'tenant.created', 'success');
    assert.throws(() => insert.run('event-cross', 'tenant-a', 'user-b', 'tenant.created', 'success'), /active membership/);
    assert.throws(() => insert.run('event-null', null, null, 'system.event', 'success'), /NOT NULL/);
  } finally {
    db.close();
  }
});

test('audit history is immutable through ordinary SQL statements', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO audit_events (id, tenant_id, event_type, outcome) VALUES (?, ?, ?, ?)").run('event-a', 'tenant-a', 'tenant.created', 'success');
    assert.throws(() => db.prepare("UPDATE audit_events SET outcome = ? WHERE id = ?").run('failure', 'event-a'), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM audit_events WHERE id = ?").run('event-a'), /immutable/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 1);
  } finally {
    db.close();
  }
});

test('file and processing-job foreign keys prevent cross-tenant resource links', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-b', 'Business B');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'tenant_owner');
    db.prepare("INSERT INTO tenant_files (id, tenant_id, uploaded_by_user_id, original_filename, object_key, content_type, byte_size) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('file-a', 'tenant-a', 'user-a', 'a.csv', 'tenant-a/file-a', 'text/csv', 10);
    const insertJob = db.prepare("INSERT INTO processing_jobs (id, tenant_id, file_id, requested_by_user_id, processor_version) VALUES (?, ?, ?, ?, ?)");
    insertJob.run('job-a', 'tenant-a', 'file-a', 'user-a', '0.1.0');
    assert.throws(() => insertJob.run('job-cross', 'tenant-b', 'file-a', null, '0.1.0'), /FOREIGN KEY/);
    assert.throws(() => db.prepare("UPDATE tenant_files SET tenant_id = ? WHERE id = ?").run('tenant-b', 'file-a'), /ownership is immutable/);
    assert.throws(() => db.prepare("UPDATE processing_jobs SET tenant_id = ? WHERE id = ?").run('tenant-b', 'job-a'), /ownership is immutable/);
  } finally {
    db.close();
  }
});

test('file uploader and job requester must be active members of the owning tenant', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-b', 'Business B');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-b', 'https://issuer.example', 'subject-b');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'tenant_owner');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-b', 'user-b', 'tenant_owner');
    const insertFile = db.prepare("INSERT INTO tenant_files (id, tenant_id, uploaded_by_user_id, original_filename, object_key, content_type, byte_size) VALUES (?, ?, ?, ?, ?, ?, ?)");
    assert.throws(() => insertFile.run('file-bad', 'tenant-a', 'user-b', 'b.csv', 'tenant-a/bad', 'text/csv', 10), /uploader must have active membership/);
    insertFile.run('file-a', 'tenant-a', 'user-a', 'a.csv', 'tenant-a/file-a', 'text/csv', 10);
    const insertJob = db.prepare("INSERT INTO processing_jobs (id, tenant_id, file_id, requested_by_user_id, processor_version) VALUES (?, ?, ?, ?, ?)");
    assert.throws(() => insertJob.run('job-bad', 'tenant-a', 'file-a', 'user-b', '0.1.0'), /requester must have active membership/);
  } finally {
    db.close();
  }
});


test('reconciliation runs enforce tenant-owned source files and immutable provenance', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-b', 'Business B');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'tenant_owner');
    const insertFile = db.prepare("INSERT INTO tenant_files (id, tenant_id, uploaded_by_user_id, original_filename, object_key, content_type, byte_size) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const id of ['orders', 'invoices', 'deliveries']) {
      insertFile.run(id, 'tenant-a', 'user-a', id + '.csv', 'tenant-a/' + id, 'text/csv', 10);
    }
    insertFile.run('foreign-file', 'tenant-b', null, 'foreign.csv', 'tenant-b/foreign', 'text/csv', 10);
    const insertRun = db.prepare(`INSERT INTO reconciliation_runs
      (id, tenant_id, requested_by_user_id, processor_version, orders_file_id,
       invoices_file_id, deliveries_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insertRun.run('run-a', 'tenant-a', 'user-a', '0.1.0', 'orders', 'invoices', 'deliveries');
    assert.throws(() => insertRun.run('run-cross', 'tenant-a', 'user-a', '0.1.0', 'orders', 'invoices', 'foreign-file'), /FOREIGN KEY/);
    assert.throws(() => db.prepare("UPDATE reconciliation_runs SET tenant_id = ? WHERE id = ?").run('tenant-b', 'run-a'), /ownership and sources are immutable/);
    assert.throws(() => db.prepare("UPDATE reconciliation_runs SET orders_file_id = ? WHERE id = ?").run('foreign-file', 'run-a'), /ownership and sources are immutable/);
  } finally {
    db.close();
  }
});

test('resumable upload sessions and parts enforce tenant ownership and bounded part metadata', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'tenant_owner');
    db.prepare(`INSERT INTO tenant_upload_sessions
      (id, tenant_id, user_id, filename, object_key, r2_upload_id, expected_bytes,
       chunk_bytes, part_count, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('upload-a', 'tenant-a', 'user-a', 'orders.csv', 'tenants/tenant-a/files/upload-a',
        'r2-multipart-a', 8388609, 8388608, 2, '2099-01-01T00:00:00Z');
    const insertPart = db.prepare(`INSERT INTO tenant_upload_parts
      (upload_id, part_number, byte_size, sha256_hex, etag)
      VALUES (?, ?, ?, ?, ?)`);
    insertPart.run('upload-a', 1, 8388608, 'a'.repeat(64), 'etag-1');
    assert.throws(() => insertPart.run('upload-a', 1, 1, 'b'.repeat(64), 'etag-duplicate'));
    assert.throws(() => insertPart.run('upload-a', 129, 1, 'c'.repeat(64), 'etag-overflow'));
    assert.throws(() => db.prepare("UPDATE tenant_upload_sessions SET tenant_id = ? WHERE id = ?").run('tenant-b', 'upload-a'));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_upload_parts WHERE upload_id = ?").get('upload-a').count, 1);
  } finally {
    db.close();
  }
});


test('durable staging enforces source provenance, tenant scope and row uniqueness', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run('tenant-a', 'Business A');
    db.prepare("INSERT INTO users (id, identity_issuer, identity_subject) VALUES (?, ?, ?)").run('user-a', 'https://issuer.example', 'subject-a');
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role) VALUES (?, ?, ?)").run('tenant-a', 'user-a', 'tenant_owner');
    const insertFile = db.prepare("INSERT INTO tenant_files (id, tenant_id, uploaded_by_user_id, original_filename, object_key, content_type, byte_size) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const id of ['orders', 'invoices', 'deliveries']) {
      insertFile.run(id, 'tenant-a', 'user-a', id + '.csv', 'tenant-a/' + id, 'text/csv', 10);
    }
    db.prepare(`INSERT INTO reconciliation_runs
      (id, tenant_id, requested_by_user_id, processor_version, orders_file_id, invoices_file_id, deliveries_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('run-a', 'tenant-a', 'user-a', '0.1.0', 'orders', 'invoices', 'deliveries');
    const insertProgress = db.prepare(`INSERT INTO reconciliation_dataset_progress
      (tenant_id, run_id, dataset, source_file_id) VALUES (?, ?, ?, ?)`);
    insertProgress.run('tenant-a', 'run-a', 'orders', 'orders');
    assert.throws(() => insertProgress.run('tenant-a', 'run-a', 'invoices', 'orders'), /must match run tenant and source/);
    const insertRow = db.prepare(`INSERT INTO reconciliation_staging_rows
      (tenant_id, run_id, dataset, row_number, record_id, order_id, record_json, row_sha256_hex)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insertRow.run('tenant-a', 'run-a', 'orders', 2, 'O-1', 'O-1', '{"order_id":"O-1"}', 'a'.repeat(64));
    assert.throws(() => insertRow.run('tenant-a', 'run-a', 'orders', 2, 'O-2', 'O-2', '{"order_id":"O-2"}', 'b'.repeat(64)));
    assert.throws(() => insertRow.run('tenant-b', 'run-a', 'orders', 3, 'O-3', 'O-3', '{"order_id":"O-3"}', 'c'.repeat(64)));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reconciliation_staging_rows WHERE tenant_id=? AND run_id=?").get('tenant-a', 'run-a').count, 1);
  } finally {
    db.close();
  }
});
