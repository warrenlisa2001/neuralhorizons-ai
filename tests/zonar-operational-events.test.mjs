import test from 'node:test';
import assert from 'node:assert/strict';
import { persistZonarOperationalEvents, handleZonarOperationalEvents } from '../src/zonar-operational-events.js';

test('event persistence stores tenant-scoped deterministic exception records in bounded batches', async () => {
  const batches = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { return { sql, values }; } };
    },
    async batch(items) {
      batches.push(items);
      return items.map(() => ({ meta: { changes: 1 } }));
    }
  };
  const result = await persistZonarOperationalEvents(db, {
    tenantId: 'tenant-a',
    runId: 'run-a',
    exceptions: Array.from({ length: 121 }, (_, i) => ({
      code: 'ORDER_NOT_DELIVERED', severity: 'medium', dataset: 'orders',
      row: i + 2, order_id: 'order-' + i, raw_row: { must_not_be_stored: true }
    }))
  });
  assert.deepEqual(result, { attempted: 121, inserted: 121 });
  assert.deepEqual(batches.map(batch => batch.length), [50, 50, 21]);
  assert.match(batches[0][0].sql, /INSERT OR IGNORE INTO operational_events/);
  assert.equal(batches[0][0].values[1], 'tenant-a');
  assert.equal(batches[0][0].values[2], 'run-a');
  assert.equal(batches[0][0].values[6], 'An order has no matching delivery');
  assert.equal(batches[0][0].values[7].includes('must_not_be_stored'), false);
});

test('event persistence rejects missing storage and unsafe tenant identifiers', async () => {
  await assert.rejects(() => persistZonarOperationalEvents({}, { tenantId: 'a', runId: 'b' }), /EVENT_STORAGE_NOT_CONFIGURED/);
  await assert.rejects(() => persistZonarOperationalEvents({
    prepare() {}, batch() {}
  }, { tenantId: 'bad/tenant', runId: 'run-a' }), /INVALID_EVENT_SOURCE/);
});

test('event feed fails closed when D1 is unavailable and rejects malformed identifiers', async () => {
  const unavailable = await handleZonarOperationalEvents(new Request('https://example.test'), {}, 'tenant-a');
  assert.equal(unavailable.status, 503);
  const invalid = await handleZonarOperationalEvents(new Request('https://example.test'), {}, 'bad/tenant');
  assert.equal(invalid.status, 400);
});

test('event feed requires tenant authentication before reading events', async () => {
  const env = { ZONAR_DB: { prepare() { throw new Error('must not query before auth'); } } };
  const response = await handleZonarOperationalEvents(
    new Request('https://example.test/api/zonar/tenants/tenant-a/operational-events'),
    env, 'tenant-a'
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'UNAUTHORISED');
});
