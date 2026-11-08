import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleZonarAsyncReconciliationEnqueue,
  dispatchZonarReconciliationOutbox,
  processZonarReconciliationMessage,
  recoverZonarReconciliationLeases
} from '../src/zonar-async-reconciliation.js';

function request(method = 'POST', body = null) {
  return new Request('https://example.test/api/zonar/tenants/acme/reconciliation-jobs', {
    method,
    headers: body === null ? {} : { 'Content-Type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body)
  });
}

test('async enqueue rejects unsupported methods before accessing bindings', async () => {
  const response = await handleZonarAsyncReconciliationEnqueue(request('GET'), {}, 'acme');
  assert.equal(response.status, 405);
  assert.equal((await response.json()).error, 'METHOD_NOT_ALLOWED');
});

test('async enqueue fails closed when D1 batch support is absent', async () => {
  const response = await handleZonarAsyncReconciliationEnqueue(request(), {}, 'acme');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'ASYNC_PROCESSING_NOT_CONFIGURED');
});

test('async enqueue rejects malformed tenant identifiers before storage access', async () => {
  const response = await handleZonarAsyncReconciliationEnqueue(request(), {}, 'bad/tenant');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_TENANT');
});

test('outbox dispatcher safely remains idle until D1 and Queue bindings exist', async () => {
  assert.deepEqual(await dispatchZonarReconciliationOutbox({}), { dispatched: 0, deferred: 0 });
  assert.deepEqual(await dispatchZonarReconciliationOutbox({ ZONAR_DB: { prepare() {} } }), { dispatched: 0, deferred: 0 });
});

test('queue consumer acknowledges malformed messages without querying tenant data', async () => {
  let acknowledged = false;
  const result = await processZonarReconciliationMessage({
    body: { version: 1, run_id: '../other-tenant' },
    ack() { acknowledged = true; }
  }, {});
  assert.equal(acknowledged, true);
  assert.deepEqual(result, { acknowledged: true, reason: 'INVALID_MESSAGE' });
});

test('queue consumer retries when storage bindings are not configured', async () => {
  let delay;
  const result = await processZonarReconciliationMessage({
    body: { version: 1, run_id: 'run_123' },
    retry(options) { delay = options.delaySeconds; }
  }, {});
  assert.equal(delay, 60);
  assert.deepEqual(result, { acknowledged: false, reason: 'PROCESSING_NOT_CONFIGURED' });
});

test('lease recovery safely reports no work without a D1 binding', async () => {
  assert.deepEqual(await recoverZonarReconciliationLeases({}), { recovered: 0, failed: 0 });
});

test('outbox dispatcher publishes only a versioned run identifier', async () => {
  const sent = [];
  const db = {
    async batch(items) { return items.map(() => ({ success: true, meta: { changes: 1 } })); },
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            values,
            async run() { return { success: true, meta: { changes: 1 } }; },
            async all() { return { results: [{ id: 'outbox_1' }] }; },
            async first() {
              return { id: 'outbox_1', run_id: 'run_1', tenant_id: 'tenant_1', attempt_count: 1 };
            }
          };
        }
      };
    }
  };
  const result = await dispatchZonarReconciliationOutbox({
    ZONAR_DB: db,
    ZONAR_RECONCILIATION_QUEUE: { async send(message) { sent.push(message); } }
  });
  assert.deepEqual(result, { dispatched: 1, deferred: 0 });
  assert.deepEqual(sent, [{ version: 1, run_id: 'run_1' }]);
});

test('outbox dispatcher returns failed sends to pending with a safe error code', async () => {
  const statements = [];
  const db = {
    async batch(items) { return items.map(() => ({ success: true, meta: { changes: 1 } })); },
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            values,
            async run() { statements.push({ sql, values }); return { success: true, meta: { changes: 1 } }; },
            async all() { return { results: [{ id: 'outbox_2' }] }; },
            async first() {
              return { id: 'outbox_2', run_id: 'run_2', tenant_id: 'tenant_2', attempt_count: 2 };
            }
          };
        }
      };
    }
  };
  const result = await dispatchZonarReconciliationOutbox({
    ZONAR_DB: db,
    ZONAR_RECONCILIATION_QUEUE: { async send() { throw new Error('private provider error'); } }
  });
  assert.deepEqual(result, { dispatched: 0, deferred: 1 });
  assert.ok(statements.some(item => item.sql.includes("status='pending'") && item.sql.includes("QUEUE_SEND_FAILED")));
  assert.equal(statements.some(item => JSON.stringify(item).includes('private provider error')), false);
});

