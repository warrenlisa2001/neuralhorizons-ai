import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { runHaluPoll, parseTenants, webhookSummary } from '../src/worker.js';
import { SUPPORTED_SCHEMA } from '../src/zonar-findings-client.js';

import { migrations as migration, openGate } from './helpers.mjs';
const jsonRes = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const SECRET = 'SUPER-SECRET-VALUE';

function d1(sqlite) {
  return { prepare(sql) { return { bind(...v) { return {
    async run() { const r = sqlite.prepare(sql).run(...v); return { meta: { changes: Number(r.changes || 0) } }; },
    async first() { return sqlite.prepare(sql).get(...v) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...v) }; } }; } }; } };
}
const finding = (id, code, ds, row, order, expected, actual) => ({ id: String(id), code, severity: 'high',
  source: { file_id: 'f-' + ds, dataset: ds, row_number: row, record_id: 'R' + id, order_id: order }, expected, actual, details: null });

function world({ tenantFailures = {}, webhookStatus = 200 } = {}) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(migration); openGate(sqlite, 't1'); openGate(sqlite, 't2');
  const runs = [
    { id: 'r1', completed_at: '2026-11-14T10:00:00.000Z', findings: [finding(1, 'ORDER_INVOICE_VALUE_MISMATCH', 'invoices', 3, 'O2', 50, 45)] },
    { id: 'r2', completed_at: '2026-11-14T11:00:00.000Z', findings: [] }
  ];
  const seen = { webhooks: [], tokenCalls: 0, urls: [] };
  const state = { webhookStatus };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); seen.urls.push(u.host + u.pathname);
    if (u.host === 'login.microsoftonline.com') { seen.tokenCalls++; return jsonRes({ access_token: 'TOK', expires_in: 3600 }); }
    if (u.host === 'hooks.example') { seen.webhooks.push(JSON.parse(init.body)); return new Response('', { status: state.webhookStatus }); }
    const parts = u.pathname.split('/'); const tenant = parts[4];
    if (tenantFailures[tenant]) return jsonRes({ error: tenantFailures[tenant] }, 403);
    if (u.pathname.endsWith('/verified-runs')) {
      const cursor = u.searchParams.get('cursor'); const key = r => r.completed_at + '|' + r.id;
      const after = runs.filter(r => !cursor || key(r) > cursor);
      return jsonRes({ schema_version: SUPPORTED_SCHEMA, runs: after.map(({ id, completed_at }) => ({ id, completed_at, processor_version: 'zonar-staged-1' })),
        page: { limit: 50, next_cursor: after.length ? key(after[after.length - 1]) : cursor, has_more: false } });
    }
    const r = runs.find(x => x.id === parts[6]);
    return jsonRes({ schema_version: SUPPORTED_SCHEMA, run: { id: r.id, status: 'succeeded', processor_version: 'zonar-staged-1', completed_at: r.completed_at },
      findings: r.findings, page: { limit: 100, next_cursor: null } });
  };
  const env = { HALU_DB: d1(sqlite), HALU_ZONAR_BASE_URL: 'https://zonar.example', HALU_ZONAR_SCOPE: 'api://z/.default',
    HALU_ENTRA_TENANT_ID: 'dir-1', HALU_CLIENT_ID: 'cid', HALU_CLIENT_SECRET: SECRET, HALU_TENANTS: 't1', HALU_WEBHOOK_URL: 'https://hooks.example/h' };
  return { sqlite, env, fetchImpl, seen, state };
}

