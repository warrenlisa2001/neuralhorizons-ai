// HALU read API for people (finance leads etc.). Authentication is delegated to ZONAR:
// the caller's own ZONAR access token is forwarded to ZONAR's /api/zonar/me, which
// verifies it and returns only the workspaces the person actively belongs to. HALU keeps
// no user table and no signing keys, so access can never outlive ZONAR membership.
//
//   GET /api/halu/workspaces
//   GET /api/halu/tenants/:tenant/briefings?limit=&cursor=
//   GET /api/halu/tenants/:tenant/briefings/:run
//   POST /api/halu/tenants/:tenant/ask   {question, run_id?}  (answers grounded in the stored briefing)
//   GET /api/halu/config                  (public sign-in settings for the page; no secrets)

import { askHalu, AskError } from './ask.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR = /^[0-9TZ:.\-]{0,40}\|[A-Za-z0-9_-]{1,128}$/;
const MAX_BEARER = 8192;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const ALL_ROLES = ['tenant_owner', 'tenant_admin', 'analyst', 'operator', 'viewer'];

function headers(env, extra = {}) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", Vary: 'Origin, Authorization', ...extra
  };
  return h;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  // Only the single configured origin is ever echoed; no wildcard.
  if (origin && env.HALU_ALLOWED_ORIGIN && origin === env.HALU_ALLOWED_ORIGIN) {
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600' };
  }
  return {};
}

const reply = (request, env, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: headers(env, corsHeaders(request, env)) });

function readerRoles(env) {
  const configured = String(env.HALU_READER_ROLES || '').split(',').map(r => r.trim()).filter(Boolean);
  const roles = configured.filter(r => ALL_ROLES.includes(r));
  return new Set(roles.length ? roles : ALL_ROLES);
}

/** Ask ZONAR who this token belongs to. Returns {ok, workspaces} or {ok:false,status,error}. */
async function resolveWorkspaces(request, env, fetchImpl) {
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!bearer || authorization.length > MAX_BEARER + 7) return { ok: false, status: 401, error: 'UNAUTHORISED' };
  let response;
  try {
    response = await fetchImpl(env.HALU_ZONAR_BASE_URL.replace(/\/+$/, '') + '/api/zonar/me', {
      headers: { Authorization: 'Bearer ' + bearer[1], Accept: 'application/json' }, redirect: 'manual'
    });
  } catch { return { ok: false, status: 503, error: 'IDENTITY_UNAVAILABLE' }; }
  if (response.status === 401 || response.status === 403) return { ok: false, status: 401, error: 'UNAUTHORISED' };
  if (!response.ok) return { ok: false, status: 503, error: 'IDENTITY_UNAVAILABLE' };
  let body;
  try { body = await response.json(); } catch { return { ok: false, status: 503, error: 'IDENTITY_UNAVAILABLE' }; }
  if (!body || body.authenticated !== true || !Array.isArray(body.workspaces)) return { ok: false, status: 503, error: 'IDENTITY_UNAVAILABLE' };
  const known = new Set(String(env.HALU_TENANTS || '').split(',').map(t => t.trim()).filter(Boolean));
  const roles = readerRoles(env);
  // Only workspaces HALU serves AND where the person's role may read.
  const workspaces = body.workspaces
    .filter(w => w && typeof w.id === 'string' && known.has(w.id) && roles.has(w.role))
    .map(w => ({ id: w.id, name: String(w.name ?? ''), role: w.role }));
  return { ok: true, workspaces };
}

function parse(text) { try { return JSON.parse(text); } catch { return null; } }

