-- Audit and rate-limit trail for questions people put to HALU.
CREATE TABLE IF NOT EXISTS halu_ask_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT,
  question TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('answered', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_halu_ask_log_tenant_time ON halu_ask_log(tenant_id, created_at);
