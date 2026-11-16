import test from 'node:test';
import assert from 'node:assert/strict';
import { createFindingsClient, SUPPORTED_SCHEMA } from '../src/zonar-findings-client.js';
import { createRunWatcher, createMemoryCursorStore } from '../src/run-watcher.js';
import { buildFinanceView } from '../src/views/finance.js';

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const finding = (id, code, severity, dataset, row, order, expected = null, actual = null) => ({
  id: String(id), code, severity,
  source: { file_id: 'f-' + dataset, dataset, row_number: row, record_id: 'R' + id, order_id: order }, expected, actual, details: null
});

// A tiny in-memory ZONAR: runs in completion order, each with findings, some failing on request.
function fakeZonar(runs, { failFor = {} } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith('/verified-runs')) {
      const cursor = u.searchParams.get('cursor');
      const limit = Number(u.searchParams.get('limit') || 50);
      const key = r => r.completed_at + '|' + r.id;
      const after = runs.filter(r => !cursor || key(r) > cursor);
      const page = after.slice(0, limit);
      return jsonRes({ schema_version: SUPPORTED_SCHEMA,
        runs: page.map(({ id, completed_at, processor_version }) => ({ id, completed_at, processor_version })),
        page: { limit, next_cursor: page.length ? key(page[page.length - 1]) : cursor, has_more: after.length > limit } });
    }
    const runId = u.pathname.split('/')[6];
    if (failFor[runId]) return jsonRes({ error: failFor[runId].error }, failFor[runId].status);
    const r = runs.find(x => x.id === runId);
    return jsonRes({ schema_version: SUPPORTED_SCHEMA,
      run: { id: r.id, status: 'succeeded', processor_version: 'zonar-staged-1', completed_at: r.completed_at },
      findings: r.findings, page: { limit: 100, next_cursor: null } });
  };
  return { fetchImpl, calls };
}
const mkRuns = () => [
  { id: 'r1', completed_at: '2026-11-14T10:00:00.000Z', processor_version: 'zonar-staged-1', findings: [finding(1, 'ORDER_INVOICE_VALUE_MISMATCH', 'high', 'invoices', 3, 'O2', 50, 45)] },
  { id: 'r2', completed_at: '2026-11-14T11:00:00.000Z', processor_version: 'zonar-staged-1', findings: [finding(2, 'ORDER_NOT_INVOICED', 'medium', 'orders', 4, 'O3')] },
  { id: 'r3', completed_at: '2026-11-14T12:00:00.000Z', processor_version: 'zonar-staged-1', findings: [] }
];
const setup = (runs, opts, extra = {}) => {
  const z = fakeZonar(runs, opts);
  const client = createFindingsClient({ baseUrl: 'https://z', tenantId: 't1', getToken: async () => 'T', fetchImpl: z.fetchImpl, sleep: async () => {} });
  const store = createMemoryCursorStore();
  const delivered = [];
  const watcher = createRunWatcher({ client, tenantId: 't1', store, deliver: async p => { delivered.push(p); }, pageSize: 2, ...extra });
  return { z, client, store, delivered, watcher };
};

test('delivers each verified run once, in order, across pages, and a repeat poll delivers nothing', async () => {
  const s = setup(mkRuns());
  const first = await s.watcher.pollOnce();
  assert.deepEqual(first.delivered, ['r1', 'r2', 'r3']);
  assert.deepEqual(s.delivered.map(d => d.idempotency_key), ['t1:r1', 't1:r2', 't1:r3']);
  assert.equal((await s.watcher.pollOnce()).delivered.length, 0);
  assert.equal(s.delivered.length, 3);
});

