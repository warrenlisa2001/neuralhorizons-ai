import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { authenticateZonarTenant } from '../src/zonar-auth.js';

globalThis.crypto ||= webcrypto;

const encoder = new TextEncoder();
const b64url = value => Buffer.from(value).toString('base64url');
const jsonPart = value => b64url(JSON.stringify(value));

async function createToken(privateKey, claims, kid = 'test-key', headerOverrides = {}) {
  const header = jsonPart({ alg: 'RS256', typ: 'JWT', kid, ...headerOverrides });
  const payload = jsonPart({ scp: 'zonar.api', ...claims });
  const input = encoder.encode(header + '.' + payload);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, input);
  return header + '.' + payload + '.' + b64url(signature);
}

let fixtureNumber = 0;

async function fixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'test-key';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  const oldFetch = globalThis.fetch;
  let publishedKeys = [jwk];
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(JSON.stringify({ keys: publishedKeys }), {
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const now = Math.floor(Date.now() / 1000);
  const env = {
    ZONAR_ISSUER: 'https://identity.example/',
    ZONAR_AUDIENCE: 'zonar-api',
    ZONAR_REQUIRED_SCOPE: 'zonar.api',
    ZONAR_JWKS_URL: 'https://identity.example/.well-known/jwks.json?fixture=' + (++fixtureNumber),
    ZONAR_DB: {
      prepare(sql) {
        assert.match(sql, /m\.tenant_id = \?3/);
        return {
          bind(issuer, subject, tenantId) {
            return {
              async first() {
                if (issuer === 'https://identity.example/' && subject === 'user-123' && tenantId === 'tenant-a') {
                  return { user_id: 'db-user-1', tenant_id: 'tenant-a', tenant_status: 'active', role: 'analyst' };
                }
                return null;
              }
            };
          }
        };
      }
    }
  };
  const token = await createToken(pair.privateKey, {
    iss: env.ZONAR_ISSUER, aud: env.ZONAR_AUDIENCE, sub: 'user-123', exp: now + 300
  });
  return {
    env, token, privateKey: pair.privateKey, jwk, now,
    publishKeys: keys => { publishedKeys = keys; },
    getFetchCount: () => fetchCount,
    restore: () => { globalThis.fetch = oldFetch; }
  };
}

test('valid identity receives only its active tenant membership', async () => {
  const f = await fixture();
  try {
    const result = await authenticateZonarTenant(
      new Request('https://api.example/tenant/tenant-a', { headers: { Authorization: 'Bearer ' + f.token } }),
      f.env,
      'tenant-a'
    );
    assert.deepEqual(result, { ok: true, userId: 'db-user-1', tenantId: 'tenant-a', role: 'analyst' });
  } finally { f.restore(); }
});

test('cross-tenant membership lookup is denied even with a valid identity token', async () => {
  const f = await fixture();
  try {
    const result = await authenticateZonarTenant(
      new Request('https://api.example/tenant/tenant-b', { headers: { Authorization: 'Bearer ' + f.token } }),
      f.env,
      'tenant-b'
    );
    assert.deepEqual(result, { ok: false, status: 403, error: 'TENANT_ACCESS_DENIED' });
  } finally { f.restore(); }
});

test('wrong issuer and expired tokens are rejected', async () => {
  const f = await fixture();
  try {
    const wrongIssuer = await createToken(f.privateKey, {
      iss: 'https://attacker.example/', aud: f.env.ZONAR_AUDIENCE, sub: 'user-123', exp: f.now + 300
    });
    const expired = await createToken(f.privateKey, {
      iss: f.env.ZONAR_ISSUER, aud: f.env.ZONAR_AUDIENCE, sub: 'user-123', exp: f.now - 1
    });
    for (const token of [wrongIssuer, expired]) {
      const result = await authenticateZonarTenant(
        new Request('https://api.example/tenant/tenant-a', { headers: { Authorization: 'Bearer ' + token } }),
        f.env,
        'tenant-a'
      );
      assert.equal(result.status, 401);
      assert.equal(result.error, 'UNAUTHORISED');
    }
  } finally { f.restore(); }
});

test('missing D1 binding fails closed', async () => {
  const result = await authenticateZonarTenant(new Request('https://api.example'), {}, 'tenant-a');
  assert.deepEqual(result, { ok: false, status: 503, error: 'TENANT_AUTH_NOT_CONFIGURED' });
});

test('missing bearer token fails closed', async () => {
  const f = await fixture();
  try {
    const result = await authenticateZonarTenant(new Request('https://api.example'), f.env, 'tenant-a');
    assert.equal(result.status, 401);
  } finally { f.restore(); }
});

test('unknown signing key refreshes cached JWKS once for key rotation', async () => {
  const f = await fixture();
  try {
    const first = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + f.token } }), f.env, 'tenant-a');
    assert.equal(first.ok, true);
    const rotated = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    const nextJwk = await crypto.subtle.exportKey('jwk', rotated.publicKey);
    Object.assign(nextJwk, { kid: 'rotated-key', use: 'sig', alg: 'RS256' });
    f.publishKeys([nextJwk]);
    const rotatedToken = await createToken(rotated.privateKey, {
      iss: f.env.ZONAR_ISSUER, aud: f.env.ZONAR_AUDIENCE, sub: 'user-123', exp: f.now + 300
    }, 'rotated-key');
    const result = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + rotatedToken } }), f.env, 'tenant-a');
    assert.equal(result.ok, true);
    assert.equal(f.getFetchCount(), 2);
  } finally { f.restore(); }
});

