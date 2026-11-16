-- HALU governance: an agent may act for a tenant only when four conditions hold.
--   data        evidence the data the use case needs exists and is trustworthy
--   defined     every term the use case decides on has one agreed definition and a named owner
--   governance  a boundary letter signed by the business owner, with a named escalation owner
--   free        no blocking dependency (another system or migration in progress)
-- Rows are written by an operator (SQL or a future admin screen), never by HALU itself.

CREATE TABLE IF NOT EXISTS halu_use_cases (
  tenant_id TEXT NOT NULL,
  use_case_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  PRIMARY KEY (tenant_id, use_case_key)
);

CREATE TABLE IF NOT EXISTS halu_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  term TEXT NOT NULL,
  definition TEXT NOT NULL,
  owner TEXT NOT NULL,                 -- the named person accountable for this term
  agreed_by TEXT,                      -- who signed it off; NULL while draft
  agreed_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'agreed', 'retired')),
  UNIQUE (tenant_id, term)
);

CREATE TABLE IF NOT EXISTS halu_use_case_definitions (
  tenant_id TEXT NOT NULL,
  use_case_key TEXT NOT NULL,
  definition_id TEXT NOT NULL REFERENCES halu_definitions(id),
  PRIMARY KEY (tenant_id, use_case_key, definition_id)
);

CREATE TABLE IF NOT EXISTS halu_readiness (
  tenant_id TEXT NOT NULL,
  use_case_key TEXT NOT NULL,
  data_ok INTEGER NOT NULL DEFAULT 0 CHECK (data_ok IN (0, 1)),
  data_evidence TEXT,                  -- what was checked, by whom, against which records
  blocked_by TEXT,                     -- NULL/empty = free of dependencies
  assessed_by TEXT NOT NULL,
  assessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, use_case_key)
);

-- The "boundary letter": what the agent may do, who owns the decisions, who gets exceptions.
CREATE TABLE IF NOT EXISTS halu_boundaries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  use_case_key TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,       -- space-separated, e.g. 'deliver_briefing'
  escalation_owner TEXT NOT NULL,
  signed_by TEXT NOT NULL,             -- the business owner of the decision
  signed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_halu_boundaries_lookup
  ON halu_boundaries(tenant_id, use_case_key, status);

-- Every gate decision and delivery is recorded.
CREATE TABLE IF NOT EXISTS halu_decision_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  use_case_key TEXT NOT NULL,
  run_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('delivered', 'withheld')),
  verdict TEXT NOT NULL,
  boundary_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_halu_decision_log_tenant
  ON halu_decision_log(tenant_id, use_case_key, created_at DESC);