test('expired run recovery atomically resets the run and its outbox delivery', async () => {
  let batchStatements = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            sql, values,
            async all() { return { results: [{ id: 'run_3', tenant_id: 'tenant_3', attempt_count: 1, max_attempts: 5 }] }; },
            async run() { return { success: true, meta: { changes: 1 } }; }
          };
        }
      };
    },
    async batch(statements) { batchStatements = statements; return statements.map(() => ({ success: true, meta: { changes: 1 } })); }
  };
  const result = await recoverZonarReconciliationLeases({ ZONAR_DB: db }, new Date('2026-11-08T18:00:00.000Z'));
  assert.deepEqual(result, { recovered: 1, failed: 0 });
  assert.equal(batchStatements.length, 2);
  assert.ok(batchStatements[0].sql.includes("status='queued'"));
  assert.ok(batchStatements[1].sql.includes("status='pending'"));
});

test('async enqueue remains disabled until the feature flag and every runtime binding exist', async () => {
  const db = { prepare() {}, batch() {} };
  const response = await handleZonarAsyncReconciliationEnqueue(request(), {
    ZONAR_DB: db,
    ZONAR_FILES: { get() {}, put() {} },
    ZONAR_RECONCILIATION_QUEUE: { send() {} }
  }, 'acme');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'ASYNC_PROCESSING_NOT_CONFIGURED');

  const missingQueue = await handleZonarAsyncReconciliationEnqueue(request(), {
    ZONAR_ASYNC_ENABLED: 'true',
    ZONAR_DB: db,
    ZONAR_FILES: { get() {}, put() {} }
  }, 'acme');
  assert.equal(missingQueue.status, 503);
  assert.equal((await missingQueue.json()).error, 'ASYNC_PROCESSING_NOT_CONFIGURED');
});

test('outbox dispatch dead-letters after the configured maximum attempts', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            sql, values,
            async run() { statements.push({ sql, values }); return { success: true, meta: { changes: 1 } }; },
            async all() { return { results: [{ id: 'outbox_exhausted' }] }; },
            async first() {
              return {
                id: 'outbox_exhausted', run_id: 'run_exhausted',
                tenant_id: 'tenant_1', attempt_count: 10, max_dispatch_attempts: 10
              };
            }
          };
        }
      };
    },
    async batch(items) { return items.map(() => ({ success: true, meta: { changes: 1 } })); }
  };
  const result = await dispatchZonarReconciliationOutbox({
    ZONAR_DB: db,
    ZONAR_RECONCILIATION_QUEUE: { async send() { throw new Error('queue unavailable'); } }
  });
  assert.deepEqual(result, { dispatched: 0, deferred: 1 });
  const failedSend = statements.find(item => item.sql.includes('QUEUE_SEND_FAILED'));
  assert.ok(failedSend);
  assert.ok(failedSend.sql.includes("THEN 'dead_letter'"));
  assert.ok(failedSend.sql.includes('max_dispatch_attempts'));
});

test('outbox dispatch selects only pending jobs whose reconciliation run is queued', async () => {
  let candidateSql = '';
  const db = {
    prepare(sql) {
      return {
        sql,
        bind() {
          return {
            async run() { return { success: true, meta: { changes: 0 } }; },
            async all() { candidateSql = sql; return { results: [] }; }
          };
        }
      };
    },
    async batch(items) { return items.map(() => ({ success: true, meta: { changes: 0 } })); }
  };
  await dispatchZonarReconciliationOutbox({
    ZONAR_DB: db,
    ZONAR_RECONCILIATION_QUEUE: { async send() {} }
  });
  assert.ok(candidateSql.includes("r.status='queued'"));
  assert.ok(candidateSql.includes('o.attempt_count<o.max_dispatch_attempts'));
});
