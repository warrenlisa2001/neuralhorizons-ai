import { authenticateZonarTenant } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';
import { appendTenantAuditEvent } from './zonar-audit.js';
import { buildZonarReconciliation, ZONAR_RECONCILIATION_PIPELINE_VERSION } from './zonar-reconciliation-pipeline.js';
import { persistZonarOperationalEvents } from './zonar-operational-events.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REQUEST_BYTES = 4096;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

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

async function readRequest(request) {
  const declared = request.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
  }
  if (!request.body) throw Object.assign(new Error('INVALID_REQUEST'), { status: 400 });
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw Object.assign(new Error('INVALID_JSON'), { status: 400 });
  }
}

function validFileIds(body) {
  const ids = [body?.orders_file_id, body?.invoices_file_id, body?.deliveries_file_id];
  if (ids.some(id => typeof id !== 'string' || !SAFE_ID.test(id)) ||
      new Set(ids).size !== 3) return null;
  return ids;
}

async function readVerifiedCsv(bucket, file) {
  const object = await bucket.get(file.object_key);
  if (!object) throw new Error('SOURCE_OBJECT_MISSING');
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== Number(file.byte_size)) throw new Error('SOURCE_SIZE_MISMATCH');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (!file.sha256_hex || actual !== file.sha256_hex) throw new Error('SOURCE_INTEGRITY_FAILED');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('SOURCE_ENCODING_INVALID');
  }
}

/**
 * Synchronously processes three previously uploaded tenant files.
 * Tenant identity and source ownership are resolved exclusively server-side.
 * Results are stored in R2; D1 keeps status, provenance, checksum and summary.
 */
