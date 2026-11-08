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
