import test from 'node:test';
import assert from 'node:assert/strict';
import { handleZonarReconciliationRun } from '../src/zonar-reconciliation-runs.js';
import { handleZonarReconciliationResult } from '../src/zonar-reconciliation-results.js';

const request = (method = 'POST', body = null, headers = {}) => new Request(
  'https://example.test/api/zonar/tenants/acme/reconciliation-runs',
  { method, headers, body: body === null ? undefined : JSON.stringify(body) }
);

test('run endpoint rejects unsupported methods before touching bindings', async () => {
  const response = await handleZonarReconciliationRun(request('GET'), {}, 'acme');
  assert.equal(response.status, 405);
  assert.equal((await response.json()).error, 'METHOD_NOT_ALLOWED');
});

test('run endpoint rejects malformed tenant identifiers', async () => {
  const response = await handleZonarReconciliationRun(request(), {}, 'bad/tenant');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_TENANT');
});

test('run endpoint fails closed when D1 or R2 bindings are absent', async () => {
  const response = await handleZonarReconciliationRun(request(), {}, 'acme');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'PROCESSING_NOT_CONFIGURED');
});

test('run endpoint requires tenant authentication before accepting file identifiers', async () => {
  const env = { ZONAR_DB: { prepare() { throw new Error('must not query without bearer'); } }, ZONAR_FILES: { get() {}, put() {} } };
  const response = await handleZonarReconciliationRun(
    request('POST', { orders_file_id: 'a', invoices_file_id: 'b', deliveries_file_id: 'c' }),
    env, 'acme'
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'UNAUTHORISED');
});

test('result endpoint rejects unsupported methods and malformed identifiers', async () => {
  const methodResponse = await handleZonarReconciliationResult(
    request('POST'), {}, 'acme', 'run_123'
  );
  assert.equal(methodResponse.status, 405);
  const idResponse = await handleZonarReconciliationResult(
    request('GET'), {}, 'bad/tenant', 'run_123'
  );
  assert.equal(idResponse.status, 400);
  assert.equal((await idResponse.json()).error, 'INVALID_RESOURCE');
});

test('result endpoint fails closed when storage bindings are absent', async () => {
  const response = await handleZonarReconciliationResult(request('GET'), {}, 'acme', 'run_123');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'PROCESSING_NOT_CONFIGURED');
});

test('result endpoint requires tenant authentication before querying run metadata', async () => {
  const env = { ZONAR_DB: { prepare() { throw new Error('must not query without bearer'); } }, ZONAR_FILES: { get() {} } };
  const response = await handleZonarReconciliationResult(request('GET'), env, 'acme', 'run_123');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'UNAUTHORISED');
});
