// Provider-neutral OIDC/JWT authentication and tenant membership resolution.
// Configure ZONAR_ISSUER, ZONAR_AUDIENCE, ZONAR_JWKS_URL and ZONAR_DB
// before enabling customer routes. User and membership provisioning is explicit.
const MAX_BEARER_TOKEN_LENGTH = 8192;
const MAX_JWKS_BYTES = 64 * 1024;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const JWKS_UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30 * 1000;
let lastUnknownKidRefresh = { url: null, at: 0 };
let jwksCache = { url: null, expiresAt: 0, keys: null };

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('INVALID_BASE64URL');
  }
  const normal = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal + '='.repeat((4 - normal.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJsonPart(value) {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(value)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON_OBJECT');
  return parsed;
}

async function readBoundedJwks(response) {
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_JWKS_BYTES) {
    throw new Error('INVALID_JWKS');
  }
  if (!response.body) throw new Error('INVALID_JWKS');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new Error('INVALID_JWKS');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function validateJwks(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.keys) ||
      document.keys.length === 0 || document.keys.length > 50) {
    throw new Error('INVALID_JWKS');
  }
  const usable = document.keys.filter(key =>
    key && typeof key === 'object' && !Array.isArray(key) &&
    key.kty === 'RSA' && typeof key.kid === 'string' && key.kid.length > 0 && key.kid.length <= 256 &&
    typeof key.n === 'string' && key.n.length > 0 &&
    typeof key.e === 'string' && key.e.length > 0 &&
    (!key.use || key.use === 'sig') &&
    (!key.alg || key.alg === 'RS256') &&
    (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))));
  if (!usable.length) throw new Error('INVALID_JWKS');
  const kids = usable.map(key => key.kid);
  if (new Set(kids).size !== kids.length) throw new Error('INVALID_JWKS');
  // A public JWKS must not publish private RSA parameters.
  if (usable.some(key => ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(field => field in key))) {
    throw new Error('INVALID_JWKS');
  }
  return usable;
}

async function loadJwks(url, forceRefresh = false) {
  if (!forceRefresh && jwksCache.url === url && jwksCache.expiresAt > Date.now() && jwksCache.keys) {
    return jwksCache.keys;
  }
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error'
  });
  if (!response.ok) throw new Error('JWKS_UNAVAILABLE');
  const document = await readBoundedJwks(response);
  const keys = validateJwks(document);
  jwksCache = { url, expiresAt: Date.now() + JWKS_CACHE_TTL_MS, keys };
  return keys;
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
  if (jwksUrl.protocol !== 'https:' || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
    throw new Error('AUTH_CONFIGURATION_MISSING');
  }

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

  // Only understood JOSE header parameters are accepted; critical extensions are unsupported.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 ||
      (header.typ !== undefined && header.typ !== 'JWT') ||
      Object.keys(header).some(key => !['alg', 'kid', 'typ'].includes(key))) {
    throw new Error('INVALID_TOKEN');
  }

  const now = Math.floor(Date.now() / 1000);
  const audienceValid = claims.aud === env.ZONAR_AUDIENCE ||
    (Array.isArray(claims.aud) && claims.aud.includes(env.ZONAR_AUDIENCE));
  if (!env.ZONAR_REQUIRED_SCOPE || typeof env.ZONAR_REQUIRED_SCOPE !== 'string') {
    throw new Error('AUTH_CONFIGURATION_MISSING');
  }
  const delegatedScopes = typeof claims.scp === 'string' ? claims.scp.split(/\\s+/) : [];
  if (!delegatedScopes.includes(env.ZONAR_REQUIRED_SCOPE) ||
      claims.iss !== env.ZONAR_ISSUER || !audienceValid ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512 ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now))) {
    throw new Error('INVALID_TOKEN');
  }

  const hadFreshCache = jwksCache.url === env.ZONAR_JWKS_URL &&
    jwksCache.expiresAt > Date.now() && Array.isArray(jwksCache.keys);
  let keys = await loadJwks(env.ZONAR_JWKS_URL);
  let jwk = keys.find(key => key.kid === header.kid);
  // Refresh only when a previously cached set lacks the kid. Cool down forced
  // refreshes so attacker-chosen kids cannot turn every request into a fetch.
  if (!jwk && hadFreshCache &&
      (lastUnknownKidRefresh.url !== env.ZONAR_JWKS_URL ||
       Date.now() - lastUnknownKidRefresh.at >= JWKS_UNKNOWN_KID_REFRESH_COOLDOWN_MS)) {
    lastUnknownKidRefresh = { url: env.ZONAR_JWKS_URL, at: Date.now() };
    keys = await loadJwks(env.ZONAR_JWKS_URL, true);
    jwk = keys.find(key => key.kid === header.kid);
  }
  if (!jwk) throw new Error('INVALID_TOKEN');

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
  } catch {
    throw new Error('INVALID_TOKEN');
  }

  const signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signingInput);
  if (!valid) throw new Error('INVALID_TOKEN');
  return { issuer: claims.iss, subject: claims.sub };
}

/**
 * Authenticate a delegated ZONAR API token without assuming a customer tenant.
 * The API scope is mandatory; an ID token or unrelated access token is rejected.
 */
export async function authenticateZonarIdentity(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.match(/^Bearer ([^\\s]+)$/i);
  if (!bearer || authorization.length > MAX_BEARER_TOKEN_LENGTH + 7) {
    return { ok: false, status: 401, error: 'UNAUTHORISED' };
  }
  try {
    const identity = await verifyZonarAccessToken(bearer[1], env);
    return { ok: true, identity };
  } catch (error) {
    if (error.message === 'AUTH_CONFIGURATION_MISSING') {
      return { ok: false, status: 503, error: 'TENANT_AUTH_NOT_CONFIGURED' };
    }
    return { ok: false, status: 401, error: 'UNAUTHORISED' };
  }
}

/**
 * Prove the verified identity has active membership in the requested tenant.
 * requestedTenantId must come from trusted route/resource context.
 */
export async function authenticateZonarTenant(request, env, requestedTenantId) {
  if (!env.ZONAR_DB || typeof env.ZONAR_DB.prepare !== 'function') {
    return { ok: false, status: 503, error: 'TENANT_AUTH_NOT_CONFIGURED' };
  }
  if (typeof requestedTenantId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestedTenantId)) {
    return { ok: false, status: 400, error: 'INVALID_TENANT' };
  }

  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!bearer || authorization.length > MAX_BEARER_TOKEN_LENGTH + 7) {
    return { ok: false, status: 401, error: 'UNAUTHORISED' };
  }

  let identity;
  try {
    identity = await verifyZonarAccessToken(bearer[1], env);
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
    return { ok: true, userId: membership.user_id, tenantId: membership.tenant_id, role: membership.role };
  } catch {
    return { ok: false, status: 503, error: 'TENANT_AUTH_UNAVAILABLE' };
  }
}
