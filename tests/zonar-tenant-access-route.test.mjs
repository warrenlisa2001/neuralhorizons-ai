import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleZonarTenantAccess } from '../src/index.js';

globalThis.crypto ||= webcrypto;

const encoder = new TextEncoder();
const b64url = value => Buffer.from(value).toString('base64url');
const jsonPart = value => b64url(JSON.stringify(value));
let privateKey;
let oldFetch;
let env;
let token;

async function makeToken(claims) {
  const header = jsonPart({ alg: 'RS256', typ: 'JWT', kid: 'route-test-key' });
  const payload = jsonPart(claims);
  const input = encoder.encode(header + '.' + payload);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, input);
  return header + '.' + payload + '.' + b64url(signature);
}

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  privateKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'route-test-key';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { 'Content-Type': 'application/json' }
  });
  const now = Math.floor(Date.now() / 1000);
  env = {
    ZONAR_ISSUER: 'https://route-identity.example/',
    ZONAR_AUDIENCE: 'zonar-api',
    ZONAR_REQUIRED_SCOPE: 'zonar.api',
    ZONAR_JWKS_URL: 'https://route-identity.example/jwks.json',
    ZONAR_DB: {
      prepare() {
        return {
          bind(issuer, subject, tenantId) {
            return {
              async first() {
                if (issuer === env.ZONAR_ISSUER && subject === 'route-user' && tenantId === 'tenant-a') {
                  return { user_id: 'db-user-a', tenant_id: 'tenant-a', tenant_status: 'active', role: 'analyst' };
                }
                return null;
              }
            };
          }
        };
      }
    }
  };
  token = await makeToken({
    iss: env.ZONAR_ISSUER, aud: env.ZONAR_AUDIENCE, sub: 'route-user', scp: 'zonar.api', exp: now + 300
  });
});

after(() => {
  if (oldFetch) globalThis.fetch = oldFetch;
});

test('tenant access route returns only the verified tenant and role', async () => {
  const response = await handleZonarTenantAccess(
    new Request('https://api.example/api/zonar/tenants/tenant-a/access', {
      headers: { Authorization: 'Bearer ' + token }
    }),
    env,
    'tenant-a'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    tenant: { id: 'tenant-a', role: 'analyst' }
  });
});

test('tenant access route denies a valid user from another tenant', async () => {
  const response = await handleZonarTenantAccess(
    new Request('https://api.example/api/zonar/tenants/tenant-b/access', {
      headers: { Authorization: 'Bearer ' + token }
    }),
    env,
    'tenant-b'
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'TENANT_ACCESS_DENIED' });
});

test('tenant access route fails closed before D1 and identity are configured', async () => {
  const response = await handleZonarTenantAccess(
    new Request('https://api.example/api/zonar/tenants/tenant-a/access'),
    {},
    'tenant-a'
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'TENANT_AUTH_NOT_CONFIGURED' });
});

test('tenant access route only accepts GET', async () => {
  const response = await handleZonarTenantAccess(
    new Request('https://api.example/api/zonar/tenants/tenant-a/access', { method: 'POST' }),
    env,
    'tenant-a'
  );
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: 'METHOD_NOT_ALLOWED' });
});
