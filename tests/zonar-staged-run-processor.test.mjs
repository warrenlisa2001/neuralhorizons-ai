import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { processZonarReconciliationMessage } from '../src/zonar-async-reconciliation.js';
import { describeZonarSourceIntegrity } from '../src/zonar-staged-run-processor.js';

// Real SQL: every migration in order, executed by SQLite through a D1-shaped shim.
const migrations = readdirSync(new URL('../migrations/', import.meta.url))
  .filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');

function d1(sqlite, { failAuditInsert = false } = {}) {
  const guard = sql => {
    if (failAuditInsert && /INSERT INTO audit_events/.test(sql)) throw new Error('simulated audit outage');
  };
  return {
    prepare(sql) {
      return { bind(...values) {
        return { sql, values,
          async run() { guard(sql); const r = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes || 0) } }; },
          async first() { guard(sql); return sqlite.prepare(sql).get(...values) || null; },
          async all() { return { results: sqlite.prepare(sql).all(...values) }; } };
      } };
    },
    async batch(items) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const x of items) { const r = sqlite.prepare(x.sql).run(...x.values); out.push({ meta: { changes: Number(r.changes || 0) } }); }
        sqlite.exec('COMMIT');
        return out;
      } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    }
  };
}

function nodeDigestFactory() {
  const hash = createHash('sha256');
  let resolve;
  const stream = new WritableStream({
    write(chunk) { hash.update(chunk); },
    close() { resolve(new Uint8Array(hash.digest())); }
  });
  stream.digest = new Promise(r => { resolve = r; });
  return stream;
}

const sha = text => createHash('sha256').update(text).digest('hex');

function bucketOf(objects, { failAfterBytes = null } = {}) {
  return {
    async get(key) {
      const text = objects[key];
      if (text === undefined) return null;
      const bytes = new TextEncoder().encode(text);
      let offset = 0, sent = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (failAfterBytes !== null && sent >= failAfterBytes) { controller.error(new Error('R2_READ_INTERRUPTED')); return; }
          if (offset >= bytes.length) { controller.close(); return; }
          const end = Math.min(bytes.length, offset + 8192);
          controller.enqueue(bytes.slice(offset, end));
          sent += end - offset; offset = end;
        }
      });
      return { size: bytes.length, body };
    },
    async put() {}
  };
}

const ORDERS = 'order_id,quantity_ordered,order_value\nO1,10,100\nO2,5,50\nO3,1,10\n';
const INVOICES = 'invoice_id,order_id,quantity_invoiced,invoice_value\nI1,O1,10,100\nI2,O2,5,45\nI3,OX,1,10\n';
const DELIVERIES = 'delivery_id,order_id,quantity_delivered\nD1,O1,10\nD2,O2,4\n';

