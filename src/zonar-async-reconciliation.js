import { authenticateZonarTenant } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';
import {
  ZONAR_STAGED_PROCESSOR_VERSION,
  describeZonarSourceIntegrity,
  ensureZonarCompletionAudit,
  runZonarStagedProcessing,
  zonarSourceLimits
} from './zonar-staged-run-processor.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REQUEST_BYTES = 4096;
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
  if (env.ZONAR_ASYNC_ENABLED !== 'true' ||
      !env.ZONAR_DB?.prepare || typeof env.ZONAR_DB.batch !== 'function' ||
      !env.ZONAR_FILES?.get || !env.ZONAR_FILES?.put ||
      !env.ZONAR_RECONCILIATION_QUEUE?.send) {
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
  // The consumer streams objects into D1 staging, so size is bounded by the
  // configured operational cap rather than by worker memory. "Ready" means the
  // shared integrity definition is satisfied (multipart manifest OR whole SHA-256).
  const limits = zonarSourceLimits(env);
  let sourceRows;
  try {
    sourceRows = await env.ZONAR_DB.prepare(
      `SELECT id, status, byte_size, sha256_hex, integrity_status, integrity_manifest_sha256_hex
       FROM tenant_files
       WHERE tenant_id = ?1 AND id IN (?2, ?3, ?4)`
    ).bind(allowed.tenantId, ordersId, invoicesId, deliveriesId).all();
  } catch {
    return json({ error: 'SOURCE_LOOKUP_UNAVAILABLE' }, 503);
  }
  const sources = Array.isArray(sourceRows.results) ? sourceRows.results : [];
  if (sources.length !== 3) return json({ error: 'SOURCE_FILES_NOT_AVAILABLE' }, 404);
  if (sources.some(file => !['received', 'processed'].includes(file.status) ||
      describeZonarSourceIntegrity(file).mode === 'none' ||
      !(Number(file.byte_size) > 0) || Number(file.byte_size) > limits.maxBytes)) {
    return json({
      error: 'SOURCE_FILES_NOT_READY_FOR_PROCESSING',
      max_source_bytes: limits.maxBytes
    }, 409);
  }
  const fingerprint = await sha256Hex(JSON.stringify({
    tenant_id: allowed.tenantId, orders_file_id: ordersId,
    invoices_file_id: invoicesId, deliveries_file_id: deliveriesId,
    processor_version: ZONAR_STAGED_PROCESSOR_VERSION
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
        ZONAR_STAGED_PROCESSOR_VERSION, ordersId, invoicesId, deliveriesId,
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
  if (!db?.prepare || !queue?.send || typeof db.batch !== 'function') return { dispatched: 0, deferred: 0 };
  const stamp = now.toISOString();
  await db.batch([
    db.prepare(
      `UPDATE reconciliation_outbox
       SET status=CASE WHEN attempt_count>=max_dispatch_attempts THEN 'dead_letter' ELSE 'pending' END,
           lease_token=NULL, lease_expires_at=NULL, available_at=?1,
           last_error_code=CASE WHEN attempt_count>=max_dispatch_attempts THEN 'DISPATCH_RETRIES_EXHAUSTED' ELSE last_error_code END,
           updated_at=?1
       WHERE status='leased' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?1`
    ).bind(stamp),
    db.prepare(
      `UPDATE reconciliation_outbox
       SET status='dead_letter', last_error_code='RUN_NOT_QUEUED', updated_at=?1
       WHERE status='pending'
         AND EXISTS (SELECT 1 FROM reconciliation_runs r
                     WHERE r.tenant_id=reconciliation_outbox.tenant_id
                       AND r.id=reconciliation_outbox.run_id AND r.status<>'queued')`
    ).bind(stamp)
  ]);
  const candidates = await db.prepare(
    `SELECT o.id FROM reconciliation_outbox o
     JOIN reconciliation_runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id
     WHERE o.status='pending' AND o.available_at<=?1
       AND o.attempt_count<o.max_dispatch_attempts AND r.status='queued'
     ORDER BY o.created_at LIMIT ?2`
  ).bind(stamp, OUTBOX_BATCH_SIZE).all();
  let dispatched = 0, deferred = 0;
  for (const candidate of candidates.results || []) {
    const leaseToken = crypto.randomUUID().replace(/-/g, '');
    const claimed = await db.prepare(
      `UPDATE reconciliation_outbox
       SET status='leased', lease_token=?1, lease_expires_at=?2,
           attempt_count=attempt_count+1, updated_at=?3
       WHERE id=?4 AND status='pending' AND available_at<=?3
         AND attempt_count<max_dispatch_attempts
       RETURNING id, run_id, tenant_id, attempt_count, max_dispatch_attempts`
    ).bind(leaseToken, isoAfter(LEASE_SECONDS), stamp, candidate.id).first();
    if (!claimed) continue;
    try {
      await queue.send({ version: 1, run_id: claimed.run_id });
      await db.prepare(
        `UPDATE reconciliation_outbox
         SET status='dispatched', lease_token=NULL, lease_expires_at=NULL,
             dispatched_at=?1, updated_at=?1
         WHERE id=?2 AND status='leased' AND lease_token=?3`
      ).bind(stamp, claimed.id, leaseToken).run();
      dispatched++;
    } catch {
      const delay = Math.min(900, 5 * (2 ** Math.min(claimed.attempt_count, 7)));
      await db.prepare(
        `UPDATE reconciliation_outbox
         SET status=CASE WHEN attempt_count>=max_dispatch_attempts THEN 'dead_letter' ELSE 'pending' END,
             lease_token=NULL, lease_expires_at=NULL, available_at=?1,
             last_error_code=CASE WHEN attempt_count>=max_dispatch_attempts THEN 'DISPATCH_RETRIES_EXHAUSTED' ELSE 'QUEUE_SEND_FAILED' END,
             updated_at=?2
         WHERE id=?3 AND status='leased' AND lease_token=?4`
      ).bind(isoAfter(delay), stamp, claimed.id, leaseToken).run();
      deferred++;
    }
  }
  return { dispatched, deferred };
}

/** Queue consumer. A lease token fences stale consumers from committing results. */
export async function processZonarReconciliationMessage(message, env, options = {}) {
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
      'SELECT status, lease_expires_at, attempt_count, max_attempts, tenant_id FROM reconciliation_runs WHERE id=?1 LIMIT 1'
    ).bind(payload.run_id).first();
    if (existing?.status === 'queued' &&
        Number(existing.attempt_count) >= Number(existing.max_attempts)) {
      await db.prepare(
        `UPDATE reconciliation_runs SET status='failed', error_code='RETRIES_EXHAUSTED',
           completed_at=?1, updated_at=?1
         WHERE tenant_id=?2 AND id=?3 AND status='queued' AND attempt_count>=max_attempts`
      ).bind(new Date().toISOString(), existing.tenant_id, payload.run_id).run();
      message.ack?.();
      return { acknowledged: true, status: 'failed' };
    }
    if (existing?.status === 'queued') {
      message.retry?.({ delaySeconds: 15 });
      return { acknowledged: false, reason: 'CLAIM_RACE' };
    }
    message.ack?.();
    return { acknowledged: true, reason: existing?.status || 'RUN_NOT_FOUND' };
  }

  const heartbeat = async () => {
    const stamp = new Date().toISOString();
    const beat = await db.prepare(
      `UPDATE reconciliation_runs SET lease_expires_at=?1, updated_at=?2
       WHERE tenant_id=?3 AND id=?4 AND status='running' AND lease_token=?5`
    ).bind(isoAfter(LEASE_SECONDS), stamp, run.tenant_id, run.id, leaseToken).run();
    if (Number(beat?.meta?.changes || 0) !== 1) throw new Error('STALE_LEASE');
  };

  try {
    const loadFiles = async () => {
      const rows = await db.prepare(
        `SELECT id, object_key, byte_size, sha256_hex, integrity_status, integrity_manifest_sha256_hex
         FROM tenant_files WHERE tenant_id=?1 AND id IN (?2,?3,?4)
           AND status IN ('received','processed') AND deleted_at IS NULL`
      ).bind(run.tenant_id, run.orders_file_id, run.invoices_file_id, run.deliveries_file_id).all();
      const byId = new Map((rows.results || []).map(file => [file.id, file]));
      if (byId.size !== 3) throw new Error('SOURCE_FILES_NOT_AVAILABLE');
      return byId;
    };
    const summary = await runZonarStagedProcessing({
      env: { ...env, ZONAR_DB: db, ZONAR_FILES: bucket }, run, loadFiles, heartbeat,
      digestFactory: options.digestFactory
    });
    const summaryJson = JSON.stringify(summary);

    // Mandatory audit first; the status change is also conditioned on it existing,
    // so a run can never be 'succeeded' without its completion audit record.
    const auditId = await ensureZonarCompletionAudit(db, run, summary);
    const completedAt = new Date().toISOString();
    const updated = await db.prepare(
      `UPDATE reconciliation_runs
       SET status='succeeded', result_object_key=NULL, result_sha256_hex=NULL,
           summary_json=?1, error_code=NULL, completed_at=?2,
           lease_token=NULL, lease_expires_at=NULL, updated_at=?2
       WHERE tenant_id=?3 AND id=?4 AND status='running' AND lease_token=?5 AND lease_expires_at>?2
         AND EXISTS (SELECT 1 FROM audit_events WHERE tenant_id=?3 AND id=?6)`
    ).bind(summaryJson, completedAt, run.tenant_id, run.id, leaseToken, auditId).run();
    if (Number(updated?.meta?.changes || 0) !== 1) {
      message.ack?.();
      return { acknowledged: true, reason: 'STALE_LEASE' };
    }
    message.ack?.();
    return { acknowledged: true, status: 'succeeded' };
  } catch (error) {
    if (error?.message === 'STALE_LEASE') {
      message.ack?.();
      return { acknowledged: true, reason: 'STALE_LEASE' };
    }
    const permanentErrors = new Set([
      'SOURCE_FILES_NOT_AVAILABLE', 'SOURCE_OBJECT_MISSING', 'SOURCE_SIZE_MISMATCH',
      'SOURCE_INTEGRITY_FAILED', 'SOURCE_INTEGRITY_UNVERIFIABLE', 'SOURCE_ENCODING_INVALID',
      'SOURCE_TOO_LARGE', 'UPLOAD_TOO_LARGE', 'EMPTY_FILE', 'NO_DATA_ROWS', 'TOO_MANY_ROWS',
      'TOO_MANY_COLUMNS', 'INVALID_CSV', 'INVALID_ENCODING', 'INVALID_STREAM',
      'INVALID_NUMERIC_VALUE', 'REQUIRED_COLUMN_MISSING', 'MALFORMED_ROW', 'DUPLICATE_HEADER',
      'BLANK_HEADER', 'AMBIGUOUS_FIELD_MAPPING', 'INVALID_DATASET', 'STREAM_DATASET_EMPTY',
      'STREAM_PARSER_EVENT_INVALID', 'STAGING_REPLAY_CONFLICT'
    ]);
    const retryable = !permanentErrors.has(error?.message);
    const exhausted = Number(run.attempt_count) >= Number(run.max_attempts);
    if (retryable && !exhausted) {
      const retryAt = isoAfter(Math.min(300, 10 * (2 ** Math.min(run.attempt_count - 1, 5))));
      const retryStamp = new Date().toISOString();
      await db.batch([
        db.prepare(
          `UPDATE reconciliation_runs SET status='queued', lease_token=NULL, lease_expires_at=NULL,
             error_code='PROCESSING_RETRY', updated_at=?1
           WHERE tenant_id=?2 AND id=?3 AND status='running' AND lease_token=?4 AND lease_expires_at>?1`
        ).bind(retryStamp, run.tenant_id, run.id, leaseToken),
        db.prepare(
          `UPDATE reconciliation_outbox SET status='pending', lease_token=NULL, lease_expires_at=NULL,
             available_at=?1, dispatched_at=NULL, updated_at=?2
           WHERE tenant_id=?3 AND run_id=?4 AND status IN ('dispatched','leased')
             AND EXISTS (SELECT 1 FROM reconciliation_runs
                         WHERE tenant_id=?3 AND id=?4 AND status='queued')`
        ).bind(retryAt, retryStamp, run.tenant_id, run.id)
      ]);
      message.ack?.();
      return { acknowledged: true, reason: 'RETRY_SCHEDULED' };
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
      await env.ZONAR_DB.batch([
        env.ZONAR_DB.prepare(
          `UPDATE reconciliation_runs SET status='queued', error_code='LEASE_RECOVERED',
             lease_token=NULL, lease_expires_at=NULL, updated_at=?1
           WHERE tenant_id=?2 AND id=?3 AND status='running' AND lease_expires_at<=?1`
        ).bind(stamp, row.tenant_id, row.id),
        env.ZONAR_DB.prepare(
          `UPDATE reconciliation_outbox SET status='pending', lease_token=NULL, lease_expires_at=NULL,
             available_at=?1, dispatched_at=NULL, updated_at=?1
           WHERE tenant_id=?2 AND run_id=?3 AND status IN ('dispatched','leased')
             AND EXISTS (SELECT 1 FROM reconciliation_runs
                         WHERE tenant_id=?2 AND id=?3 AND status='queued')`
        ).bind(stamp, row.tenant_id, row.id)
      ]);
      recovered++;
    }
  }
  return { recovered, failed };
}

export async function handleZonarReconciliationQueueBatch(batch, env) {
  for (const message of batch.messages || []) await processZonarReconciliationMessage(message, env);
}
