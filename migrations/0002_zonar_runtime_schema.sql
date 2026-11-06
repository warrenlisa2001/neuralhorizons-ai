-- ZONAR runtime schema alignment for the staging foundation.
-- IMPORTANT: This is a one-time rebuild migration for an EMPTY staging database.
-- Verify every ZONAR table has zero rows before applying. Do not apply to a
-- database containing customer or operational data.
--
-- This migration aligns D1 with the current tenant-file, processing-job,
-- audit, and reconciliation handlers. It replaces the manually-created
-- staging schema and adds the reconciliation_runs table required by runtime.

-- Child tables first. This migration is permitted only after confirming all
-- eight existing ZONAR tables are empty.
DROP TABLE IF EXISTS reconciliation_runs;
DROP TABLE IF EXISTS processing_jobs;
DROP TABLE IF EXISTS tenant_files;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  identity_issuer TEXT NOT NULL,
  identity_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (identity_issuer, identity_subject)
);

CREATE TABLE memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL
    CHECK (role IN ('tenant_owner', 'tenant_admin', 'analyst', 'operator', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('tenant_admin', 'analyst', 'operator', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tenant_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256_hex TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'failed', 'quarantined', 'deletion_pending', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (tenant_id, id)
);

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  processor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  result_object_key TEXT UNIQUE,
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, file_id)
    REFERENCES tenant_files(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  request_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE reconciliation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  processor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  orders_file_id TEXT NOT NULL,
  invoices_file_id TEXT NOT NULL,
  deliveries_file_id TEXT NOT NULL,
  result_object_key TEXT UNIQUE,
  result_sha256_hex TEXT,
  summary_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (tenant_id, orders_file_id)
    REFERENCES tenant_files(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, invoices_file_id)
    REFERENCES tenant_files(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, deliveries_file_id)
    REFERENCES tenant_files(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_memberships_user_status
  ON memberships(user_id, status);
CREATE INDEX idx_invitations_tenant_email
  ON invitations(tenant_id, email);
CREATE INDEX idx_invitations_expiry
  ON invitations(expires_at);
CREATE INDEX idx_tenant_files_tenant_created
  ON tenant_files(tenant_id, created_at);
CREATE INDEX idx_tenant_files_tenant_status
  ON tenant_files(tenant_id, status);
CREATE INDEX idx_processing_jobs_tenant_created
  ON processing_jobs(tenant_id, created_at);
CREATE INDEX idx_processing_jobs_file
  ON processing_jobs(file_id);
CREATE INDEX idx_audit_events_tenant_created
  ON audit_events(tenant_id, created_at);
CREATE INDEX idx_audit_events_actor_created
  ON audit_events(actor_user_id, created_at);
CREATE INDEX idx_reconciliation_runs_tenant_created
  ON reconciliation_runs(tenant_id, created_at);
CREATE INDEX idx_reconciliation_runs_tenant_status
  ON reconciliation_runs(tenant_id, status);

CREATE TRIGGER trg_audit_actor_tenant_membership
BEFORE INSERT ON audit_events
WHEN NEW.actor_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM memberships m
   INNER JOIN users u ON u.id = m.user_id
   INNER JOIN tenants t ON t.id = m.tenant_id
   WHERE m.tenant_id = NEW.tenant_id
     AND m.user_id = NEW.actor_user_id
     AND m.status = 'active'
     AND u.status = 'active'
     AND t.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'audit actor must have active membership in tenant');
END;

CREATE TRIGGER trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER trg_tenant_file_uploader_membership
BEFORE INSERT ON tenant_files
WHEN NEW.uploaded_by_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM memberships m
   INNER JOIN users u ON u.id = m.user_id
   INNER JOIN tenants t ON t.id = m.tenant_id
   WHERE m.tenant_id = NEW.tenant_id
     AND m.user_id = NEW.uploaded_by_user_id
     AND m.status = 'active'
     AND u.status = 'active'
     AND t.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'file uploader must have active membership in tenant');
END;

CREATE TRIGGER trg_tenant_file_owner_immutable
BEFORE UPDATE OF id, tenant_id ON tenant_files
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'file tenant ownership is immutable');
END;

CREATE TRIGGER trg_processing_job_requester_membership
BEFORE INSERT ON processing_jobs
WHEN NEW.requested_by_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM memberships m
   INNER JOIN users u ON u.id = m.user_id
   INNER JOIN tenants t ON t.id = m.tenant_id
   WHERE m.tenant_id = NEW.tenant_id
     AND m.user_id = NEW.requested_by_user_id
     AND m.status = 'active'
     AND u.status = 'active'
     AND t.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'job requester must have active membership in tenant');
END;

CREATE TRIGGER trg_processing_job_owner_immutable
BEFORE UPDATE OF id, tenant_id, file_id ON processing_jobs
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.file_id <> OLD.file_id
BEGIN
  SELECT RAISE(ABORT, 'processing job tenant ownership is immutable');
END;

CREATE TRIGGER trg_reconciliation_run_requester_membership
BEFORE INSERT ON reconciliation_runs
WHEN NEW.requested_by_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM memberships m
   INNER JOIN users u ON u.id = m.user_id
   INNER JOIN tenants t ON t.id = m.tenant_id
   WHERE m.tenant_id = NEW.tenant_id
     AND m.user_id = NEW.requested_by_user_id
     AND m.status = 'active'
     AND u.status = 'active'
     AND t.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'reconciliation requester must have active membership in tenant');
END;

CREATE TRIGGER trg_reconciliation_run_owner_immutable
BEFORE UPDATE OF id, tenant_id, orders_file_id, invoices_file_id, deliveries_file_id
ON reconciliation_runs
WHEN NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.orders_file_id <> OLD.orders_file_id
  OR NEW.invoices_file_id <> OLD.invoices_file_id
  OR NEW.deliveries_file_id <> OLD.deliveries_file_id
BEGIN
  SELECT RAISE(ABORT, 'reconciliation run ownership is immutable');
END;
