-- ZONAR operational event delivery and acknowledgement metadata.
-- Additive migration; must be applied deliberately to a configured D1 database.

ALTER TABLE operational_events
  ADD COLUMN acknowledged_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE operational_events
  ADD COLUMN resolved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE operational_events
  ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- A reconciliation exception is materialised at most once per tenant/run/source reference.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_events_source_dedupe
  ON operational_events(tenant_id, source_run_id, source_ref)
  WHERE source_run_id IS NOT NULL AND source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_severity_status
  ON operational_events(tenant_id, severity, status, recorded_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_operational_event_ack_actor_membership
BEFORE UPDATE OF acknowledged_by_user_id ON operational_events
WHEN NEW.acknowledged_by_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM memberships m
   INNER JOIN users u ON u.id = m.user_id
   INNER JOIN tenants t ON t.id = m.tenant_id
   WHERE m.tenant_id = NEW.tenant_id
     AND m.user_id = NEW.acknowledged_by_user_id
     AND m.status = 'active' AND u.status = 'active' AND t.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'event acknowledgement actor must have active tenant membership');
END;

CREATE TRIGGER IF NOT EXISTS trg_operational_event_resolve_actor_membership
BEFORE UPDATE OF resolved_by_user_id ON operational_events
WHEN NEW.resolved_by_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM memberships m
   INNER JOIN users u ON u.id = m.user_id
   INNER JOIN tenants t ON t.id = m.tenant_id
   WHERE m.tenant_id = NEW.tenant_id
     AND m.user_id = NEW.resolved_by_user_id
     AND m.status = 'active' AND u.status = 'active' AND t.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'event resolution actor must have active tenant membership');
END;

-- Keep event origin and source facts immutable while allowing controlled status fields to change.
DROP TRIGGER IF EXISTS trg_operational_event_source_immutable;
CREATE TRIGGER trg_operational_event_source_immutable
BEFORE UPDATE OF id, tenant_id, source_kind, source_run_id, source_ref, event_code,
                 severity, summary, exposure_minor_units, currency_code,
                 occurred_at, recorded_at, details_json
ON operational_events
WHEN NEW.id <> OLD.id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.source_kind <> OLD.source_kind
  OR COALESCE(NEW.source_run_id, '') <> COALESCE(OLD.source_run_id, '')
  OR COALESCE(NEW.source_ref, '') <> COALESCE(OLD.source_ref, '')
  OR NEW.event_code <> OLD.event_code
  OR NEW.severity <> OLD.severity
  OR NEW.summary <> OLD.summary
  OR COALESCE(NEW.exposure_minor_units, -1) <> COALESCE(OLD.exposure_minor_units, -1)
  OR COALESCE(NEW.currency_code, '') <> COALESCE(OLD.currency_code, '')
  OR COALESCE(NEW.occurred_at, '') <> COALESCE(OLD.occurred_at, '')
  OR NEW.recorded_at <> OLD.recorded_at
  OR COALESCE(NEW.details_json, '') <> COALESCE(OLD.details_json, '')
BEGIN
  SELECT RAISE(ABORT, 'operational event provenance is immutable');
END;
