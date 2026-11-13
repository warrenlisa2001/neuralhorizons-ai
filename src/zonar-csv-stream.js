// Incremental CSV reader for large-file ingestion.
// Emits one canonical record at a time; callers must persist bounded batches and
// checkpoint offsets outside this pure parser. It never accumulates a dataset.
const DEFAULTS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxRows: 10000, maxColumns: 100 });
const ALIASES = Object.freeze({
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
const NUMERIC = Object.freeze({
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

async function* csvRecords(stream, limits, onBytes) {
  if (!stream || typeof stream.getReader !== 'function') fail('INVALID_STREAM');
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let row = [], cell = '', state = 'plain', pendingCR = false, sawAny = false;
  const emit = () => {
    row.push(cell); cell = '';
    const result = row; row = [];
    return result.some(value => value.trim() !== '') ? result : null;
  };
  try {
    while (true) {
      let part;
      try { part = await reader.read(); }
      catch (error) {
        // Source-stream failures (R2 I/O, upstream integrity checks) are not CSV
        // syntax errors: preserve them so callers can tell transient from permanent.
        throw Object.assign(error instanceof Error ? error : new Error('SOURCE_STREAM_ERROR'), { sourceStream: true });
      }
      if (part.done) break;
      onBytes(part.value.byteLength);
      let text;
      try { text = decoder.decode(part.value, { stream: true }); }
      catch { fail('INVALID_ENCODING'); }
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (pendingCR) { pendingCR = false; if (ch === '\n') continue; }
        if (state === 'quoted') {
          if (ch === '"') state = 'quote_end';
          else cell += ch;
          continue;
        }
        if (state === 'quote_end') {
          if (ch === '"') { cell += '"'; state = 'quoted'; }
          else if (ch === ',') { row.push(cell); cell = ''; state = 'plain'; }
          else if (ch === '\n' || ch === '\r') {
            const record = emit(); state = 'plain'; pendingCR = ch === '\r';
            if (record) { sawAny = true; yield record; }
          } else fail('INVALID_CSV', { reason: 'CHARACTER_AFTER_CLOSING_QUOTE' });
          continue;
        }
        if (ch === '"') {
          if (cell !== '') fail('INVALID_CSV', { reason: 'QUOTE_IN_UNQUOTED_FIELD' });
          state = 'quoted';
        } else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
          const record = emit(); pendingCR = ch === '\r';
          if (record) { sawAny = true; yield record; }
        } else cell += ch;
        if (row.length >= limits.maxColumns) fail('TOO_MANY_COLUMNS');
      }
    }
    let tail;
    try { tail = decoder.decode(); } catch { fail('INVALID_ENCODING'); }
    // Reprocess decoder tail through a one-chunk stream to preserve parser rules.
    if (tail) {
      const bytes = new TextEncoder().encode(tail);
      const extra = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      for await (const record of csvRecords(extra, { ...limits, maxBytes: limits.maxBytes }, () => {})) yield record;
      return;
    }
    if (state === 'quoted') fail('INVALID_CSV', { reason: 'UNCLOSED_QUOTE' });
    row.push(cell);
    if (row.some(value => value.trim() !== '')) { sawAny = true; yield row; }
    if (!sawAny) fail('EMPTY_FILE');
  } catch (error) {
    try { await reader.cancel(); } catch {}
    if (error.code || error.sourceStream) throw error;
    fail('INVALID_CSV');
  } finally {
    reader.releaseLock();
  }
}

/**
 * Yields {type:'header', ...} once, then {type:'row', row_number, record}.
 * maxBytes is enforced over the actual byte stream, not Content-Length.
 */
export async function* parseZonarCsvStream(stream, options = {}) {
  const dataset = options.dataset;
  if (!Object.hasOwn(ALIASES, dataset)) fail('INVALID_DATASET');
  const limits = { ...DEFAULTS, ...options };
  let bytes = 0, rowCount = 0, header = null, mapping = null;
  const counted = async function* () {
    for await (const cells of csvRecords(stream, limits, size => {
      bytes += size;
      if (bytes > limits.maxBytes) fail('UPLOAD_TOO_LARGE');
    })) {
      if (!header) {
        if (cells.length > limits.maxColumns) fail('TOO_MANY_COLUMNS');
        header = cells.map(value => value.trim());
        const normal = header.map(value => String(value).replace(/^\uFEFF/, '').trim().toLowerCase()
          .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
        if (normal.some(value => !value)) fail('BLANK_HEADER');
        if (new Set(normal).size !== normal.length) fail('DUPLICATE_HEADER');
        mapping = {};
        for (const [field, names] of Object.entries(ALIASES[dataset])) {
          const indexes = normal.map((name, index) => names.includes(name) ? index : -1).filter(index => index >= 0);
          if (indexes.length > 1) fail('AMBIGUOUS_FIELD_MAPPING', { field });
          mapping[field] = indexes.length ? indexes[0] : -1;
        }
        const idField = dataset === 'orders' ? 'order_id' : dataset === 'invoices' ? 'invoice_id' : 'delivery_id';
        if (mapping[idField] < 0) fail('REQUIRED_COLUMN_MISSING', { field: idField });
        if (dataset !== 'orders' && mapping.order_id < 0) fail('REQUIRED_COLUMN_MISSING', { field: 'order_id' });
        yield { type: 'header', dataset, headers: header, mappings: Object.fromEntries(
          Object.entries(mapping).map(([field, index]) => [field, index < 0 ? null : header[index]])
        ) };
        continue;
      }
      if (cells.length !== header.length) fail('MALFORMED_ROW', { row: rowCount + 2, expected: header.length, actual: cells.length });
      rowCount++;
      if (rowCount > limits.maxRows) fail('TOO_MANY_ROWS');
      const record = {};
      for (const [field, index] of Object.entries(mapping)) {
        const raw = index < 0 ? '' : cells[index];
        if (NUMERIC[dataset].includes(field)) {
          const value = String(raw ?? '').trim();
          if (!value) record[field] = null;
          else {
            const normal = value.replace(/,/g, '').replace(/^\((.*)\)$/, '-$1');
            if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normal) || !Number.isFinite(Number(normal))) {
              fail('INVALID_NUMERIC_VALUE', { dataset, field, row: rowCount + 1 });
            }
            record[field] = Number(normal);
          }
        } else record[field] = String(raw ?? '').trim();
      }
      yield { type: 'row', dataset, row_number: rowCount + 1, record };
    }
  };
  let sawHeader = false;
  for await (const item of counted()) { if (item.type === 'header') sawHeader = true; yield item; }
  if (!sawHeader) fail('NO_DATA_ROWS');
  if (rowCount === 0) fail('NO_DATA_ROWS');
}
