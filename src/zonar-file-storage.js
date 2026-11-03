import { authenticateZonarTenant } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';
import { appendTenantAuditEvent } from './zonar-audit.js';
import { listTenantFiles } from './zonar-tenant-data.js';

const MAX_BYTES = 2 * 1024 * 1024;
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

function safeFilename(value) {
  const name = String(value || 'upload.csv').split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._ -]/g, '_').trim().slice(0, 120);
  return name && name.toLowerCase().endsWith('.csv') ? name : 'upload.csv';
}

async function readBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) {
    throw Object.assign(new Error('UPLOAD_TOO_LARGE'), { status: 413 });
  }
  if (!request.body) throw Object.assign(new Error('EMPTY_FILE'), { status: 400 });
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('UPLOAD_TOO_LARGE'), { status: 413 });
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw Object.assign(new Error('EMPTY_FILE'), { status: 400 });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  // Reject invalid UTF-8 before persisting the file.
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Object.assign(new Error('INVALID_ENCODING'), { status: 400 }); }
  return bytes;
}

function requireBindings(env) {
  if (!env.ZONAR_DB || typeof env.ZONAR_DB.prepare !== 'function' ||
      !env.ZONAR_FILES || typeof env.ZONAR_FILES.put !== 'function') return false;
  return true;
}

export async function handleZonarTenantFiles(request, env, tenantId) {
  if (!SAFE_ID.test(tenantId || '')) return json({ error: 'INVALID_TENANT' }, 400);
  if (!['GET', 'POST'].includes(request.method)) {
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }
  if (!requireBindings(env)) return json({ error: 'FILE_STORAGE_NOT_CONFIGURED' }, 503);

  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return json({ error: authentication.error }, authentication.status);

  if (request.method === 'GET') {
    const allowed = authorizeZonarAction(authentication, 'files:read');
    if (!allowed.ok) return json({ error: allowed.error }, allowed.status);
    try {
      const files = await listTenantFiles(env.ZONAR_DB, allowed.tenantId, { limit: 50 });
      return json({ success: true, files });
    } catch {
      return json({ error: 'FILE_LIST_UNAVAILABLE' }, 503);
    }
  }

  const allowed = authorizeZonarAction(authentication, 'files:upload');
  if (!allowed.ok) return json({ error: allowed.error }, allowed.status);
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'text/csv' && contentType !== 'text/plain') {
    return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
  }

  let bytes;
  try { bytes = await readBody(request); }
  catch (error) { return json({ error: error.message || 'INVALID_UPLOAD' }, error.status || 400); }

  const fileId = crypto.randomUUID().replace(/-/g, '');
  const objectKey = 'tenants/' + allowed.tenantId + '/files/' + fileId;
  const filename = safeFilename(request.headers.get('X-Filename'));
  const sha256 = await crypto.subtle.digest('SHA-256', bytes);
  const sha256Hex = Array.from(new Uint8Array(sha256), b => b.toString(16).padStart(2, '0')).join('');
  const requestId = (request.headers.get('X-Request-ID') || '').slice(0, 128) || null;

  try {
    await env.ZONAR_FILES.put(objectKey, bytes, {
      httpMetadata: { contentType: 'text/csv' },
      customMetadata: { tenantId: allowed.tenantId, fileId, sha256Hex }
    });
    const inserted = await env.ZONAR_DB.prepare(
      `INSERT INTO tenant_files
        (id, tenant_id, uploaded_by_user_id, original_filename, object_key,
         content_type, byte_size, sha256_hex, status)
       SELECT ?1, t.id, ?3, ?4, ?5, 'text/csv', ?6, ?7, 'received'
       FROM tenants t
       WHERE t.id = ?2 AND t.status = 'active'
         AND EXISTS (
           SELECT 1 FROM memberships m
           INNER JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = t.id AND m.user_id = ?3
             AND m.status = 'active' AND u.status = 'active'
         )`
    ).bind(fileId, allowed.tenantId, allowed.userId, filename, objectKey, bytes.byteLength, sha256Hex).run();
    if (!inserted || inserted.success === false || Number(inserted.meta?.changes ?? 0) !== 1) {
      await env.ZONAR_FILES.delete(objectKey);
      return json({ error: 'FILE_RECORD_NOT_CREATED' }, 503);
    }
    await appendTenantAuditEvent(env.ZONAR_DB, {
      id: crypto.randomUUID().replace(/-/g, ''),
      tenantId: allowed.tenantId,
      actorUserId: allowed.userId,
      eventType: 'file.uploaded',
      resourceType: 'file',
      resourceId: fileId,
      requestId,
      outcome: 'success',
      details: { action: 'tenant_file_upload', file_id: fileId, bytes: bytes.byteLength }
    });
    return json({
      success: true,
      file: {
        id: fileId,
        filename,
        content_type: 'text/csv',
        byte_size: bytes.byteLength,
        sha256_hex: sha256Hex,
        status: 'received'
      }
    }, 201);
  } catch {
    try { await env.ZONAR_FILES.delete(objectKey); } catch {}
    return json({ error: 'FILE_UPLOAD_FAILED' }, 503);
  }
}
