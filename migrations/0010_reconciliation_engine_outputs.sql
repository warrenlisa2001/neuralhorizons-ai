-- Durable, idempotent reconciliation outputs and bounded order-page progress.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reconciliation_engine_progress (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','complete','failed')),
  last_order_row_number INTEGER NOT NULL DEFAULT 1 CHECK (last_order_row_number >= 1),
  processed_order_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_order_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, run_id),
);

CREATE TABLE IF NOT EXISTS reconciliation_order_results (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_row_number INTEGER NOT NULL CHECK (order_row_number >= 2),
  invoice_count INTEGER NOT NULL DEFAULT 0 CHECK (invoice_count >= 0),
  delivery_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  quantity_ordered REAL,
  quantity_invoiced REAL,
  quantity_delivered REAL,
  order_value REAL,
  invoice_value REAL,
  status TEXT NOT NULL CHECK (status IN ('linked','incomplete')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, run_id, order_id),
  UNIQUE (tenant_id, run_id, order_row_number),
);

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  dataset TEXT NOT NULL CHECK (dataset IN ('orders','invoices','deliveries')),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  record_id TEXT,
  order_id TEXT,
  expected_value REAL,
  actual_value REAL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, run_id, code, dataset, source_row_number)
);

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_engine_progress_tenant
BEFORE INSERT ON reconciliation_engine_progress
WHEN NOT EXISTS (SELECT 1 FROM reconciliation_runs r WHERE r.id=NEW.run_id AND r.tenant_id=NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'engine progress tenant/run mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_order_results_tenant
BEFORE INSERT ON reconciliation_order_results
WHEN NOT EXISTS (SELECT 1 FROM reconciliation_runs r WHERE r.id=NEW.run_id AND r.tenant_id=NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'order result tenant/run mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_exceptions_tenant
BEFORE INSERT ON reconciliation_exceptions
WHEN NOT EXISTS (SELECT 1 FROM reconciliation_runs r WHERE r.id=NEW.run_id AND r.tenant_id=NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'exception tenant/run mismatch'); END;

CREATE INDEX IF NOT EXISTS idx_reconciliation_results_run_order
  ON reconciliation_order_results(tenant_id, run_id, order_row_number);
CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_run_severity
  ON reconciliation_exceptions(tenant_id, run_id, severity, source_row_number);
