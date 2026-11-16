-- Record verified multipart content integrity without misrepresenting a
-- per-part manifest digest as a conventional whole-object SHA-256.
-- Apply deliberately to a non-production D1 database first.
ALTER TABLE tenant_files ADD COLUMN integrity_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (integrity_status IN ('unverified', 'verified_parts', 'verified_sha256', 'failed'));
ALTER TABLE tenant_files ADD COLUMN integrity_manifest_sha256_hex TEXT
  CHECK (integrity_manifest_sha256_hex IS NULL OR length(integrity_manifest_sha256_hex) = 64);

CREATE INDEX IF NOT EXISTS idx_tenant_files_integrity
  ON tenant_files(tenant_id, integrity_status, created_at);
