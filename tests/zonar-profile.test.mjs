import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const workerModule = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const worker = workerModule.default;
const TOKEN = 'local-test-token';

function send(body, {
  method = 'POST',
  token = TOKEN,
  contentType = 'text/csv',
  extraHeaders = {},
  env = { ZONAR_UPLOAD_TOKEN: TOKEN }
} = {}) {
  const headers = { 'Content-Type': contentType, ...extraHeaders };
  if (token) headers.Authorization = 'Bearer ' + token;
  return worker.fetch(new Request('https://example.test/api/zonar/profile', {
    method,
    headers,
    body: method === 'GET' ? undefined : body
  }), env, {});
}

test('rejects requests without the configured token and exposes no diagnostics', async () => {
  const response = await send('order_id,quantity_ordered\nA1,2', { token: null });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'UNAUTHORISED');
  assert.equal(body.diagnostic, undefined);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test('rejects incorrect tokens without revealing token details', async () => {
  const response = await send('order_id,quantity_ordered\nA1,2', { token: 'incorrect-test-token' });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'UNAUTHORISED');
  assert.equal(body.diagnostic, undefined);
  assert.equal(JSON.stringify(body).includes('length'), false);
});

test('profiles CSV headers, rows, mappings and preview', async () => {
  const response = await send('Order Number,Customer ID,SKU,Quantity Ordered\nA-1,C-1,SKU-1,4\nA-2,C-2,SKU-2,7');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.profile.row_count, 2);
  assert.equal(result.profile.column_count, 4);
  assert.equal(result.profile.mappings.order_id, 'Order Number');
  assert.equal(result.profile.mappings.customer_id, 'Customer ID');
  assert.equal(result.profile.mappings.sku, 'SKU');
  assert.equal(result.profile.mappings.quantity_ordered, 'Quantity Ordered');
  assert.equal(result.profile.validation.status, 'passed');
  assert.equal(result.profile.preview.length, 2);
  assert.equal(result.storage, 'not_stored');
});

test('flags duplicate headers and rows with inconsistent column counts', async () => {
  const response = await send('Order ID,Order ID,SKU\nA-1,A-1,SKU-1\nA-2,SKU-2');
  const result = await response.json();
  assert.equal(result.profile.validation.status, 'review_required');
  assert.deepEqual(result.profile.validation.duplicate_headers, ['order_id']);
  assert.equal(result.profile.validation.malformed_row_count, 1);
});

test('supports quoted commas and escaped quotes', async () => {
  const response = await send('Order ID,Description\nA-1,"Large, blue ""special"" item"');
  const result = await response.json();
  assert.equal(result.profile.preview[0].Description, 'Large, blue "special" item');
});

test('rejects unclosed quoted fields', async () => {
  const response = await send('Order ID,Description\nA-1,"not closed');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_CSV');
});

test('rejects non-POST methods', async () => {
  const response = await send('', { method: 'GET' });
  assert.equal(response.status, 405);
});

test('rejects unsupported media types', async () => {
  const response = await send('a,b\n1,2', { contentType: 'application/json' });
  assert.equal(response.status, 415);
});


test('sets defensive security headers on API responses', async () => {
  const response = await send('order_id,quantity_ordered\\nA1,2');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get('Permissions-Policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('rejects an oversized declared request body before reading it', async () => {
  const response = await send('small body', {
    extraHeaders: { 'Content-Length': String(2 * 1024 * 1024 + 1) }
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'UPLOAD_TOO_LARGE');
});

test('rejects invalid UTF-8 input', async () => {
  const response = await send(new Uint8Array([0x6f, 0x72, 0x64, 0x65, 0x72, 0x5f, 0x69, 0x64, 0x2c, 0x78, 0x0a, 0xff]));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_ENCODING');
});

test('fails closed when the upload secret is not configured', async () => {
  const response = await send('order_id,quantity_ordered\\nA1,2', { env: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'AUTH_CONFIGURATION_MISSING');
});
