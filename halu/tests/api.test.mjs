import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleHaluApi } from '../src/api.js';

const migration = readFileSync(new URL('../migrations/0001_halu.sql', import.meta.url), 'utf8');
const jsonRes = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function d1(sqlite) {
  return { prepare(sql) { return { bind(...v) { return {
    async first() { return sqlite.prepare(sql).get(...v) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...v) }; } }; } }; } };
}
function world({ workspaces = [{ id: 't1', name: 'Tenant One', role: 'analyst' }], identityStatus = 200, tenants = 't1,t2' } = {}) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(migration);
  const add = (tenant, run, at, headline) => sqlite.prepare(
    'INSERT INTO halu_briefings(idempotency_key,tenant_id,run_id,completed_at,briefing_json,finance_json) VALUES(?,?,?,?,?,?)')
    .run(`${tenant}:${run}`, tenant, run, at,
      JSON.stringify({ total_findings: 3, by_severity: { high: 1, medium: 1, low: 1 }, groups: [{ secret_detail: 'x' }] }),
      JSON.stringify({ headline: [headline], over_invoiced: { count: 1, total: 12.5 } }));
  add('t1', 'r1', '2026-11-14T10:00:00.000Z', 'older');
  add('t1', 'r2', '2026-11-14T11:00:00.000Z', 'middle');
  add('t1', 'r3', '2026-11-14T12:00:00.000Z', 'newest');
  add('t2', 'r9', '2026-11-14T12:30:00.000Z', 'OTHER TENANT');
  const seen = { auth: [] };
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/zonar/me');
    seen.auth.push(init.headers.Authorization);
    return identityStatus === 200 ? jsonRes({ authenticated: true, workspaces }) : jsonRes({ error: 'X' }, identityStatus);
  };
  const env = { HALU_DB: d1(sqlite), HALU_ZONAR_BASE_URL: 'https://zonar.example', HALU_TENANTS: tenants };
  const call = (path, { token = 'USER-TOKEN', headers = {}, method = 'GET' } = {}) => handleHaluApi(
    new Request('https://halu.example' + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }), env, { fetchImpl });
  return { env, call, seen, sqlite };
}

test('lists briefings newest first with headline, totals and cursor paging; no evidence in the list', async () => {
  const w = world();
  const first = await (await w.call('/api/halu/tenants/t1/briefings?limit=2')).json();
  assert.deepEqual(first.briefings.map(b => b.run_id), ['r3', 'r2']);
  assert.deepEqual(first.briefings[0].headline, ['newest']);
  assert.equal(first.briefings[0].total_findings, 3);
  assert.equal(JSON.stringify(first).includes('secret_detail'), false);
  const second = await (await w.call('/api/halu/tenants/t1/briefings?limit=2&cursor=' + encodeURIComponent(first.page.next_cursor))).json();
  assert.deepEqual(second.briefings.map(b => b.run_id), ['r1']);
  assert.equal(second.page.next_cursor, null);
  assert.equal(w.seen.auth[0], 'Bearer USER-TOKEN');
});

test('returns a full briefing for one run, and 404 for an unknown run', async () => {
  const w = world();
  const body = await (await w.call('/api/halu/tenants/t1/briefings/r2')).json();
  assert.equal(body.run_id, 'r2');
  assert.equal(body.briefing.groups[0].secret_detail, 'x');
  assert.equal(body.finance.over_invoiced.total, 12.5);
  assert.equal((await w.call('/api/halu/tenants/t1/briefings/nope')).status, 404);
});

test('a member of one tenant can never read another tenant, even by guessing ids', async () => {
  const w = world();
  assert.equal((await w.call('/api/halu/tenants/t2/briefings')).status, 403);
  assert.equal((await w.call('/api/halu/tenants/t2/briefings/r9')).status, 403);
  // Same run id under the member's own tenant must not leak the other tenant's row.
  assert.equal((await w.call('/api/halu/tenants/t1/briefings/r9')).status, 404);
  const all = JSON.stringify(await (await w.call('/api/halu/tenants/t1/briefings')).json());
  assert.equal(all.includes('OTHER TENANT'), false);
});

