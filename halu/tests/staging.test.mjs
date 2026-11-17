import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHaluApi } from '../src/api.js';
import { SYNTHETIC_CSVS, stagingToolsEnabled } from '../src/staging-journey.js';

const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function setup({ role = 'tenant_owner', staging = 'true', uploadStatus = 201 } = {}) {
  const calls = [];
  const env = {
    HALU_DB: { prepare() { return {}; } }, HALU_ZONAR_BASE_URL: 'https://zonar.test', HALU_TENANTS: 't1', HALU_STAGING_TOOLS: staging,
    ZONAR: { fetch: async (url, init) => {
      const path = new URL(url).pathname; calls.push({ path, method: init.method || 'GET', headers: init.headers, body: init.body });
      if (path === '/api/zonar/me') return j({ authenticated: true, workspaces: [{ id: 't1', name: 'T', role }] });
      if (path.endsWith('/files')) return uploadStatus === 201 ? j({ file: { id: 'f' + calls.length } }, 201) : j({ error: 'FILE_STORAGE_NOT_CONFIGURED' }, uploadStatus);
      if (path.endsWith('/reconciliation-jobs')) return j({ run: { id: 'run1', status: 'queued' } }, 202);
      if (path.endsWith('/reconciliation-runs/run1')) return j({ run: { id: 'run1', status: 'succeeded', summary: { exception_count: 7 } } });
      return j({ error: 'X' }, 404);
    } }
  };
  const req = (path, init = {}) => new Request('https://halu.test' + path, { ...init, headers: { Authorization: 'Bearer tok', ...(init.headers || {}) } });
  return { env, calls, req };
}

test('synthetic files carry the planted problems', () => {
  assert.match(SYNTHETIC_CSVS.invoices, /O9999/);
  assert.equal((SYNTHETIC_CSVS.invoices.match(/I2006/g) || []).length, 2);
});

test('staging tools are off unless switched on', async () => {
  const { env, req } = setup({ staging: 'false' });
  assert.equal(stagingToolsEnabled(env), false);
  const res = await handleHaluApi(req('/api/halu/staging/journey', { method: 'POST', body: JSON.stringify({ tenant_id: 't1' }) }), env);
  assert.equal(res.status, 404);
});

test('journey uploads three files, queues a job with the caller token, and reports status', async () => {
  const { env, calls, req } = setup();
  const res = await handleHaluApi(req('/api/halu/staging/journey', { method: 'POST', body: JSON.stringify({ tenant_id: 't1' }) }), env);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).run_id, 'run1');
  const uploads = calls.filter(c => c.path.endsWith('/files'));
  assert.equal(uploads.length, 3);
  assert.ok(calls.filter(c => c.path !== '/api/zonar/me').every(c => c.headers.Authorization === 'Bearer tok'));
  const status = await handleHaluApi(req('/api/halu/staging/journey/run1?tenant_id=t1'), env);
  assert.deepEqual(await status.json(), { run_id: 'run1', status: 'succeeded', error_code: null, exception_count: 7 });
});

test('a viewer role cannot start the journey and a failed upload is reported without leaking detail', async () => {
  const v = setup({ role: 'viewer' });
  const denied = await handleHaluApi(v.req('/api/halu/staging/journey', { method: 'POST', body: JSON.stringify({ tenant_id: 't1' }) }), v.env);
  assert.equal(denied.status, 403);
  const f = setup({ uploadStatus: 503 });
  const failed = await handleHaluApi(f.req('/api/halu/staging/journey', { method: 'POST', body: JSON.stringify({ tenant_id: 't1' }) }), f.env);
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).detail, /^orders 503 FILE_STORAGE_NOT_CONFIGURED$/);
});
