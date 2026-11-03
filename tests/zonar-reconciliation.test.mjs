import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDatasets } from '../src/zonar-reconciliation.js';

test('links orders to multiple invoices and deliveries and reconciles quantities and value', () => {
  const result = reconcileDatasets({
    orders: [{ order_id: 'O-1', quantity_ordered: '10', order_value: '125.00' }],
    invoices: [
      { invoice_id: 'I-1', order_id: 'O-1', quantity_invoiced: '4', invoice_value: '50' },
      { invoice_id: 'I-2', order_id: 'O-1', quantity_invoiced: '6', invoice_value: '75' }
    ],
    deliveries: [
      { delivery_id: 'D-1', order_id: 'O-1', quantity_delivered: '7' },
      { delivery_id: 'D-2', order_id: 'O-1', quantity_delivered: '3' }
    ]
  });
  assert.equal(result.summary.linked_order_count, 1);
  assert.equal(result.summary.exception_count, 0);
  assert.deepEqual(result.reconciled[0].invoice_ids, ['I-1', 'I-2']);
  assert.equal(result.reconciled[0].quantity_invoiced, 10);
  assert.equal(result.reconciled[0].quantity_delivered, 10);
});

test('flags missing links, orphan references and quantity/value mismatches', () => {
  const result = reconcileDatasets({
    orders: [
      { order_id: 'O-1', quantity_ordered: '10', order_value: '100' },
      { order_id: 'O-2', quantity_ordered: '2', order_value: '20' }
    ],
    invoices: [
      { invoice_id: 'I-1', order_id: 'O-1', quantity_invoiced: '8', invoice_value: '90' },
      { invoice_id: 'I-X', order_id: 'UNKNOWN', quantity_invoiced: '1', invoice_value: '10' }
    ],
    deliveries: [{ delivery_id: 'D-1', order_id: 'O-1', quantity_delivered: '9' }]
  });
  const codes = result.exceptions.map(item => item.code);
  assert.ok(codes.includes('INVOICE_WITHOUT_ORDER'));
  assert.ok(codes.includes('ORDER_NOT_INVOICED'));
  assert.ok(codes.includes('ORDER_NOT_DELIVERED'));
  assert.ok(codes.includes('ORDER_INVOICE_QUANTITY_MISMATCH'));
  assert.ok(codes.includes('ORDER_DELIVERY_QUANTITY_MISMATCH'));
  assert.ok(codes.includes('ORDER_INVOICE_VALUE_MISMATCH'));
  assert.equal(result.summary.severity_counts.high, 4);
});

test('reports missing and duplicate identifiers without silently overwriting rows', () => {
  const result = reconcileDatasets({
    orders: [
      { order_id: 'O-1', quantity_ordered: '1' },
      { order_id: 'O-1', quantity_ordered: '2' },
      { quantity_ordered: '3' }
    ]
  });
  assert.equal(result.summary.order_count, 1);
  assert.ok(result.exceptions.some(item => item.code === 'DUPLICATE_RECORD_ID'));
  assert.ok(result.exceptions.some(item => item.code === 'MISSING_RECORD_ID'));
});

test('does not mutate caller-provided datasets', () => {
  const orders = [{ order_id: 'O-1', quantity_ordered: '1' }];
  const before = structuredClone(orders);
  reconcileDatasets({ orders });
  assert.deepEqual(orders, before);
});

test('handles blank numeric fields as unknown rather than zero', () => {
  const result = reconcileDatasets({
    orders: [{ order_id: 'O-1', quantity_ordered: '5', order_value: '' }],
    invoices: [{ invoice_id: 'I-1', order_id: 'O-1', quantity_invoiced: '', invoice_value: '' }],
    deliveries: [{ delivery_id: 'D-1', order_id: 'O-1', quantity_delivered: '' }]
  });
  assert.equal(result.reconciled[0].quantity_invoiced, null);
  assert.equal(result.reconciled[0].quantity_delivered, null);
  assert.equal(result.reconciled[0].invoice_value, null);
  assert.equal(result.summary.exception_count, 0);
});


test('keeps financial and quantity values unknown when an order has no linked records', () => {
  const result = reconcileDatasets({
    orders: [{ order_id: 'O-EMPTY', quantity_ordered: '12', order_value: '240' }]
  });
  assert.equal(result.reconciled[0].quantity_invoiced, null);
  assert.equal(result.reconciled[0].quantity_delivered, null);
  assert.equal(result.reconciled[0].invoice_value, null);
  assert.equal(result.reconciled[0].status, 'incomplete');
  assert.equal(result.summary.linked_order_count, 0);
  assert.ok(result.exceptions.some(item => item.code === 'ORDER_NOT_INVOICED'));
  assert.ok(result.exceptions.some(item => item.code === 'ORDER_NOT_DELIVERED'));
});
