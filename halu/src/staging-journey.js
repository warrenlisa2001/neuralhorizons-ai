// Staging-only test journey: uploads three small SYNTHETIC CSVs to ZONAR for the signed-in user's
// workspace and queues one reconciliation run, so HALU has a verified run to brief.
// Switched on only by HALU_STAGING_TOOLS="true" together with the ZONAR service binding.
// The user's own token is forwarded, so ZONAR's normal tenant and role checks decide what is allowed.

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ROLES = new Set(['tenant_owner', 'tenant_admin', 'operator']);

// Planted problems (one each): O1003 invoice value differs, O1004 invoiced quantity differs,
// O1005 never invoiced or delivered, I2005 invoices an unknown order, I2006 appears twice.
export const SYNTHETIC_CSVS = Object.freeze({
  orders: [
    'order_id,quantity_ordered,order_value',
    'O1001,10,1000.00', 'O1002,5,500.00', 'O1003,8,800.00',
    'O1004,20,2000.00', 'O1005,3,300.00', 'O1006,12,1200.00', ''
  ].join('\n'),
  invoices: [
    'invoice_id,order_id,quantity_invoiced,invoice_value',
    'I2001,O1001,10,1000.00', 'I2002,O1002,5,500.00', 'I2003,O1003,8,820.00',
    'I2004,O1004,18,1800.00', 'I2005,O9999,4,400.00', 'I2006,O1006,12,1200.00',
    'I2006,O1006,12,1200.00', ''
  ].join('\n'),
  deliveries: [
    'delivery_id,order_id,quantity_delivered',
    'D3001,O1001,10', 'D3002,O1002,5', 'D3003,O1003,8', 'D3004,O1004,20', 'D3006,O1006,12', ''
  ].join('\n')
});

export function stagingToolsEnabled(env) {
  return env.HALU_STAGING_TOOLS === 'true' && Boolean(env.ZONAR) && typeof env.ZONAR.fetch === 'function';
}

const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const safeCode = v => (typeof v === 'string' && /^[A-Z0-9_]{1,60}$/.test(v) ? v : 'UNKNOWN');

async function zonar(env, path, init) {
  const base = String(env.HALU_ZONAR_BASE_URL).replace(/\/+$/, '');
  const res = await env.ZONAR.fetch(base + path, { ...init, redirect: 'manual' });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

export async function startStagingJourney({ env, bearer, tenantId, workspaces }) {
  const ws = workspaces.find(w => w.id === tenantId);
  if (!ws) return { status: 403, body: { error: 'TENANT_ACCESS_DENIED' } };
  if (!RUN_ROLES.has(ws.role)) return { status: 403, body: { error: 'PERMISSION_DENIED' } };
  const auth = { Authorization: 'Bearer ' + bearer };
  const ids = {};
  for (const dataset of ['orders', 'invoices', 'deliveries']) {
    const up = await zonar(env, '/api/zonar/tenants/' + encodeURIComponent(tenantId) + '/files', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'text/csv', 'X-Filename': 'synthetic-' + dataset + '.csv' },
      body: SYNTHETIC_CSVS[dataset]
    });
    if (up.status !== 201 || !up.body?.file?.id) {
      return { status: 502, body: { error: 'STAGING_UPLOAD_FAILED', detail: dataset + ' ' + up.status + ' ' + safeCode(up.body?.error) } };
    }
    ids[dataset] = up.body.file.id;
  }
  const job = await zonar(env, '/api/zonar/tenants/' + encodeURIComponent(tenantId) + '/reconciliation-jobs', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': hex() },
    body: JSON.stringify({ orders_file_id: ids.orders, invoices_file_id: ids.invoices, deliveries_file_id: ids.deliveries })
  });
  if (job.status !== 202 || !job.body?.run?.id) {
    return { status: 502, body: { error: 'STAGING_JOB_FAILED', detail: job.status + ' ' + safeCode(job.body?.error) } };
  }
  return { status: 202, body: { run_id: job.body.run.id, status: job.body.run.status } };
}

export async function stagingJourneyStatus({ env, bearer, tenantId, runId, workspaces }) {
  if (!SAFE_ID.test(runId) || !workspaces.some(w => w.id === tenantId)) return { status: 403, body: { error: 'TENANT_ACCESS_DENIED' } };
  const res = await zonar(env, '/api/zonar/tenants/' + encodeURIComponent(tenantId) + '/reconciliation-runs/' + encodeURIComponent(runId),
    { method: 'GET', headers: { Authorization: 'Bearer ' + bearer } });
  if (res.status !== 200 || !res.body?.run) return { status: 502, body: { error: 'STAGING_STATUS_FAILED', detail: String(res.status) } };
  const run = res.body.run;
  return { status: 200, body: { run_id: runId, status: String(run.status || 'unknown').slice(0, 20), error_code: run.error_code ? safeCode(run.error_code) : null,
    exception_count: Number.isInteger(run.summary?.exception_count) ? run.summary.exception_count : null } };
}
