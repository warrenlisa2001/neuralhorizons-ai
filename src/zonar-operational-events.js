import { authenticateZonarTenant } from './zonar-auth.js';
import { authorizeZonarAction } from './zonar-permissions.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY_BYTES = 1024;
const MAX_PAGE_SIZE = 100;
const EVENT_BATCH_SIZE = 50;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  }});
}

function safeDetails(exception) {
  const allowed = ['dataset', 'row', 'record_id', 'order_id', 'field', 'expected', 'actual'];
  return Object.fromEntries(allowed
    .filter(key => exception[key] !== undefined && exception[key] !== null)
    .map(key => [key, exception[key]]));
}

async function readBoundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_JSON');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('REQUEST_TOO_LARGE');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function eventSummary(exception) {
  const labels = {
    MISSING_RECORD_ID: 'A source record is missing its identifier',
    DUPLICATE_RECORD_ID: 'A source record has a duplicate identifier',
    INVOICE_MISSING_ORDER_REFERENCE: 'An invoice is missing its order reference',
    INVOICE_WITHOUT_ORDER: 'An invoice does not match an order',
    DELIVERY_MISSING_ORDER_REFERENCE: 'A delivery is missing its order reference',
    DELIVERY_WITHOUT_ORDER: 'A delivery does not match an order',
    ORDER_NOT_INVOICED: 'An order has no matching invoice',
    ORDER_NOT_DELIVERED: 'An order has no matching delivery',
    ORDER_INVOICE_QUANTITY_MISMATCH: 'Invoiced quantity differs from ordered quantity',
    ORDER_DELIVERY_QUANTITY_MISMATCH: 'Delivered quantity differs from ordered quantity',
    ORDER_INVOICE_VALUE_MISMATCH: 'Invoice value differs from order value'
  };
  return labels[exception.code] || 'A reconciliation exception requires review';
}

function stableSourceRef(exception) {
  const record = exception.record_id || exception.order_id || String(exception.row || 'unknown');
  return [exception.code || 'UNKNOWN', exception.dataset || 'unknown', record].join(':').slice(0, 240);
}

/**
 * Persist deterministic reconciliation exceptions as tenant-scoped operational events.
 * The unique source reference makes retries safe if a multi-batch write is interrupted.
 */
