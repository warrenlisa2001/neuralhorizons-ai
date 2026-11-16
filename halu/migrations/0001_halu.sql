-- HALU's own database. ZONAR's database is never written by HALU.

-- Where each tenant's poll has got to (opaque ZONAR cursor).
CREATE TABLE IF NOT EXISTS halu_cursors (
  tenant_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per delivered run; idempotency_key is "<tenant>:<run>".
CREATE TABLE IF NOT EXISTS halu_briefings (
  idempotency_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  completed_at TEXT,
  briefing_json TEXT NOT NULL,
  finance_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  webhook_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_halu_briefings_tenant_completed
  ON halu_briefings(tenant_id, completed_at DESC);
