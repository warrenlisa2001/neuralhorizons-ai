import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZonarCsv } from '../src/zonar-csv-ingestion.js';

test('parses quoted commas, escaped quotes, CRLF and embedded newlines', () => {
  const csv = 'Order Number,Ordered Quantity,Order Value,Note\r\nO-1,2,"1,250.50","box ""A"",\r\nfragile"\r\n';
  const result = parseZonarCsv(csv, { dataset: 'orders' });
  assert.equal(result.rows[0].order_id, 'O-1');
  assert.equal(result.rows[0].order_value, 1250.5);
  assert.equal(result.row_count, 1);
});

test('maps invoice and delivery references to canonical order IDs', () => {
  const invoice = parseZonarCsv('Invoice No,Sales Order,Invoiced Quantity,Invoice Amount\nI-1,O-1,3,45.00', { dataset: 'invoices' });
  const delivery = parseZonarCsv('Delivery No,Order Number,Delivered Quantity\nD-1,O-1,3', { dataset: 'deliveries' });
  assert.deepEqual(invoice.rows[0], { invoice_id: 'I-1', order_id: 'O-1', quantity_invoiced: 3, invoice_value: 45 });
  assert.deepEqual(delivery.rows[0], { delivery_id: 'D-1', order_id: 'O-1', quantity_delivered: 3 });
});

test('supports accounting negative numbers and blank numeric values', () => {
  const result = parseZonarCsv('order_id,quantity_ordered,order_value\nO-1,(2),', { dataset: 'orders' });
  assert.equal(result.rows[0].quantity_ordered, -2);
  assert.equal(result.rows[0].order_value, null);
});

test('rejects malformed quoting, duplicate headers and inconsistent row widths', () => {
  assert.throws(() => parseZonarCsv('order_id,quantity_ordered\nO-1,"2', { dataset: 'orders' }), e => e.code === 'INVALID_CSV');
  assert.throws(() => parseZonarCsv('order_id,Order ID\nO-1,O-1', { dataset: 'orders' }), e => e.code === 'DUPLICATE_HEADER');
  assert.throws(() => parseZonarCsv('order_id,quantity_ordered\nO-1,2,extra', { dataset: 'orders' }), e => e.code === 'MALFORMED_ROW');
});

test('rejects invalid numeric values and missing required columns', () => {
  assert.throws(() => parseZonarCsv('order_id,quantity_ordered\nO-1,many', { dataset: 'orders' }), e => e.code === 'INVALID_NUMERIC_VALUE' && e.row === 2);
  assert.throws(() => parseZonarCsv('invoice_id,quantity_invoiced\nI-1,1', { dataset: 'invoices' }), e => e.code === 'REQUIRED_COLUMN_MISSING' && e.field === 'order_id');
});

test('enforces row, column and byte limits', () => {
  assert.throws(() => parseZonarCsv('order_id,quantity_ordered\nO-1,1\nO-2,2', { dataset: 'orders', maxRows: 1 }), e => e.code === 'TOO_MANY_ROWS');
  assert.throws(() => parseZonarCsv('order_id,quantity_ordered,extra\nO-1,1,x', { dataset: 'orders', maxColumns: 2 }), e => e.code === 'TOO_MANY_COLUMNS');
  assert.throws(() => parseZonarCsv('order_id,quantity_ordered\nO-1,1', { dataset: 'orders', maxBytes: 5 }), e => e.code === 'UPLOAD_TOO_LARGE');
});
