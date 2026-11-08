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
