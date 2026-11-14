// HALU scheduled Worker: on each cron tick, poll ZONAR for each configured tenant and
// deliver new verified runs. Its only HTTP surface is the authenticated read API (api.js).
//
// Env (vars): HALU_ZONAR_BASE_URL, HALU_ZONAR_SCOPE (e.g. api://<zonar-app-id>/.default),
//             HALU_ENTRA_TENANT_ID, HALU_CLIENT_ID, HALU_TENANTS (comma-separated ZONAR tenant ids),
//             HALU_WEBHOOK_URL (optional)
// Env (secret): HALU_CLIENT_SECRET
// Env (binding): HALU_DB (D1)

import { createEntraTokenProvider } from './entra-token.js';
import { createFindingsClient } from './zonar-findings-client.js';
import { createRunWatcher } from './run-watcher.js';
import { handleHaluApi } from './api.js';
import { createD1CursorStore, saveBriefing, markWebhookSent, webhookAlreadySent } from './d1-store.js';

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseTenants(value) {
  return String(value || '').split(',').map(t => t.trim()).filter(Boolean);
}

function configError(env) {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('HALU_') && typeof value === 'string' && value.includes('REPLACE_WITH')) return key;
  }
  for (const key of ['HALU_ZONAR_BASE_URL', 'HALU_ZONAR_SCOPE', 'HALU_ENTRA_TENANT_ID', 'HALU_CLIENT_ID', 'HALU_CLIENT_SECRET']) {
    if (!env[key]) return key;
  }
  if (!env.HALU_DB?.prepare) return 'HALU_DB';
  const tenants = parseTenants(env.HALU_TENANTS);
  if (!tenants.length || !tenants.every(t => TENANT_ID.test(t))) return 'HALU_TENANTS';
  try { if (new URL(env.HALU_ZONAR_BASE_URL).protocol !== 'https:') return 'HALU_ZONAR_BASE_URL'; } catch { return 'HALU_ZONAR_BASE_URL'; }
  if (env.HALU_WEBHOOK_URL) {
    try { if (new URL(env.HALU_WEBHOOK_URL).protocol !== 'https:') return 'HALU_WEBHOOK_URL'; } catch { return 'HALU_WEBHOOK_URL'; }
  }
  return null;
}

/** Summary only: headline and totals. Evidence and row-level detail stay in HALU's database. */
export function webhookSummary(payload) {
  return {
    idempotency_key: payload.idempotency_key, tenant_id: payload.tenant_id, run_id: payload.run_id,
    completed_at: payload.briefing.completed_at, total_findings: payload.briefing.total_findings,
    by_severity: payload.briefing.by_severity, headline: payload.finance.headline,
    over_invoiced: payload.finance.over_invoiced, under_invoiced: payload.finance.under_invoiced
  };
}

export async function runHaluPoll(env, { fetchImpl = fetch, log = () => {} } = {}) {
  const missing = configError(env);
  if (missing) { log({ level: 'error', event: 'halu.config_invalid', key: missing }); return { ok: false, error: 'CONFIG_INVALID:' + missing, tenants: [] }; }

  const getToken = createEntraTokenProvider({
    authorityTenantId: env.HALU_ENTRA_TENANT_ID, clientId: env.HALU_CLIENT_ID,
    clientSecret: env.HALU_CLIENT_SECRET, scope: env.HALU_ZONAR_SCOPE, fetchImpl
  });
  const results = [];
  // Tenants are independent: one tenant failing never blocks the others.
  for (const tenantId of parseTenants(env.HALU_TENANTS)) {
    try {
      const client = createFindingsClient({ baseUrl: env.HALU_ZONAR_BASE_URL, tenantId, getToken, fetchImpl });
      const watcher = createRunWatcher({
        client, tenantId, store: createD1CursorStore(env.HALU_DB, tenantId),
        onSkip: s => log({ level: 'warn', event: 'halu.run_skipped', tenant_id: tenantId, ...s }),
        deliver: async payload => {
          await saveBriefing(env.HALU_DB, payload);
          if (env.HALU_WEBHOOK_URL && !(await webhookAlreadySent(env.HALU_DB, payload.idempotency_key))) {
            const response = await fetchImpl(env.HALU_WEBHOOK_URL, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(webhookSummary(payload)), redirect: 'error'
            });
            if (!response.ok) throw new Error('WEBHOOK_FAILED:' + response.status);
            await markWebhookSent(env.HALU_DB, payload.idempotency_key);
          }
        }
      });
      const out = await watcher.pollOnce();
      results.push({ tenant_id: tenantId, ok: true, delivered: out.delivered.length, skipped: out.skipped.length });
    } catch (error) {
      // Log the code only: never the message, which could echo upstream bodies.
      log({ level: 'error', event: 'halu.tenant_poll_failed', tenant_id: tenantId, code: error.code || String(error.message).split(':')[0] });
      results.push({ tenant_id: tenantId, ok: false, error: error.code || String(error.message).split(':')[0] });
    }
  }
  return { ok: results.every(r => r.ok), tenants: results };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runHaluPoll(env, { log: entry => console.log(JSON.stringify(entry)) }));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/halu/')) return handleHaluApi(request, env);
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
};
