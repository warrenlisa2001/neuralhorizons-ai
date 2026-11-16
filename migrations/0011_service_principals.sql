-- Service principals: app-only callers (for example HALU) bound to ONE tenant.
-- Scopes are granted here, by an operator, and never read from the token.
-- Allowed scopes are enforced in application code (currently only 'findings:read').

CREATE TABLE IF NOT EXISTS service_principals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_issuer TEXT NOT NULL,
  app_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'findings:read',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, identity_issuer, app_id)
);

CREATE INDEX IF NOT EXISTS idx_service_principals_lookup
  ON service_principals(identity_issuer, app_id, status);
