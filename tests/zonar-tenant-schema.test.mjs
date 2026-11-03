import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../migrations/0001_tenant_foundation.sql', import.meta.url), 'utf8');

test('tenant foundation migration creates required tables and indexes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name);
    for (const name of ['tenants', 'users', 'memberships', 'invitations', 'tenant_files', 'processing_jobs', 'audit_events']) {
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
