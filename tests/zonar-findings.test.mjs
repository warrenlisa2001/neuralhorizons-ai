import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { processZonarReconciliationMessage } from '../src/zonar-async-reconciliation.js';
import { queryZonarFindings, handleZonarReconciliationFindings, ZONAR_FINDINGS_SCHEMA_VERSION } from '../src/zonar-findings.js';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()
  .map(n => readFileSync(new URL('../migrations/' + n, import.meta.url), 'utf8')).join('\n');

function d1(sqlite) {
  return {
    prepare(sql) { return { bind(...values) { return { sql, values,
      async run() { const r = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes || 0) } }; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; } }; } }; },
    async batch(items) {
      sqlite.exec('BEGIN');
      try { const out = []; for (const x of items) { const r = sqlite.prepare(x.sql).run(...x.values); out.push({ meta: { changes: Number(r.changes || 0) } }); } sqlite.exec('COMMIT'); return out; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    }
  };
}

const CSV = {
  orders: 'order_id,quantity_ordered,order_value\nO1,10,100\nO2,5,50\nO3,1,10\n',
  invoices: 'invoice_id,order_id,quantity_invoiced,invoice_value\nI1,O1,10,100\nI2,O2,5,45\nI3,OX,1,10\n',
  deliveries: 'delivery_id,order_id,quantity_delivered\nD1,O1,10\nD2,O2,4\n'
};
import { createHash } from 'node:crypto';
const sha = t => createHash('sha256').update(t).digest('hex');

