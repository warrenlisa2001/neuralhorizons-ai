// Strict, bounded CSV parsing and canonical mapping for Zonar ingestion.
// This module is deliberately pure: callers must authenticate, authorize and
// tenant-scope file retrieval before passing file contents here.
const DEFAULT_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxRows: 10000, maxColumns: 100 });

const FIELD_ALIASES = Object.freeze({
  orders: Object.freeze({
    order_id: ['order_id', 'order_number', 'order_no', 'sales_order', 'transaction_id'],
    quantity_ordered: ['quantity_ordered', 'ordered_quantity', 'order_qty', 'qty_ordered'],
    order_value: ['order_value', 'total_order_value', 'sales_value', 'net_amount']
  }),
  invoices: Object.freeze({
    invoice_id: ['invoice_id', 'invoice_number', 'invoice_no'],
    order_id: ['order_id', 'order_number', 'order_no', 'sales_order', 'transaction_id'],
    quantity_invoiced: ['quantity_invoiced', 'invoiced_quantity', 'invoice_qty', 'qty_invoiced'],
    invoice_value: ['invoice_value', 'total_invoice_value', 'invoice_amount', 'net_amount']
  }),
  deliveries: Object.freeze({
    delivery_id: ['delivery_id', 'delivery_number', 'delivery_no', 'shipment_id'],
    order_id: ['order_id', 'order_number', 'order_no', 'sales_order', 'transaction_id'],
    quantity_delivered: ['quantity_delivered', 'delivered_quantity', 'delivery_qty', 'qty_delivered']
  })
});
const NUMERIC_FIELDS = Object.freeze({
  orders: ['quantity_ordered', 'order_value'],
  invoices: ['quantity_invoiced', 'invoice_value'],
  deliveries: ['quantity_delivered']
});

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function parseRows(source, maxRows, maxColumns) {
  const rows = [];
  let row = [], cell = '', state = 'plain';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (state === 'quoted') {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') state = 'closed';
      else cell += ch;
      continue;
    }
    if (state === 'closed') {
      if (ch === ',') { row.push(cell); cell = ''; state = 'plain'; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && source[i + 1] === '\n') i++;
        row.push(cell);
        if (row.some(value => value.trim() !== '')) rows.push(row);
        row = []; cell = ''; state = 'plain';
        if (rows.length > maxRows + 1) fail('TOO_MANY_ROWS');
      } else fail('INVALID_CSV', { reason: 'CHARACTER_AFTER_CLOSING_QUOTE' });
      continue;
    }
    if (ch === '"') {
      if (cell !== '') fail('INVALID_CSV', { reason: 'QUOTE_IN_UNQUOTED_FIELD' });
      state = 'quoted';
    } else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some(value => value.trim() !== '')) rows.push(row);
      row = []; cell = '';
      if (rows.length > maxRows + 1) fail('TOO_MANY_ROWS');
    } else cell += ch;
    if (row.length >= maxColumns) fail('TOO_MANY_COLUMNS');
  }
  if (state === 'quoted') fail('INVALID_CSV', { reason: 'UNCLOSED_QUOTE' });
  row.push(cell);
  if (row.some(value => value.trim() !== '')) rows.push(row);
  if (rows.length > maxRows + 1) fail('TOO_MANY_ROWS');
  if (rows.length && rows[0].length > maxColumns) fail('TOO_MANY_COLUMNS');
  return rows;
}

function normaliseHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function numericValue(value, dataset, field, row) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normal = text.replace(/,/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normal) || !Number.isFinite(Number(normal))) {
    fail('INVALID_NUMERIC_VALUE', { dataset, field, row });
  }
  return Number(normal);
}

export function parseZonarCsv(source, options = {}) {
  const dataset = options.dataset;
  if (!Object.hasOwn(FIELD_ALIASES, dataset)) fail('INVALID_DATASET');
  if (typeof source !== 'string') fail('INVALID_CSV');
  const limits = { ...DEFAULT_LIMITS, ...options };
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (byteLength > limits.maxBytes) fail('UPLOAD_TOO_LARGE');
  if (!source.trim()) fail('EMPTY_FILE');

  const rows = parseRows(source.replace(/^\uFEFF/, ''), limits.maxRows, limits.maxColumns);
  if (rows.length < 2) fail('NO_DATA_ROWS');
  const headers = rows[0].map(value => value.trim());
  if (headers.length > limits.maxColumns) fail('TOO_MANY_COLUMNS');
  const normal = headers.map(normaliseHeader);
  if (normal.some(value => !value)) fail('BLANK_HEADER');
  if (new Set(normal).size !== normal.length) fail('DUPLICATE_HEADER');

  const aliases = FIELD_ALIASES[dataset];
  const mapping = {};
  for (const [field, names] of Object.entries(aliases)) {
    const indexes = normal.map((name, index) => names.includes(name) ? index : -1).filter(index => index >= 0);
    if (indexes.length > 1) fail('AMBIGUOUS_FIELD_MAPPING', { field });
    mapping[field] = indexes.length ? indexes[0] : -1;
  }
  const idField = dataset === 'orders' ? 'order_id' : dataset === 'invoices' ? 'invoice_id' : 'delivery_id';
  if (mapping[idField] < 0) fail('REQUIRED_COLUMN_MISSING', { field: idField });
  if (dataset !== 'orders' && mapping.order_id < 0) fail('REQUIRED_COLUMN_MISSING', { field: 'order_id' });

  const data = rows.slice(1);
  const canonicalRows = data.map((cells, index) => {
    const rowNumber = index + 2;
    if (cells.length !== headers.length) fail('MALFORMED_ROW', { row: rowNumber, expected: headers.length, actual: cells.length });
    const record = {};
    for (const field of Object.keys(aliases)) {
      const column = mapping[field];
      const raw = column < 0 ? '' : cells[column];
      record[field] = NUMERIC_FIELDS[dataset].includes(field)
        ? numericValue(raw, dataset, field, rowNumber)
        : String(raw ?? '').trim();
    }
    return record;
  });
  return {
    dataset,
    headers,
    row_count: canonicalRows.length,
    mappings: Object.fromEntries(Object.entries(mapping).map(([field, index]) => [field, index < 0 ? null : headers[index]])),
    rows: canonicalRows
  };
}

export const ZONAR_CSV_LIMITS = DEFAULT_LIMITS;