export async function handleHaluApi(request, env, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(env, corsHeaders(request, env)) });
  const askMatch = url.pathname.match(/^\/api\/halu\/tenants\/([^/]+)\/ask$/);
  if (request.method !== 'GET' && !(request.method === 'POST' && askMatch)) return reply(request, env, { error: 'METHOD_NOT_ALLOWED' }, 405);
  if (url.pathname === '/api/halu/config') {
    // Public values only. The SPA client id and scopes are not secrets.
    return reply(request, env, {
      sign_in: env.HALU_SPA_CLIENT_ID && env.HALU_ENTRA_TENANT_ID && env.HALU_USER_SCOPE && !String(env.HALU_SPA_CLIENT_ID).includes('REPLACE_WITH')
        ? { authority_tenant: env.HALU_ENTRA_TENANT_ID, client_id: env.HALU_SPA_CLIENT_ID, scope: env.HALU_USER_SCOPE } : null,
      ask_enabled: Boolean(env.HALU_ANTHROPIC_API_KEY)
    });
  }
  if (!env.HALU_DB?.prepare || !env.HALU_ZONAR_BASE_URL) return reply(request, env, { error: 'HALU_NOT_CONFIGURED' }, 503);

  const workspacesMatch = url.pathname === '/api/halu/workspaces';
  const listMatch = url.pathname.match(/^\/api\/halu\/tenants\/([^/]+)\/briefings$/);
  const itemMatch = url.pathname.match(/^\/api\/halu\/tenants\/([^/]+)\/briefings\/([^/]+)$/);
  if (!workspacesMatch && !listMatch && !itemMatch && !askMatch) return reply(request, env, { error: 'NOT_FOUND' }, 404);

  let tenantId = null; let runId = null;
  try {
    if (listMatch) tenantId = decodeURIComponent(listMatch[1]);
    if (askMatch) tenantId = decodeURIComponent(askMatch[1]);
    if (itemMatch) { tenantId = decodeURIComponent(itemMatch[1]); runId = decodeURIComponent(itemMatch[2]); }
  } catch { return reply(request, env, { error: 'INVALID_RESOURCE' }, 400); }
  if (tenantId !== null && !SAFE_ID.test(tenantId)) return reply(request, env, { error: 'INVALID_RESOURCE' }, 400);
  if (runId !== null && !SAFE_ID.test(runId)) return reply(request, env, { error: 'INVALID_RESOURCE' }, 400);

  const who = await resolveWorkspaces(request, env, fetchImpl);
  if (!who.ok) return reply(request, env, { error: who.error }, who.status);
  if (workspacesMatch) return reply(request, env, { workspaces: who.workspaces });
  if (!who.workspaces.some(w => w.id === tenantId)) return reply(request, env, { error: 'TENANT_ACCESS_DENIED' }, 403);

  if (askMatch) {
    const raw = await request.text();
    if (raw.length > 4096) return reply(request, env, { error: 'INVALID_QUESTION' }, 400);
    const input = parse(raw);
    if (!input || typeof input !== 'object') return reply(request, env, { error: 'INVALID_QUESTION' }, 400);
    if (input.run_id !== undefined && input.run_id !== null && (typeof input.run_id !== 'string' || !SAFE_ID.test(input.run_id))) return reply(request, env, { error: 'INVALID_RESOURCE' }, 400);
    try {
      return reply(request, env, await askHalu({ env, tenantId, runId: input.run_id ?? null, question: input.question, fetchImpl }));
    } catch (error) {
      if (error instanceof AskError) return reply(request, env, { error: error.code }, error.status);
      return reply(request, env, { error: 'ASK_UNAVAILABLE' }, 502);
    }
  }

  try {
    if (itemMatch) {
      const row = await env.HALU_DB.prepare(
        'SELECT run_id, completed_at, briefing_json, finance_json FROM halu_briefings WHERE tenant_id=?1 AND run_id=?2 LIMIT 1'
      ).bind(tenantId, runId).first();
      if (!row) return reply(request, env, { error: 'BRIEFING_NOT_FOUND' }, 404);
      return reply(request, env, { tenant_id: tenantId, run_id: row.run_id, completed_at: row.completed_at,
        briefing: parse(row.briefing_json), finance: parse(row.finance_json) });
    }
    const params = url.searchParams;
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) return reply(request, env, { error: 'INVALID_LIMIT' }, 400);
    const cursor = params.get('cursor');
    if (cursor !== null && !CURSOR.test(cursor)) return reply(request, env, { error: 'INVALID_CURSOR' }, 400);
    const [afterAt, afterRun] = cursor ? cursor.split('|') : [null, null];
    const capped = Math.min(limit, MAX_LIMIT);
    const rows = (await env.HALU_DB.prepare(
      `SELECT run_id, completed_at, briefing_json, finance_json FROM halu_briefings
       WHERE tenant_id=?1 AND (?2 IS NULL OR COALESCE(completed_at,'') < ?2 OR (COALESCE(completed_at,'') = ?2 AND run_id < ?3))
       ORDER BY COALESCE(completed_at,'') DESC, run_id DESC LIMIT ?4`
    ).bind(tenantId, afterAt, afterRun, capped + 1).all()).results || [];
    const page = rows.slice(0, capped);
    const last = page[page.length - 1];
    return reply(request, env, {
      briefings: page.map(r => {
        const briefing = parse(r.briefing_json) || {}; const finance = parse(r.finance_json) || {};
        return { run_id: r.run_id, completed_at: r.completed_at, headline: finance.headline ?? [],
          total_findings: briefing.total_findings ?? null, by_severity: briefing.by_severity ?? null };
      }),
      page: { limit: capped, next_cursor: rows.length > capped && last ? (last.completed_at ?? '') + '|' + last.run_id : null }
    });
  } catch {
    return reply(request, env, { error: 'BRIEFINGS_READ_FAILED' }, 503);
  }
}
