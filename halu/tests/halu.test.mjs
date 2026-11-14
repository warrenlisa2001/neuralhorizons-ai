import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntraTokenProvider } from '../src/entra-token.js';
import { createFindingsClient, ZonarFeedError, SUPPORTED_SCHEMA } from '../src/zonar-findings-client.js';
import { buildBriefing } from '../src/briefing.js';

const run = { id: 'r1', status: 'succeeded', processor_version: 'zonar-staged-1', completed_at: '2026-11-14T10:00:00Z' };
const mkFinding = (id, code, severity, dataset = 'invoices', row = 2) => ({
  id: String(id), code, severity,
  source: { file_id: 'f-' + dataset, dataset, row_number: row, record_id: 'R' + id, order_id: 'O' + id }, expected: 50, actual: 45, details: null
});
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('token provider caches, refreshes early and shares one in-flight request', async () => {
  let calls = 0; let t = 1_000_000;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.match(String(url), /login\.microsoftonline\.com\/tenant-x\/oauth2\/v2\.0\/token/);
    assert.match(init.body, /grant_type=client_credentials/);
    return jsonRes({ access_token: 'tok' + calls, expires_in: 3600 });
  };
  const get = createEntraTokenProvider({ authorityTenantId: 'tenant-x', clientId: 'cid', clientSecret: 'secret', scope: 'api://zonar/.default', fetchImpl, now: () => t });
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, 'tok1'); assert.equal(b, 'tok1'); assert.equal(calls, 1);
  t += 3000_000; assert.equal(await get(), 'tok1');       // still fresh
  t += 600_000;  assert.equal(await get(), 'tok2');       // inside the 60 s early-refresh window
});

test('token errors never leak the client secret', async () => {
  const get = createEntraTokenProvider({ authorityTenantId: 't', clientId: 'c', clientSecret: 'TOP-SECRET', scope: 's',
    fetchImpl: async () => jsonRes({ error: 'invalid_client', error_description: 'TOP-SECRET echoed' }, 401) });
  await assert.rejects(get(), e => { assert.doesNotMatch(e.message, /TOP-SECRET/); return /ENTRA_TOKEN_REQUEST_FAILED:401/.test(e.message); });
  assert.throws(() => createEntraTokenProvider({ authorityTenantId: 't' }), /ENTRA_CONFIG_INCOMPLETE/);
});

test('client follows cursors across pages and sends the bearer token', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization });
    const cursor = new URL(url).searchParams.get('cursor');
    return cursor
      ? jsonRes({ schema_version: SUPPORTED_SCHEMA, run, findings: [mkFinding(3, 'A', 'low')], page: { limit: 2, next_cursor: null } })
      : jsonRes({ schema_version: SUPPORTED_SCHEMA, run, findings: [mkFinding(1, 'A', 'high'), mkFinding(2, 'A', 'high')], page: { limit: 2, next_cursor: '2' } });
  };
  const client = createFindingsClient({ baseUrl: 'https://z.example/', tenantId: 't1', getToken: async () => 'T', fetchImpl });
  const { findings, run: gotRun } = await client.collectFindings('r1', { severity: undefined });
  assert.deepEqual(findings.map(f => f.id), ['1', '2', '3']);
  assert.equal(gotRun.id, 'r1');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].auth, 'Bearer T');
  assert.match(seen[0].url, /\/api\/zonar\/tenants\/t1\/reconciliation-runs\/r1\/findings/);
  assert.match(seen[1].url, /cursor=2/);
});

test('client retries transient errors but fails fast on permanent ones', async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? jsonRes({ error: 'FINDINGS_READ_FAILED' }, 503)
    : jsonRes({ schema_version: SUPPORTED_SCHEMA, run, findings: [], page: { limit: 50, next_cursor: null } }));
  const c1 = createFindingsClient({ baseUrl: 'https://z', tenantId: 't1', getToken: async () => 'T', fetchImpl: flaky, sleep: async () => {} });
  assert.deepEqual((await c1.collectFindings('r1')).findings, []);
  assert.equal(n, 3);

  let m = 0;
  const unverified = async () => { m++; return jsonRes({ error: 'RUN_NOT_VERIFIED' }, 409); };
  const c2 = createFindingsClient({ baseUrl: 'https://z', tenantId: 't1', getToken: async () => 'T', fetchImpl: unverified, sleep: async () => {} });
  await assert.rejects(c2.collectFindings('r1'), e => e instanceof ZonarFeedError && e.code === 'RUN_NOT_VERIFIED' && e.status === 409);
  assert.equal(m, 1);
});

test('client refuses an unknown schema version and a runaway cursor loop', async () => {
  const c1 = createFindingsClient({ baseUrl: 'https://z', tenantId: 't1', getToken: async () => 'T',
    fetchImpl: async () => jsonRes({ schema_version: 'zonar.findings.v9', run, findings: [], page: { next_cursor: null } }) });
  await assert.rejects(c1.collectFindings('r1'), e => e.code === 'UNSUPPORTED_SCHEMA_VERSION');
  const c2 = createFindingsClient({ baseUrl: 'https://z', tenantId: 't1', getToken: async () => 'T', maxPages: 3,
    fetchImpl: async () => jsonRes({ schema_version: SUPPORTED_SCHEMA, run, findings: [], page: { next_cursor: '9' } }) });
  await assert.rejects(c2.collectFindings('r1'), e => e.code === 'PAGE_LIMIT_EXCEEDED');
});

test('briefing counts, orders by severity, and keeps source evidence on every group', () => {
  const findings = [
    mkFinding(1, 'INVOICE_VALUE_MISMATCH', 'high'), mkFinding(2, 'INVOICE_VALUE_MISMATCH', 'high'),
    mkFinding(3, 'MISSING_DELIVERY', 'medium', 'deliveries'), mkFinding(4, 'DUPLICATE_INVOICE', 'high', 'invoices'),
    mkFinding(5, 'ROUNDING', 'low')
  ];
  const b = buildBriefing({ run, findings });
  assert.equal(b.total_findings, 5);
  assert.deepEqual(b.by_severity, { high: 3, medium: 1, low: 1 });
  assert.deepEqual(b.groups.map(g => g.code), ['INVOICE_VALUE_MISMATCH', 'DUPLICATE_INVOICE', 'MISSING_DELIVERY', 'ROUNDING']);
  assert.equal(b.groups[0].count, 2);
  assert.ok(b.groups.every(g => g.evidence.length > 0 && g.evidence.every(e => e.file_id && e.row_number >= 2)));
  assert.equal(b.evidence_truncated, false);
});

test('briefing caps evidence, flags truncation, and rejects unverified runs', () => {
  const many = Array.from({ length: 12 }, (_, i) => mkFinding(i + 1, 'X', 'high', 'orders', i + 2));
  const b = buildBriefing({ run, findings: many });
  assert.equal(b.groups[0].count, 12);
  assert.equal(b.groups[0].evidence.length, 5);
  assert.equal(b.evidence_truncated, true);
  assert.throws(() => buildBriefing({ run: { ...run, status: 'running' }, findings: [] }), /BRIEFING_REQUIRES_VERIFIED_RUN/);
});
