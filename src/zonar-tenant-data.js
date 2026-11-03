// Tenant-scoped D1 data access primitives for Zonar.
// Every read and write is constrained by the authenticated tenant ID.
// Callers must pass authorization. Never pass tenant IDs from untrusted bodies.

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('D1 database binding is required');
}

function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid ' + name);
  }
  return value;
}

function clampLimit(value) {
  if (value === undefined) return 50;
  if (!Number.isInteger(value)) throw new TypeError('Invalid limit');
  return Math.max(1, Math.min(value, 100));
}

function assertSuccessful(result) {
  if (!result || result.success === false) throw new Error('D1 operation failed');
  return result;
}

/**
 * List non-deleted files belonging only to one tenant.
 * Cursor is an opaque pair of (created_at, id) from the last returned row.
 */
export async function listTenantFiles(db, tenantId, options = {}) {
  requireDb(db);
  requireId(tenantId, 'tenant ID');
  const limit = clampLimit(options.limit);
  const hasCursor = options.beforeCreatedAt !== undefined || options.beforeId !== undefined;
  if (hasCursor && (typeof options.beforeCreatedAt !== 'string' || !options.beforeCreatedAt ||
      typeof options.beforeId !== 'string' || !options.beforeId)) {
    throw new TypeError('Both cursor fields are required');
  }

  let sql = `SELECT id, tenant_id, original_filename, content_type, byte_size,
                    sha256_hex, version, status, created_at
             FROM tenant_files
             WHERE tenant_id = ?1
               AND status <> 'deleted'
               AND deleted_at IS NULL`;
  const bindings = [tenantId];
  if (hasCursor) {
    sql += ' AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))';
    bindings.push(options.beforeCreatedAt, options.beforeId);
  }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ?${bindings.length + 1}`;
  bindings.push(limit);

  const result = assertSuccessful(await db.prepare(sql).bind(...bindings).all());
  return Array.isArray(result.results) ? result.results : [];
}

export async function getTenantFile(db, tenantId, fileId) {
  requireDb(db);
  requireId(tenantId, 'tenant ID');
  requireId(fileId, 'file ID');
  return db.prepare(
    `SELECT id, tenant_id, original_filename, content_type, byte_size,
            sha256_hex, version, status, created_at
     FROM tenant_files
     WHERE tenant_id = ?1 AND id = ?2
       AND status <> 'deleted' AND deleted_at IS NULL
     LIMIT 1`
  ).bind(tenantId, fileId).first();
}

export async function getTenantProcessingJob(db, tenantId, jobId) {
  requireDb(db);
  requireId(tenantId, 'tenant ID');
  requireId(jobId, 'job ID');
  return db.prepare(
    `SELECT id, tenant_id, file_id, processor_version, status,
            error_code, started_at, completed_at, created_at
     FROM processing_jobs
     WHERE tenant_id = ?1 AND id = ?2
     LIMIT 1`
  ).bind(tenantId, jobId).first();
}

/**
 * Queue a job only if the referenced file belongs to this tenant and is active.
 * INSERT ... SELECT makes the ownership check atomic with job creation.
 */
export async function createTenantProcessingJob(db, input) {
  requireDb(db);
  const id = requireId(input?.id, 'job ID');
  const tenantId = requireId(input?.tenantId, 'tenant ID');
  const fileId = requireId(input?.fileId, 'file ID');
  const requestedByUserId = input?.requestedByUserId == null
    ? null
    : requireId(input.requestedByUserId, 'requesting user ID');
  if (typeof input?.processorVersion !== 'string' ||
      input.processorVersion.length < 1 || input.processorVersion.length > 80) {
    throw new TypeError('Invalid processor version');
  }

  const result = assertSuccessful(await db.prepare(
    `INSERT INTO processing_jobs
       (id, tenant_id, file_id, requested_by_user_id, processor_version, status)
     SELECT ?1, ?2, f.id, ?5, ?4, 'queued'
     FROM tenant_files f
     WHERE f.id = ?3 AND f.tenant_id = ?2
       AND f.status IN ('received', 'processed')
       AND f.deleted_at IS NULL`
  ).bind(id, tenantId, fileId, input.processorVersion, requestedByUserId).run());

  const changes = Number(result.meta?.changes ?? 0);
  return { created: changes === 1, changes };
}

const JOB_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'cancelled']),
  running: Object.freeze(['succeeded', 'failed']),
  failed: Object.freeze([]),
  succeeded: Object.freeze([]),
  cancelled: Object.freeze([])
});

/**
 * Compare-and-set a job state inside its tenant boundary.
 * Concurrent or stale transitions return updated:false rather than overwriting.
 */
export async function transitionTenantJob(db, input) {
  requireDb(db);
  const tenantId = requireId(input?.tenantId, 'tenant ID');
  const jobId = requireId(input?.jobId, 'job ID');
  const fromStatus = input?.fromStatus;
  const toStatus = input?.toStatus;
  if (!JOB_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new TypeError('Invalid job status transition');
  }
  const errorCode = toStatus === 'failed'
    ? (typeof input.errorCode === 'string' ? input.errorCode.slice(0, 80) : 'PROCESSING_FAILED')
    : null;

  const result = assertSuccessful(await db.prepare(
    `UPDATE processing_jobs
     SET status = ?1,
         error_code = ?2,
         started_at = CASE WHEN ?1 = 'running' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
         completed_at = CASE WHEN ?1 IN ('succeeded', 'failed', 'cancelled') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END
     WHERE tenant_id = ?3 AND id = ?4 AND status = ?5`
  ).bind(toStatus, errorCode, tenantId, jobId, fromStatus).run());

  const changes = Number(result.meta?.changes ?? 0);
  return { updated: changes === 1, changes };
}
