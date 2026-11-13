import { ingestZonarCsvStreamToStaging } from './zonar-reconciliation-stream-ingestion.js';
import {
  processZonarStagedReconciliationBatch,
  getZonarStagedReconciliationSummary,
  ZONAR_RECONCILIATION_ENGINE_BATCH_LIMIT
} from './zonar-staged-reconciliation-engine.js';
import { persistZonarOperationalEvents } from './zonar-operational-events.js';
import { appendTenantAuditEvent } from './zonar-audit.js';

/**
 * Streaming + staged processor used by the queue consumer.
 *
 * Replaces the legacy path (whole-object arrayBuffer(), 2 MiB ceiling, in-memory
 * reconciler). Source objects are streamed R2 -> CSV parser -> bounded D1 staging
 * batches; reconciliation then runs over staged rows in bounded pages.
 */
export const ZONAR_STAGED_PROCESSOR_VERSION = 'zonar-staged-1';

const DATASET_FILE_FIELDS = Object.freeze([
  ['orders', 'orders_file_id'],
  ['invoices', 'invoices_file_id'],
  ['deliveries', 'deliveries_file_id']
]);
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_ROWS = 10000;
const MAX_ENGINE_BATCHES_PER_INVOCATION = 200;
const EXCEPTION_PAGE_SIZE = 200;
const HEARTBEAT_INTERVAL_MS = 30000;

/** Operational caps. Env overrides must be positive safe integers. */
export function zonarSourceLimits(env = {}) {
  const read = (value, fallback) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  return {
    maxBytes: read(env.ZONAR_MAX_SOURCE_BYTES, DEFAULT_MAX_SOURCE_BYTES),
    maxRows: read(env.ZONAR_MAX_SOURCE_ROWS, DEFAULT_MAX_SOURCE_ROWS)
  };
}

/**
 * The single definition of a "verified source object", shared by job submission
 * and the consumer so the two can never disagree.
 *   verified_parts  - multipart upload; per-part manifest verified at completion
 *                     (no whole-object SHA-256 exists, and none is claimed).
 *   whole_sha256    - a stored whole-object SHA-256 that the consumer re-checks
 *                     while streaming.
 *   none            - not processable.
 */
export function describeZonarSourceIntegrity(file) {
  if (!file || file.integrity_status === 'failed') return { mode: 'none' };
  if (file.integrity_status === 'verified_parts') {
    return /^[0-9a-f]{64}$/.test(file.integrity_manifest_sha256_hex || '')
      ? { mode: 'verified_parts' } : { mode: 'none' };
  }
  if (/^[0-9a-f]{64}$/.test(file.sha256_hex || '')) {
    return { mode: 'whole_sha256', expected: file.sha256_hex };
  }
  return { mode: 'none' };
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

function defaultDigestFactory() {
  if (typeof crypto === 'undefined' || typeof crypto.DigestStream !== 'function') return null;
  return new crypto.DigestStream('SHA-256');
}

/**
 * Wrap an R2 body so that bytes are counted, the lease is kept alive, and (for
 * whole-object checksums) SHA-256 is verified incrementally. A mismatch errors the
 * stream at end-of-input, i.e. BEFORE the ingester can mark the dataset complete,
 * so a retry can never skip verification.
 */
function guardedStream(body, { integrity, expectedBytes, digestFactory, heartbeat }) {
  let digest = null;
  let writer = null;
  if (integrity.mode === 'whole_sha256') {
    digest = digestFactory();
    if (!digest) throw new Error('SOURCE_INTEGRITY_UNVERIFIABLE');
    writer = digest.getWriter ? digest.getWriter() : digest.writable.getWriter();
  }
  let seen = 0;
  let lastBeat = Date.now();
  return body.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expectedBytes) throw new Error('SOURCE_SIZE_MISMATCH');
      if (writer) await writer.write(chunk);
      if (Date.now() - lastBeat >= HEARTBEAT_INTERVAL_MS) {
        lastBeat = Date.now();
        await heartbeat();
      }
      controller.enqueue(chunk);
    },
    async flush() {
      if (seen !== expectedBytes) throw new Error('SOURCE_SIZE_MISMATCH');
      if (writer) {
        await writer.close();
        const actual = toHex(await digest.digest);
        if (actual !== integrity.expected) throw new Error('SOURCE_INTEGRITY_FAILED');
      }
    }
  }));
}

async function datasetAlreadyComplete(db, run, dataset) {
  const row = await db.prepare(
    `SELECT status FROM reconciliation_dataset_progress
     WHERE tenant_id=?1 AND run_id=?2 AND dataset=?3`
  ).bind(run.tenant_id, run.id, dataset).first();
  return row?.status === 'complete';
}

