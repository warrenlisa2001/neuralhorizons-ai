import { parseZonarCsv, ZONAR_CSV_LIMITS } from './zonar-csv-ingestion.js';
import { reconcileDatasets } from './zonar-reconciliation.js';

export const ZONAR_RECONCILIATION_PIPELINE_VERSION = '0.1.0';

/**
 * Compose strict CSV ingestion with deterministic order/invoice/delivery
 * reconciliation. This is a pure processing boundary: callers must retrieve
 * tenant-owned files only after authentication and authorization.
 *
 * Each source CSV is independently bounded by ZONAR_CSV_LIMITS.maxBytes.
 * Raw source content is never copied into the returned result.
 */
export function buildZonarReconciliation(input = {}, options = {}) {
  const limits = {
    maxBytes: ZONAR_CSV_LIMITS.maxBytes,
    maxRows: ZONAR_CSV_LIMITS.maxRows,
    maxColumns: ZONAR_CSV_LIMITS.maxColumns,
    ...options.limits
  };

  const orders = parseZonarCsv(input.ordersCsv, { dataset: 'orders', ...limits });
  const invoices = parseZonarCsv(input.invoicesCsv, { dataset: 'invoices', ...limits });
  const deliveries = parseZonarCsv(input.deliveriesCsv, { dataset: 'deliveries', ...limits });

  const reconciliation = reconcileDatasets({
    orders: orders.rows,
    invoices: invoices.rows,
    deliveries: deliveries.rows
  }, {
    valueTolerance: options.valueTolerance
  });

  return {
    pipeline_version: ZONAR_RECONCILIATION_PIPELINE_VERSION,
    datasets: {
      orders: { row_count: orders.row_count, mappings: orders.mappings },
      invoices: { row_count: invoices.row_count, mappings: invoices.mappings },
      deliveries: { row_count: deliveries.row_count, mappings: deliveries.mappings }
    },
    summary: reconciliation.summary,
    reconciled: reconciliation.reconciled,
    exceptions: reconciliation.exceptions
  };
}
