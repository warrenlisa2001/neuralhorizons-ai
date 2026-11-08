import { authenticateZonarTenant } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';
import { appendTenantAuditEvent } from './zonar-audit.js';

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_PARTS = 128;
const SESSION_TTL_HOURS = 24;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    }
  });
}

function filename(value) {
  const clean = String(value || 'upload.csv').split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._ -]/g, '_').trim().slice(0, 120);
  return clean && clean.toLowerCase().endsWith('.csv') ? clean : 'upload.csv';
}

function sha256Hex(bytes) {
  return crypto.subtle.digest('SHA-256', bytes).then(hash =>
    Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
  );
}

function bindingsReady(env) {
  return env.ZONAR_RESUMABLE_UPLOADS_ENABLED === 'true' && Boolean(env.ZONAR_DB?.prepare && env.ZONAR_DB?.batch &&
    env.ZONAR_FILES?.createMultipartUpload && env.ZONAR_FILES?.resumeMultipartUpload);
}

async function tenantContext(request, env, tenantId) {
  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return { response: json({ error: authentication.error }, authentication.status) };
  const allowed = authorizeZonarAction(authentication, 'files:upload');
  if (!allowed.ok) return { response: json({ error: allowed.error }, allowed.status) };
  return { allowed };
}

async function createSession(request, env, tenantId, allowed) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  const size = Number(body?.byte_size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
    return json({ error: 'INVALID_FILE_SIZE', max_bytes: MAX_FILE_BYTES }, 400);
  }
  const partCount = Math.ceil(size / CHUNK_BYTES);
  if (partCount < 1 || partCount > MAX_PARTS) return json({ error: 'TOO_MANY_PARTS' }, 400);

  const id = crypto.randomUUID().replace(/-/g, '');
  const objectKey = 'tenants/' + allowed.tenantId + '/files/' + id;
  let multipart;
  try {
    multipart = await env.ZONAR_FILES.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: 'text/csv' },
      customMetadata: { tenantId: allowed.tenantId, uploadSessionId: id }
    });
    if (!multipart?.uploadId) throw new Error('MULTIPART_CREATE_FAILED');
    await env.ZONAR_DB.prepare(
      `INSERT INTO tenant_upload_sessions
        (id, tenant_id, user_id, filename, object_key, r2_upload_id,
         expected_bytes, chunk_bytes, part_count, status, expires_at)
       SELECT ?1, t.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours')
       FROM tenants t
       WHERE t.id = ?2 AND t.status = 'active'
         AND EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = t.id AND m.user_id = ?3
             AND m.status = 'active' AND u.status = 'active')`
    ).bind(id, allowed.tenantId, allowed.userId, filename(body.filename),
      objectKey, multipart.uploadId, size, CHUNK_BYTES, partCount).run();
    const row = await env.ZONAR_DB.prepare(
      'SELECT id FROM tenant_upload_sessions WHERE id = ?1 AND tenant_id = ?2'
    ).bind(id, allowed.tenantId).first();
    if (!row) throw new Error('UPLOAD_SESSION_NOT_CREATED');
    return json({
      success: true, upload_id: id, chunk_bytes: CHUNK_BYTES,
      part_count: partCount, expected_bytes: size,
      expires_in_seconds: SESSION_TTL_HOURS * 3600
    }, 201);
  } catch {
    if (multipart?.uploadId) {
      try { await env.ZONAR_FILES.resumeMultipartUpload(objectKey, multipart.uploadId).abort(); } catch {}
    }
    return json({ error: 'UPLOAD_SESSION_CREATE_FAILED' }, 503);
  }
}

