import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildZonarReconciliation,
  ZONAR_RECONCILIATION_PIPELINE_VERSION
} from '../src/zonar-reconciliation-pipeline.js';

const validInputs = {
  ordersCsv: 'Order Number,Ordered Quantity,Order Value\nO-1,10,125.00',
  invoicesCsv: 'Invoice No,Sales Order,Invoiced Quantity,Invoice Amount\nI-1,O-1,10,125.00',
  deliveriesCsv: 'Delivery No,Order Number,Delivered Quantity\nD-1,O-1,10'
};

test('profiles all three source files and reconciles a complete order', () => {
  const result = buildZonarReconciliation(validInputs);
  assert.equal(result.pipeline_version, ZONAR_RECONCILIATION_PIPELINE_VERSION);
  assert.deepEqual(result.datasets, {
    orders: {
      row_count: 1,
      mappings: {
        order_id: 'Order Number',
        quantity_ordered: 'Ordered Quantity',
        order_value: 'Order Value'
      }
    },
    invoices: {
      row_count: 1,
      mappings: {
        invoice_id: 'Invoice No',
        order_id: 'Sales Order',
        quantity_invoiced: 'Invoiced Quantity',
        invoice_value: 'Invoice Amount'
      }
    },
    deliveries: {
      row_count: 1,
      mappings: {
        delivery_id: 'Delivery No',
        order_id: 'Order Number',
        quantity_delivered: 'Delivered Quantity'
      }
    }
  });
  assert.equal(result.summary.order_count, 1);
  assert.equal(result.summary.linked_order_count, 1);
  assert.equal(result.summary.exception_count, 0);
  assert.equal(result.reconciled[0].invoice_value, 125);
});

test('returns explainable exceptions for quantity and value discrepancies', () => {
  const result = buildZonarReconciliation({
    ...validInputs,
    invoicesCsv: 'invoice_id,order_id,quantity_invoiced,invoice_value\nI-1,O-1,8,100',
    deliveriesCsv: 'delivery_id,order_id,quantity_delivered\nD-1,O-1,9'
  });
  const codes = result.exceptions.map(item => item.code);
  assert.ok(codes.includes('ORDER_INVOICE_QUANTITY_MISMATCH'));
  assert.ok(codes.includes('ORDER_DELIVERY_QUANTITY_MISMATCH'));
  assert.ok(codes.includes('ORDER_INVOICE_VALUE_MISMATCH'));
});

test('does not convert missing invoice or delivery data into zero values', () => {
  const result = buildZonarReconciliation({
    ordersCsv: 'order_id,quantity_ordered,order_value\nO-1,10,125',
    invoicesCsv: 'invoice_id,order_id,quantity_invoiced,invoice_value\nI-1,UNKNOWN,1,10',
    deliveriesCsv: 'delivery_id,order_id,quantity_delivered\nD-1,UNKNOWN,1'
  });
  assert.equal(result.reconciled[0].quantity_invoiced, null);
  assert.equal(result.reconciled[0].quantity_delivered, null);
  assert.equal(result.reconciled[0].invoice_value, null);
  assert.ok(result.exceptions.some(item => item.code === 'ORDER_NOT_INVOICED'));
  assert.ok(result.exceptions.some(item => item.code === 'ORDER_NOT_DELIVERED'));
});

test('rejects malformed source data before reconciliation', () => {
  assert.throws(
    () => buildZonarReconciliation({ ...validInputs, invoicesCsv: 'invoice_id,order_id\nI-1' }),
    error => error.code === 'MALFORMED_ROW'
  );
});

test('applies independent byte limits to each source file', () => {
  assert.throws(
    () => buildZonarReconciliation(validInputs, { limits: { maxBytes: 10 } }),
    error => error.code === 'UPLOAD_TOO_LARGE'
  );
});

test('does not include raw source CSV content in the result', () => {
  const result = buildZonarReconciliation(validInputs);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(validInputs.ordersCsv));
  assert.ok(!serialized.includes(validInputs.invoicesCsv));
  assert.ok(!serialized.includes(validInputs.deliveriesCsv));
});
