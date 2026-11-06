-- Zonar reconciliation run provenance.
-- Each run references three tenant-owned source files and stores its result in R2.
-- This migration is additive; it does not alter the existing single-file job model.

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  processor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  orders_file_id TEXT NOT NULL,
  invoices_file_id TEXT NOT NULL,
  deliveries_file_id TEXT NOT NULL,
  result_object_key TEXT UNIQUE,
  result_sha256_hex TEXT,
  summary_json TEXT,
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, orders_file_id) REFERENCES tenant_files(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, invoices_file_id) REFERENCES tenant_files(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, deliveries_file_id) REFERENCES tenant_files(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_tenant_created
  ON reconciliation_runs(tenant_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_run_requester_membership
BEFORE INSERT ON reconciliation_runs
WHEN NEW.requested_by_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM memberships m
   INNER JOIN users u ON u.id = m.user_id
   INNER JOIN tenants t ON t.id = m.tenant_id
   WHERE m.tenant_id = NEW.tenant_id
     AND m.user_id = NEW.requested_by_user_id
     AND m.status = 'active' AND u.status = 'active' AND t.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'run requester must have active membership in tenant');
END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_run_ownership_immutable
BEFORE UPDATE OF id, tenant_id, orders_file_id, invoices_file_id, deliveries_file_id
ON reconciliation_runs
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.orders_file_id <> OLD.orders_file_id
  OR NEW.invoices_file_id <> OLD.invoices_file_id
  OR NEW.deliveries_file_id <> OLD.deliveries_file_id
BEGIN
  SELECT RAISE(ABORT, 'reconciliation run ownership and sources are immutable');
END;
