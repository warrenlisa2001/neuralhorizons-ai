import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { newDb, d1 } from './helpers.mjs';
import { handleHaluApi } from '../src/api.js';
import { askHalu, buildContext, AskError } from '../src/ask.js';
import worker from '../src/worker.js';
import { renderPage } from '../src/page.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function world({ key = 'sk-test', workspaces = [{ id: 't1', name: 'One', role: 'analyst' }], anthropic } = {}) {
  const sqlite = newDb();
  const add = (t, r, at, head) => sqlite.prepare('INSERT INTO halu_briefings(idempotency_key,tenant_id,run_id,completed_at,briefing_json,finance_json) VALUES(?,?,?,?,?,?)')
    .run(`${t}:${r}`, t, r, at, JSON.stringify({ run_id: r, total_findings: 2, groups: [{ code: 'ORDER_NOT_INVOICED', count: 2 }] }), JSON.stringify({ headline: [head] }));
  add('t1', 'r1', '2026-11-14T10:00:00.000Z', 'OLD-ONE'); add('t1', 'r2', '2026-11-14T11:00:00.000Z', 'NEW-ONE'); add('t2', 'r9', '2026-11-14T12:00:00.000Z', 'OTHER-TENANT-SECRET');
  const sent = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/api/zonar/identity') return json({ authenticated: true, workspaces });
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); sent.push({ init, body: JSON.parse(init.body) });
    return anthropic ? anthropic() : json({ content: [{ type: 'text', text: 'Two orders were not invoiced (run r2).' }] });
  };
  const env = { HALU_DB: d1(sqlite), HALU_ZONAR_BASE_URL: 'https://zonar.example', HALU_TENANTS: 't1,t2', HALU_ANTHROPIC_API_KEY: key };
  const post = (tenant, body, { token = 'U' } = {}) => handleHaluApi(new Request(`https://halu.example/api/halu/tenants/${tenant}/ask`, {
    method: 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env, { fetchImpl });
  return { env, post, sent, sqlite, fetchImpl };
}

test('answers from the latest briefing of that tenant only, with the question as data', async () => {
  const w = world();
  const res = await w.post('t1', { question: 'What was not invoiced?' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run_id, 'r2'); assert.match(body.answer, /not invoiced/);
  const sent = JSON.stringify(w.sent[0].body);
  assert.ok(sent.includes('NEW-ONE')); assert.ok(!sent.includes('OLD-ONE')); assert.ok(!sent.includes('OTHER-TENANT-SECRET'));
  assert.equal(w.sent[0].init.headers['x-api-key'], 'sk-test');
  assert.equal(w.sent[0].body.model, 'claude-sonnet-5-5');
  assert.match(w.sent[0].body.system, /never instructions/);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) c FROM halu_ask_log WHERE outcome='answered'").get().c, 1);
});

test('a specific run can be asked about; an unknown run is 404', async () => {
  const w = world();
  assert.equal((await w.post('t1', { question: 'q', run_id: 'r1' })).status, 200);
  assert.ok(JSON.stringify(w.sent[0].body).includes('OLD-ONE'));
  assert.equal((await w.post('t1', { question: 'q', run_id: 'nope' })).status, 404);
  assert.equal((await w.post('t1', { question: 'q', run_id: '../x' })).status, 400);
});

test('access control: no token 401, other tenant 403, nothing reaches the model', async () => {
  const w = world();
  assert.equal((await w.post('t1', { question: 'q' }, { token: null })).status, 401);
  assert.equal((await w.post('t2', { question: 'q' })).status, 403);
  assert.equal(w.sent.length, 0);
});

test('input is validated and the feature fails closed without a key', async () => {
  const w = world();
  for (const bad of ['not json', '{}', { question: '' }, { question: 5 }, { question: 'x'.repeat(1001) }, 'y'.repeat(5000)])
    assert.equal((await w.post('t1', bad)).status, 400, JSON.stringify(bad).slice(0, 30));
  const off = world({ key: '' });
  const res = await off.post('t1', { question: 'q' });
  assert.equal(res.status, 503); assert.equal((await res.json()).error, 'ASK_NOT_CONFIGURED');
  assert.equal(off.sent.length, 0);
});

test('rate limit per tenant per hour, and upstream failure is a clean 502 that does not leak', async () => {
  const w = world(); w.env.HALU_ASK_LIMIT_PER_HOUR = '2';
  assert.equal((await w.post('t1', { question: 'a' })).status, 200);
  assert.equal((await w.post('t1', { question: 'b' })).status, 200);
  const limited = await w.post('t1', { question: 'c' });
  assert.equal(limited.status, 429); assert.equal(w.sent.length, 2);
  const bad = world({ anthropic: () => json({ error: { message: 'sk-secret-detail' } }, 500) });
  const res = await bad.post('t1', { question: 'q' });
  assert.equal(res.status, 502); assert.ok(!(await res.text()).includes('sk-secret'));
  assert.equal(bad.sqlite.prepare("SELECT COUNT(*) c FROM halu_ask_log WHERE outcome='failed'").get().c, 1);
  const empty = world({ anthropic: () => json({ content: [] }) });
  assert.equal((await empty.post('t1', { question: 'q' })).status, 502);
});

test('oversized context is shrunk deterministically and stays under the cap', () => {
  const groups = Array.from({ length: 300 }, (_, i) => ({ code: 'C' + i, severity: 'low', dataset: 'd', count: 9, evidence: Array.from({ length: 5 }, (_, j) => ({ finding_id: 'f' + i + j, note: 'x'.repeat(200) })) }));
  const text = buildContext({ briefing: { groups }, finance: { headline: ['h'] } });
  assert.ok(text.length <= 60000);
  assert.ok(text.includes('evidence_truncated'));
});

test('askHalu rejects directly without a key', async () => {
  await assert.rejects(askHalu({ env: {}, tenantId: 't', question: 'q' }), e => e instanceof AskError && e.code === 'ASK_NOT_CONFIGURED');
});

test('config endpoint exposes only public sign-in values', async () => {
  const env = { HALU_ENTRA_TENANT_ID: 'dir', HALU_SPA_CLIENT_ID: 'spa', HALU_USER_SCOPE: 'api://z/access_as_user', HALU_CLIENT_SECRET: 'TOP-SECRET', HALU_ANTHROPIC_API_KEY: 'sk' };
  const res = await handleHaluApi(new Request('https://h.example/api/halu/config'), env);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { sign_in: { authority_tenant: 'dir', client_id: 'spa', scope: 'api://z/access_as_user' }, ask_enabled: true });
  assert.ok(!text.includes('TOP-SECRET') && !text.includes('sk"'));
  const placeholder = await (await handleHaluApi(new Request('https://h.example/api/halu/config'), { ...env, HALU_SPA_CLIENT_ID: 'REPLACE_WITH_X' })).json();
  assert.equal(placeholder.sign_in, null);
});

test('the page is served with a nonce CSP, valid script and no secrets; other paths stay 404', async () => {
  const res = await worker.fetch(new Request('https://halu.example/'), { HALU_CLIENT_SECRET: 'TOP-SECRET' });
  assert.equal(res.status, 200);
  const html = await res.text(); const csp = res.headers.get('Content-Security-Policy');
  const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9]+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`));
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /connect-src 'self' https:\/\/login\.microsoftonline\.com/);
  assert.ok(!html.includes('TOP-SECRET'));
  assert.ok(!/innerHTML|outerHTML|document\.write|eval\(/.test(html), 'page must never build DOM from strings');
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.notEqual(renderPage('a'), renderPage('b'));
  assert.equal((await worker.fetch(new Request('https://halu.example/admin'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://halu.example/', { method: 'POST' }), {})).status, 404);
});