async function uploadPart(request, env, tenantId, allowed, uploadId, partNumber) {
  if (!SAFE_ID.test(uploadId) || !/^\d+$/.test(partNumber)) return json({ error: 'INVALID_UPLOAD_PART' }, 400);
  const number = Number(partNumber);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PARTS) return json({ error: 'INVALID_UPLOAD_PART' }, 400);
  const session = await env.ZONAR_DB.prepare(
    `SELECT id, object_key, r2_upload_id, expected_bytes, chunk_bytes, part_count, status,
            expires_at, user_id
     FROM tenant_upload_sessions WHERE id = ?1 AND tenant_id = ?2 LIMIT 1`
  ).bind(uploadId, allowed.tenantId).first();
  if (!session || session.user_id !== allowed.userId) return json({ error: 'UPLOAD_SESSION_NOT_FOUND' }, 404);
  if (session.status !== 'active' || Date.parse(session.expires_at) <= Date.now()) {
    return json({ error: 'UPLOAD_SESSION_NOT_ACTIVE' }, 409);
  }
  if (number > session.part_count) return json({ error: 'INVALID_UPLOAD_PART' }, 400);

  const expectedPartBytes = number < session.part_count
    ? session.chunk_bytes
    : session.expected_bytes - session.chunk_bytes * (session.part_count - 1);
  const declared = request.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) !== expectedPartBytes) {
    return json({ error: 'INVALID_PART_SIZE', expected_bytes: expectedPartBytes }, 400);
  }
  if (!request.body) return json({ error: 'EMPTY_PART' }, 400);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > expectedPartBytes) {
        await reader.cancel();
        return json({ error: 'INVALID_PART_SIZE', expected_bytes: expectedPartBytes }, 400);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (total !== expectedPartBytes) return json({ error: 'INVALID_PART_SIZE', expected_bytes: expectedPartBytes }, 400);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const digest = await sha256Hex(bytes);

  const existing = await env.ZONAR_DB.prepare(
    'SELECT byte_size, sha256_hex, etag, status FROM tenant_upload_parts WHERE upload_id = ?1 AND part_number = ?2'
  ).bind(uploadId, number).first();
  if (existing) {
    if (existing.byte_size === total && existing.sha256_hex === digest && existing.status === 'uploaded' && existing.etag) {
      return json({ success: true, part_number: number, byte_size: total, sha256_hex: digest, already_uploaded: true });
    }
    return json({ error: 'PART_CONFLICT_OR_IN_PROGRESS' }, 409);
  }

  const reserved = await env.ZONAR_DB.prepare(
    `INSERT OR IGNORE INTO tenant_upload_parts
      (upload_id, part_number, byte_size, sha256_hex, status)
     SELECT ?1, ?2, ?3, ?4, 'reserved'
     WHERE EXISTS (SELECT 1 FROM tenant_upload_sessions
       WHERE id = ?1 AND tenant_id = ?5 AND user_id = ?6 AND status = 'active')`
  ).bind(uploadId, number, total, digest, allowed.tenantId, allowed.userId).run();
  if (Number(reserved.meta?.changes ?? 0) !== 1) return json({ error: 'PART_CONFLICT_OR_IN_PROGRESS' }, 409);

  try {
    const upload = env.ZONAR_FILES.resumeMultipartUpload(session.object_key, session.r2_upload_id);
    const result = await upload.uploadPart(number, bytes);
    if (!result?.etag) throw new Error('PART_UPLOAD_FAILED');
    await env.ZONAR_DB.prepare(
      `UPDATE tenant_upload_parts SET etag = ?1, status = 'uploaded'
       WHERE upload_id = ?2 AND part_number = ?3 AND sha256_hex = ?4 AND status = 'reserved'`
    ).bind(result.etag, uploadId, number, digest).run();
    return json({ success: true, part_number: number, byte_size: total, sha256_hex: digest });
  } catch {
    await env.ZONAR_DB.prepare(
      'DELETE FROM tenant_upload_parts WHERE upload_id = ?1 AND part_number = ?2 AND status = ?3'
    ).bind(uploadId, number, 'reserved').run();
    return json({ error: 'PART_UPLOAD_FAILED' }, 503);
  }
}

async function getSessionStatus(env, allowed, uploadId) {
  const session = await env.ZONAR_DB.prepare(
    `SELECT id, filename, expected_bytes, chunk_bytes, part_count, status,
            expires_at, completed_file_id, created_at, updated_at
     FROM tenant_upload_sessions
     WHERE id = ?1 AND tenant_id = ?2 AND user_id = ?3 LIMIT 1`
  ).bind(uploadId, allowed.tenantId, allowed.userId).first();
  if (!session) return json({ error: 'UPLOAD_SESSION_NOT_FOUND' }, 404);
  const result = await env.ZONAR_DB.prepare(
    `SELECT part_number, byte_size, sha256_hex, status
     FROM tenant_upload_parts WHERE upload_id = ?1 ORDER BY part_number ASC`
  ).bind(uploadId).all();
  const parts = Array.isArray(result.results) ? result.results : [];
  return json({
    success: true,
    upload: {
      id: session.id, filename: session.filename,
      expected_bytes: session.expected_bytes, chunk_bytes: session.chunk_bytes,
      part_count: session.part_count, status: session.status,
      expires_at: session.expires_at, completed_file_id: session.completed_file_id,
      created_at: session.created_at, updated_at: session.updated_at
    },
    uploaded_parts: parts.filter(part => part.status === 'uploaded').map(part => ({
      part_number: part.part_number, byte_size: part.byte_size, sha256_hex: part.sha256_hex
    })),
    uploaded_part_count: parts.filter(part => part.status === 'uploaded').length
  });
}

