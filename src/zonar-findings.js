import { authenticateZonarService, authenticateZonarTenant, peekZonarTokenKind } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';
import { zonarCompletionAuditId } from './zonar-staged-run-processor.js';

/**
 * HALU-facing findings feed (v1).
 *
 * Contract: only COMPLETED, VERIFIED runs expose findings. "Verified" means the run
 * is 'succeeded' AND its mandatory completion audit event exists. Every finding
 * carries a source reference (file id, dataset, CSV row number, record/order ids)
 * so it can be traced back to the original record. Tenant scope is resolved
 * server-side from authentication, never from the request body.
 */
export const ZONAR_FINDINGS_SCHEMA_VERSION = 'zonar.findings.v1';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEVERITIES = new Set(['high', 'medium', 'low']);
const DATASETS = new Set(['orders', 'invoices', 'deliveries']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  }});
}

function parseOptions(searchParams) {
  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return { error: 'INVALID_LIMIT' };
  const rawCursor = searchParams.get('cursor');
  const cursor = rawCursor === null ? 0 : Number(rawCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || (rawCursor !== null && !/^\d+$/.test(rawCursor))) {
    return { error: 'INVALID_CURSOR' };
  }
  const severity = searchParams.get('severity');
  if (severity !== null && !SEVERITIES.has(severity)) return { error: 'INVALID_SEVERITY_FILTER' };
  const dataset = searchParams.get('dataset');
  if (dataset !== null && !DATASETS.has(dataset)) return { error: 'INVALID_DATASET_FILTER' };
  return { limit: Math.min(limit, MAX_LIMIT), cursor, severity, dataset };
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Pure, tenant-scoped query. Returns {status, body} so it can be tested without HTTP. */
export async function queryZonarFindings(db, { tenantId, runId, limit, cursor = 0, severity = null, dataset = null }) {
  const run = await db.prepare(
    `SELECT id, status, processor_version, summary_json, completed_at,
            result_object_key, orders_file_id, invoices_file_id, deliveries_file_id
     FROM reconciliation_runs WHERE tenant_id=?1 AND id=?2 LIMIT 1`
  ).bind(tenantId, runId).first();
  if (!run) return { status: 404, body: { error: 'RUN_NOT_FOUND' } };
  if (run.status !== 'succeeded') {
    return { status: 409, body: { error: 'RUN_NOT_COMPLETE', run: { id: run.id, status: run.status } } };
  }
  if (run.result_object_key) {
    // Legacy runs keep findings in an R2 blob; this feed only serves staged runs.
    return { status: 409, body: { error: 'FINDINGS_UNAVAILABLE_FOR_PROCESSOR', processor_version: run.processor_version } };
  }
  const audit = await db.prepare(
    'SELECT 1 AS present FROM audit_events WHERE tenant_id=?1 AND id=?2 LIMIT 1'
  ).bind(tenantId, zonarCompletionAuditId(run.id)).first();
  if (!audit) return { status: 409, body: { error: 'RUN_NOT_VERIFIED' } };

  const rows = (await db.prepare(
    `SELECT e.id, e.code, e.severity, e.dataset, e.source_row_number, e.record_id, e.order_id,
            e.expected_value, e.actual_value, e.details_json, p.source_file_id
     FROM reconciliation_exceptions e
     LEFT JOIN reconciliation_dataset_progress p
       ON p.tenant_id=e.tenant_id AND p.run_id=e.run_id AND p.dataset=e.dataset
     WHERE e.tenant_id=?1 AND e.run_id=?2 AND e.id>?3
       AND (?4 IS NULL OR e.severity=?4) AND (?5 IS NULL OR e.dataset=?5)
     ORDER BY e.id LIMIT ?6`
  ).bind(tenantId, runId, cursor, severity, dataset, limit + 1).all()).results || [];

  const page = rows.slice(0, limit);
  return { status: 200, body: {
    schema_version: ZONAR_FINDINGS_SCHEMA_VERSION,
    run: {
      id: run.id, status: run.status, processor_version: run.processor_version,
      completed_at: run.completed_at, summary: safeJson(run.summary_json),
      source_files: {
        orders: run.orders_file_id, invoices: run.invoices_file_id, deliveries: run.deliveries_file_id
      }
    },
    findings: page.map(row => ({
      id: String(row.id), code: row.code, severity: row.severity,
      source: {
        file_id: row.source_file_id || null, dataset: row.dataset,
        row_number: row.source_row_number, record_id: row.record_id, order_id: row.order_id
      },
      expected: row.expected_value, actual: row.actual_value,
      details: safeJson(row.details_json)
    })),
    page: { limit, next_cursor: rows.length > limit ? String(page[page.length - 1].id) : null }
  } };
}

/**
 * Shared caller check for the HALU-facing feeds. Two caller kinds, one policy: a
 * signed-in tenant user (jobs:read) or an app-only service principal (registry-granted
 * findings:read). The kind is only a routing hint from unverified claims; each path
 * verifies the token in full.
 */
async function authorizeFeedRead(request, env, tenantId) {
  if (peekZonarTokenKind(request) === 'service') {
    const service = await authenticateZonarService(request, env, tenantId);
    if (!service.ok) return { ok: false, error: service.error, status: service.status };
    if (!service.scopes.includes('findings:read')) return { ok: false, error: 'PERMISSION_DENIED', status: 403 };
    return { ok: true, tenantId: service.tenantId, service };
  }
  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return { ok: false, error: authentication.error, status: authentication.status };
  const allowed = authorizeZonarAction(authentication, 'jobs:read');
  if (!allowed.ok) return { ok: false, error: allowed.error, status: allowed.status };
  return { ok: true, tenantId: allowed.tenantId, service: null };
}

/** Machine access to tenant data is audited before any data is returned (fail closed). */
async function auditServiceRead(env, caller, eventType, resourceType, resourceId, details) {
  await env.ZONAR_DB.prepare(
    `INSERT INTO audit_events (id, tenant_id, actor_user_id, event_type, resource_type, resource_id, outcome, details_json)
     VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'success', ?6)`
  ).bind('fr_' + crypto.randomUUID(), caller.tenantId, eventType, resourceType, resourceId, JSON.stringify({
    actor: 'service_principal', service_principal_id: caller.service.servicePrincipalId,
    app_id: caller.service.appId, ...details
  })).run();
}

export async function handleZonarReconciliationFindings(request, env, tenantId, runId) {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!SAFE_ID.test(tenantId || '') || !SAFE_ID.test(runId || '')) return json({ error: 'INVALID_RESOURCE' }, 400);
  if (!env.ZONAR_DB?.prepare) return json({ error: 'FINDINGS_NOT_CONFIGURED' }, 503);
  const caller = await authorizeFeedRead(request, env, tenantId);
  if (!caller.ok) return json({ error: caller.error }, caller.status);
  const options = parseOptions(new URL(request.url).searchParams);
  if (options.error) return json({ error: options.error }, 400);
  if (caller.service) {
    try {
      await auditServiceRead(env, caller, 'findings.read', 'reconciliation_run', runId,
        { cursor: options.cursor, limit: options.limit });
    } catch { return json({ error: 'AUDIT_UNAVAILABLE' }, 503); }
  }
  try {
    const result = await queryZonarFindings(env.ZONAR_DB, { tenantId: caller.tenantId, runId, ...options });
    return json(result.body, result.status);
  } catch {
    return json({ error: 'FINDINGS_READ_FAILED' }, 503);
  }
}

