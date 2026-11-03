// Provider-neutral OIDC/JWT authentication and tenant membership resolution.
// Configure ZONAR_ISSUER, ZONAR_AUDIENCE, ZONAR_JWKS_URL and ZONAR_DB
// as Worker environment settings/bindings before enabling any customer route.
// User and membership provisioning is deliberately explicit; this module never
// auto-creates a user or trusts a tenant identifier from an unverified token.

const MAX_BEARER_TOKEN_LENGTH = 8192;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
let jwksCache = { url: null, expiresAt: 0, keys: null };

function base64UrlToBytes(value) {
  const normal = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal + '='.repeat((4 - normal.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function loadJwks(url) {
  if (jwksCache.url === url && jwksCache.expiresAt > Date.now() && jwksCache.keys) {
    return jwksCache.keys;
  }

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error'
  });
  if (!response.ok) throw new Error('JWKS_UNAVAILABLE');

  const document = await response.json();
  if (!document || !Array.isArray(document.keys) || document.keys.length > 50) {
    throw new Error('INVALID_JWKS');
  }

  jwksCache = {
    url,
    expiresAt: Date.now() + JWKS_CACHE_TTL_MS,
    keys: document.keys
  };
  return document.keys;
}

async function verifyZonarAccessToken(token, env) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_BEARER_TOKEN_LENGTH) {
    throw new Error('INVALID_TOKEN');
  }
  if (!env.ZONAR_ISSUER || !env.ZONAR_AUDIENCE || !env.ZONAR_JWKS_URL) {
    throw new Error('AUTH_CONFIGURATION_MISSING');
  }
  let jwksUrl;
  try { jwksUrl = new URL(env.ZONAR_JWKS_URL); } catch { throw new Error('AUTH_CONFIGURATION_MISSING'); }
  if (jwksUrl.protocol !== 'https:') throw new Error('AUTH_CONFIGURATION_MISSING');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('INVALID_TOKEN');

  let header, claims, signature;
  try {
    header = decodeJsonPart(parts[0]);
    claims = decodeJsonPart(parts[1]);
    signature = base64UrlToBytes(parts[2]);
  } catch {
    throw new Error('INVALID_TOKEN');
  }

  // Restrict algorithms and key type; never accept alg=none or algorithm negotiation.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('INVALID_TOKEN');
  }

  const now = Math.floor(Date.now() / 1000);
  const audienceValid = claims.aud === env.ZONAR_AUDIENCE ||
    (Array.isArray(claims.aud) && claims.aud.includes(env.ZONAR_AUDIENCE));

  if (claims.iss !== env.ZONAR_ISSUER ||
      !audienceValid ||
      typeof claims.sub !== 'string' || !claims.sub ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now))) {
    throw new Error('INVALID_TOKEN');
  }

  const keys = await loadJwks(env.ZONAR_JWKS_URL);
  const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' &&
    (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (!jwk) throw new Error('INVALID_TOKEN');

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
  } catch {
    throw new Error('INVALID_TOKEN');
  }

  const signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    signingInput
  );
  if (!valid) throw new Error('INVALID_TOKEN');

  return { issuer: claims.iss, subject: claims.sub };
}

/**
 * Authenticate a request and prove the identity has an active membership
 * in the requested tenant. requestedTenantId must come from the route/resource
 * being accessed; authorization is always resolved against D1 on the server.
 *
 * Returns { ok: true, userId, tenantId, role } or { ok: false, status, error }.
 */
export async function authenticateZonarTenant(request, env, requestedTenantId) {
  if (!env.ZONAR_DB || typeof env.ZONAR_DB.prepare !== 'function') {
    return { ok: false, status: 503, error: 'TENANT_AUTH_NOT_CONFIGURED' };
  }
  if (!requestedTenantId || typeof requestedTenantId !== 'string' || requestedTenantId.length > 128) {
    return { ok: false, status: 400, error: 'INVALID_TENANT' };
  }

  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ') || authorization.length > MAX_BEARER_TOKEN_LENGTH + 7) {
    return { ok: false, status: 401, error: 'UNAUTHORISED' };
  }

  let identity;
  try {
    identity = await verifyZonarAccessToken(authorization.slice(7), env);
  } catch (error) {
    if (error.message === 'AUTH_CONFIGURATION_MISSING') {
      return { ok: false, status: 503, error: 'TENANT_AUTH_NOT_CONFIGURED' };
    }
    return { ok: false, status: 401, error: 'UNAUTHORISED' };
  }

  try {
    const membership = await env.ZONAR_DB.prepare(
      `SELECT u.id AS user_id, t.id AS tenant_id, t.status AS tenant_status, m.role AS role
       FROM users u
       INNER JOIN memberships m ON m.user_id = u.id
       INNER JOIN tenants t ON t.id = m.tenant_id
       WHERE u.identity_issuer = ?1
         AND u.identity_subject = ?2
         AND u.status = 'active'
         AND m.tenant_id = ?3
         AND m.status = 'active'
         AND t.status = 'active'
       LIMIT 1`
    ).bind(identity.issuer, identity.subject, requestedTenantId).first();

    if (!membership) return { ok: false, status: 403, error: 'TENANT_ACCESS_DENIED' };
    return {
      ok: true,
      userId: membership.user_id,
      tenantId: membership.tenant_id,
      role: membership.role
    };
  } catch {
    return { ok: false, status: 503, error: 'TENANT_AUTH_UNAVAILABLE' };
  }
}