test('a tick delivers new runs, stores them once, sends summary-only webhooks, and the next tick is a no-op', async () => {
  const w = world(); const logs = [];
  const first = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl, log: l => logs.push(l) });
  assert.equal(first.ok, true);
  assert.deepEqual(first.tenants, [{ tenant_id: 't1', ok: true, delivered: 2, skipped: 0 }]);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings').get().c, 2);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings WHERE webhook_sent_at IS NOT NULL').get().c, 2);
  assert.equal(w.seen.webhooks.length, 2);
  const hook = w.seen.webhooks[0];
  assert.equal(hook.idempotency_key, 't1:r1');
  assert.match(hook.headline.join(' '), /fall short/);
  assert.equal(JSON.stringify(hook).includes('row_number'), false, 'webhook must not carry row-level evidence');
  assert.equal(w.sqlite.prepare("SELECT cursor FROM halu_cursors WHERE tenant_id='t1'").get().cursor, '2026-11-14T11:00:00.000Z|r2');

  const second = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
  assert.equal(second.tenants[0].delivered, 0);
  assert.equal(w.seen.webhooks.length, 2);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings').get().c, 2);
  assert.equal(JSON.stringify([first, second, logs]).includes(SECRET), false, 'client secret must never appear in results or logs');
});

test('a failed webhook keeps the cursor, retries next tick, and never duplicates the stored briefing', async () => {
  const w = world({ webhookStatus: 500 });
  const first = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
  assert.equal(first.ok, false);
  assert.match(first.tenants[0].error, /WEBHOOK_FAILED/);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_cursors').get().c, 0);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings').get().c, 1);

  w.state.webhookStatus = 200;
  const retry = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
  assert.equal(retry.ok, true);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings').get().c, 2);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings WHERE webhook_sent_at IS NULL').get().c, 0);
  assert.deepEqual(w.seen.webhooks.filter(h => h.run_id === 'r1').length, 2, 'r1 webhook attempted twice, sent once');
});

test('one tenant failing does not block another; failure is reported by code only', async () => {
  const w = world({ tenantFailures: { t1: 'TENANT_ACCESS_DENIED' } });
  w.env.HALU_TENANTS = 't1, t2'; delete w.env.HALU_WEBHOOK_URL;
  const logs = [];
  const out = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl, log: l => logs.push(l) });
  assert.equal(out.ok, false);
  assert.deepEqual(out.tenants.map(t => [t.tenant_id, t.ok]), [['t1', false], ['t2', true]]);
  assert.equal(out.tenants[0].error, 'TENANT_ACCESS_DENIED');
  assert.equal(w.seen.tokenCalls, 1, 'one token is shared across tenants');
  assert.equal(logs.some(l => l.event === 'halu.tenant_poll_failed' && l.tenant_id === 't1'), true);
});

test('invalid configuration fails closed before any network call', async () => {
  for (const [key, value, expected] of [
    ['HALU_CLIENT_SECRET', '', 'HALU_CLIENT_SECRET'], ['HALU_TENANTS', 'bad tenant!', 'HALU_TENANTS'],
    ['HALU_ZONAR_BASE_URL', 'http://zonar.example', 'HALU_ZONAR_BASE_URL'], ['HALU_WEBHOOK_URL', 'http://hooks.example/h', 'HALU_WEBHOOK_URL'],
    ['HALU_DB', null, 'HALU_DB']
  ]) {
    const w = world(); w.env[key] = value;
    const out = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'CONFIG_INVALID:' + expected);
    assert.equal(w.seen.urls.length, 0);
  }
});

test('unfilled REPLACE_WITH placeholders fail closed', async () => {
  const w = world(); w.env.HALU_CLIENT_ID = 'REPLACE_WITH_HALU_APP_CLIENT_ID';
  const out = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
  assert.equal(out.error, 'CONFIG_INVALID:HALU_CLIENT_ID');
  assert.equal(w.seen.urls.length, 0);
});

