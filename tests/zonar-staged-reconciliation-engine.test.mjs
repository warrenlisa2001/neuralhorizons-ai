import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { processZonarStagedReconciliationBatch } from '../src/zonar-staged-reconciliation-engine.js';

const migrations = [
  '0001_tenant_foundation.sql',
  '0002_reconciliation_runs.sql',
  '0007_resumable_upload_sessions.sql',
  '0009_reconciliation_staging.sql',
  '0010_reconciliation_engine_outputs.sql'
].map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql, values,
            async run() {
              const result = sqlite.prepare(sql).run(...values);
              return { success:true, meta:{ changes:Number(result.changes || 0) } };
            },
            async first() { return sqlite.prepare(sql).get(...values) || null; },
            async all() { return { results:sqlite.prepare(sql).all(...values) }; }
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          const result = sqlite.prepare(statement.sql).run(...statement.values);
          results.push({ success:true, meta:{ changes:Number(result.changes || 0) } });
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

function seedDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migrations);
  sqlite.prepare("INSERT INTO tenants (id,name) VALUES (?,?)").run('tenant-a','Business A');
  sqlite.prepare("INSERT INTO users (id,identity_issuer,identity_subject) VALUES (?,?,?)")
    .run('user-a','https://issuer.example','subject-a');
  sqlite.prepare("INSERT INTO memberships (tenant_id,user_id,role) VALUES (?,?,?)")
    .run('tenant-a','user-a','tenant_owner');
  const file = sqlite.prepare(`INSERT INTO tenant_files
    (id,tenant_id,uploaded_by_user_id,original_filename,object_key,content_type,byte_size)
    VALUES (?,?,?,?,?,?,?)`);
  for (const id of ['orders','invoices','deliveries']) {
    file.run(id,'tenant-a','user-a',id+'.csv','tenant-a/'+id,'text/csv',100);
  }
  sqlite.prepare(`INSERT INTO reconciliation_runs
    (id,tenant_id,requested_by_user_id,processor_version,orders_file_id,invoices_file_id,deliveries_file_id)
    VALUES (?,?,?,?,?,?,?)`)
    .run('run-a','tenant-a','user-a','0.1.0','orders','invoices','deliveries');

  const progress = sqlite.prepare(`INSERT INTO reconciliation_dataset_progress
    (tenant_id,run_id,dataset,source_file_id,status,last_row_number,row_count)
    VALUES ('tenant-a','run-a',?,?,'complete',?,?)`);
  for (const dataset of ['orders','invoices','deliveries']) {
    const count = dataset === 'orders' ? 4 : dataset === 'invoices' ? 4 : 2;
    progress.run(dataset,dataset,count+1,count);
  }
  const insert = sqlite.prepare(`INSERT INTO reconciliation_staging_rows
    (tenant_id,run_id,dataset,row_number,record_id,order_id,record_json,row_sha256_hex)
    VALUES ('tenant-a','run-a',?,?,?,?,?,?)`);
  const rows = [
    ['orders',2,'O-1','O-1',{order_id:'O-1',quantity_ordered:10,order_value:100}],
    ['orders',3,'O-2','O-2',{order_id:'O-2',quantity_ordered:5,order_value:50}],
    ['orders',4,'O-2','O-2',{order_id:'O-2',quantity_ordered:5,order_value:50}],
    ['orders',5,null,null,{order_id:'',quantity_ordered:1,order_value:10}],
    ['invoices',2,'I-1','O-1',{invoice_id:'I-1',order_id:'O-1',quantity_invoiced:8,invoice_value:80}],
    ['invoices',3,'I-2','O-1',{invoice_id:'I-2',order_id:'O-1',quantity_invoiced:2,invoice_value:20}],
    ['invoices',4,'I-3','O-X',{invoice_id:'I-3',order_id:'O-X',quantity_invoiced:1,invoice_value:10}],
    ['invoices',5,'I-4',null,{invoice_id:'I-4',order_id:'',quantity_invoiced:1,invoice_value:10}],
    ['deliveries',2,'D-1','O-1',{delivery_id:'D-1',order_id:'O-1',quantity_delivered:10}],
    ['deliveries',3,'D-2','O-2',{delivery_id:'D-2',order_id:'O-2',quantity_delivered:4}]
  ];
  for (const [dataset,row,id,orderId,record] of rows) {
    insert.run(dataset,row,id,orderId,JSON.stringify(record),'a'.repeat(64));
  }
  return { sqlite, db:d1Adapter(sqlite) };
}

test('staged SQL reconciliation preserves core exception semantics across bounded pages', async () => {
  const { sqlite, db } = seedDatabase();
  try {
    const first = await processZonarStagedReconciliationBatch(db, {
      tenantId:'tenant-a',runId:'run-a',batchSize:1
    });
    assert.equal(first.status,'running');
    assert.equal(first.processed_this_batch,1);

    const second = await processZonarStagedReconciliationBatch(db, {
      tenantId:'tenant-a',runId:'run-a',batchSize:1
    });
    assert.equal(second.status,'running');
    assert.equal(second.processed_this_batch,1);

    const final = await processZonarStagedReconciliationBatch(db, {
      tenantId:'tenant-a',runId:'run-a',batchSize:1
    });
    assert.equal(final.status,'complete');
    assert.deepEqual(final.summary,{
      order_count:2,invoice_count:2,delivery_count:2,linked_order_count:1,
      exception_count:6,severity_counts:{high:3,medium:1,low:0}
    });
    const resultRows = sqlite.prepare("SELECT order_id,invoice_count,delivery_count,status,quantity_invoiced,quantity_delivered FROM reconciliation_order_results WHERE tenant_id='tenant-a' AND run_id='run-a' ORDER BY order_row_number").all();
    assert.deepEqual(resultRows.map(row=>[row.order_id,row.invoice_count,row.delivery_count,row.status,row.quantity_invoiced,row.quantity_delivered]),[
      ['O-1',2,1,'linked',10,10],['O-2',0,1,'incomplete',null,4]
    ]);
    const codes = sqlite.prepare("SELECT code FROM reconciliation_exceptions WHERE tenant_id='tenant-a' AND run_id='run-a' ORDER BY code").all().map(row=>row.code);
    assert.deepEqual(codes.sort(),[
      'DELIVERY_WITHOUT_ORDER','DUPLICATE_RECORD_ID','INVOICE_MISSING_ORDER_REFERENCE',
      'INVOICE_WITHOUT_ORDER','MISSING_RECORD_ID','ORDER_NOT_INVOICED',
      'ORDER_DELIVERY_QUANTITY_MISMATCH'
    ].sort());
    const replay = await processZonarStagedReconciliationBatch(db,{tenantId:'tenant-a',runId:'run-a'});
    assert.equal(replay.status,'complete');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM reconciliation_exceptions WHERE tenant_id='tenant-a' AND run_id='run-a'").get().count,7);
  } finally { sqlite.close(); }
});

test('staged reconciliation refuses to run until all three datasets are complete', async () => {
  const { sqlite, db } = seedDatabase();
  try {
    sqlite.prepare("UPDATE reconciliation_dataset_progress SET status='ingesting' WHERE tenant_id='tenant-a' AND run_id='run-a' AND dataset='invoices'").run();
    await assert.rejects(() => processZonarStagedReconciliationBatch(db,{
      tenantId:'tenant-a',runId:'run-a'
    }),/RECONCILIATION_STAGING_INCOMPLETE/);
  } finally { sqlite.close(); }
});
