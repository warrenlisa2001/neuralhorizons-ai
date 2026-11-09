const DATASETS = ['orders', 'invoices', 'deliveries'];
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;

function assertIdentity(input) {
  const { tenantId, runId } = input || {};
  if (![tenantId, runId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
    throw new Error('INVALID_RECONCILIATION_IDENTITY');
  }
}

function bind(db, sql, ...values) {
  return db.prepare(sql).bind(...values);
}

async function seedSourceExceptions(db, tenantId, runId) {
  const statements = [];
  for (const dataset of DATASETS) {
    statements.push(bind(db, `
      INSERT OR IGNORE INTO reconciliation_exceptions
        (tenant_id,run_id,code,severity,dataset,source_row_number,record_id,details_json)
      SELECT tenant_id,run_id,'MISSING_RECORD_ID','high',dataset,row_number,NULL,
             json_object('field', CASE dataset WHEN 'orders' THEN 'order_id' WHEN 'invoices' THEN 'invoice_id' ELSE 'delivery_id' END)
      FROM reconciliation_staging_rows
      WHERE tenant_id=?1 AND run_id=?2 AND dataset=?3 AND record_id IS NULL
    `, tenantId, runId, dataset));
    statements.push(bind(db, `
      INSERT OR IGNORE INTO reconciliation_exceptions
        (tenant_id,run_id,code,severity,dataset,source_row_number,record_id,details_json)
      SELECT s.tenant_id,s.run_id,'DUPLICATE_RECORD_ID','high',s.dataset,s.row_number,s.record_id,
             json_object('field', CASE s.dataset WHEN 'orders' THEN 'order_id' WHEN 'invoices' THEN 'invoice_id' ELSE 'delivery_id' END)
      FROM reconciliation_staging_rows s
      WHERE s.tenant_id=?1 AND s.run_id=?2 AND s.dataset=?3 AND s.record_id IS NOT NULL
        AND s.row_number > (SELECT MIN(first.row_number) FROM reconciliation_staging_rows first
          WHERE first.tenant_id=s.tenant_id AND first.run_id=s.run_id
            AND first.dataset=s.dataset AND first.record_id=s.record_id)
    `, tenantId, runId, dataset));
  }
  for (const [dataset, missingCode, orphanCode] of [
    ['invoices','INVOICE_MISSING_ORDER_REFERENCE','INVOICE_WITHOUT_ORDER'],
    ['deliveries','DELIVERY_MISSING_ORDER_REFERENCE','DELIVERY_WITHOUT_ORDER']
  ]) {
    statements.push(bind(db, `
      INSERT OR IGNORE INTO reconciliation_exceptions
        (tenant_id,run_id,code,severity,dataset,source_row_number,record_id,order_id)
      SELECT s.tenant_id,s.run_id,'${missingCode}','high','${dataset}',s.row_number,s.record_id,NULL
      FROM reconciliation_staging_rows s
      WHERE s.tenant_id=?1 AND s.run_id=?2 AND s.dataset='${dataset}'
        AND s.record_id IS NOT NULL
        AND s.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
          WHERE x.tenant_id=s.tenant_id AND x.run_id=s.run_id AND x.dataset=s.dataset AND x.record_id=s.record_id)
        AND s.order_id IS NULL
    `, tenantId, runId));
    statements.push(bind(db, `
      INSERT OR IGNORE INTO reconciliation_exceptions
        (tenant_id,run_id,code,severity,dataset,source_row_number,record_id,order_id)
      SELECT s.tenant_id,s.run_id,'${orphanCode}','high','${dataset}',s.row_number,s.record_id,s.order_id
      FROM reconciliation_staging_rows s
      WHERE s.tenant_id=?1 AND s.run_id=?2 AND s.dataset='${dataset}'
        AND s.record_id IS NOT NULL AND s.order_id IS NOT NULL
        AND s.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
          WHERE x.tenant_id=s.tenant_id AND x.run_id=s.run_id AND x.dataset=s.dataset AND x.record_id=s.record_id)
        AND NOT EXISTS (SELECT 1 FROM reconciliation_staging_rows o
          WHERE o.tenant_id=s.tenant_id AND o.run_id=s.run_id AND o.dataset='orders'
            AND o.record_id=s.order_id
            AND o.row_number=(SELECT MIN(oo.row_number) FROM reconciliation_staging_rows oo
              WHERE oo.tenant_id=o.tenant_id AND oo.run_id=o.run_id AND oo.dataset='orders' AND oo.record_id=o.record_id))
    `, tenantId, runId));
  }
  await db.batch(statements);
}

/**
 * Process one bounded page of staged orders. All result and exception writes
 * are idempotent and committed with the progress cursor in a single D1 batch.
 */
export async function processZonarStagedReconciliationBatch(db, input = {}) {
  assertIdentity(input);
  if (!db?.prepare || typeof db.batch !== 'function') throw new Error('RECONCILIATION_DB_UNAVAILABLE');
  const { tenantId, runId } = input;
  const batchSize = Number.isInteger(input.batchSize)
    ? Math.max(1, Math.min(MAX_BATCH_SIZE, input.batchSize)) : DEFAULT_BATCH_SIZE;
  const tolerance = Number.isFinite(input.valueTolerance) && input.valueTolerance >= 0
    ? input.valueTolerance : 0.01;

  const datasets = await db.prepare(
    `SELECT dataset,status FROM reconciliation_dataset_progress
     WHERE tenant_id=?1 AND run_id=?2`
  ).bind(tenantId, runId).all();
  const statuses = new Map((datasets.results || []).map(row => [row.dataset, row.status]));
  if (DATASETS.some(dataset => statuses.get(dataset) !== 'complete')) {
    throw new Error('RECONCILIATION_STAGING_INCOMPLETE');
  }

  await db.prepare(
    `INSERT OR IGNORE INTO reconciliation_engine_progress (tenant_id,run_id,status)
     VALUES (?1,?2,'pending')`
  ).bind(tenantId, runId).run();
  let progress = await db.prepare(
    `SELECT status,last_order_row_number,processed_order_count
     FROM reconciliation_engine_progress WHERE tenant_id=?1 AND run_id=?2`
  ).bind(tenantId, runId).first();
  if (progress.status === 'complete') {
    return { status:'complete', processed_orders:Number(progress.processed_order_count), more_work:false };
  }

  await seedSourceExceptions(db, tenantId, runId);
  const cursor = Number(progress.last_order_row_number || 1);
  const page = await db.prepare(
    `SELECT s.row_number,s.record_id
     FROM reconciliation_staging_rows s
     WHERE s.tenant_id=?1 AND s.run_id=?2 AND s.dataset='orders'
       AND s.row_number>?3 AND s.record_id IS NOT NULL
       AND s.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
         WHERE x.tenant_id=s.tenant_id AND x.run_id=s.run_id
           AND x.dataset='orders' AND x.record_id=s.record_id)
     ORDER BY s.row_number LIMIT ?4`
  ).bind(tenantId, runId, cursor, batchSize).all();
  const orders = page.results || [];
  if (!orders.length) {
    await db.prepare(
      `UPDATE reconciliation_engine_progress SET status='complete',
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE tenant_id=?1 AND run_id=?2 AND status IN ('pending','running')`
    ).bind(tenantId, runId).run();
    const summary = await getZonarStagedReconciliationSummary(db, { tenantId, runId });
    return { status:'complete', processed_orders:Number(progress.processed_order_count), more_work:false, summary };
  }

  const lastRow = Number(orders[orders.length - 1].row_number);
  const firstCursor = cursor;
  const resultSql = `
    WITH page AS (
      SELECT s.tenant_id,s.run_id,s.row_number,s.record_id AS order_id,s.record_json
      FROM reconciliation_staging_rows s
      WHERE s.tenant_id=?1 AND s.run_id=?2 AND s.dataset='orders'
        AND s.row_number>?3 AND s.row_number<=?4 AND s.record_id IS NOT NULL
        AND s.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
          WHERE x.tenant_id=s.tenant_id AND x.run_id=s.run_id
            AND x.dataset='orders' AND x.record_id=s.record_id)
    ),
    invoice_totals AS (
      SELECT i.order_id,COUNT(*) AS invoice_count,
        SUM(CASE WHEN json_type(i.record_json,'$.quantity_invoiced') IS NOT NULL
                       AND json_type(i.record_json,'$.quantity_invoiced')<>'null'
                 THEN CAST(json_extract(i.record_json,'$.quantity_invoiced') AS REAL) ELSE 0 END) AS invoiced_qty,
        SUM(CASE WHEN json_type(i.record_json,'$.invoice_value') IS NOT NULL
                       AND json_type(i.record_json,'$.invoice_value')<>'null'
                 THEN CAST(json_extract(i.record_json,'$.invoice_value') AS REAL) ELSE 0 END) AS invoice_value,
        SUM(CASE WHEN json_type(i.record_json,'$.quantity_invoiced') IS NOT NULL
                       AND json_type(i.record_json,'$.quantity_invoiced')<>'null' THEN 1 ELSE 0 END) AS known_qty,
        SUM(CASE WHEN json_type(i.record_json,'$.invoice_value') IS NOT NULL
                       AND json_type(i.record_json,'$.invoice_value')<>'null' THEN 1 ELSE 0 END) AS known_value
      FROM reconciliation_staging_rows i JOIN page p ON p.order_id=i.order_id
      WHERE i.tenant_id=?1 AND i.run_id=?2 AND i.dataset='invoices'
        AND i.record_id IS NOT NULL
        AND i.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
          WHERE x.tenant_id=i.tenant_id AND x.run_id=i.run_id
            AND x.dataset='invoices' AND x.record_id=i.record_id)
      GROUP BY i.order_id
    ),
    delivery_totals AS (
      SELECT d.order_id,COUNT(*) AS delivery_count,
        SUM(CASE WHEN json_type(d.record_json,'$.quantity_delivered') IS NOT NULL
                       AND json_type(d.record_json,'$.quantity_delivered')<>'null'
                 THEN CAST(json_extract(d.record_json,'$.quantity_delivered') AS REAL) ELSE 0 END) AS delivered_qty,
        SUM(CASE WHEN json_type(d.record_json,'$.quantity_delivered') IS NOT NULL
                       AND json_type(d.record_json,'$.quantity_delivered')<>'null' THEN 1 ELSE 0 END) AS known_qty
      FROM reconciliation_staging_rows d JOIN page p ON p.order_id=d.order_id
      WHERE d.tenant_id=?1 AND d.run_id=?2 AND d.dataset='deliveries'
        AND d.record_id IS NOT NULL
        AND d.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
          WHERE x.tenant_id=d.tenant_id AND x.run_id=d.run_id
            AND x.dataset='deliveries' AND x.record_id=d.record_id)
      GROUP BY d.order_id
    )
    INSERT OR IGNORE INTO reconciliation_order_results
      (tenant_id,run_id,order_id,order_row_number,invoice_count,delivery_count,
       quantity_ordered,quantity_invoiced,quantity_delivered,order_value,invoice_value,status)
    SELECT p.tenant_id,p.run_id,p.order_id,p.row_number,
      COALESCE(it.invoice_count,0),COALESCE(dt.delivery_count,0),
      CASE WHEN json_type(p.record_json,'$.quantity_ordered') IS NOT NULL
                  AND json_type(p.record_json,'$.quantity_ordered')<>'null'
           THEN CAST(json_extract(p.record_json,'$.quantity_ordered') AS REAL) ELSE NULL END,
      CASE WHEN COALESCE(it.invoice_count,0)>0 AND it.known_qty=it.invoice_count THEN it.invoiced_qty ELSE NULL END,
      CASE WHEN COALESCE(dt.delivery_count,0)>0 AND dt.known_qty=dt.delivery_count THEN dt.delivered_qty ELSE NULL END,
      CASE WHEN json_type(p.record_json,'$.order_value') IS NOT NULL
                  AND json_type(p.record_json,'$.order_value')<>'null'
           THEN CAST(json_extract(p.record_json,'$.order_value') AS REAL) ELSE NULL END,
      CASE WHEN COALESCE(it.invoice_count,0)>0 AND it.known_value=it.invoice_count THEN it.invoice_value ELSE NULL END,
      CASE WHEN COALESCE(it.invoice_count,0)>0 AND COALESCE(dt.delivery_count,0)>0 THEN 'linked' ELSE 'incomplete' END
    FROM page p LEFT JOIN invoice_totals it ON it.order_id=p.order_id
                LEFT JOIN delivery_totals dt ON dt.order_id=p.order_id
  `;
  const linksSql = `
    WITH page AS (
      SELECT s.tenant_id,s.run_id,s.record_id AS order_id
      FROM reconciliation_staging_rows s
      WHERE s.tenant_id=?1 AND s.run_id=?2 AND s.dataset='orders'
        AND s.row_number>?3 AND s.row_number<=?4 AND s.record_id IS NOT NULL
        AND s.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
          WHERE x.tenant_id=s.tenant_id AND x.run_id=s.run_id
            AND x.dataset='orders' AND x.record_id=s.record_id)
    )
    INSERT OR IGNORE INTO reconciliation_result_links
      (tenant_id,run_id,order_id,dataset,linked_record_id,source_row_number)
    SELECT p.tenant_id,p.run_id,p.order_id,i.dataset,i.record_id,i.row_number
    FROM page p JOIN reconciliation_staging_rows i ON i.tenant_id=p.tenant_id
      AND i.run_id=p.run_id AND i.order_id=p.order_id
      AND i.dataset IN ('invoices','deliveries') AND i.record_id IS NOT NULL
      AND i.row_number=(SELECT MIN(x.row_number) FROM reconciliation_staging_rows x
        WHERE x.tenant_id=i.tenant_id AND x.run_id=i.run_id
          AND x.dataset=i.dataset AND x.record_id=i.record_id)
  `;
  const exceptionSql = `
    INSERT OR IGNORE INTO reconciliation_exceptions
      (tenant_id,run_id,code,severity,dataset,source_row_number,record_id,order_id,expected_value,actual_value,details_json)
    SELECT r.tenant_id,r.run_id,'ORDER_NOT_INVOICED','medium','orders',r.order_row_number,r.order_id,r.order_id,NULL,NULL,NULL
      FROM reconciliation_order_results r
      WHERE r.tenant_id=?1 AND r.run_id=?2 AND r.order_row_number>?3 AND r.order_row_number<=?4 AND r.invoice_count=0
    UNION ALL
    SELECT r.tenant_id,r.run_id,'ORDER_NOT_DELIVERED','medium','orders',r.order_row_number,r.order_id,r.order_id,NULL,NULL,NULL
      FROM reconciliation_order_results r
      WHERE r.tenant_id=?1 AND r.run_id=?2 AND r.order_row_number>?3 AND r.order_row_number<=?4 AND r.delivery_count=0
    UNION ALL
    SELECT r.tenant_id,r.run_id,'ORDER_INVOICE_QUANTITY_MISMATCH','high','orders',r.order_row_number,r.order_id,r.order_id,r.quantity_ordered,r.quantity_invoiced,NULL
      FROM reconciliation_order_results r
      WHERE r.tenant_id=?1 AND r.run_id=?2 AND r.order_row_number>?3 AND r.order_row_number<=?4
        AND r.quantity_ordered IS NOT NULL AND r.quantity_invoiced IS NOT NULL
        AND ABS(r.quantity_ordered-r.quantity_invoiced)>0.000001
    UNION ALL
    SELECT r.tenant_id,r.run_id,'ORDER_DELIVERY_QUANTITY_MISMATCH','high','orders',r.order_row_number,r.order_id,r.order_id,r.quantity_ordered,r.quantity_delivered,NULL
      FROM reconciliation_order_results r
      WHERE r.tenant_id=?1 AND r.run_id=?2 AND r.order_row_number>?3 AND r.order_row_number<=?4
        AND r.quantity_ordered IS NOT NULL AND r.quantity_delivered IS NOT NULL
        AND ABS(r.quantity_ordered-r.quantity_delivered)>0.000001
    UNION ALL
    SELECT r.tenant_id,r.run_id,'ORDER_INVOICE_VALUE_MISMATCH','high','orders',r.order_row_number,r.order_id,r.order_id,r.order_value,r.invoice_value,NULL
      FROM reconciliation_order_results r
      WHERE r.tenant_id=?1 AND r.run_id=?2 AND r.order_row_number>?3 AND r.order_row_number<=?4
        AND r.order_value IS NOT NULL AND r.invoice_value IS NOT NULL
        AND ABS(r.order_value-r.invoice_value)>?5
  `;
  await db.batch([
    bind(db, resultSql, tenantId, runId, firstCursor, lastRow),
    bind(db, linksSql, tenantId, runId, firstCursor, lastRow),
    bind(db, exceptionSql, tenantId, runId, firstCursor, lastRow, tolerance),
    bind(db, `UPDATE reconciliation_engine_progress
      SET status='running',last_order_row_number=?1,
          processed_order_count=processed_order_count+?2,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE tenant_id=?3 AND run_id=?4 AND status IN ('pending','running')`,
      lastRow, orders.length, tenantId, runId)
  ]);
  return {
    status:'running',
    processed_this_batch:orders.length,
    processed_orders:Number(progress.processed_order_count)+orders.length,
    more_work:true,
    next_after_row:lastRow
  };
}

export async function getZonarStagedReconciliationSummary(db, input = {}) {
  assertIdentity(input);
  const { tenantId, runId } = input;
  const [results, exceptions, sourceCounts] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS order_count,
        SUM(CASE WHEN status='linked' THEN 1 ELSE 0 END) AS linked_order_count
      FROM reconciliation_order_results WHERE tenant_id=?1 AND run_id=?2`).bind(tenantId,runId).first(),
    db.prepare(`SELECT COUNT(*) AS exception_count,
        SUM(CASE WHEN severity='high' THEN 1 ELSE 0 END) AS high_count,
        SUM(CASE WHEN severity='medium' THEN 1 ELSE 0 END) AS medium_count,
        SUM(CASE WHEN severity='low' THEN 1 ELSE 0 END) AS low_count
      FROM reconciliation_exceptions WHERE tenant_id=?1 AND run_id=?2`).bind(tenantId,runId).first(),
    db.prepare(`SELECT dataset,COUNT(DISTINCT record_id) AS record_count
      FROM reconciliation_staging_rows WHERE tenant_id=?1 AND run_id=?2 AND record_id IS NOT NULL
      GROUP BY dataset`).bind(tenantId,runId).all()
  ]);
  return {
    order_count:Number(results?.order_count || 0),
    invoice_count:Number((sourceCounts?.results || []).find(row=>row.dataset==='invoices')?.record_count || 0),
    delivery_count:Number((sourceCounts?.results || []).find(row=>row.dataset==='deliveries')?.record_count || 0),
    linked_order_count:Number(results?.linked_order_count || 0),
    exception_count:Number(exceptions?.exception_count || 0),
    severity_counts:{
      high:Number(exceptions?.high_count || 0),
      medium:Number(exceptions?.medium_count || 0),
      low:Number(exceptions?.low_count || 0)
    }
  };
}

export const ZONAR_RECONCILIATION_ENGINE_BATCH_LIMIT = MAX_BATCH_SIZE;
