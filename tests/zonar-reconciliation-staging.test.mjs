import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialiseZonarDatasetProgress,
  persistZonarStagingBatch,
  completeZonarDatasetProgress,
  ZONAR_STAGING_BATCH_LIMIT
} from '../src/zonar-reconciliation-staging.js';

function mockDb() {
  const rows = new Map();
  let progress = null;
  return {
    rows,
    prepare(sql) {
      return { bind(...values) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO reconciliation_dataset_progress')) {
              progress ||= { source_file_id: values[3], status: 'pending', last_row_number: 0, row_count: 0 };
              return { meta: { changes: 1 } };
            }
            if (sql.includes('UPDATE reconciliation_dataset_progress') && sql.includes("status='ingesting'")) {
              progress = { ...progress, status: 'ingesting', last_row_number: Math.max(progress.last_row_number, values[2]), row_count: Math.max(progress.row_count, values[3]) };
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status='complete'")) {
              if (progress?.status === 'ingesting' && progress.last_row_number === values[0] + 1) {
                progress = { ...progress, status: 'complete', row_count: values[0] };
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            if (sql.includes('INSERT INTO reconciliation_staging_rows')) {
              const key = values.slice(0, 4).join(':');
              if (!rows.has(key)) rows.set(key, { row_number: values[3], row_sha256_hex: values[7] });
            }
            return { meta: { changes: 1 } };
          },
          async first() { return progress; },
          async all() {
            if (sql.includes('SELECT row_number, row_sha256_hex')) {
              return { results: [...rows.values()].filter(row => row.row_number >= values[3] && row.row_number <= values[4]).sort((a,b)=>a.row_number-b.row_number) };
            }
            return { results: [] };
          }
        };
      }};
    },
    async batch(statements) { for (const statement of statements) await statement.run(); return []; }
  };
}

test('initialises a tenant/run/dataset checkpoint and rejects source mismatch', async () => {
  const db = mockDb();
  const progress = await initialiseZonarDatasetProgress(db, {
    tenantId: 'tenant_1', runId: 'run_1', dataset: 'orders', sourceFileId: 'file_1'
  });
  assert.equal(progress.source_file_id, 'file_1');
  await assert.rejects(() => initialiseZonarDatasetProgress(db, {
    tenantId: 'tenant_1', runId: 'run_1', dataset: 'orders', sourceFileId: 'file_2'
  }), /STAGING_SOURCE_CONFLICT/);
});

test('persists bounded canonical rows and safely replays identical batches', async () => {
  const db = mockDb();
  await initialiseZonarDatasetProgress(db, { tenantId:'tenant_1', runId:'run_1', dataset:'orders', sourceFileId:'file_1' });
  const input = { tenantId:'tenant_1', runId:'run_1', dataset:'orders', rows:[
    { row_number:2, record:{order_id:'O-1', quantity_ordered:2} },
    { row_number:3, record:{order_id:'O-2', quantity_ordered:1} }
  ]};
  assert.deepEqual(await persistZonarStagingBatch(db, input), {
    inserted_or_confirmed:2, first_row_number:2, last_row_number:3
  });
  assert.deepEqual(await persistZonarStagingBatch(db, input), {
    inserted_or_confirmed:2, first_row_number:2, last_row_number:3
  });
  assert.equal(db.rows.size, 2);
  await assert.rejects(() => persistZonarStagingBatch(db, {
    ...input, rows:[{ row_number:2, record:{order_id:'O-1', quantity_ordered:99} }]
  }), /STAGING_REPLAY_CONFLICT/);
});

test('rejects oversized batches and does not complete without the final checkpoint', async () => {
  const db = mockDb();
  await initialiseZonarDatasetProgress(db, { tenantId:'tenant_1', runId:'run_1', dataset:'orders', sourceFileId:'file_1' });
  assert.equal(ZONAR_STAGING_BATCH_LIMIT, 50);
  await assert.rejects(() => persistZonarStagingBatch(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders',
    rows:Array.from({length:51}, (_,i)=>({row_number:i+2,record:{order_id:String(i)}}))
  }), /INVALID_STAGING_BATCH/);
  await assert.rejects(() => completeZonarDatasetProgress(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders', expectedRowCount:2
  }), /STAGING_COMPLETION_CHECKPOINT_MISMATCH/);
});

test('marks a dataset complete only when the final row checkpoint matches', async () => {
  const db = mockDb();
  await initialiseZonarDatasetProgress(db, { tenantId:'tenant_1', runId:'run_1', dataset:'orders', sourceFileId:'file_1' });
  await persistZonarStagingBatch(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders',
    rows:[{row_number:2,record:{order_id:'O-1'}},{row_number:3,record:{order_id:'O-2'}}]
  });
  assert.deepEqual(await completeZonarDatasetProgress(db, {
    tenantId:'tenant_1', runId:'run_1', dataset:'orders', expectedRowCount:2
  }), { status:'complete', row_count:2 });
});
