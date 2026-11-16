// Finance view: what a finance controller needs from a verified reconciliation run.
// Pure and deterministic. Amounts are in the source files' currency units; the findings
// feed does not carry a currency code, so none is asserted here.

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const TOP_N = 5;
const DATA_QUALITY = new Set(['MISSING_RECORD_ID', 'DUPLICATE_RECORD_ID', 'INVOICE_MISSING_ORDER_REFERENCE', 'DELIVERY_MISSING_ORDER_REFERENCE']);

const ref = f => ({
  finding_id: f.id, file_id: f.source.file_id, dataset: f.source.dataset, row_number: f.source.row_number,
  record_id: f.source.record_id, order_id: f.source.order_id
});

export function buildFinanceView({ run, findings }) {
  if (!run || run.status !== 'succeeded') throw new Error('FINANCE_VIEW_REQUIRES_VERIFIED_RUN');

  const valueMismatches = findings.filter(f => f.code === 'ORDER_INVOICE_VALUE_MISMATCH' &&
    Number.isFinite(f.expected) && Number.isFinite(f.actual));
  const diffs = valueMismatches.map(f => ({ f, diff: f.actual - f.expected }));
  const over = diffs.filter(d => d.diff > 0);
  const under = diffs.filter(d => d.diff < 0);
  const sum = list => round2(list.reduce((t, d) => t + Math.abs(d.diff), 0));

  const byCode = code => findings.filter(f => f.code === code);
  const uninvoiced = byCode('ORDER_NOT_INVOICED');
  const orphanInvoices = byCode('INVOICE_WITHOUT_ORDER');
  const qtyMismatch = byCode('ORDER_INVOICE_QUANTITY_MISMATCH');
  const dataQuality = findings.filter(f => DATA_QUALITY.has(f.code));

  const largest = [...diffs].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.f.id.localeCompare(b.f.id))
    .slice(0, TOP_N).map(d => ({ ...ref(d.f), expected: d.f.expected, actual: d.f.actual, difference: round2(d.diff) }));

  const headline = [];
  if (over.length) headline.push(`${over.length} invoice(s) exceed the order value by ${sum(over)} in total`);
  if (under.length) headline.push(`${under.length} invoice(s) fall short of the order value by ${sum(under)} in total`);
  if (orphanInvoices.length) headline.push(`${orphanInvoices.length} invoice(s) have no matching order`);
  if (uninvoiced.length) headline.push(`${uninvoiced.length} order(s) have not been invoiced`);
  if (!headline.length) headline.push('No invoice or billing exceptions in this run');

  return {
    view: 'finance', run_id: run.id, completed_at: run.completed_at,
    headline,
    over_invoiced: { count: over.length, total: sum(over) },
    under_invoiced: { count: under.length, total: sum(under) },
    uninvoiced_orders: { count: uninvoiced.length, evidence: uninvoiced.slice(0, TOP_N).map(ref) },
    invoices_without_order: { count: orphanInvoices.length, evidence: orphanInvoices.slice(0, TOP_N).map(ref) },
    invoice_quantity_mismatches: { count: qtyMismatch.length, evidence: qtyMismatch.slice(0, TOP_N).map(ref) },
    data_quality_issues: { count: dataQuality.length },
    largest_value_differences: largest,
    units_note: 'Amounts are in the source files\' currency units; the findings feed does not record a currency code.'
  };
}