async function completeSession(request, env, tenantId, allowed, uploadId) {
  if (!SAFE_ID.test(uploadId)) return json({ error: 'INVALID_UPLOAD_ID' }, 400);
  const session = await env.ZONAR_DB.prepare(
    `SELECT * FROM tenant_upload_sessions
     WHERE id = ?1 AND tenant_id = ?2 AND user_id = ?3 LIMIT 1`
  ).bind(uploadId, allowed.tenantId, allowed.userId).first();
  if (!session) return json({ error: 'UPLOAD_SESSION_NOT_FOUND' }, 404);
  if (session.status === 'completed' && session.completed_file_id) {
    const existingFile = await env.ZONAR_DB.prepare(
      `SELECT id, original_filename, content_type, byte_size, status
       FROM tenant_files WHERE tenant_id = ?1 AND id = ?2
         AND deleted_at IS NULL AND status <> 'deleted' LIMIT 1`
    ).bind(allowed.tenantId, session.completed_file_id).first();
    if (!existingFile) return json({ error: 'COMPLETED_FILE_UNAVAILABLE' }, 503);
    return json({
      success: true, already_completed: true,
      file: { id: existingFile.id, filename: existingFile.original_filename,
        content_type: existingFile.content_type, byte_size: existingFile.byte_size,
        status: existingFile.status }
    }, 200);
  }
  if (session.status !== 'active') return json({ error: 'UPLOAD_SESSION_NOT_ACTIVE' }, 409);
  if (Date.parse(session.expires_at) <= Date.now()) return json({ error: 'UPLOAD_SESSION_EXPIRED' }, 410);

  const partsResult = await env.ZONAR_DB.prepare(
    `SELECT part_number, byte_size, sha256_hex, etag, status
     FROM tenant_upload_parts WHERE upload_id = ?1 ORDER BY part_number ASC`
  ).bind(uploadId).all();
  const parts = Array.isArray(partsResult.results) ? partsResult.results : [];
  if (parts.length !== session.part_count || parts.some((part, index) =>
    part.part_number !== index + 1 || part.status !== 'uploaded' || !part.etag)) {
    return json({ error: 'UPLOAD_INCOMPLETE', uploaded_parts: parts.filter(p => p.status === 'uploaded').length, required_parts: session.part_count }, 409);
  }
  const total = parts.reduce((sum, part) => sum + Number(part.byte_size), 0);
  if (total !== session.expected_bytes) return json({ error: 'UPLOAD_SIZE_MISMATCH' }, 409);

  const claim = await env.ZONAR_DB.prepare(
    `UPDATE tenant_upload_sessions SET status = 'completing',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?1 AND tenant_id = ?2 AND user_id = ?3 AND status = 'active'`
  ).bind(uploadId, allowed.tenantId, allowed.userId).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return json({ error: 'UPLOAD_SESSION_BUSY' }, 409);

  let object;
  try {
    const upload = env.ZONAR_FILES.resumeMultipartUpload(session.object_key, session.r2_upload_id);
    await upload.complete(parts.map(part => ({ partNumber: part.part_number, etag: part.etag })));
    object = await env.ZONAR_FILES.head(session.object_key);
    if (!object || Number(object.size) !== session.expected_bytes) throw new Error('COMPLETED_OBJECT_SIZE_MISMATCH');
  } catch {
    await env.ZONAR_DB.prepare(
      `UPDATE tenant_upload_sessions SET status = 'active',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?1 AND tenant_id = ?2 AND status = 'completing'`
    ).bind(uploadId, allowed.tenantId).run();
    return json({ error: 'UPLOAD_FINALIZATION_FAILED' }, 503);
  }

  const fileId = crypto.randomUUID().replace(/-/g, '');
  const aggregate = await env.ZONAR_DB.batch([
    env.ZONAR_DB.prepare(
      `INSERT INTO tenant_files
        (id, tenant_id, uploaded_by_user_id, original_filename, object_key,
         content_type, byte_size, sha256_hex, status)
       SELECT ?1, ?2, ?3, ?4, ?5, 'text/csv', ?6, NULL, 'received'
       WHERE EXISTS (SELECT 1 FROM tenant_upload_sessions
         WHERE id = ?7 AND tenant_id = ?2 AND user_id = ?3 AND status = 'completing')`
    ).bind(fileId, allowed.tenantId, allowed.userId, session.filename, session.object_key, session.expected_bytes, uploadId),
    env.ZONAR_DB.prepare(
      `UPDATE tenant_upload_sessions SET status = 'completed', completed_file_id = ?1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?2 AND tenant_id = ?3 AND user_id = ?4 AND status = 'completing'`
    ).bind(fileId, uploadId, allowed.tenantId, allowed.userId)
  ]);
  if (aggregate.some(result => !result || result.success === false) ||
      Number(aggregate[0]?.meta?.changes ?? 0) !== 1 ||
      Number(aggregate[1]?.meta?.changes ?? 0) !== 1) {
    try { await env.ZONAR_FILES.delete(session.object_key); } catch {}
    await env.ZONAR_DB.prepare(
      `UPDATE tenant_upload_sessions SET status = 'failed',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?1 AND tenant_id = ?2 AND status = 'completing'`
    ).bind(uploadId, allowed.tenantId).run();
    return json({ error: 'FILE_RECORD_NOT_CREATED' }, 503);
  }

  await appendTenantAuditEvent(env.ZONAR_DB, {
    id: crypto.randomUUID().replace(/-/g, ''), tenantId: allowed.tenantId,
    actorUserId: allowed.userId, eventType: 'file.uploaded',
    resourceType: 'file', resourceId: fileId,
    requestId: (request.headers.get('X-Request-ID') || '').slice(0, 128) || null,
    outcome: 'success',
    details: { action: 'resumable_tenant_file_upload', file_id: fileId, bytes: session.expected_bytes, parts: session.part_count }
  });
  return json({
    success: true,
    file: { id: fileId, filename: session.filename, content_type: 'text/csv',
      byte_size: session.expected_bytes, status: 'received' }
  }, 201);
}

