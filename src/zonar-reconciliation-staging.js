const DATASETS = new Set(['orders', 'invoices', 'deliveries']);
const MAX_BATCH_ROWS = 50;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertDb(db) {
  if (!db?.prepare || typeof db.batch !== 'function') throw new Error('STAGING_DB_UNAVAILABLE');
}

async function digestRecord(record) {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Create the durable per-dataset checkpoint. The source-file relationship is
 * additionally enforced by migration 0009's tenant/run/source trigger.
 */
export async function initialiseZonarDatasetProgress(db, input) {
  assertDb(db);
  const { tenantId, runId, dataset, sourceFileId } = input || {};
  if (![tenantId, runId, sourceFileId].every(value => typeof value === 'string' && SAFE_ID.test(value)) ||
      !DATASETS.has(dataset)) throw new Error('INVALID_STAGING_IDENTITY');
  await db.prepare(
    `INSERT OR IGNORE INTO reconciliation_dataset_progress
      (tenant_id, run_id, dataset, source_file_id, status, last_row_number, row_count)
     VALUES (?1, ?2, ?3, ?4, 'pending', 0, 0)`
  ).bind(tenantId, runId, dataset, sourceFileId).run();
  const progress = await db.prepare(
    `SELECT source_file_id, status, last_row_number, row_count
     FROM reconciliation_dataset_progress
     WHERE tenant_id=?1 AND run_id=?2 AND dataset=?3`
  ).bind(tenantId, runId, dataset).first();
  if (!progress || progress.source_file_id !== sourceFileId) throw new Error('STAGING_SOURCE_CONFLICT');
  return progress;
}

/**
 * Persist one bounded, idempotent row batch. Replayed rows are accepted only
 * when their canonical content hash matches the already-staged row. The
 * checkpoint advances in the same D1 batch as row inserts.
 */
export async function persistZonarStagingBatch(db, input) {
  assertDb(db);
  const { tenantId, runId, dataset, rows, headers, mappings } = input || {};
  if (![tenantId, runId].every(value => typeof value === 'string' && SAFE_ID.test(value)) ||
      !DATASETS.has(dataset) || !Array.isArray(rows) || !rows.length ||
      rows.length > MAX_BATCH_ROWS) throw new Error('INVALID_STAGING_BATCH');
  const ordered = [...rows].sort((a, b) => a.row_number - b.row_number);
  for (let i = 0; i < ordered.length; i++) {
    if (!Number.isInteger(ordered[i].row_number) || ordered[i].row_number < 2 ||
        (i && ordered[i].row_number !== ordered[i - 1].row_number + 1) ||
        !ordered[i].record || typeof ordered[i].record !== 'object' ||
        Array.isArray(ordered[i].record)) throw new Error('INVALID_STAGING_ROW');
  }
  const first = ordered[0].row_number;
  const last = ordered[ordered.length - 1].row_number;
  const hashes = new Map();
  for (const item of ordered) hashes.set(item.row_number, await digestRecord(item.record));
  const statements = ordered.map(item => {
    const record = item.record;
    const idField = dataset === 'orders' ? 'order_id' : dataset === 'invoices' ? 'invoice_id' : 'delivery_id';
    const recordId = String(record[idField] ?? '').trim() || null;
    const orderId = dataset === 'orders' ? recordId : String(record.order_id ?? '').trim() || null;
    const json = JSON.stringify(record);
    return db.prepare(
      `INSERT INTO reconciliation_staging_rows
        (tenant_id, run_id, dataset, row_number, record_id, order_id, record_json, row_sha256_hex)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(tenant_id, run_id, dataset, row_number) DO NOTHING`
    ).bind(tenantId, runId, dataset, item.row_number, recordId, orderId, json, hashes.get(item.row_number));
  });
  statements.push(db.prepare(
    `UPDATE reconciliation_dataset_progress
     SET status='ingesting',
         headers_json=COALESCE(?1, headers_json),
         mappings_json=COALESCE(?2, mappings_json),
         last_row_number=MAX(last_row_number, ?3),
         row_count=MAX(row_count, ?4),
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE tenant_id=?5 AND run_id=?6 AND dataset=?7 AND status IN ('pending','ingesting')`
  ).bind(headers ? JSON.stringify(headers) : null, mappings ? JSON.stringify(mappings) : null,
    last, last - 1, tenantId, runId, dataset));
  await db.batch(statements);

  const persisted = await db.prepare(
    `SELECT row_number, row_sha256_hex FROM reconciliation_staging_rows
     WHERE tenant_id=?1 AND run_id=?2 AND dataset=?3 AND row_number BETWEEN ?4 AND ?5
     ORDER BY row_number`
  ).bind(tenantId, runId, dataset, first, last).all();
  const byRow = new Map((persisted.results || []).map(row => [Number(row.row_number), row.row_sha256_hex]));
  for (const item of ordered) {
    if (byRow.get(item.row_number) !== hashes.get(item.row_number)) {
      throw new Error('STAGING_REPLAY_CONFLICT');
    }
  }
  if (byRow.size !== ordered.length) throw new Error('STAGING_BATCH_INCOMPLETE');
  return { inserted_or_confirmed: ordered.length, first_row_number: first, last_row_number: last };
}

export async function completeZonarDatasetProgress(db, input) {
  assertDb(db);
  const { tenantId, runId, dataset, expectedRowCount } = input || {};
  if (![tenantId, runId].every(value => typeof value === 'string' && SAFE_ID.test(value)) ||
      !DATASETS.has(dataset) || !Number.isInteger(expectedRowCount) || expectedRowCount < 1) {
    throw new Error('INVALID_STAGING_COMPLETION');
  }
  const result = await db.prepare(
    `UPDATE reconciliation_dataset_progress
     SET status='complete', row_count=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE tenant_id=?2 AND run_id=?3 AND dataset=?4
       AND status='ingesting' AND last_row_number=?1+1`
  ).bind(expectedRowCount, tenantId, runId, dataset).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new Error('STAGING_COMPLETION_CHECKPOINT_MISMATCH');
  return { status: 'complete', row_count: expectedRowCount };
}

export const ZONAR_STAGING_BATCH_LIMIT = MAX_BATCH_ROWS;
