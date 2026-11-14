import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { authenticateZonarTenant } from '../src/zonar-auth.js';
import { handleZonarReconciliationFindings } from '../src/zonar-findings.js';

globalThis.crypto ||= webcrypto;
const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()
  .map(n => readFileSync(new URL('../migrations/' + n, import.meta.url), 'utf8')).join('\n');

const ISS = 'https://login.example/tenant/v2.0';
const HALU_APP = '11111111-1111-1111-1111-111111111111';
const b64u = v => Buffer.from(v).toString('base64url');
const part = v => b64u(JSON.stringify(v));

function d1(sqlite, { failAuditInsert = false } = {}) {
  return { prepare(sql) { return { bind(...values) { return { sql, values,
    async run() {
      if (failAuditInsert && /INSERT INTO audit_events/.test(sql)) throw new Error('boom');
      const r = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes || 0) } };
    },
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; } }; } }; } };
}

let n = 0;
async function fixture({ failAuditInsert = false } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  Object.assign(jwk, { kid: 'k1', use: 'sig', alg: 'RS256' });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migrations);
  for (const t of ['t1', 't2']) sqlite.prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run(t, t);
  sqlite.prepare('INSERT INTO users(id,identity_issuer,identity_subject) VALUES(?,?,?)').run('u1', ISS, 'user-sub');
  sqlite.prepare("INSERT INTO memberships(tenant_id,user_id,role) VALUES('t1','u1','tenant_owner')").run();
  for (const id of ['o', 'i', 'd']) {
    sqlite.prepare(`INSERT INTO tenant_files(id,tenant_id,uploaded_by_user_id,original_filename,object_key,content_type,byte_size,sha256_hex)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, 't1', 'u1', id + '.csv', 't1/' + id, 'text/csv', 1, 'a'.repeat(64));
  }
  sqlite.prepare(`INSERT INTO reconciliation_runs(id,tenant_id,requested_by_user_id,processor_version,status,orders_file_id,invoices_file_id,deliveries_file_id,summary_json)
    VALUES('r1','t1','u1','zonar-staged-1','succeeded','o','i','d','{"ok":true}')`).run();
  sqlite.prepare("INSERT INTO audit_events(id,tenant_id,event_type,outcome) VALUES('rc_r1','t1','reconciliation.completed','success')").run();
  sqlite.prepare(`INSERT INTO reconciliation_exceptions(tenant_id,run_id,code,severity,dataset,source_row_number,record_id,order_id,expected_value,actual_value)
    VALUES('t1','r1','INVOICE_VALUE_MISMATCH','high','invoices',3,'I2','O2',50,45)`).run();
  sqlite.prepare("INSERT INTO service_principals(id,tenant_id,identity_issuer,app_id,display_name) VALUES('sp1','t1',?,?,'HALU')").run(ISS, HALU_APP);

  const now = Math.floor(Date.now() / 1000);
  const env = {
    ZONAR_ISSUER: ISS, ZONAR_AUDIENCE: 'zonar-api', ZONAR_REQUIRED_SCOPE: 'zonar.api',
    ZONAR_JWKS_URL: 'https://login.example/keys?f=' + (++n), ZONAR_DB: d1(sqlite, { failAuditInsert })
  };
  const sign = async claims => {
    const h = part({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
    const p = part({ iss: ISS, aud: 'zonar-api', exp: now + 300, ...claims });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(h + '.' + p));
    return h + '.' + p + '.' + b64u(sig);
  };
  const serviceToken = (extra = {}) => sign({ sub: 'sp-object-id', azp: HALU_APP, roles: ['Zonar.Findings.Read'], idtyp: 'app', ...extra });
  const call = (token, tenant = 't1') => handleZonarReconciliationFindings(
    new Request(`https://z.example/api/zonar/tenants/${tenant}/reconciliation-runs/r1/findings`, { headers: { Authorization: 'Bearer ' + token } }),
    env, tenant, 'r1');
  return { sqlite, env, sign, serviceToken, call, restore: () => { globalThis.fetch = oldFetch; } };
}

test('registered service principal reads verified findings and the access is audited', async () => {
  const f = await fixture();
  try {
    const res = await f.call(await f.serviceToken());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.findings.length, 1);
    assert.equal(body.findings[0].source.record_id, 'I2');
    const audit = f.sqlite.prepare("SELECT * FROM audit_events WHERE event_type='findings.read'").all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].tenant_id, 't1');
    assert.equal(audit[0].actor_user_id, null);
    assert.equal(JSON.parse(audit[0].details_json).app_id, HALU_APP);
  } finally { f.restore(); }
});

test('service principal is bound to its own tenant only', async () => {
  const f = await fixture();
  try {
    const res = await f.call(await f.serviceToken(), 't2');
    assert.equal(res.status, 403);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) c FROM audit_events WHERE event_type='findings.read'").get().c, 0);
  } finally { f.restore(); }
});

test('unregistered app, revoked principal, and empty registry scopes are denied', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(await f.serviceToken({ azp: '22222222-2222-2222-2222-222222222222' }))).status, 403);
    f.sqlite.prepare("UPDATE service_principals SET scopes='' WHERE id='sp1'").run();
    assert.equal((await f.call(await f.serviceToken())).status, 403);
    f.sqlite.prepare("UPDATE service_principals SET scopes='findings:read', status='revoked' WHERE id='sp1'").run();
    assert.equal((await f.call(await f.serviceToken())).status, 403);
  } finally { f.restore(); }
});

test('suspended tenant blocks its service principal', async () => {
  const f = await fixture();
  try {
    f.sqlite.prepare("UPDATE tenants SET status='suspended' WHERE id='t1'").run();
    assert.equal((await f.call(await f.serviceToken())).status, 403);
  } finally { f.restore(); }
});

test('app token without the findings role, or with a delegated scp, is not accepted as a service', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(await f.serviceToken({ roles: ['Other.Role'] }))).status, 401);
    // roles + scp together is treated as a delegated token and must pass user membership, which it lacks.
    const mixed = await f.serviceToken({ scp: 'zonar.api' });
    const res = await f.call(mixed);
    assert.equal(res.status, 403);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) c FROM audit_events WHERE event_type='findings.read'").get().c, 0);
  } finally { f.restore(); }
});

test('wrong issuer, expired token and idtyp=user are rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(await f.serviceToken({ iss: 'https://evil.example/' }))).status, 401);
    assert.equal((await f.call(await f.serviceToken({ exp: Math.floor(Date.now() / 1000) - 10 }))).status, 401);
    assert.equal((await f.call(await f.serviceToken({ idtyp: 'user' }))).status, 401);
  } finally { f.restore(); }
});

test('findings are not served if the access audit cannot be written', async () => {
  const f = await fixture({ failAuditInsert: true });
  try {
    const res = await f.call(await f.serviceToken());
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'AUDIT_UNAVAILABLE');
  } finally { f.restore(); }
});

test('a service token cannot be used on user-only tenant routes', async () => {
  const f = await fixture();
  try {
    const req = new Request('https://z.example/x', { headers: { Authorization: 'Bearer ' + await f.serviceToken() } });
    const result = await authenticateZonarTenant(req, f.env, 't1');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  } finally { f.restore(); }
});