export async function persistZonarOperationalEvents(db, { tenantId, runId, exceptions = [] }) {
  if (!db?.prepare || typeof db.batch !== 'function') throw new Error('EVENT_STORAGE_NOT_CONFIGURED');
  if (!SAFE_ID.test(tenantId || '') || !SAFE_ID.test(runId || '')) throw new Error('INVALID_EVENT_SOURCE');
  const statements = exceptions.map(exception => {
    const sourceRef = stableSourceRef(exception);
    const details = JSON.stringify(safeDetails(exception));
    return db.prepare(
      `INSERT OR IGNORE INTO operational_events
        (id, tenant_id, source_kind, source_run_id, source_ref, event_code,
         severity, summary, details_json)
       VALUES (?1, ?2, 'reconciliation', ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      crypto.randomUUID().replace(/-/g, ''),
      tenantId,
      runId,
      sourceRef,
      String(exception.code || 'UNKNOWN').slice(0, 100),
      ['info', 'low', 'medium', 'high', 'critical'].includes(exception.severity) ? exception.severity : 'medium',
      eventSummary(exception),
      details
    );
  });

  let inserted = 0;
  for (let offset = 0; offset < statements.length; offset += EVENT_BATCH_SIZE) {
    const result = await db.batch(statements.slice(offset, offset + EVENT_BATCH_SIZE));
    for (const item of result || []) inserted += Number(item?.meta?.changes || 0);
  }
  return { attempted: statements.length, inserted };
}

/** Tenant-authenticated event feed and controlled acknowledgement lifecycle. */
export async function handleZonarOperationalEvents(request, env, tenantId, eventId = null) {
  if (!SAFE_ID.test(tenantId || '') || (eventId !== null && !SAFE_ID.test(eventId))) {
    return json({ error: 'INVALID_RESOURCE' }, 400);
  }
  if (!env.ZONAR_DB?.prepare) return json({ error: 'EVENT_STORAGE_NOT_CONFIGURED' }, 503);

  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) return json({ error: authentication.error }, authentication.status);

  if (request.method === 'GET' && eventId === null) {
    const allowed = authorizeZonarAction(authentication, 'events:read');
    if (!allowed.ok) return json({ error: allowed.error }, allowed.status);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_PAGE_SIZE, requestedLimit)) : 50;
    const status = url.searchParams.get('status');
    const severity = url.searchParams.get('severity');
    if (status && !['open', 'acknowledged', 'resolved', 'dismissed'].includes(status)) {
      return json({ error: 'INVALID_STATUS_FILTER' }, 400);
    }
    if (severity && !['info', 'low', 'medium', 'high', 'critical'].includes(severity)) {
      return json({ error: 'INVALID_SEVERITY_FILTER' }, 400);
    }
    const rows = await env.ZONAR_DB.prepare(
      `SELECT id, source_kind, source_run_id, source_ref, event_code, severity,
              status, summary, exposure_minor_units, currency_code, occurred_at,
              recorded_at, acknowledged_at, acknowledged_by_user_id,
              resolved_at, resolved_by_user_id, updated_at, details_json
       FROM operational_events
       WHERE tenant_id = ?1
         AND (?2 IS NULL OR status = ?2)
         AND (?3 IS NULL OR severity = ?3)
       ORDER BY recorded_at DESC, id DESC
       LIMIT ?4`
    ).bind(allowed.tenantId, status || null, severity || null, limit).all();
    return json({ success: true, events: rows.results || [], limit });
  }

  if (request.method === 'PATCH' && eventId) {
    const allowed = authorizeZonarAction(authentication, 'events:manage');
    if (!allowed.ok) return json({ error: allowed.error }, allowed.status);
    const declared = request.headers.get('Content-Length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
      return json({ error: 'REQUEST_TOO_LARGE' }, 413);
    }
    let body;
    try { body = await readBoundedJson(request); }
    catch (error) {
      return json({ error: error.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON' },
        error.message === 'REQUEST_TOO_LARGE' ? 413 : 400);
    }
    if (!body || Object.keys(body).length !== 1 ||
        !['acknowledged', 'resolved', 'dismissed'].includes(body.status)) {
      return json({ error: 'INVALID_EVENT_TRANSITION' }, 400);
    }
    const current = await env.ZONAR_DB.prepare(
      'SELECT status FROM operational_events WHERE tenant_id = ?1 AND id = ?2 LIMIT 1'
    ).bind(allowed.tenantId, eventId).first();
    if (!current) return json({ error: 'EVENT_NOT_FOUND' }, 404);

    let update;
    if (body.status === 'acknowledged' && current.status === 'open') {
      update = await env.ZONAR_DB.prepare(
        `UPDATE operational_events
         SET status = 'acknowledged', acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             acknowledged_by_user_id = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE tenant_id = ?2 AND id = ?3 AND status = 'open'`
      ).bind(allowed.userId, allowed.tenantId, eventId).run();
    } else if (['resolved', 'dismissed'].includes(body.status) && current.status === 'acknowledged') {
      update = await env.ZONAR_DB.prepare(
        `UPDATE operational_events
         SET status = ?1, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             resolved_by_user_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE tenant_id = ?3 AND id = ?4 AND status = 'acknowledged'`
      ).bind(body.status, allowed.userId, allowed.tenantId, eventId).run();
    } else {
      return json({ error: 'INVALID_EVENT_TRANSITION', current_status: current.status }, 409);
    }
    if (Number(update?.meta?.changes || 0) !== 1) return json({ error: 'EVENT_STATE_CONFLICT' }, 409);
    return json({ success: true, event_id: eventId, status: body.status });
  }

  return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
}
