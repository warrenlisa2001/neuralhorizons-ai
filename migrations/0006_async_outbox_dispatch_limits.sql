-- Bound repeated attempts to publish a durable reconciliation outbox item.
-- A dead-lettered item remains visible for operator investigation and manual replay.
ALTER TABLE reconciliation_outbox ADD COLUMN max_dispatch_attempts INTEGER NOT NULL DEFAULT 10
  CHECK (max_dispatch_attempts BETWEEN 1 AND 50);

CREATE INDEX IF NOT EXISTS idx_reconciliation_outbox_dispatchable
  ON reconciliation_outbox(status, available_at, attempt_count);