async function processedFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migrations);
  for (const t of ['t1', 't2']) sqlite.prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run(t, t);
  sqlite.prepare('INSERT INTO users(id,identity_issuer,identity_subject) VALUES(?,?,?)').run('u1', 'iss', 'sub');
  sqlite.prepare('INSERT INTO memberships(tenant_id,user_id,role) VALUES(?,?,?)').run('t1', 'u1', 'tenant_owner');
  const objects = {};
  for (const [id, text] of Object.entries(CSV)) {
    objects['t1/' + id] = text;
    sqlite.prepare(`INSERT INTO tenant_files(id,tenant_id,uploaded_by_user_id,original_filename,object_key,content_type,byte_size,sha256_hex)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, 't1', 'u1', id + '.csv', 't1/' + id, 'text/csv', new TextEncoder().encode(text).length, sha(text));
  }
  sqlite.prepare(`INSERT INTO reconciliation_runs(id,tenant_id,requested_by_user_id,processor_version,status,orders_file_id,invoices_file_id,deliveries_file_id)
    VALUES('r1','t1','u1','zonar-staged-1','queued','orders','invoices','deliveries')`).run();
  const bucket = { async get(key) {
    const bytes = new TextEncoder().encode(objects[key]);
    return { size: bytes.length, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
  }, async put() {} };
  const digestFactory = () => {
    const h = createHash('sha256'); let resolve;
    const ws = new WritableStream({ write(c) { h.update(c); }, close() { resolve(new Uint8Array(h.digest())); } });
    ws.digest = new Promise(r => { resolve = r; }); return ws;
  };
  const db = d1(sqlite);
  const out = await processZonarReconciliationMessage({ body: { version: 1, run_id: 'r1' }, ack() {}, retry() {} },
    { ZONAR_DB: db, ZONAR_FILES: bucket }, { digestFactory });
  assert.equal(out.status, 'succeeded');
  return { sqlite, db };
}

test('feed returns versioned findings with traceable source references', async () => {
  const { sqlite, db } = await processedFixture();
  try {
    const { status, body } = await queryZonarFindings(db, { tenantId: 't1', runId: 'r1', limit: 50 });
    assert.equal(status, 200);
    assert.equal(body.schema_version, ZONAR_FINDINGS_SCHEMA_VERSION);
    assert.equal(body.run.summary.exception_count, 5);
    assert.deepEqual(body.run.source_files, { orders: 'orders', invoices: 'invoices', deliveries: 'deliveries' });
    assert.equal(body.findings.length, 5);
    const orphan = body.findings.find(f => f.code === 'INVOICE_WITHOUT_ORDER');
    assert.deepEqual(orphan.source, { file_id: 'invoices', dataset: 'invoices', row_number: 4, record_id: 'I3', order_id: 'OX' });
    const mismatch = body.findings.find(f => f.code === 'ORDER_DELIVERY_QUANTITY_MISMATCH');
    assert.equal(mismatch.source.file_id, 'orders');
    assert.equal(mismatch.expected, 5); assert.equal(mismatch.actual, 4);
    assert.equal(body.page.next_cursor, null);
  } finally { sqlite.close(); }
});

test('pagination is stable and complete; filters narrow results', async () => {
  const { sqlite, db } = await processedFixture();
  try {
    const seen = []; let cursor = 0, pages = 0;
    while (true) {
      const { body } = await queryZonarFindings(db, { tenantId: 't1', runId: 'r1', limit: 2, cursor });
      seen.push(...body.findings.map(f => f.id)); pages++;
      if (!body.page.next_cursor) break;
      cursor = Number(body.page.next_cursor);
    }
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, 5);
    const high = await queryZonarFindings(db, { tenantId: 't1', runId: 'r1', limit: 50, severity: 'high' });
    assert.ok(high.body.findings.length > 0 && high.body.findings.every(f => f.severity === 'high'));
    const inv = await queryZonarFindings(db, { tenantId: 't1', runId: 'r1', limit: 50, dataset: 'invoices' });
    assert.ok(inv.body.findings.every(f => f.source.dataset === 'invoices'));
  } finally { sqlite.close(); }
});

test('another tenant cannot read the run (indistinguishable from not found)', async () => {
  const { sqlite, db } = await processedFixture();
  try {
    const r = await queryZonarFindings(db, { tenantId: 't2', runId: 'r1', limit: 50 });
    assert.equal(r.status, 404);
    assert.equal(r.body.findings, undefined);
  } finally { sqlite.close(); }
});

test('incomplete, unverified and legacy runs expose no findings', async () => {
  const { sqlite, db } = await processedFixture();
  try {
    const mk = (id, status, key = null) => sqlite.prepare(`INSERT INTO reconciliation_runs(id,tenant_id,requested_by_user_id,processor_version,status,orders_file_id,invoices_file_id,deliveries_file_id,result_object_key)
      VALUES(?, 't1','u1','v',?, 'orders','invoices','deliveries',?)`).run(id, status, key);
    mk('r_queued', 'queued'); mk('r_noaudit', 'succeeded'); mk('r_legacy', 'succeeded', 'blob/key');
    assert.equal((await queryZonarFindings(db, { tenantId: 't1', runId: 'r_queued', limit: 5 })).body.error, 'RUN_NOT_COMPLETE');
    assert.equal((await queryZonarFindings(db, { tenantId: 't1', runId: 'r_noaudit', limit: 5 })).body.error, 'RUN_NOT_VERIFIED');
    assert.equal((await queryZonarFindings(db, { tenantId: 't1', runId: 'r_legacy', limit: 5 })).body.error, 'FINDINGS_UNAVAILABLE_FOR_PROCESSOR');
  } finally { sqlite.close(); }
});

test('handler rejects bad methods and unauthenticated callers before reading data', async () => {
  const post = await handleZonarReconciliationFindings(new Request('https://x.test/f', { method: 'POST' }), {}, 't1', 'r1');
  assert.equal(post.status, 405);
  const bad = await handleZonarReconciliationFindings(new Request('https://x.test/f'), {}, 'bad/tenant', 'r1');
  assert.equal(bad.status, 400);
  const unconfigured = await handleZonarReconciliationFindings(new Request('https://x.test/f'), {}, 't1', 'r1');
  assert.equal(unconfigured.status, 503);
  let touched = false;
  const env = { ZONAR_DB: { prepare() { touched = true; throw new Error('must not query'); } } };
  const anon = await handleZonarReconciliationFindings(new Request('https://x.test/f'), env, 't1', 'r1');
  assert.ok([401, 403, 503].includes(anon.status));
  assert.equal(touched && anon.status === 200, false);
});