async function ingestDataset({ db, bucket, run, dataset, file, limits, digestFactory, heartbeat }) {
  if (!file) throw new Error('SOURCE_FILES_NOT_AVAILABLE');
  const integrity = describeZonarSourceIntegrity(file);
  if (integrity.mode === 'none') throw new Error('SOURCE_INTEGRITY_FAILED');
  const expectedBytes = Number(file.byte_size);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new Error('SOURCE_SIZE_MISMATCH');
  if (expectedBytes > limits.maxBytes) throw new Error('SOURCE_TOO_LARGE');

  // A dataset already committed as complete was verified in the invocation that
  // completed it (verification precedes completion), so a retry does not re-read it.
  if (await datasetAlreadyComplete(db, run, dataset)) return { dataset, replayed: true };

  const object = await bucket.get(file.object_key);
  if (!object || !object.body) throw new Error('SOURCE_OBJECT_MISSING');
  if (Number(object.size) !== expectedBytes) throw new Error('SOURCE_SIZE_MISMATCH');

  const stream = guardedStream(object.body, { integrity, expectedBytes, digestFactory, heartbeat });
  const result = await ingestZonarCsvStreamToStaging(db, {
    tenantId: run.tenant_id, runId: run.id, dataset, sourceFileId: file.id, stream,
    maxBytes: limits.maxBytes, maxRows: limits.maxRows
  });
  return { dataset, ...result };
}

async function publishOperationalEvents(db, run) {
  let cursor = 0, attempted = 0, inserted = 0;
  while (true) {
    const page = await db.prepare(
      `SELECT id, code, severity, dataset, source_row_number, record_id, order_id,
              expected_value, actual_value
       FROM reconciliation_exceptions
       WHERE tenant_id=?1 AND run_id=?2 AND id>?3
       ORDER BY id LIMIT ?4`
    ).bind(run.tenant_id, run.id, cursor, EXCEPTION_PAGE_SIZE).all();
    const rows = page.results || [];
    if (!rows.length) break;
    const events = await persistZonarOperationalEvents(db, {
      tenantId: run.tenant_id, runId: run.id,
      exceptions: rows.map(row => ({
        code: row.code, severity: row.severity, dataset: row.dataset,
        row: row.source_row_number, record_id: row.record_id, order_id: row.order_id,
        expected: row.expected_value, actual: row.actual_value
      }))
    });
    attempted += events.attempted;
    inserted += events.inserted;
    cursor = Number(rows[rows.length - 1].id);
    if (rows.length < EXCEPTION_PAGE_SIZE) break;
  }
  return { attempted, inserted };
}

/**
 * Stream, stage, reconcile and publish events for one claimed run. Everything here
 * is idempotent so a retry after any interruption resumes from durable checkpoints.
 * Returns the summary; the caller owns the completion transition.
 */
export async function runZonarStagedProcessing({ env, run, loadFiles, heartbeat, digestFactory }) {
  const db = env.ZONAR_DB;
  const bucket = env.ZONAR_FILES;
  const limits = zonarSourceLimits(env);
  const files = await loadFiles();
  const factory = digestFactory || defaultDigestFactory;

  for (const [dataset, field] of DATASET_FILE_FIELDS) {
    await heartbeat();
    await ingestDataset({
      db, bucket, run, dataset, file: files.get(run[field]),
      limits, digestFactory: factory, heartbeat
    });
  }

  let complete = false;
  for (let i = 0; i < MAX_ENGINE_BATCHES_PER_INVOCATION && !complete; i++) {
    await heartbeat();
    const step = await processZonarStagedReconciliationBatch(db, {
      tenantId: run.tenant_id, runId: run.id,
      batchSize: ZONAR_RECONCILIATION_ENGINE_BATCH_LIMIT
    });
    complete = step.status === 'complete';
  }
  // Progress is durable; a retry resumes at the checkpoint.
  if (!complete) throw new Error('RECONCILIATION_CONTINUATION_REQUIRED');

  const summary = await getZonarStagedReconciliationSummary(db, {
    tenantId: run.tenant_id, runId: run.id
  });
  const events = await publishOperationalEvents(db, run);
  return {
    ...summary,
    processor: ZONAR_STAGED_PROCESSOR_VERSION,
    operational_event_count: events.inserted,
    operational_event_attempt_count: events.attempted
  };
}

export function zonarCompletionAuditId(runId) {
  return `rc_${runId}`;
}

async function completionAuditExists(db, tenantId, auditId) {
  const row = await db.prepare(
    'SELECT 1 AS present FROM audit_events WHERE tenant_id=?1 AND id=?2 LIMIT 1'
  ).bind(tenantId, auditId).first();
  return !!row;
}

/**
 * The completion audit event is REQUIRED. It is written (idempotently, under a
 * deterministic id) before the run may enter 'succeeded', and the status change
 * itself is additionally conditioned on that row existing. Throws if it cannot be
 * made durable, which sends the run down the normal retry/fail path.
 */
export async function ensureZonarCompletionAudit(db, run, summary) {
  const auditId = zonarCompletionAuditId(run.id);
  if (await completionAuditExists(db, run.tenant_id, auditId)) return auditId;
  const base = {
    id: auditId, tenantId: run.tenant_id, eventType: 'reconciliation.completed',
    resourceType: 'reconciliation_run', resourceId: run.id, outcome: 'success'
  };
  const details = { action: 'reconcile_three_datasets', job_id: run.id, count: summary.exception_count ?? 0 };
  let written = await appendTenantAuditEvent(db, { ...base, actorUserId: run.requested_by_user_id, details });
  if (!written.created && run.requested_by_user_id) {
    // Requester membership may have lapsed mid-run; keep the trail, drop the actor.
    written = await appendTenantAuditEvent(db, {
      ...base, actorUserId: null, details: { ...details, reason_code: 'requester_inactive' }
    });
  }
  if (!written.created && !(await completionAuditExists(db, run.tenant_id, auditId))) {
    throw new Error('AUDIT_COMPLETION_NOT_WRITTEN');
  }
  return auditId;
}
