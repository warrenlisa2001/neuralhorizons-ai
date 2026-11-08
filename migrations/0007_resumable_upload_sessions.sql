-- Resumable, tenant-scoped R2 multipart upload sessions.
-- Code-only migration: apply deliberately to a non-production D1 database first.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenant_upload_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0 AND expected_bytes <= 1073741824),
  chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes = 8388608),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completing', 'completed', 'aborted', 'expired', 'failed')),
  expires_at TEXT NOT NULL,
  completed_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, completed_file_id) REFERENCES tenant_files(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_upload_parts (
  upload_id TEXT NOT NULL REFERENCES tenant_upload_sessions(id) ON DELETE RESTRICT,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 128),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 8388608),
  sha256_hex TEXT NOT NULL CHECK (length(sha256_hex) = 64),
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (upload_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_tenant_status
  ON tenant_upload_sessions(tenant_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expiry
  ON tenant_upload_sessions(status, expires_at);

CREATE TRIGGER IF NOT EXISTS trg_upload_session_owner_immutable
BEFORE UPDATE OF id, tenant_id, user_id, object_key, r2_upload_id, expected_bytes, chunk_bytes, part_count
ON tenant_upload_sessions
WHEN NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
 OR NEW.object_key <> OLD.object_key OR NEW.r2_upload_id <> OLD.r2_upload_id
 OR NEW.expected_bytes <> OLD.expected_bytes OR NEW.chunk_bytes <> OLD.chunk_bytes
 OR NEW.part_count <> OLD.part_count
BEGIN
  SELECT RAISE(ABORT, 'upload session ownership and parameters are immutable');
END;