/**
 * Verified-runs feed: completed, verified, staged runs in a stable order so a poller
 * can resume from an opaque cursor. Only runs whose findings the feed will serve are
 * listed (succeeded + completion audit + no legacy R2 result).
 */
const RUN_CURSOR = /^[0-9TZ:.\-]{1,40}\|[A-Za-z0-9_-]{1,128}$/;

export async function queryZonarVerifiedRuns(db, { tenantId, limit, cursor = null }) {
  let afterAt = '';
  let afterId = '';
  if (cursor !== null) {
    if (!RUN_CURSOR.test(cursor)) return { status: 400, body: { error: 'INVALID_CURSOR' } };
    [afterAt, afterId] = cursor.split('|');
  }
  const rows = (await db.prepare(
    `SELECT r.id, r.completed_at, r.processor_version
     FROM reconciliation_runs r
     WHERE r.tenant_id=?1 AND r.status='succeeded' AND r.result_object_key IS NULL
       AND r.completed_at IS NOT NULL
       AND (r.completed_at > ?2 OR (r.completed_at = ?2 AND r.id > ?3))
       AND EXISTS (SELECT 1 FROM audit_events a WHERE a.tenant_id=r.tenant_id AND a.id = 'rc_' || r.id)
     ORDER BY r.completed_at, r.id LIMIT ?4`
  ).bind(tenantId, afterAt, afterId, limit + 1).all()).results || [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { status: 200, body: {
    schema_version: ZONAR_FINDINGS_SCHEMA_VERSION,
    runs: page.map(r => ({ id: r.id, completed_at: r.completed_at, processor_version: r.processor_version })),
    page: { limit, next_cursor: last ? last.completed_at + '|' + last.id : cursor, has_more: rows.length > limit }
  } };
}

export async function handleZonarVerifiedRuns(request, env, tenantId) {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!SAFE_ID.test(tenantId || '')) return json({ error: 'INVALID_RESOURCE' }, 400);
  if (!env.ZONAR_DB?.prepare) return json({ error: 'FINDINGS_NOT_CONFIGURED' }, 503);
  const caller = await authorizeFeedRead(request, env, tenantId);
  if (!caller.ok) return json({ error: caller.error }, caller.status);
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return json({ error: 'INVALID_LIMIT' }, 400);
  const cursor = params.get('cursor');
  const cappedLimit = Math.min(limit, MAX_LIMIT);
  if (caller.service) {
    try {
      await auditServiceRead(env, caller, 'verified_runs.read', 'tenant', caller.tenantId, { cursor, limit: cappedLimit });
    } catch { return json({ error: 'AUDIT_UNAVAILABLE' }, 503); }
  }
  try {
    const result = await queryZonarVerifiedRuns(env.ZONAR_DB, { tenantId: caller.tenantId, limit: cappedLimit, cursor });
    return json(result.body, result.status);
  } catch {
    return json({ error: 'FINDINGS_READ_FAILED' }, 503);
  }
}
