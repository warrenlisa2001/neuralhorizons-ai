import { authenticateZonarTenant } from './zonar-auth.js';
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

export async function handleZonarReconciliationFindings(request, env, tenantId, runId) {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!SAFE_ID.test(tenantId || '') || !SAFE_ID.test(runId || '')) return json({ error: 'INVALID_RESOURCE' }, 400);
  if (!env.ZONAR_DB?.prepare) return json({ error: 'FINDINGS_NOT_CONFIGURED' }, 503);
  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return json({ error: authentication.error }, authentication.status);
  const allowed = authorizeZonarAction(authentication, 'jobs:read');
  if (!allowed.ok) return json({ error: allowed.error }, allowed.status);
  const options = parseOptions(new URL(request.url).searchParams);
  if (options.error) return json({ error: options.error }, 400);
  try {
    const result = await queryZonarFindings(env.ZONAR_DB, { tenantId: allowed.tenantId, runId, ...options });
    return json(result.body, result.status);
  } catch {
    return json({ error: 'FINDINGS_READ_FAILED' }, 503);
  }
}
