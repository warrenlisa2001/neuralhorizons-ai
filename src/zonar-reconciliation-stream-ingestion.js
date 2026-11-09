import { parseZonarCsvStream } from './zonar-csv-stream.js';
import {
  initialiseZonarDatasetProgress,
  persistZonarStagingBatch,
  completeZonarDatasetProgress,
  ZONAR_STAGING_BATCH_LIMIT
} from './zonar-reconciliation-staging.js';

/**
 * Stream one R2 object into durable D1 row batches.
 *
 * Retries deliberately re-read from byte zero: committed batches are verified
 * as identical replays, and the first uncommitted batch must follow the durable
 * row checkpoint. This avoids pretending a CSV row checkpoint is a byte offset.
 */
export async function ingestZonarCsvStreamToStaging(db, input) {
  const {
    tenantId, runId, dataset, sourceFileId, stream,
    maxBytes, maxRows, maxColumns
  } = input || {};
  const progress = await initialiseZonarDatasetProgress(db, {
    tenantId, runId, dataset, sourceFileId
  });
  if (progress.status === 'complete') {
    return { status: 'complete', row_count: Number(progress.row_count), replayed: true };
  }

  let headers = null;
  let mappings = null;
  let rowCount = 0;
  let batch = [];
  let committed = 0;

  const flush = async () => {
    if (!batch.length) return;
    const result = await persistZonarStagingBatch(db, {
      tenantId, runId, dataset, rows: batch, headers, mappings
    });
    committed += result.inserted_or_confirmed;
    batch = [];
  };

  for await (const item of parseZonarCsvStream(stream, {
    dataset,
    ...(Number.isSafeInteger(maxBytes) ? { maxBytes } : {}),
    ...(Number.isSafeInteger(maxRows) ? { maxRows } : {}),
    ...(Number.isSafeInteger(maxColumns) ? { maxColumns } : {})
  })) {
    if (item.type === 'header') {
      headers = item.headers;
      mappings = item.mappings;
      continue;
    }
    if (item.type !== 'row' || item.dataset !== dataset) {
      throw new Error('STREAM_PARSER_EVENT_INVALID');
    }
    rowCount++;
    batch.push({ row_number: item.row_number, record: item.record });
    if (batch.length >= ZONAR_STAGING_BATCH_LIMIT) await flush();
  }
  await flush();
  if (!headers || rowCount < 1) throw new Error('STREAM_DATASET_EMPTY');
  await completeZonarDatasetProgress(db, {
    tenantId, runId, dataset, expectedRowCount: rowCount
  });
  return {
    status: 'complete',
    row_count: rowCount,
    batches: Math.ceil(rowCount / ZONAR_STAGING_BATCH_LIMIT),
    rows_confirmed: committed,
    resumed_from_start: Number(progress.last_row_number || 0) > 0
  };
}
