// Deterministic, explainable reconciliation for Zonar.
// Pure function: no network, persistence, tenant context, or side effects.
// Inputs are already parsed CSV rows with canonical field names.
const ID_FIELDS = Object.freeze({
  orders: 'order_id',
  invoices: 'invoice_id',
  deliveries: 'delivery_id'
});

function cleanId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normal = String(value).trim().replace(/,/g, '').replace(/^\((.*)\)$/, '-$1');
  const number = Number(normal);
  return Number.isFinite(number) ? number : null;
}

function indexRows(rows, dataset, idField, exceptions) {
  const index = new Map();
  rows.forEach((row, offset) => {
    const rowNumber = offset + 2; // CSV header is row 1.
    const id = cleanId(row?.[idField]);
    if (!id) {
      exceptions.push({ code: 'MISSING_RECORD_ID', severity: 'high', dataset, row: rowNumber, field: idField });
      return;
    }
    if (index.has(id)) {
      exceptions.push({ code: 'DUPLICATE_RECORD_ID', severity: 'high', dataset, row: rowNumber, field: idField, record_id: id });
      return;
    }
    index.set(id, { ...row, __row: rowNumber, __id: id });
  });
  return index;
}

/**
 * Reconcile canonical orders, invoices and deliveries.
 * Required:
 *   orders: [{order_id, quantity_ordered, order_value?}]
 *   invoices: [{invoice_id, order_id, quantity_invoiced?, invoice_value?}]
 *   deliveries: [{delivery_id, order_id, quantity_delivered?}]
 *
 * Optional numeric tolerance applies to value comparisons. No fuzzy matching
 * is performed: ambiguous or absent keys are surfaced as exceptions.
 */
