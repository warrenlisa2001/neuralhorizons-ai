// Tenant-scoped append-only audit event access for Zonar.
// Caller must authenticate and authorize audit:read or the relevant write action.
// This module deliberately exposes no update/delete operation for audit rows.

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('D1 database binding is required');
}

function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid ' + name);
  }
  return value;
}

function optionalText(value, name, max = 128) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new TypeError('Invalid ' + name);
  }
  return value;
}

const ALLOWED_OUTCOMES = new Set(['success', 'denied', 'failure']);
const ALLOWED_DETAIL_KEYS = new Set([
  'action', 'reason_code', 'file_id', 'job_id', 'status',
  'role', 'permission', 'source', 'count', 'bytes'
]);

function serializeSafeDetails(details) {
  if (details == null) return null;
  if (!details || typeof details !== 'object' || Array.isArray(details) ||
      (Object.getPrototypeOf(details) !== Object.prototype && Object.getPrototypeOf(details) !== null)) {
    throw new TypeError('Audit details must be a plain object');
  }
  const keys = Object.keys(details);
  if (keys.length > 12) throw new TypeError('Too many audit detail fields');
  const safe = {};
  for (const key of keys) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) throw new TypeError('Unsupported audit detail field');
    const value = details[key];
    if ((key === 'count' || key === 'bytes') &&
        (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError('Invalid audit detail value');
    }
    if (value === null || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) {
      safe[key] = value;
    } else if (typeof value === 'string' && value.length <= 160) {
      safe[key] = value;
    } else {
      throw new TypeError('Invalid audit detail value');
    }
  }
  const serialized = JSON.stringify(safe);
  if (serialized.length > 2000) throw new TypeError('Audit details are too large');
  return serialized;
}

function assertSuccessful(result) {
  if (!result || result.success === false) throw new Error('D1 operation failed');
  return result;
}

/**
 * Append one tenant audit event. Tenant ID and actor ID must come from
 * authenticated server-side context. No client-supplied free-form payloads.
 */
export async function appendTenantAuditEvent(db, input) {
  requireDb(db);
  const id = requireId(input?.id, 'audit event ID');
  const tenantId = requireId(input?.tenantId, 'tenant ID');
  const actorUserId = input?.actorUserId == null
    ? null : requireId(input.actorUserId, 'actor user ID');
  const eventType = optionalText(input?.eventType, 'event type', 80);
  const resourceType = optionalText(input?.resourceType, 'resource type', 40);
  const resourceId = optionalText(input?.resourceId, 'resource ID', 128);
  const requestId = optionalText(input?.requestId, 'request ID', 128);
  if (!/^[a-z][a-z0-9_.-]*$/.test(eventType || '')) throw new TypeError('Invalid event type');
  if (!ALLOWED_OUTCOMES.has(input?.outcome)) throw new TypeError('Invalid audit outcome');
  const detailsJson = serializeSafeDetails(input?.details);

  const result = assertSuccessful(await db.prepare(
    `INSERT INTO audit_events
       (id, tenant_id, actor_user_id, event_type, resource_type,
        resource_id, request_id, outcome, details_json)
     SELECT ?1, t.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     FROM tenants t
     WHERE t.id = ?2 AND t.status = 'active'
       AND (?3 IS NULL OR EXISTS (
         SELECT 1 FROM users u
         INNER JOIN memberships m ON m.user_id = u.id
         WHERE u.id = ?3 AND u.status = 'active'
           AND m.tenant_id = t.id AND m.status = 'active'
       ))`
  ).bind(id, tenantId, actorUserId, eventType, resourceType,
    resourceId, requestId, input.outcome, detailsJson).run());

  return { created: Number(result.meta?.changes ?? 0) === 1 };
}

/**
 * Read audit history for one tenant only. Pagination is bounded and stable.
 * Details are returned as stored JSON; callers should expose only fields
 * appropriate to the requesting user's permission and UI.
 */
export async function listTenantAuditEvents(db, tenantId, options = {}) {
  requireDb(db);
  requireId(tenantId, 'tenant ID');
  const limit = options.limit === undefined ? 50 : options.limit;
  if (!Number.isInteger(limit)) throw new TypeError('Invalid limit');
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const hasCursor = options.beforeCreatedAt !== undefined || options.beforeId !== undefined;
  if (hasCursor && (typeof options.beforeCreatedAt !== 'string' || !options.beforeCreatedAt ||
      typeof options.beforeId !== 'string' || !options.beforeId)) {
    throw new TypeError('Both cursor fields are required');
  }

  let sql = `SELECT id, tenant_id, actor_user_id, event_type, resource_type,
                    resource_id, request_id, outcome, details_json, created_at
             FROM audit_events
             WHERE tenant_id = ?1`;
  const bindings = [tenantId];
  if (hasCursor) {
    sql += ' AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))';
    bindings.push(options.beforeCreatedAt, options.beforeId);
  }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ?${bindings.length + 1}`;
  bindings.push(boundedLimit);
  const result = assertSuccessful(await db.prepare(sql).bind(...bindings).all());
  return Array.isArray(result.results) ? result.results : [];
}
