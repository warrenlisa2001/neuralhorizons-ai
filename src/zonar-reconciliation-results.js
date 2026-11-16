import { authenticateZonarTenant } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  }});
}

/** Read a completed result only after tenant authentication and jobs:read. */
export async function handleZonarReconciliationResult(request, env, tenantId, runId) {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!SAFE_ID.test(tenantId || '') || !SAFE_ID.test(runId || '')) return json({ error: 'INVALID_RESOURCE' }, 400);
  if (!env.ZONAR_DB?.prepare || !env.ZONAR_FILES?.get) return json({ error: 'PROCESSING_NOT_CONFIGURED' }, 503);
  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return json({ error: authentication.error }, authentication.status);
  const allowed = authorizeZonarAction(authentication, 'jobs:read');
  if (!allowed.ok) return json({ error: allowed.error }, allowed.status);

  try {
    const run = await env.ZONAR_DB.prepare(
      `SELECT id, tenant_id, processor_version, status, result_object_key,
              result_sha256_hex, summary_json, error_code, created_at,
              started_at, completed_at
       FROM reconciliation_runs
       WHERE tenant_id = ?1 AND id = ?2 LIMIT 1`
    ).bind(allowed.tenantId, runId).first();
    if (!run) return json({ error: 'RUN_NOT_FOUND' }, 404);
    if (run.status !== 'succeeded') {
      return json({ run: { id: run.id, status: run.status, error_code: run.error_code || null } }, 200);
    }
    if (!run.result_object_key && !run.result_sha256_hex) {
      // Staged processor: findings live in D1 (order results, links, exceptions),
      // not in an R2 blob. Only the verified summary is returned here; the
      // paginated findings feed is a separate, versioned endpoint.
      let summary = null;
      try { summary = run.summary_json ? JSON.parse(run.summary_json) : null; }
      catch { return json({ error: 'RESULT_INVALID' }, 503); }
      return json({ success: true, run: {
        id: run.id, status: run.status, processor_version: run.processor_version,
        created_at: run.created_at, started_at: run.started_at, completed_at: run.completed_at,
        result_storage: 'd1', summary
      } }, 200);
    }
    if (!run.result_object_key || !run.result_sha256_hex) {
      return json({ error: 'RESULT_INVALID' }, 503);
    }
    const object = await env.ZONAR_FILES.get(run.result_object_key);
    if (!object) return json({ error: 'RESULT_UNAVAILABLE' }, 503);
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > MAX_RESULT_BYTES) return json({ error: 'RESULT_INVALID' }, 503);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== run.result_sha256_hex) return json({ error: 'RESULT_INTEGRITY_FAILED' }, 503);
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return json({ error: 'RESULT_INVALID' }, 503); }
    return json({ success: true, run: {
      id: run.id, status: run.status, processor_version: run.processor_version,
      created_at: run.created_at, started_at: run.started_at, completed_at: run.completed_at,
      result_sha256_hex: run.result_sha256_hex,
      summary: run.summary_json ? JSON.parse(run.summary_json) : null
    }, result });
  } catch {
    return json({ error: 'RESULT_READ_FAILED' }, 503);
  }
}
