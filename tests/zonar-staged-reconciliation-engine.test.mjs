import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { processZonarStagedReconciliationBatch } from '../src/zonar-staged-reconciliation-engine.js';

const migrationFiles=['0001_tenant_foundation.sql','0002_reconciliation_runs.sql','0007_resumable_upload_sessions.sql','0009_reconciliation_staging.sql','0010_reconciliation_engine_outputs.sql'];
const migrations=migrationFiles.map(name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8')).join('\n');
function d1(sqlite){return{
 prepare(sql){return{bind(...values){return{sql,values,
  async run(){const r=sqlite.prepare(sql).run(...values);return{meta:{changes:Number(r.changes||0)}}},
  async first(){return sqlite.prepare(sql).get(...values)||null},
  async all(){return{results:sqlite.prepare(sql).all(...values)}}};}};},
 async batch(items){sqlite.exec('BEGIN');try{const out=[];for(const x of items){const r=sqlite.prepare(x.sql).run(...x.values);out.push({meta:{changes:Number(r.changes||0)}});}sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}
};}
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(migrations);
 sqlite.prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run('t1','Tenant');
 sqlite.prepare('INSERT INTO users(id,identity_issuer,identity_subject) VALUES(?,?,?)').run('u1','https://issuer','sub');
 sqlite.prepare('INSERT INTO memberships(tenant_id,user_id,role) VALUES(?,?,?)').run('t1','u1','tenant_owner');
 const file=sqlite.prepare('INSERT INTO tenant_files(id,tenant_id,uploaded_by_user_id,original_filename,object_key,content_type,byte_size) VALUES(?,?,?,?,?,?,?)');
 for(const id of ['orders','invoices','deliveries'])file.run(id,'t1','u1',id+'.csv','t1/'+id,'text/csv',10);
 sqlite.prepare('INSERT INTO reconciliation_runs(id,tenant_id,requested_by_user_id,processor_version,orders_file_id,invoices_file_id,deliveries_file_id) VALUES(?,?,?,?,?,?,?)').run('r1','t1','u1','0.1','orders','invoices','deliveries');
 const p=sqlite.prepare("INSERT INTO reconciliation_dataset_progress(tenant_id,run_id,dataset,source_file_id,status,last_row_number,row_count) VALUES('t1','r1',?,?,'complete',?,?)");
 for(const [d,n] of [['orders',4],['invoices',4],['deliveries',2]])p.run(d,d,n+1,n);
 const ins=sqlite.prepare("INSERT INTO reconciliation_staging_rows(tenant_id,run_id,dataset,row_number,record_id,order_id,record_json,row_sha256_hex) VALUES('t1','r1',?,?,?,?,?,?)");
 const rows=[
 ['orders',2,'O1','O1',{order_id:'O1',quantity_ordered:10,order_value:100}],
 ['orders',3,'O2','O2',{order_id:'O2',quantity_ordered:5,order_value:50}],
 ['orders',4,'O2','O2',{order_id:'O2',quantity_ordered:5,order_value:50}],
 ['orders',5,null,null,{order_id:'',quantity_ordered:1,order_value:10}],
 ['invoices',2,'I1','O1',{invoice_id:'I1',order_id:'O1',quantity_invoiced:8,invoice_value:80}],
 ['invoices',3,'I2','O1',{invoice_id:'I2',order_id:'O1',quantity_invoiced:2,invoice_value:20}],
 ['invoices',4,'I3','OX',{invoice_id:'I3',order_id:'OX',quantity_invoiced:1,invoice_value:10}],
 ['invoices',5,'I4',null,{invoice_id:'I4',order_id:'',quantity_invoiced:1,invoice_value:10}],
 ['deliveries',2,'D1','O1',{delivery_id:'D1',order_id:'O1',quantity_delivered:10}],
 ['deliveries',3,'D2','O2',{delivery_id:'D2',order_id:'O2',quantity_delivered:4}]
 ];
 for(const [d,n,id,oid,record] of rows)ins.run(d,n,id,oid,JSON.stringify(record),'a'.repeat(64));
 return{sqlite,db:d1(sqlite)};
}
test('reconciles staged datasets in bounded pages and preserves exception semantics',async()=>{
 const {sqlite,db}=fixture();try{
  const a=await processZonarStagedReconciliationBatch(db,{tenantId:'t1',runId:'r1',batchSize:1});
  assert.equal(a.status,'running');assert.equal(a.processed_this_batch,1);
  const b=await processZonarStagedReconciliationBatch(db,{tenantId:'t1',runId:'r1',batchSize:1});
  assert.equal(b.status,'running');assert.equal(b.processed_this_batch,1);
  const c=await processZonarStagedReconciliationBatch(db,{tenantId:'t1',runId:'r1',batchSize:1});
  assert.equal(c.status,'complete');
  assert.deepEqual(c.summary,{order_count:2,invoice_count:4,delivery_count:2,linked_order_count:1,exception_count:6,severity_counts:{high:5,medium:1,low:0}});
  const rows=sqlite.prepare('SELECT order_id,invoice_count,delivery_count,status,quantity_invoiced,quantity_delivered FROM reconciliation_order_results ORDER BY order_row_number').all();
  assert.deepEqual(rows.map(x=>[x.order_id,x.invoice_count,x.delivery_count,x.status,x.quantity_invoiced,x.quantity_delivered]),[['O1',2,1,'linked',10,10],['O2',0,1,'incomplete',null,4]]);
  const links=sqlite.prepare('SELECT dataset,linked_record_id FROM reconciliation_result_links ORDER BY order_id,dataset,linked_record_id').all();
  assert.equal(links.length,4);
  assert.deepEqual(links.map(x=>[x.dataset,x.linked_record_id]),[['deliveries','D1'],['invoices','I1'],['invoices','I2'],['deliveries','D2']]);
  const codes=sqlite.prepare('SELECT code FROM reconciliation_exceptions').all().map(x=>x.code).sort();
  assert.deepEqual(codes,['DUPLICATE_RECORD_ID','INVOICE_MISSING_ORDER_REFERENCE','INVOICE_WITHOUT_ORDER','MISSING_RECORD_ID','ORDER_DELIVERY_QUANTITY_MISMATCH','ORDER_NOT_INVOICED'].sort());
  const replay=await processZonarStagedReconciliationBatch(db,{tenantId:'t1',runId:'r1'});
  assert.equal(replay.status,'complete');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reconciliation_exceptions').get().n,6);
 }finally{sqlite.close();}
});
test('refuses reconciliation until all three dataset checkpoints are complete',async()=>{
 const {sqlite,db}=fixture();try{
  sqlite.prepare("UPDATE reconciliation_dataset_progress SET status='ingesting' WHERE dataset='invoices'").run();
  await assert.rejects(()=>processZonarStagedReconciliationBatch(db,{tenantId:'t1',runId:'r1'}),/RECONCILIATION_STAGING_INCOMPLETE/);
 }finally{sqlite.close();}
});
