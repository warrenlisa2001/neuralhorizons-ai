import { authenticateZonarTenant } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';
import { appendTenantAuditEvent } from './zonar-audit.js';
import { buildZonarReconciliation, ZONAR_RECONCILIATION_PIPELINE_VERSION } from './zonar-reconciliation-pipeline.js';
import { persistZonarOperationalEvents } from './zonar-operational-events.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REQUEST_BYTES = 4096;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const OUTBOX_BATCH_SIZE = 20;
const LEASE_SECONDS = 300;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  }});
}

async function readBoundedJson(request) {
  if (!request.body) throw Object.assign(new Error('INVALID_JSON'), { status: 400 });
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
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }); }
}

function validFileIds(body) {
  const ids = [body?.orders_file_id, body?.invoices_file_id, body?.deliveries_file_id];
  return ids.every(id => typeof id === 'string' && SAFE_ID.test(id)) && new Set(ids).size === 3 ? ids : null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Authenticated, idempotent job submission. D1 batch commits run + outbox together. */
export async function handleZonarAsyncReconciliationEnqueue(request, env, tenantId) {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!SAFE_ID.test(tenantId || '')) return json({ error: 'INVALID_TENANT' }, 400);
  if (!env.ZONAR_DB?.prepare || typeof env.ZONAR_DB.batch !== 'function') {
    return json({ error: 'ASYNC_PROCESSING_NOT_CONFIGURED' }, 503);
  }
  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return json({ error: authentication.error }, authentication.status);
  const allowed = authorizeZonarAction(authentication, 'jobs:run');
  if (!allowed.ok) return json({ error: allowed.error }, allowed.status);

  let body;
  try { body = await readBoundedJson(request); }
  catch (error) { return json({ error: error.message }, error.status || 400); }
  const ids = validFileIds(body);
  if (!ids) return json({ error: 'THREE_DISTINCT_FILE_IDS_REQUIRED' }, 400);

  const suppliedKey = request.headers.get('Idempotency-Key') || body.idempotency_key || '';
  if (suppliedKey && (typeof suppliedKey !== 'string' || !SAFE_ID.test(suppliedKey))) {
    return json({ error: 'INVALID_IDEMPOTENCY_KEY' }, 400);
  }
  const idempotencyKey = suppliedKey || crypto.randomUUID().replace(/-/g, '');
  const [ordersId, invoicesId, deliveriesId] = ids;
  const fingerprint = await sha256Hex(JSON.stringify({
    tenant_id: allowed.tenantId, orders_file_id: ordersId,
    invoices_file_id: invoicesId, deliveries_file_id: deliveriesId,
    processor_version: ZONAR_RECONCILIATION_PIPELINE_VERSION
  }));
  const runId = crypto.randomUUID().replace(/-/g, '');
  const outboxId = crypto.randomUUID().replace(/-/g, '');

  try {
    await env.ZONAR_DB.batch([
      env.ZONAR_DB.prepare(
        `INSERT INTO reconciliation_runs
          (id, tenant_id, requested_by_user_id, processor_version, status,
           orders_file_id, invoices_file_id, deliveries_file_id,
           idempotency_key, request_fingerprint)
         SELECT ?1, t.id, ?3, ?4, 'queued', o.id, i.id, d.id, ?8, ?9
         FROM tenants t
         INNER JOIN tenant_files o ON o.tenant_id=t.id AND o.id=?5
         INNER JOIN tenant_files i ON i.tenant_id=t.id AND i.id=?6
         INNER JOIN tenant_files d ON d.tenant_id=t.id AND d.id=?7
         WHERE t.id=?2 AND t.status='active'
           AND o.status IN ('received','processed') AND o.deleted_at IS NULL
           AND i.status IN ('received','processed') AND i.deleted_at IS NULL
           AND d.status IN ('received','processed') AND d.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
             WHERE m.tenant_id=t.id AND m.user_id=?3
               AND m.status='active' AND u.status='active'
           )
         ON CONFLICT(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`
      ).bind(runId, allowed.tenantId, allowed.userId,
        ZONAR_RECONCILIATION_PIPELINE_VERSION, ordersId, invoicesId, deliveriesId,
        idempotencyKey, fingerprint),
      env.ZONAR_DB.prepare(
        `INSERT OR IGNORE INTO reconciliation_outbox (id, tenant_id, run_id)
         SELECT ?1, ?2, id FROM reconciliation_runs WHERE tenant_id=?2 AND id=?3`
      ).bind(outboxId, allowed.tenantId, runId)
    ]);
    const run = await env.ZONAR_DB.prepare(
      `SELECT id, status, processor_version, request_fingerprint, created_at
       FROM reconciliation_runs WHERE tenant_id=?1 AND idempotency_key=?2 LIMIT 1`
    ).bind(allowed.tenantId, idempotencyKey).first();
    if (!run) return json({ error: 'SOURCE_FILES_NOT_AVAILABLE' }, 404);
    if (run.request_fingerprint !== fingerprint) {
      return json({ error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' }, 409);
    }
    return json({
      success: true,
      run: { id: run.id, status: run.status, processor_version: run.processor_version, created_at: run.created_at },
      status_url: `/api/zonar/tenants/${encodeURIComponent(allowed.tenantId)}/reconciliation-runs/${encodeURIComponent(run.id)}`
    }, 202);
  } catch {
    return json({ error: 'JOB_ENQUEUE_FAILED' }, 503);
  }
}

function isoAfter(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Claim pending outbox rows with compare-and-set before publishing minimal messages. */
export async function dispatchZonarReconciliationOutbox(env, now = new Date()) {
  const db = env.ZONAR_DB;
  const queue = env.ZONAR_RECONCILIATION_QUEUE;
  if (!db?.prepare || !queue?.send) return { dispatched: 0, deferred: 0 };
  await db.prepare(
    `UPDATE reconciliation_outbox
     SET status='pending', lease_token=NULL, lease_expires_at=NULL,
         available_at=?1, updated_at=?1
     WHERE status='leased' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?1`
  ).bind(now.toISOString()).run();
  const candidates = await db.prepare(
    `SELECT id FROM reconciliation_outbox
     WHERE status='pending' AND available_at<=?1
     ORDER BY created_at LIMIT ?2`
  ).bind(now.toISOString(), OUTBOX_BATCH_SIZE).all();
  let dispatched = 0, deferred = 0;
  for (const candidate of candidates.results || []) {
    const leaseToken = crypto.randomUUID().replace(/-/g, '');
    const claimed = await db.prepare(
      `UPDATE reconciliation_outbox
       SET status='leased', lease_token=?1, lease_expires_at=?2,
           attempt_count=attempt_count+1, updated_at=?3
       WHERE id=?4 AND status='pending' AND available_at<=?3
       RETURNING id, run_id, tenant_id, attempt_count`
    ).bind(leaseToken, isoAfter(LEASE_SECONDS), now.toISOString(), candidate.id).first();
    if (!claimed) continue;
    try {
      await queue.send({ version: 1, run_id: claimed.run_id });
      await db.prepare(
        `UPDATE reconciliation_outbox
         SET status='dispatched', lease_token=NULL, lease_expires_at=NULL,
             dispatched_at=?1, updated_at=?1
         WHERE id=?2 AND status='leased' AND lease_token=?3`
      ).bind(now.toISOString(), claimed.id, leaseToken).run();
      dispatched++;
    } catch {
      const delay = Math.min(900, 5 * (2 ** Math.min(claimed.attempt_count, 7)));
      await db.prepare(
        `UPDATE reconciliation_outbox
         SET status='pending', lease_token=NULL, lease_expires_at=NULL,
             available_at=?1, last_error_code='QUEUE_SEND_FAILED', updated_at=?2
         WHERE id=?3 AND status='leased' AND lease_token=?4`
      ).bind(isoAfter(delay), now.toISOString(), claimed.id, leaseToken).run();
      deferred++;
    }
  }
  return { dispatched, deferred };
}

async function readVerifiedCsv(bucket, file) {
  if (Number(file.byte_size) > MAX_SOURCE_BYTES) throw new Error('SOURCE_TOO_LARGE');
  const object = await bucket.get(file.object_key);
  if (!object) throw new Error('SOURCE_OBJECT_MISSING');
  if (Number(object.size) > MAX_SOURCE_BYTES) throw new Error('SOURCE_TOO_LARGE');
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('SOURCE_TOO_LARGE');
  if (bytes.byteLength !== Number(file.byte_size)) throw new Error('SOURCE_SIZE_MISMATCH');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (!file.sha256_hex || actual !== file.sha256_hex) throw new Error('SOURCE_INTEGRITY_FAILED');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Queue consumer. A lease token fences stale consumers from committing results. */
export async function processZonarReconciliationMessage(message, env) {
  const payload = message?.body;
  if (!payload || payload.version !== 1 || !SAFE_ID.test(payload.run_id || '')) {
    message?.ack?.();
    return { acknowledged: true, reason: 'INVALID_MESSAGE' };
  }
  const db = env.ZONAR_DB;
  const bucket = env.ZONAR_FILES;
  if (!db?.prepare || !bucket?.get || !bucket?.put) {
    message.retry?.({ delaySeconds: 60 });
    return { acknowledged: false, reason: 'PROCESSING_NOT_CONFIGURED' };
  }
  const leaseToken = crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();
  const run = await db.prepare(
    `UPDATE reconciliation_runs
     SET status='running', attempt_count=attempt_count+1,
         lease_token=?1, lease_expires_at=?2, last_attempt_at=?3,
         started_at=COALESCE(started_at, ?3), updated_at=?3
     WHERE id=?4 AND status='queued' AND attempt_count<max_attempts
     RETURNING id, tenant_id, requested_by_user_id, processor_version,
               orders_file_id, invoices_file_id, deliveries_file_id, attempt_count, max_attempts`
  ).bind(leaseToken, isoAfter(LEASE_SECONDS), now, payload.run_id).first();

  if (!run) {
    const existing = await db.prepare(
      'SELECT status, lease_expires_at FROM reconciliation_runs WHERE id=?1 LIMIT 1'
    ).bind(payload.run_id).first();
    if (existing?.status === 'queued') {
      message.retry?.({ delaySeconds: 15 });
      return { acknowledged: false, reason: 'CLAIM_RACE' };
    }
    message.ack?.();
    return { acknowledged: true, reason: existing?.status || 'RUN_NOT_FOUND' };
  }

  let resultKey = null;
  try {
    const files = await db.prepare(
      `SELECT id, object_key, byte_size, sha256_hex
       FROM tenant_files WHERE tenant_id=?1 AND id IN (?2,?3,?4)
         AND status IN ('received','processed') AND deleted_at IS NULL`
    ).bind(run.tenant_id, run.orders_file_id, run.invoices_file_id, run.deliveries_file_id).all();
    const byId = new Map((files.results || []).map(file => [file.id, file]));
    if (byId.size !== 3) throw new Error('SOURCE_FILES_NOT_AVAILABLE');
    const [ordersCsv, invoicesCsv, deliveriesCsv] = await Promise.all([
      readVerifiedCsv(bucket, byId.get(run.orders_file_id)),
      readVerifiedCsv(bucket, byId.get(run.invoices_file_id)),
      readVerifiedCsv(bucket, byId.get(run.deliveries_file_id))
    ]);
    const result = buildZonarReconciliation({ ordersCsv, invoicesCsv, deliveriesCsv });
    const bytes = new TextEncoder().encode(JSON.stringify(result));
    if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('RESULT_TOO_LARGE');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const resultSha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    resultKey = `tenants/${run.tenant_id}/reconciliation-results/${run.id}/${leaseToken}.json`;
    await bucket.put(resultKey, bytes, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { tenantId: run.tenant_id, runId: run.id, sha256Hex: resultSha }
    });
    const events = await persistZonarOperationalEvents(db, {
      tenantId: run.tenant_id, runId: run.id, exceptions: result.exceptions
    });
    const summary = JSON.stringify({
      ...result.summary, operational_event_count: events.inserted,
      operational_event_attempt_count: events.attempted
    });
    const completedAt = new Date().toISOString();
    const updated = await db.prepare(
      `UPDATE reconciliation_runs
       SET status='succeeded', result_object_key=?1, result_sha256_hex=?2,
           summary_json=?3, completed_at=?4, lease_token=NULL, lease_expires_at=NULL, updated_at=?4
       WHERE tenant_id=?5 AND id=?6 AND status='running' AND lease_token=?7 AND lease_expires_at>?4`
    ).bind(resultKey, resultSha, summary, completedAt, run.tenant_id, run.id, leaseToken).run();
    if (Number(updated?.meta?.changes || 0) !== 1) {
      await bucket.delete?.(resultKey);
      message.ack?.();
      return { acknowledged: true, reason: 'STALE_LEASE' };
    }
    try {
      await appendTenantAuditEvent(db, {
        id: crypto.randomUUID().replace(/-/g, ''), tenantId: run.tenant_id,
        actorUserId: run.requested_by_user_id, eventType: 'reconciliation.completed',
        resourceType: 'reconciliation_run', resourceId: run.id, outcome: 'success',
        details: { action: 'reconcile_three_datasets', job_id: run.id, count: result.summary?.exception_count ?? 0 }
      });
    } catch { /* Result durability is independent of secondary audit availability. */ }
    message.ack?.();
    return { acknowledged: true, status: 'succeeded' };
  } catch (error) {
    if (resultKey) { try { await bucket.delete?.(resultKey); } catch {} }
    const permanentErrors = new Set([
      'SOURCE_FILES_NOT_AVAILABLE', 'SOURCE_OBJECT_MISSING', 'SOURCE_SIZE_MISMATCH',
      'SOURCE_INTEGRITY_FAILED', 'SOURCE_ENCODING_INVALID', 'RESULT_TOO_LARGE', 'SOURCE_TOO_LARGE',
      'UPLOAD_TOO_LARGE', 'EMPTY_FILE', 'NO_DATA_ROWS', 'TOO_MANY_ROWS', 'TOO_MANY_COLUMNS',
      'INVALID_CSV', 'INVALID_NUMERIC_VALUE', 'REQUIRED_COLUMN_MISSING', 'MALFORMED_ROW',
      'DUPLICATE_HEADER', 'BLANK_HEADER', 'AMBIGUOUS_FIELD_MAPPING', 'INVALID_DATASET'
    ]);
    const retryable = !permanentErrors.has(error?.message);
    const exhausted = Number(run.attempt_count) >= Number(run.max_attempts);
    if (retryable && !exhausted) {
      await db.prepare(
        `UPDATE reconciliation_runs SET status='queued', lease_token=NULL, lease_expires_at=NULL,
           error_code=?1, updated_at=?2
         WHERE tenant_id=?3 AND id=?4 AND status='running' AND lease_token=?5 AND lease_expires_at>?2`
      ).bind('PROCESSING_RETRY', new Date().toISOString(), run.tenant_id, run.id, leaseToken).run();
      message.retry?.({ delaySeconds: Math.min(300, 10 * (2 ** Math.min(run.attempt_count - 1, 5))) });
      return { acknowledged: false, reason: 'RETRY_SCHEDULED' };
    }
    await db.prepare(
      `UPDATE reconciliation_runs SET status='failed', error_code=?1,
         completed_at=?2, lease_token=NULL, lease_expires_at=NULL, updated_at=?2
       WHERE tenant_id=?3 AND id=?4 AND status='running' AND lease_token=?5`
    ).bind(retryable ? 'RETRIES_EXHAUSTED' : String(error?.message || 'PROCESSING_FAILED').slice(0, 80),
      new Date().toISOString(), run.tenant_id, run.id, leaseToken).run();
    message.ack?.();
    return { acknowledged: true, status: 'failed' };
  }
}

/** Scheduled recovery for abandoned consumer leases and bounded outbox dispatch. */
export async function recoverZonarReconciliationLeases(env, now = new Date()) {
  if (!env.ZONAR_DB?.prepare) return { recovered: 0, failed: 0 };
  const stamp = now.toISOString();
  const rows = await env.ZONAR_DB.prepare(
    `SELECT id, tenant_id, attempt_count, max_attempts FROM reconciliation_runs
     WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?1
     ORDER BY lease_expires_at LIMIT 100`
  ).bind(stamp).all();
  let recovered = 0, failed = 0;
  for (const row of rows.results || []) {
    if (Number(row.attempt_count) >= Number(row.max_attempts)) {
      await env.ZONAR_DB.prepare(
        `UPDATE reconciliation_runs SET status='failed', error_code='LEASE_EXPIRED',
           completed_at=?1, lease_token=NULL, lease_expires_at=NULL, updated_at=?1
         WHERE tenant_id=?2 AND id=?3 AND status='running' AND lease_expires_at<=?1`
      ).bind(stamp, row.tenant_id, row.id).run();
      failed++;
    } else {
      await env.ZONAR_DB.prepare(
        `UPDATE reconciliation_runs SET status='queued', error_code='LEASE_RECOVERED',
           lease_token=NULL, lease_expires_at=NULL, updated_at=?1
         WHERE tenant_id=?2 AND id=?3 AND status='running' AND lease_expires_at<=?1`
      ).bind(stamp, row.tenant_id, row.id).run();
      await env.ZONAR_DB.prepare(
        `UPDATE reconciliation_outbox SET status='pending', lease_token=NULL, lease_expires_at=NULL,
           available_at=?1, dispatched_at=NULL, updated_at=?1
         WHERE tenant_id=?2 AND run_id=?3 AND status IN ('dispatched','leased')`
      ).bind(stamp, row.tenant_id, row.id).run();
      recovered++;
    }
  }
  return { recovered, failed };
}

export async function handleZonarReconciliationQueueBatch(batch, env) {
  for (const message of batch.messages || []) await processZonarReconciliationMessage(message, env);
}
