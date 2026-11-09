-- Durable, tenant-scoped canonical row staging for resumable reconciliation.
-- This is schema groundwork only: the queue consumer remains on its existing
-- bounded processor until the streaming worker is integrated and acceptance-tested.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reconciliation_dataset_progress (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  dataset TEXT NOT NULL CHECK (dataset IN ('orders', 'invoices', 'deliveries')),
  source_file_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ingesting', 'complete', 'failed')),
  last_row_number INTEGER NOT NULL DEFAULT 0 CHECK (last_row_number >= 0),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  headers_json TEXT,
  mappings_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, run_id, dataset),
  FOREIGN KEY (tenant_id, source_file_id) REFERENCES tenant_files(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS reconciliation_staging_rows (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  dataset TEXT NOT NULL CHECK (dataset IN ('orders', 'invoices', 'deliveries')),
  row_number INTEGER NOT NULL CHECK (row_number >= 2),
  record_id TEXT,
  order_id TEXT,
  record_json TEXT NOT NULL,
  row_sha256_hex TEXT NOT NULL CHECK (length(row_sha256_hex) = 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, run_id, dataset, row_number),
  FOREIGN KEY (tenant_id, run_id, dataset)
    REFERENCES reconciliation_dataset_progress(tenant_id, run_id, dataset)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_staging_record
  ON reconciliation_staging_rows(tenant_id, run_id, dataset, record_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_staging_order
  ON reconciliation_staging_rows(tenant_id, run_id, dataset, order_id);

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_progress_tenant_run
BEFORE INSERT ON reconciliation_dataset_progress
WHEN NOT EXISTS (
  SELECT 1 FROM reconciliation_runs r
  WHERE r.id = NEW.run_id AND r.tenant_id = NEW.tenant_id
    AND ( (NEW.dataset = 'orders' AND r.orders_file_id = NEW.source_file_id)
       OR (NEW.dataset = 'invoices' AND r.invoices_file_id = NEW.source_file_id)
       OR (NEW.dataset = 'deliveries' AND r.deliveries_file_id = NEW.source_file_id) )
)
BEGIN
  SELECT RAISE(ABORT, 'dataset progress must match run tenant and source');
END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_staging_tenant_run
BEFORE INSERT ON reconciliation_staging_rows
WHEN NOT EXISTS (
  SELECT 1 FROM reconciliation_dataset_progress p
  WHERE p.tenant_id = NEW.tenant_id AND p.run_id = NEW.run_id
    AND p.dataset = NEW.dataset
)
BEGIN
  SELECT RAISE(ABORT, 'staging rows require matching dataset progress');
END;