export async function handleZonarReconciliationRun(request, env, tenantId) {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!SAFE_ID.test(tenantId || '')) return json({ error: 'INVALID_TENANT' }, 400);
  if (!env.ZONAR_DB?.prepare || !env.ZONAR_FILES?.get || !env.ZONAR_FILES?.put) {
    return json({ error: 'PROCESSING_NOT_CONFIGURED' }, 503);
  }

  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return json({ error: authentication.error }, authentication.status);
  const allowed = authorizeZonarAction(authentication, 'jobs:run');
  if (!allowed.ok) return json({ error: allowed.error }, allowed.status);

  let body;
  try { body = await readRequest(request); }
  catch (error) { return json({ error: error.message }, error.status || 400); }
  const ids = validFileIds(body);
  if (!ids) return json({ error: 'THREE_DISTINCT_FILE_IDS_REQUIRED' }, 400);

  const [ordersId, invoicesId, deliveriesId] = ids;
  const runId = crypto.randomUUID().replace(/-/g, '');
  const resultKey = 'tenants/' + allowed.tenantId + '/reconciliation-results/' + runId + '.json';
  const requestId = (request.headers.get('X-Request-ID') || '').slice(0, 128) || null;

  try {
    const inserted = await env.ZONAR_DB.prepare(
      `INSERT INTO reconciliation_runs
        (id, tenant_id, requested_by_user_id, processor_version, status,
         orders_file_id, invoices_file_id, deliveries_file_id, result_object_key, started_at)
       SELECT ?1, t.id, ?3, ?4, 'running', o.id, i.id, d.id, ?8,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       FROM tenants t
       INNER JOIN tenant_files o ON o.tenant_id = t.id AND o.id = ?5
       INNER JOIN tenant_files i ON i.tenant_id = t.id AND i.id = ?6
       INNER JOIN tenant_files d ON d.tenant_id = t.id AND d.id = ?7
       WHERE t.id = ?2 AND t.status = 'active'
         AND o.status IN ('received', 'processed') AND o.deleted_at IS NULL
         AND i.status IN ('received', 'processed') AND i.deleted_at IS NULL
         AND d.status IN ('received', 'processed') AND d.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM memberships m
           INNER JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = t.id AND m.user_id = ?3
             AND m.status = 'active' AND u.status = 'active'
         )`
    ).bind(runId, allowed.tenantId, allowed.userId,
      ZONAR_RECONCILIATION_PIPELINE_VERSION, ordersId, invoicesId, deliveriesId, resultKey).run();
    if (!inserted || inserted.success === false || Number(inserted.meta?.changes ?? 0) !== 1) {
      return json({ error: 'SOURCE_FILES_NOT_AVAILABLE' }, 404);
    }

    const files = await env.ZONAR_DB.prepare(
      `SELECT id, object_key, byte_size, sha256_hex
       FROM tenant_files
       WHERE tenant_id = ?1 AND id IN (?2, ?3, ?4)
         AND status IN ('received', 'processed') AND deleted_at IS NULL`
    ).bind(allowed.tenantId, ordersId, invoicesId, deliveriesId).all();
    const byId = new Map((files.results || []).map(file => [file.id, file]));
    if (byId.size !== 3) throw new Error('SOURCE_FILES_NOT_AVAILABLE');

    const [ordersCsv, invoicesCsv, deliveriesCsv] = await Promise.all([
      readVerifiedCsv(env.ZONAR_FILES, byId.get(ordersId)),
      readVerifiedCsv(env.ZONAR_FILES, byId.get(invoicesId)),
      readVerifiedCsv(env.ZONAR_FILES, byId.get(deliveriesId))
    ]);

    const result = buildZonarReconciliation({ ordersCsv, invoicesCsv, deliveriesCsv });
    const resultBytes = new TextEncoder().encode(JSON.stringify(result));
    if (resultBytes.byteLength > MAX_RESULT_BYTES) throw new Error('RESULT_TOO_LARGE');
    const digest = await crypto.subtle.digest('SHA-256', resultBytes);
    const resultSha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');

    await env.ZONAR_FILES.put(resultKey, resultBytes, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { tenantId: allowed.tenantId, runId, sha256Hex: resultSha }
    });

    const operationalEvents = await persistZonarOperationalEvents(env.ZONAR_DB, {
      tenantId: allowed.tenantId,
      runId,
      exceptions: result.exceptions
    });

    const summaryJson = JSON.stringify({
      ...result.summary,
      operational_event_count: operationalEvents.inserted,
      operational_event_attempt_count: operationalEvents.attempted
    });
    const updated = await env.ZONAR_DB.prepare(
      `UPDATE reconciliation_runs
       SET status = 'succeeded', result_sha256_hex = ?1, summary_json = ?2,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE tenant_id = ?3 AND id = ?4 AND status = 'running'`
    ).bind(resultSha, summaryJson, allowed.tenantId, runId).run();
    if (!updated || updated.success === false || Number(updated.meta?.changes ?? 0) !== 1) {
      throw new Error('RUN_STATE_UPDATE_FAILED');
    }

    let auditRecorded = false;
    try {
      const audit = await appendTenantAuditEvent(env.ZONAR_DB, {
        id: crypto.randomUUID().replace(/-/g, ''),
        tenantId: allowed.tenantId,
        actorUserId: allowed.userId,
        eventType: 'reconciliation.completed',
        resourceType: 'reconciliation_run',
        resourceId: runId,
        requestId,
        outcome: 'success',
        details: { action: 'reconcile_three_datasets', job_id: runId, count: result.summary?.exception_count ?? 0 }
      });
      auditRecorded = audit.created === true;
    } catch {
      // A persisted, integrity-checked result remains successful if the
      // secondary audit write is temporarily unavailable; disclose the gap.
    }

    return json({
      success: true,
      run: {
        id: runId,
        status: 'succeeded',
        processor_version: ZONAR_RECONCILIATION_PIPELINE_VERSION,
        result_sha256_hex: resultSha,
        audit_recorded: auditRecorded,
        operational_events: operationalEvents,
        summary: { ...result.summary, operational_event_count: operationalEvents.inserted }
      }
    }, 201);
  } catch (error) {
    try { await env.ZONAR_FILES.delete(resultKey); } catch {}
    try {
      await env.ZONAR_DB.prepare(
        'DELETE FROM operational_events WHERE tenant_id = ?1 AND source_run_id = ?2'
      ).bind(allowed.tenantId, runId).run();
    } catch {}
    try {
      await env.ZONAR_DB.prepare(
        `UPDATE reconciliation_runs
         SET status = 'failed', error_code = ?1,
             completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE tenant_id = ?2 AND id = ?3 AND status = 'running'`
      ).bind(String(error?.message || 'PROCESSING_FAILED').slice(0, 80),
        allowed.tenantId, runId).run();
    } catch {}
    try {
      await appendTenantAuditEvent(env.ZONAR_DB, {
        id: crypto.randomUUID().replace(/-/g, ''),
        tenantId: allowed.tenantId,
        actorUserId: allowed.userId,
        eventType: 'reconciliation.failed',
        resourceType: 'reconciliation_run',
        resourceId: runId,
        requestId,
        outcome: 'failure',
        details: { action: 'reconcile_three_datasets', job_id: runId, reason_code: 'PROCESSING_FAILED' }
      });
    } catch {}
    const safeErrors = new Set([
      'SOURCE_OBJECT_MISSING', 'SOURCE_SIZE_MISMATCH', 'SOURCE_INTEGRITY_FAILED',
      'SOURCE_ENCODING_INVALID', 'SOURCE_FILES_NOT_AVAILABLE', 'RESULT_TOO_LARGE'
    ]);
    return json({ error: safeErrors.has(error?.message) ? error.message : 'RECONCILIATION_FAILED', run_id: runId }, 422);
  }
}