test('delivery failure keeps the cursor so the run is retried; earlier runs are not repeated', async () => {
  const s = setup(mkRuns());
  let fail = true;
  const watcher = createRunWatcher({ client: s.client, tenantId: 't1', store: s.store, pageSize: 2,
    deliver: async p => { if (p.run_id === 'r2' && fail) throw new Error('downstream down'); s.delivered.push(p.run_id); } });
  await assert.rejects(watcher.pollOnce(), /downstream down/);
  assert.deepEqual(s.delivered, ['r1']);
  fail = false;
  const second = await watcher.pollOnce();
  assert.deepEqual(second.delivered, ['r2', 'r3']);
  assert.deepEqual(s.delivered, ['r1', 'r2', 'r3']);
});

test('an unreadable run is skipped and reported, and does not block later runs', async () => {
  const skipped = [];
  const s = setup(mkRuns(), { failFor: { r2: { error: 'RUN_NOT_VERIFIED', status: 409 } } }, { onSkip: x => skipped.push(x) });
  const out = await s.watcher.pollOnce();
  assert.deepEqual(out.delivered, ['r1', 'r3']);
  assert.deepEqual(out.skipped, [{ run_id: 'r2', code: 'RUN_NOT_VERIFIED' }]);
  assert.deepEqual(skipped, [{ run_id: 'r2', code: 'RUN_NOT_VERIFIED' }]);
  assert.equal((await s.watcher.pollOnce()).delivered.length, 0);
});

test('a transient or authorisation failure stops the poll without skipping the run', async () => {
  const s = setup(mkRuns(), { failFor: { r2: { error: 'TENANT_ACCESS_DENIED', status: 403 } } });
  await assert.rejects(s.watcher.pollOnce(), e => e.code === 'TENANT_ACCESS_DENIED');
  assert.deepEqual(s.delivered.map(d => d.run_id), ['r1']);     // r1 done, r2 not skipped
  assert.equal(await s.store.get(), '2026-11-14T10:00:00.000Z|r1');
});

test('finance view totals value differences by direction and keeps evidence', () => {
  const run = { id: 'r9', status: 'succeeded', completed_at: '2026-11-14T10:00:00Z' };
  const findings = [
    finding(1, 'ORDER_INVOICE_VALUE_MISMATCH', 'high', 'invoices', 3, 'O2', 50, 45),     // short by 5
    finding(2, 'ORDER_INVOICE_VALUE_MISMATCH', 'high', 'invoices', 4, 'O7', 100, 112.5), // over by 12.5
    finding(3, 'ORDER_INVOICE_VALUE_MISMATCH', 'high', 'invoices', 5, 'O8', 10, 10.1),   // over by 0.1
    finding(4, 'ORDER_NOT_INVOICED', 'medium', 'orders', 6, 'O9'),
    finding(5, 'INVOICE_WITHOUT_ORDER', 'high', 'invoices', 7, 'OX'),
    finding(6, 'DUPLICATE_RECORD_ID', 'low', 'orders', 8, null)
  ];
  const v = buildFinanceView({ run, findings });
  assert.deepEqual(v.over_invoiced, { count: 2, total: 12.6 });
  assert.deepEqual(v.under_invoiced, { count: 1, total: 5 });
  assert.equal(v.uninvoiced_orders.count, 1);
  assert.equal(v.invoices_without_order.evidence[0].order_id, 'OX');
  assert.equal(v.data_quality_issues.count, 1);
  assert.equal(v.largest_value_differences[0].difference, 12.5);
  assert.ok(v.largest_value_differences.every(d => d.file_id && d.row_number >= 2));
  assert.match(v.headline.join(' '), /2 invoice\(s\) exceed the order value by 12.6/);
  assert.match(v.units_note, /currency/);
});

test('finance view handles a clean run and refuses an unverified one', () => {
  const run = { id: 'r9', status: 'succeeded', completed_at: 'x' };
  assert.deepEqual(buildFinanceView({ run, findings: [] }).headline, ['No invoice or billing exceptions in this run']);
  assert.throws(() => buildFinanceView({ run: { ...run, status: 'failed' }, findings: [] }), /FINANCE_VIEW_REQUIRES_VERIFIED_RUN/);
});