test('worker exposes only the authenticated read API and parses tenant lists', async () => {
  assert.equal((await worker.fetch(new Request('https://h.example/other'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://h.example/api/halu/workspaces'), { HALU_DB: { prepare() {} }, HALU_ZONAR_BASE_URL: 'https://z' })).status, 401);
  assert.deepEqual(parseTenants(' a, b ,,c '), ['a', 'b', 'c']);
  assert.equal(webhookSummary({ idempotency_key: 'k', tenant_id: 't', run_id: 'r',
    briefing: { completed_at: 'x', total_findings: 1, by_severity: {}, groups: [{ evidence: [1] }] },
    finance: { headline: ['h'], over_invoiced: {}, under_invoiced: {}, uninvoiced_orders: { evidence: [1] } } }).groups, undefined);
});

test('the gate is off by default: nothing is withheld when it is not required', async () => {
  const w = world(); delete w.env.HALU_WEBHOOK_URL;
  w.sqlite.exec('DELETE FROM halu_boundaries; DELETE FROM halu_readiness;');
  const out = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
  assert.equal(out.tenants[0].delivered, 2); assert.equal(out.tenants[0].gated, undefined);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_decision_log').get().c, 0);
});

test('a closed gate withholds delivery, does not move the cursor, and the backlog flows once it opens', async () => {
  const w = world(); w.env.HALU_REQUIRE_READINESS = 'true';
  w.sqlite.prepare("UPDATE halu_boundaries SET status='revoked' WHERE tenant_id='t1'").run();
  const logs = [];
  const closed = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl, log: l => logs.push(l) });
  assert.deepEqual(closed.tenants, [{ tenant_id: 't1', ok: true, gated: true, verdict: 'on_governance', delivered: 0, skipped: 0 }]);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings').get().c, 0);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_cursors').get().c, 0);
  assert.equal(w.seen.webhooks.length, 0);
  assert.equal(w.seen.urls.some(u => u.startsWith('zonar.example')), false, 'no ZONAR call while the gate is closed');
  assert.equal(logs.some(l => l.event === 'halu.gate_closed'), true);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) c FROM halu_decision_log WHERE decision='withheld'").get().c, 1);

  w.sqlite.prepare("UPDATE halu_boundaries SET status='active' WHERE tenant_id='t1'").run();
  const open = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
  assert.equal(open.tenants[0].delivered, 2);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) c FROM halu_decision_log WHERE decision='delivered'").get().c, 2);
  assert.equal(w.sqlite.prepare("SELECT boundary_id FROM halu_decision_log WHERE decision='delivered' LIMIT 1").get().boundary_id, 'bl-t1');
});

test('a boundary revoked mid-poll stops delivery of later runs without losing them', async () => {
  const w = world(); delete w.env.HALU_WEBHOOK_URL; w.env.HALU_REQUIRE_READINESS = 'true';
  let delivered = 0;
  const realFetch = w.fetchImpl;
  const fetchImpl = async (url, init) => {
    const res = await realFetch(url, init);
    if (new URL(url).pathname.endsWith('/reconciliation-runs/r1/findings')) { delivered++; w.sqlite.prepare("UPDATE halu_boundaries SET status='revoked' WHERE tenant_id='t1'").run(); }
    return res;
  };
  const out = await runHaluPoll(w.env, { fetchImpl });
  assert.equal(out.tenants[0].gated, true);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) c FROM halu_briefings').get().c, 0, 'revocation during the poll blocks even the run being processed');
  w.sqlite.prepare("UPDATE halu_boundaries SET status='active'").run();
  const again = await runHaluPoll(w.env, { fetchImpl: realFetch });
  assert.equal(again.tenants[0].delivered, 2);
});

test('one tenant gated does not stop another tenant', async () => {
  const w = world(); w.env.HALU_TENANTS = 't1,t2'; delete w.env.HALU_WEBHOOK_URL; w.env.HALU_REQUIRE_READINESS = 'true';
  w.sqlite.prepare("UPDATE halu_readiness SET data_ok=0 WHERE tenant_id='t1'").run();
  const out = await runHaluPoll(w.env, { fetchImpl: w.fetchImpl });
  assert.deepEqual(out.tenants.map(t => [t.tenant_id, t.gated === true, t.delivered]), [['t1', true, 0], ['t2', false, 2]]);
});