async function abortSession(env, tenantId, allowed, uploadId) {
  if (!SAFE_ID.test(uploadId)) return json({ error: 'INVALID_UPLOAD_ID' }, 400);
  const session = await env.ZONAR_DB.prepare(
    `SELECT object_key, r2_upload_id, status FROM tenant_upload_sessions
     WHERE id = ?1 AND tenant_id = ?2 AND user_id = ?3 LIMIT 1`
  ).bind(uploadId, allowed.tenantId, allowed.userId).first();
  if (!session) return json({ error: 'UPLOAD_SESSION_NOT_FOUND' }, 404);
  if (session.status === 'completed') return json({ error: 'UPLOAD_ALREADY_COMPLETED' }, 409);
  if (['aborted', 'expired', 'failed'].includes(session.status)) return json({ success: true, status: session.status });
  try { await env.ZONAR_FILES.resumeMultipartUpload(session.object_key, session.r2_upload_id).abort(); } catch {}
  await env.ZONAR_DB.prepare(
    `UPDATE tenant_upload_sessions SET status = 'aborted',
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?1 AND tenant_id = ?2 AND user_id = ?3 AND status IN ('active', 'completing')`
  ).bind(uploadId, allowed.tenantId, allowed.userId).run();
  return json({ success: true, status: 'aborted' });
}

export async function handleZonarResumableUpload(request, env, tenantId, uploadId = null, partNumber = null, action = null) {
  if (!SAFE_ID.test(tenantId || '')) return json({ error: 'INVALID_TENANT' }, 400);
  if (!bindingsReady(env)) return json({ error: 'RESUMABLE_UPLOAD_NOT_CONFIGURED' }, 503);
  const context = await tenantContext(request, env, tenantId);
  if (context.response) return context.response;
  const { allowed } = context;

  if (!uploadId && request.method === 'POST') return createSession(request, env, tenantId, allowed);
  if (!uploadId || !SAFE_ID.test(uploadId)) return json({ error: 'INVALID_UPLOAD_ID' }, 400);
  if (!action && request.method === 'GET') return getSessionStatus(env, allowed, uploadId);
  if (action === 'parts' && request.method === 'PUT') return uploadPart(request, env, tenantId, allowed, uploadId, partNumber);
  if (action === 'complete' && request.method === 'POST') return completeSession(request, env, tenantId, allowed, uploadId);
  if (action === 'abort' && request.method === 'DELETE') return abortSession(env, tenantId, allowed, uploadId);
  return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
}


/** Abort expired incomplete multipart uploads in a bounded scheduled batch. */
export async function expireZonarUploadSessions(env, now = new Date()) {
  const db = env.ZONAR_DB;
  const bucket = env.ZONAR_FILES;
  if (env.ZONAR_RESUMABLE_UPLOADS_ENABLED !== 'true' ||
      !db?.prepare || !bucket?.resumeMultipartUpload) return { expired: 0, deferred: 0 };
  const stamp = now.toISOString();
  const result = await db.prepare(
    `SELECT id, object_key, r2_upload_id, tenant_id
     FROM tenant_upload_sessions
     WHERE status = 'active' AND expires_at <= ?1
     ORDER BY expires_at LIMIT 20`
  ).bind(stamp).all();
  let expired = 0, deferred = 0;
  for (const session of result.results || []) {
    try {
      await bucket.resumeMultipartUpload(session.object_key, session.r2_upload_id).abort();
      const update = await db.prepare(
        `UPDATE tenant_upload_sessions SET status = 'expired',
         updated_at = ?1 WHERE id = ?2 AND tenant_id = ?3
         AND status = 'active' AND expires_at <= ?1`
      ).bind(stamp, session.id, session.tenant_id).run();
      if (Number(update.meta?.changes ?? 0) === 1) expired++;
    } catch { deferred++; }
  }
  return { expired, deferred };
}
