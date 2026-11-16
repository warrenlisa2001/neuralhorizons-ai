// Polls ZONAR for newly verified runs and hands each one to a delivery function.
// Delivery is AT LEAST ONCE: the cursor advances only after a run has been delivered, so
// a crash re-delivers the last run. Consumers must treat idempotency_key as the identity.

import { ZonarFeedError } from './zonar-findings-client.js';
import { buildBriefing } from './briefing.js';
import { buildFinanceView } from './views/finance.js';

// A run that can never be read (for example it stopped being verifiable) must not block
// every later run. Anything else is treated as transient and stops the poll.
const SKIPPABLE = new Set(['RUN_NOT_FOUND', 'RUN_NOT_COMPLETE', 'RUN_NOT_VERIFIED', 'FINDINGS_UNAVAILABLE_FOR_PROCESSOR']);

export function createRunWatcher({ client, tenantId, store, deliver, onSkip = () => {}, pageSize = 50 }) {
  if (!client || !tenantId || !store || typeof deliver !== 'function') throw new Error('WATCHER_CONFIG_INCOMPLETE');

  async function processRun(run) {
    const { run: runMeta, findings } = await client.collectFindings(run.id);
    await deliver({
      idempotency_key: `${tenantId}:${run.id}`,
      tenant_id: tenantId,
      run_id: run.id,
      briefing: buildBriefing({ run: runMeta, findings }),
      finance: buildFinanceView({ run: runMeta, findings })
    });
  }

  return {
    /** Process everything new. Returns { delivered, skipped }. Throws on a transient failure after saving progress. */
    async pollOnce() {
      let cursor = await store.get();
      const result = { delivered: [], skipped: [] };
      for (;;) {
        const page = await client.listVerifiedRuns({ cursor, limit: pageSize });
        for (const run of page.runs) {
          try {
            await processRun(run);
            result.delivered.push(run.id);
          } catch (error) {
            if (!(error instanceof ZonarFeedError) || !SKIPPABLE.has(error.code)) throw error;
            result.skipped.push({ run_id: run.id, code: error.code });
            onSkip({ run_id: run.id, code: error.code });
          }
          cursor = run.completed_at + '|' + run.id;
          await store.set(cursor);
        }
        if (!page.hasMore) return result;
      }
    }
  };
}

export function createMemoryCursorStore(initial = null) {
  let value = initial;
  return { async get() { return value; }, async set(next) { value = next; } };
}