test('workspaces list is limited to tenants HALU serves and roles allowed to read', async () => {
  const w = world({ workspaces: [
    { id: 't1', name: 'One', role: 'viewer' }, { id: 'tX', name: 'Not served by HALU', role: 'tenant_owner' }, { id: 't2', name: 'Two', role: 'weird_role' }] });
  w.env.HALU_READER_ROLES = 'tenant_owner,analyst';
  const body = await (await w.call('/api/halu/workspaces')).json();
  assert.deepEqual(body.workspaces, []);
  w.env.HALU_READER_ROLES = '';  // empty falls back to all five known roles
  assert.deepEqual((await (await w.call('/api/halu/workspaces')).json()).workspaces.map(x => x.id), ['t1']);
});

test('missing/invalid tokens are 401 and identity outages are 503, never data', async () => {
  const none = world();
  assert.equal((await none.call('/api/halu/tenants/t1/briefings', { token: null })).status, 401);
  assert.equal(none.seen.auth.length, 0, 'no ZONAR call without a token');
  assert.equal((await world({ identityStatus: 401 }).call('/api/halu/tenants/t1/briefings')).status, 401);
  assert.equal((await world({ identityStatus: 500 }).call('/api/halu/tenants/t1/briefings')).status, 503);
  const down = world(); down.env.HALU_ZONAR_BASE_URL = 'https://zonar.example';
  const res = await handleHaluApi(new Request('https://h/api/halu/workspaces', { headers: { Authorization: 'Bearer x' } }), down.env,
    { fetchImpl: async () => { throw new Error('network'); } });
  assert.equal(res.status, 503);
});

test('bad input is rejected before any database or identity work', async () => {
  const w = world();
  assert.equal((await w.call('/api/halu/tenants/t1/briefings?cursor=bad')).status, 400);
  assert.equal((await w.call('/api/halu/tenants/t1/briefings?cursor=' + encodeURIComponent("a|b';--"))).status, 400);
  assert.equal((await w.call('/api/halu/tenants/t1/briefings?limit=0')).status, 400);
  assert.equal((await w.call('/api/halu/tenants/t%201/briefings')).status, 400);
  assert.equal((await w.call('/api/halu/tenants/t1/briefings/%E0%A4%A')).status, 400);
  assert.equal((await w.call('/api/halu/tenants/t1/briefings', { method: 'POST' })).status, 405);
  assert.equal((await w.call('/api/halu/elsewhere')).status, 404);
});

test('CORS echoes only the single configured origin and responses are never cached', async () => {
  const w = world(); w.env.HALU_ALLOWED_ORIGIN = 'https://app.example';
  const ok = await w.call('/api/halu/workspaces', { headers: { Origin: 'https://app.example' } });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  const other = await w.call('/api/halu/workspaces', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  const pre = await w.call('/api/halu/workspaces', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } });
  assert.equal(pre.status, 204);
});

test('unconfigured HALU fails closed', async () => {
  const w = world(); delete w.env.HALU_ZONAR_BASE_URL;
  assert.equal((await w.call('/api/halu/workspaces')).status, 503);
});

test('workspace lookup uses the ZONAR service binding when configured', async () => {
  const w = world();
  let viaBinding = 0;
  const env = { ...w.env, ZONAR: { fetch: async (url, init) => { viaBinding++; return jsonRes({ authenticated: true, workspaces: [{ id: 't1', name: 'Tenant One', role: 'analyst' }] }); } } };
  const res = await handleHaluApi(new Request('https://halu.test/api/halu/workspaces', { headers: { Authorization: 'Bearer abc' } }), env, { fetchImpl: async () => { throw new Error('public fetch must not be used'); } });
  assert.equal(res.status, 200);
  assert.equal(viaBinding, 1);
});