function fixture(csv = { orders: ORDERS, invoices: INVOICES, deliveries: DELIVERIES }, opts = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migrations);
  sqlite.prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run('t1', 'Tenant');
  sqlite.prepare('INSERT INTO users(id,identity_issuer,identity_subject) VALUES(?,?,?)').run('u1', 'https://issuer', 'sub');
  sqlite.prepare('INSERT INTO memberships(tenant_id,user_id,role) VALUES(?,?,?)').run('t1', 'u1', 'tenant_owner');
  const insert = sqlite.prepare(
    `INSERT INTO tenant_files(id,tenant_id,uploaded_by_user_id,original_filename,object_key,content_type,byte_size,sha256_hex,integrity_status,integrity_manifest_sha256_hex)
     VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const objects = {};
  for (const [id, text] of Object.entries(csv)) {
    objects['t1/' + id] = text;
    const size = new TextEncoder().encode(text).length;
    // orders: legacy whole-object SHA-256; invoices: multipart manifest; deliveries: SHA-256.
    if (id === 'invoices') insert.run(id, 't1', 'u1', id + '.csv', 't1/' + id, 'text/csv', size, null, 'verified_parts', sha('manifest'));
    else insert.run(id, 't1', 'u1', id + '.csv', 't1/' + id, 'text/csv', size, opts.badHash === id ? sha('tampered') : sha(text), 'unverified', null);
  }
  sqlite.prepare(
    `INSERT INTO reconciliation_runs(id,tenant_id,requested_by_user_id,processor_version,status,orders_file_id,invoices_file_id,deliveries_file_id)
     VALUES('r1','t1','u1','zonar-staged-1','queued','orders','invoices','deliveries')`).run();
  return { sqlite, objects };
}

function message() {
  const log = { acked: false, retried: null };
  return { log, body: { version: 1, run_id: 'r1' }, ack() { log.acked = true; }, retry(o) { log.retried = o; } };
}

const runRow = sqlite => sqlite.prepare('SELECT * FROM reconciliation_runs WHERE id=?').get('r1');

test('end to end: streams three datasets, reconciles, audits, then succeeds', async () => {
  const { sqlite, objects } = fixture();
  try {
    const msg = message();
    const out = await processZonarReconciliationMessage(msg,
      { ZONAR_DB: d1(sqlite), ZONAR_FILES: bucketOf(objects) }, { digestFactory: nodeDigestFactory });
    assert.deepEqual(out, { acknowledged: true, status: 'succeeded' });
    const run = runRow(sqlite);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.result_object_key, null); // findings live in D1, not an R2 blob
    const summary = JSON.parse(run.summary_json);
    assert.equal(summary.processor, 'zonar-staged-1');
    assert.equal(summary.order_count, 3);
    assert.equal(summary.linked_order_count, 2);
    const codes = sqlite.prepare('SELECT code FROM reconciliation_exceptions ORDER BY code').all().map(r => r.code);
    assert.deepEqual(codes, ['INVOICE_WITHOUT_ORDER', 'ORDER_DELIVERY_QUANTITY_MISMATCH', 'ORDER_INVOICE_VALUE_MISMATCH', 'ORDER_NOT_DELIVERED', 'ORDER_NOT_INVOICED']);
    assert.equal(summary.operational_event_count, 5);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='reconciliation.completed' AND resource_id='r1'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM reconciliation_dataset_progress WHERE status='complete'").get().n, 3);
  } finally { sqlite.close(); }
});

test('no 2 MiB ceiling: a >3 MiB source is streamed and reconciled', async () => {
  const pad = 'x'.repeat(700);
  let big = 'order_id,quantity_ordered,order_value,notes\n';
  for (let i = 1; i <= 5000; i++) big += `O${i},1,10,${pad}\n`;
  assert.ok(big.length > 3 * 1024 * 1024);
  const { sqlite, objects } = fixture({ orders: big, invoices: INVOICES, deliveries: DELIVERIES });
  try {
    const out = await processZonarReconciliationMessage(message(),
      { ZONAR_DB: d1(sqlite), ZONAR_FILES: bucketOf(objects) }, { digestFactory: nodeDigestFactory });
    assert.equal(out.status, 'succeeded');
    assert.equal(JSON.parse(runRow(sqlite).summary_json).order_count, 5000);
  } finally { sqlite.close(); }
});

test('whole-object checksum mismatch fails the run permanently before completion', async () => {
  const { sqlite, objects } = fixture(undefined, { badHash: 'orders' });
  try {
    const out = await processZonarReconciliationMessage(message(),
      { ZONAR_DB: d1(sqlite), ZONAR_FILES: bucketOf(objects) }, { digestFactory: nodeDigestFactory });
    assert.equal(out.status, 'failed');
    const run = runRow(sqlite);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'SOURCE_INTEGRITY_FAILED');
    // Verification precedes completion: the tampered dataset never became 'complete'.
    assert.notEqual(sqlite.prepare("SELECT status FROM reconciliation_dataset_progress WHERE dataset='orders'").get()?.status, 'complete');
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0);
  } finally { sqlite.close(); }
});

test('a failed completion audit write prevents the succeeded state', async () => {
  const { sqlite, objects } = fixture();
  try {
    const env = { ZONAR_DB: d1(sqlite, { failAuditInsert: true }), ZONAR_FILES: bucketOf(objects) };
    const out = await processZonarReconciliationMessage(message(), env, { digestFactory: nodeDigestFactory });
    assert.equal(out.reason, 'RETRY_SCHEDULED');
    assert.equal(runRow(sqlite).status, 'queued');
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='reconciliation.completed'").get().n, 0);
    // Even with the audit outage persisting through every attempt it must end failed, never succeeded.
    sqlite.prepare("UPDATE reconciliation_runs SET attempt_count=max_attempts-1 WHERE id='r1'").run();
    const last = await processZonarReconciliationMessage(message(), env, { digestFactory: nodeDigestFactory });
    assert.equal(last.status, 'failed');
    assert.equal(runRow(sqlite).status, 'failed');
  } finally { sqlite.close(); }
});

test('the status change itself requires the completion audit row', async () => {
  const { sqlite, objects } = fixture();
  try {
    // Remove the audit insert's effect by dropping the table row right after it is written.
    sqlite.exec(`CREATE TRIGGER vanish AFTER INSERT ON audit_events BEGIN SELECT 1; END;`);
    const db = d1(sqlite);
    const realPrepare = db.prepare.bind(db);
    db.prepare = sql => {
      if (/UPDATE reconciliation_runs\s+SET status='succeeded'/.test(sql)) {
        sqlite.exec('DROP TRIGGER IF EXISTS trg_audit_events_no_delete');
        sqlite.exec("DELETE FROM audit_events WHERE resource_id='r1'");
      }
      return realPrepare(sql);
    };
    const out = await processZonarReconciliationMessage(message(),
      { ZONAR_DB: db, ZONAR_FILES: bucketOf(objects) }, { digestFactory: nodeDigestFactory });
    assert.equal(out.reason, 'STALE_LEASE');
    assert.notEqual(runRow(sqlite).status, 'succeeded');
  } finally { sqlite.close(); }
});

test('interrupted ingestion resumes from durable checkpoints without duplicating rows', async () => {
  let rows = 'order_id,quantity_ordered,order_value,notes\n';
  for (let i = 1; i <= 400; i++) rows += `O${i},1,10,${'n'.repeat(100)}\n`;
  const { sqlite, objects } = fixture({ orders: rows, invoices: INVOICES, deliveries: DELIVERIES });
  try {
    const db = d1(sqlite);
    const first = await processZonarReconciliationMessage(message(),
      { ZONAR_DB: db, ZONAR_FILES: bucketOf(objects, { failAfterBytes: 20000 }) }, { digestFactory: nodeDigestFactory });
    assert.equal(first.reason, 'RETRY_SCHEDULED');
    const partial = sqlite.prepare("SELECT COUNT(*) n FROM reconciliation_staging_rows WHERE dataset='orders'").get().n;
    assert.ok(partial > 0 && partial < 400, `expected partial staging, got ${partial}`);
    // Outbox redelivery re-queues the run; the retry re-reads from byte zero and verifies replayed batches.
    const second = await processZonarReconciliationMessage(message(),
      { ZONAR_DB: db, ZONAR_FILES: bucketOf(objects) }, { digestFactory: nodeDigestFactory });
    assert.equal(second.status, 'succeeded');
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM reconciliation_staging_rows WHERE dataset='orders'").get().n, 400);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='reconciliation.completed'").get().n, 1);
  } finally { sqlite.close(); }
});

test('malformed source data fails permanently with the parser error code', async () => {
  const { sqlite, objects } = fixture({ orders: ORDERS, invoices: INVOICES + 'I9,O1\n', deliveries: DELIVERIES });
  try {
    const out = await processZonarReconciliationMessage(message(),
      { ZONAR_DB: d1(sqlite), ZONAR_FILES: bucketOf(objects) }, { digestFactory: nodeDigestFactory });
    assert.equal(out.status, 'failed');
    assert.equal(runRow(sqlite).error_code, 'MALFORMED_ROW');
  } finally { sqlite.close(); }
});

test('one integrity definition: multipart manifest or whole SHA-256, otherwise none', () => {
  const hex = 'a'.repeat(64);
  assert.equal(describeZonarSourceIntegrity({ integrity_status: 'verified_parts', integrity_manifest_sha256_hex: hex }).mode, 'verified_parts');
  assert.equal(describeZonarSourceIntegrity({ integrity_status: 'verified_parts', integrity_manifest_sha256_hex: null }).mode, 'none');
  assert.equal(describeZonarSourceIntegrity({ integrity_status: 'unverified', sha256_hex: hex }).mode, 'whole_sha256');
  assert.equal(describeZonarSourceIntegrity({ integrity_status: 'failed', sha256_hex: hex }).mode, 'none');
  assert.equal(describeZonarSourceIntegrity({ integrity_status: 'unverified', sha256_hex: null }).mode, 'none');
});
