import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { authenticateZonarTenant } from '../src/zonar-auth.js';

globalThis.crypto ||= webcrypto;

const encoder = new TextEncoder();
const b64url = value => Buffer.from(value).toString('base64url');
const jsonPart = value => b64url(JSON.stringify(value));

async function createToken(privateKey, claims, kid = 'test-key') {
  const header = jsonPart({ alg: 'RS256', typ: 'JWT', kid });
  const payload = jsonPart(claims);
  const input = encoder.encode(header + '.' + payload);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, input);
  return header + '.' + payload + '.' + b64url(signature);
}

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
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { 'Content-Type': 'application/json' }
  });
  const now = Math.floor(Date.now() / 1000);
  const env = {
    ZONAR_ISSUER: 'https://identity.example/',
    ZONAR_AUDIENCE: 'zonar-api',
    ZONAR_JWKS_URL: 'https://identity.example/.well-known/jwks.json',
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
  return { env, token, privateKey: pair.privateKey, now, restore: () => { globalThis.fetch = oldFetch; } };
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