test('rejects critical or unsupported JOSE header parameters', async () => {
  const f = await fixture();
  try {
    const token = await createToken(f.privateKey, {
      iss: f.env.ZONAR_ISSUER, aud: f.env.ZONAR_AUDIENCE, sub: 'user-123', exp: f.now + 300
    }, 'test-key', { crit: ['b64'], b64: false });
    const result = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + token } }), f.env, 'tenant-a');
    assert.equal(result.status, 401);
  } finally { f.restore(); }
});

test('rejects malformed and duplicate-kid JWKS documents', async () => {
  const f = await fixture();
  try {
    f.publishKeys([f.jwk, { ...f.jwk }]);
    const result = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + f.token } }), f.env, 'tenant-a');
    assert.equal(result.status, 401);
  } finally { f.restore(); }
});

test('rejects an oversized JWKS response before parsing', async () => {
  const f = await fixture();
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(' '.repeat(65537), {
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + f.token } }), f.env, 'tenant-a');
    assert.equal(result.status, 401);
  } finally {
    globalThis.fetch = oldFetch;
    f.restore();
  }
});

test('tenant identifiers are validated before identity-provider or database work', async () => {
  const f = await fixture();
  try {
    const result = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + f.token } }), f.env, 'tenant/a');
    assert.deepEqual(result, { ok: false, status: 400, error: 'INVALID_TENANT' });
    assert.equal(f.getFetchCount(), 0);
  } finally { f.restore(); }
});

test('bearer scheme is case-insensitive but token whitespace is rejected', async () => {
  const f = await fixture();
  try {
    const accepted = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'bearer ' + f.token } }), f.env, 'tenant-a');
    assert.equal(accepted.ok, true);
    const rejected = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + f.token + ' extra' } }), f.env, 'tenant-a');
    assert.equal(rejected.status, 401);
  } finally { f.restore(); }
});

test('unknown-kid refresh cooldown prevents repeated JWKS fetches', async () => {
  const f = await fixture();
  try {
    const first = await authenticateZonarTenant(
      new Request('https://api.example', { headers: { Authorization: 'Bearer ' + f.token } }), f.env, 'tenant-a');
    assert.equal(first.ok, true);
    const unknownTokens = await Promise.all(['unknown-one', 'unknown-two'].map(kid => createToken(f.privateKey, {
      iss: f.env.ZONAR_ISSUER, aud: f.env.ZONAR_AUDIENCE, sub: 'user-123', exp: f.now + 300
    }, kid)));
    for (const token of unknownTokens) {
      const result = await authenticateZonarTenant(
        new Request('https://api.example', { headers: { Authorization: 'Bearer ' + token } }), f.env, 'tenant-a');
      assert.equal(result.status, 401);
    }
    assert.equal(f.getFetchCount(), 2);
  } finally { f.restore(); }
});
