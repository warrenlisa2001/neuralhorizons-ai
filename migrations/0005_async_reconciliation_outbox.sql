-- ZONAR durable asynchronous reconciliation dispatch.
-- Additive only. Apply deliberately after the preceding migrations in a non-production environment.
-- Queue delivery is at-least-once; the D1 outbox is the durable source of dispatch intent.

ALTER TABLE reconciliation_runs ADD COLUMN idempotency_key TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN request_fingerprint TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0);
ALTER TABLE reconciliation_runs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5
  CHECK (max_attempts BETWEEN 1 AND 20);
ALTER TABLE reconciliation_runs ADD COLUMN lease_token TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN last_attempt_at TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN updated_at TEXT NOT NULL
  DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_runs_tenant_idempotency
  ON reconciliation_runs(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_recovery
  ON reconciliation_runs(status, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'dispatched', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  dispatched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES reconciliation_runs(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'leased'
  ),
  CHECK (
    (status = 'dispatched' AND dispatched_at IS NOT NULL)
    OR status <> 'dispatched'
  )
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_outbox_dispatch
  ON reconciliation_outbox(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_reconciliation_outbox_tenant
  ON reconciliation_outbox(tenant_id, run_id);

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_outbox_identity_immutable
BEFORE UPDATE OF id, tenant_id, run_id ON reconciliation_outbox
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.run_id <> OLD.run_id
BEGIN
  SELECT RAISE(ABORT, 'reconciliation outbox identity is immutable');
END;
