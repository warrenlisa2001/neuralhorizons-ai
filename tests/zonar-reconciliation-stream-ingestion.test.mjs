import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestZonarCsvStreamToStaging } from '../src/zonar-reconciliation-stream-ingestion.js';

function makeStream(value, chunkSize = 7) {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    }
  });
}

function fakeDb() {
  const staged = new Map();
  let progress = { source_file_id: 'file_1', status: 'pending', last_row_number: 0, row_count: 0 };
  return {
    staged,
    prepare(sql) {
      return { bind(...values) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO reconciliation_dataset_progress')) return { meta: { changes: 1 } };
            if (sql.includes('UPDATE reconciliation_dataset_progress') && sql.includes("status='ingesting'")) {
              progress = { ...progress, status: 'ingesting', last_row_number: Math.max(progress.last_row_number, values[2]), row_count: Math.max(progress.row_count, values[3]) };
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status='complete'")) {
              if (progress.status === 'ingesting' && progress.last_row_number === values[0] + 1) {
                progress = { ...progress, status: 'complete', row_count: values[0] };
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            if (sql.includes('INSERT INTO reconciliation_staging_rows')) {
              const key = values.slice(0, 4).join(':');
              if (!staged.has(key)) staged.set(key, {
                row_number: values[3], row_sha256_hex: values[7]
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('SELECT source_file_id')) return progress;
            if (sql.includes('SELECT status, last_row_number')) return progress;
            if (sql.includes('SELECT COUNT(*) AS row_count')) {
              const rows = [...staged.values()];
              return { row_count: rows.length, first_row: rows.length ? Math.min(...rows.map(row => row.row_number)) : null, last_row: rows.length ? Math.max(...rows.map(row => row.row_number)) : null };
            }
            return progress;
          },
          async all() {
            if (sql.includes('SELECT row_number, row_sha256_hex')) {
              return { results: [...staged.values()].filter(row => row.row_number >= values[3] && row.row_number <= values[4]) };
            }
            return { results: [] };
          }
        };
      }};
    },
    async batch(statements) { for (const statement of statements) await statement.run(); return []; }
  };
}

test('streams parsed records into bounded durable batches and completes the dataset', async () => {
  const db = fakeDb();
  const csv = 'order_id,quantity_ordered,order_value\n' +
    Array.from({length: 120}, (_, i) => `O-${i + 1},${i + 1},${(i + 1) * 10}`).join('\n');
  const result = await ingestZonarCsvStreamToStaging(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders',
    sourceFileId:'file_1', stream:makeStream(csv)
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.row_count, 120);
  assert.equal(result.batches, 3);
  assert.equal(db.staged.size, 120);
});

test('resumes by replaying identical committed batches and rejects changed staged content', async () => {
  const db = fakeDb();
  const rows = Array.from({length: 60}, (_, i) => `O-${i + 1},${i + 1}`);
  const csv = 'order_id,quantity_ordered\n' + rows.join('\n');
  const initialRows = Array.from({length: 50}, (_, i) => ({
    row_number: i + 2,
    record: { order_id: `O-${i + 1}`, quantity_ordered: i + 1 }
  }));
  // Simulate a worker that committed its first complete 50-row batch before interruption.
  const { initialiseZonarDatasetProgress, persistZonarStagingBatch } =
    await import('../src/zonar-reconciliation-staging.js');
  await initialiseZonarDatasetProgress(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders', sourceFileId:'file_1'
  });
  await persistZonarStagingBatch(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders', rows:initialRows
  });

  const resumed = await ingestZonarCsvStreamToStaging(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders',
    sourceFileId:'file_1', stream:makeStream(csv)
  });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.row_count, 60);
  assert.equal(db.staged.size, 60);

  const otherDb = fakeDb();
  await initialiseZonarDatasetProgress(otherDb, {
    tenantId:'tenant_1', runId:'run_2', dataset:'orders', sourceFileId:'file_2'
  });
  await persistZonarStagingBatch(otherDb, {
    tenantId:'tenant_1', runId:'run_2', dataset:'orders',
    rows:[{row_number:2, record:{order_id:'O-1', quantity_ordered:1}}]
  });
  await assert.rejects(() => persistZonarStagingBatch(otherDb, {
    tenantId:'tenant_1', runId:'run_2', dataset:'orders',
    rows:[{row_number:2, record:{order_id:'O-1', quantity_ordered:99}}]
  }), /STAGING_REPLAY_CONFLICT/);
});
