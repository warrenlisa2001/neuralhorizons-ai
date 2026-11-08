-- ZONAR operational intelligence event and metric history.
-- Additive schema only. This migration is not applied to any live D1 database.
-- Operational events are distinct from security/audit_events:
-- they describe business exceptions and outcomes, not user/security activity.

PRAGMA foreign_keys = ON;

-- Reconciliation run IDs are globally generated, but the composite key makes
-- tenant ownership explicit for downstream operational records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_runs_tenant_id
  ON reconciliation_runs(tenant_id, id);

CREATE TABLE IF NOT EXISTS operational_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('reconciliation', 'connector', 'scheduled_rule', 'manual')),
  source_run_id TEXT,
  source_ref TEXT,
  event_code TEXT NOT NULL,
  severity TEXT NOT NULL
    CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 240),
  -- Store monetary exposure in minor units (e.g. fils/cents), never floats.
  exposure_minor_units INTEGER
    CHECK (
    exposure_minor_units IS NULL
    OR (typeof(exposure_minor_units) = 'integer' AND exposure_minor_units >= 0)
  ),
  currency_code TEXT
    CHECK (currency_code IS NULL OR currency_code GLOB '[A-Z][A-Z][A-Z]'),
  occurred_at TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  acknowledged_at TEXT,
  resolved_at TEXT,
  details_json TEXT,
  FOREIGN KEY (tenant_id, source_run_id)
    REFERENCES reconciliation_runs(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (exposure_minor_units IS NULL AND currency_code IS NULL)
    OR (exposure_minor_units IS NOT NULL AND currency_code IS NOT NULL)
  ),
  CHECK (
    (status = 'acknowledged' AND acknowledged_at IS NOT NULL)
    OR status <> 'acknowledged'
  ),
  CHECK (
    (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL)
    OR status NOT IN ('resolved', 'dismissed')
  )
);

CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_recorded
  ON operational_events(tenant_id, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_status_severity
  ON operational_events(tenant_id, status, severity, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_events_source_run
  ON operational_events(tenant_id, source_run_id);

CREATE TRIGGER IF NOT EXISTS trg_operational_event_source_immutable
BEFORE UPDATE OF id, tenant_id, source_kind, source_run_id, source_ref, event_code
ON operational_events
WHEN NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.source_kind <> OLD.source_kind
  OR COALESCE(NEW.source_run_id, '') <> COALESCE(OLD.source_run_id, '')
  OR COALESCE(NEW.source_ref, '') <> COALESCE(OLD.source_ref, '')
  OR NEW.event_code <> OLD.event_code
BEGIN
  SELECT RAISE(ABORT, 'operational event provenance is immutable');
END;

-- A snapshot is a reproducible, point-in-time calculation from a named source.
-- JSON content is produced by the server-side metrics engine, not the browser.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_run_id TEXT,
  snapshot_type TEXT NOT NULL
    CHECK (snapshot_type IN ('reconciliation', 'operational', 'executive')),
  metrics_json TEXT NOT NULL CHECK (length(metrics_json) <= 65536),
  currency_code TEXT
    CHECK (currency_code IS NULL OR currency_code GLOB '[A-Z][A-Z][A-Z]'),
  period_start TEXT,
  period_end TEXT,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, source_run_id)
    REFERENCES reconciliation_runs(tenant_id, id) ON DELETE RESTRICT,
  CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_tenant_computed
  ON metric_snapshots(tenant_id, computed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_source_run
  ON metric_snapshots(tenant_id, source_run_id);

CREATE TRIGGER IF NOT EXISTS trg_metric_snapshot_provenance_immutable
BEFORE UPDATE OF id, tenant_id, source_run_id, snapshot_type, metrics_json,
                 currency_code, period_start, period_end, computed_at
ON metric_snapshots
BEGIN
  SELECT RAISE(ABORT, 'metric snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_metric_snapshots_no_delete
BEFORE DELETE ON metric_snapshots
BEGIN
  SELECT RAISE(ABORT, 'metric snapshots are immutable');
END;