export function reconcileDatasets(input = {}, options = {}) {
  const orders = Array.isArray(input.orders) ? input.orders : [];
  const invoices = Array.isArray(input.invoices) ? input.invoices : [];
  const deliveries = Array.isArray(input.deliveries) ? input.deliveries : [];
  const tolerance = Number.isFinite(options.valueTolerance) && options.valueTolerance >= 0
    ? options.valueTolerance : 0.01;
  const exceptions = [];

  const orderIndex = indexRows(orders, 'orders', ID_FIELDS.orders, exceptions);
  const invoiceIndex = indexRows(invoices, 'invoices', ID_FIELDS.invoices, exceptions);
  const deliveryIndex = indexRows(deliveries, 'deliveries', ID_FIELDS.deliveries, exceptions);

  const invoicesByOrder = new Map();
  for (const invoice of invoiceIndex.values()) {
    const orderId = cleanId(invoice.order_id);
    if (!orderId) {
      exceptions.push({ code: 'INVOICE_MISSING_ORDER_REFERENCE', severity: 'high', dataset: 'invoices', row: invoice.__row, record_id: invoice.__id });
      continue;
    }
    if (!orderIndex.has(orderId)) {
      exceptions.push({ code: 'INVOICE_WITHOUT_ORDER', severity: 'high', dataset: 'invoices', row: invoice.__row, record_id: invoice.__id, order_id: orderId });
      continue;
    }
    const list = invoicesByOrder.get(orderId) || [];
    list.push(invoice);
    invoicesByOrder.set(orderId, list);
  }

  const deliveriesByOrder = new Map();
  for (const delivery of deliveryIndex.values()) {
    const orderId = cleanId(delivery.order_id);
    if (!orderId) {
      exceptions.push({ code: 'DELIVERY_MISSING_ORDER_REFERENCE', severity: 'high', dataset: 'deliveries', row: delivery.__row, record_id: delivery.__id });
      continue;
    }
    if (!orderIndex.has(orderId)) {
      exceptions.push({ code: 'DELIVERY_WITHOUT_ORDER', severity: 'high', dataset: 'deliveries', row: delivery.__row, record_id: delivery.__id, order_id: orderId });
      continue;
    }
    const list = deliveriesByOrder.get(orderId) || [];
    list.push(delivery);
    deliveriesByOrder.set(orderId, list);
  }

  const reconciled = [];
  for (const order of orderIndex.values()) {
    const linkedInvoices = invoicesByOrder.get(order.__id) || [];
    const linkedDeliveries = deliveriesByOrder.get(order.__id) || [];
    const orderedQty = finiteNumber(order.quantity_ordered);
    const invoicedQty = linkedInvoices.reduce((sum, row) => sum + (finiteNumber(row.quantity_invoiced) ?? 0), 0);
    const deliveredQty = linkedDeliveries.reduce((sum, row) => sum + (finiteNumber(row.quantity_delivered) ?? 0), 0);
    const orderValue = finiteNumber(order.order_value);
    const invoiceValue = linkedInvoices.reduce((sum, row) => sum + (finiteNumber(row.invoice_value) ?? 0), 0);

    if (!linkedInvoices.length) {
      exceptions.push({ code: 'ORDER_NOT_INVOICED', severity: 'medium', dataset: 'orders', row: order.__row, order_id: order.__id });
    }
    if (!linkedDeliveries.length) {
      exceptions.push({ code: 'ORDER_NOT_DELIVERED', severity: 'medium', dataset: 'orders', row: order.__row, order_id: order.__id });
    }
    if (orderedQty !== null && linkedInvoices.length &&
        linkedInvoices.every(row => finiteNumber(row.quantity_invoiced) !== null) &&
        Math.abs(orderedQty - invoicedQty) > 0.000001) {
      exceptions.push({ code: 'ORDER_INVOICE_QUANTITY_MISMATCH', severity: 'high', dataset: 'orders', row: order.__row, order_id: order.__id, expected: orderedQty, actual: invoicedQty });
    }
    if (orderedQty !== null && linkedDeliveries.length &&
        linkedDeliveries.every(row => finiteNumber(row.quantity_delivered) !== null) &&
        Math.abs(orderedQty - deliveredQty) > 0.000001) {
      exceptions.push({ code: 'ORDER_DELIVERY_QUANTITY_MISMATCH', severity: 'high', dataset: 'orders', row: order.__row, order_id: order.__id, expected: orderedQty, actual: deliveredQty });
    }
    if (orderValue !== null && linkedInvoices.length &&
        linkedInvoices.every(row => finiteNumber(row.invoice_value) !== null) &&
        Math.abs(orderValue - invoiceValue) > tolerance) {
      exceptions.push({ code: 'ORDER_INVOICE_VALUE_MISMATCH', severity: 'high', dataset: 'orders', row: order.__row, order_id: order.__id, expected: orderValue, actual: invoiceValue });
    }

    reconciled.push({
      order_id: order.__id,
      order_row: order.__row,
      invoice_ids: linkedInvoices.map(row => row.__id),
      delivery_ids: linkedDeliveries.map(row => row.__id),
      quantity_ordered: orderedQty,
      quantity_invoiced: linkedInvoices.every(row => finiteNumber(row.quantity_invoiced) !== null) ? invoicedQty : null,
      quantity_delivered: linkedDeliveries.every(row => finiteNumber(row.quantity_delivered) !== null) ? deliveredQty : null,
      order_value: orderValue,
      invoice_value: linkedInvoices.every(row => finiteNumber(row.invoice_value) !== null) ? invoiceValue : null,
      status: linkedInvoices.length && linkedDeliveries.length ? 'linked' : 'incomplete'
    });
  }

  const severityCounts = exceptions.reduce((counts, item) => {
    counts[item.severity] = (counts[item.severity] || 0) + 1;
    return counts;
  }, { high: 0, medium: 0, low: 0 });

  return {
    summary: {
      order_count: orderIndex.size,
      invoice_count: invoiceIndex.size,
      delivery_count: deliveryIndex.size,
      linked_order_count: reconciled.filter(row => row.status === 'linked').length,
      exception_count: exceptions.length,
      severity_counts: severityCounts
    },
    reconciled,
    exceptions
  };
}
