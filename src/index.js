import { authenticateZonarTenant } from './zonar-auth.js';
import { handleZonarIdentity } from './zonar-identity.js';
import { authorizeZonarAction } from './zonar-permissions.js';
import { handleZonarTenantFiles } from './zonar-file-storage.js';
import { handleZonarResumableUpload } from "./zonar-resumable-uploads.js";
import { handleZonarReconciliationRun } from './zonar-reconciliation-runs.js';
import { handleZonarReconciliationResult } from './zonar-reconciliation-results.js';
import { handleZonarOperationalEvents } from './zonar-operational-events.js';
import { handleZonarAsyncReconciliationEnqueue, handleZonarReconciliationQueueBatch, recoverZonarReconciliationLeases, dispatchZonarReconciliationOutbox } from './zonar-async-reconciliation.js';

// Neural Horizons AI — Cloudflare Worker
// Serves the static site (dist/) and a small live AI-news API used by the
// homepage ticker (#nhTicker). The news endpoint pulls real, dated headlines
// from Google News RSS (no API key required), caches them at the edge for
// 30 minutes, and always falls back to a safe static list if the fetch or
// parse ever fails — the ticker never breaks, it just stops refreshing.

const NEWS_QUERIES = [
  'agentic AI OR autonomous AI when:2d',
  '(AI OR "artificial intelligence") (UAE OR GCC OR Gulf OR Dubai OR "Saudi Arabia") when:3d'
];

const FALLBACK_ITEMS = [
  { title: 'UAE unveils design guide for agentic AI-powered government services', url: 'https://www.globalgovernmentforum.com/uae-publishes-design-guide-for-agentic-ai-powered-public-services-as-part-of-drive-to-automate-half-of-government/', source: 'Global Government Forum' },
  { title: 'Saudi Arabia’s Humain AI laptop tipped as “game-changer” by IDC', url: 'https://www.cnbc.com/video/2026/08/21/saudi-arabias-humain-ai-laptop-will-be-a-game-changer-idc.html', source: 'CNBC' },
  { title: 'Anthropic signs $45B AI compute deal with Nscale ahead of planned IPO', url: 'https://techcrunch.com/2026/08/26/anthropic-continues-compute-gobbling-streak-in-45-billion-deal-with-nscale/', source: 'TechCrunch' },
  { title: 'UAE sovereign fund weighs $6.3B AI data center investment in Japan', url: 'https://www.bloomberg.com/news/articles/2026-08-06/uae-fund-weighs-6-3-billion-ai-data-center-investment-in-japan', source: 'Bloomberg' },
  { title: 'US, UAE launch first joint military AI task force', url: 'https://thedefensepost.com/2026/08/05/us-uae-military-ai-task-force/', source: 'The Defense Post' }
];

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
  return m ? decodeEntities(m[1]) : '';
}

function feedUrlFor(query) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-US&gl=US&ceid=US:en';
}

async function fetchFeed(query) {
  const res = await fetch(feedUrlFor(query), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
    }
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const items = [];
  for (const block of itemBlocks) {
    let title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    let source = extractTag(block, 'source');
    if (source && title.endsWith(' - ' + source)) {
      title = title.slice(0, -(source.length + 3)).trim();
    } else if (!source && title.includes(' - ')) {
      const parts = title.split(' - ');
      source = parts.pop().trim();
      title = parts.join(' - ').trim();
    }
    if (title && link) {
      items.push({
        title,
        url: link,
        source: source || 'Google News',
        pubDate: pubDate ? new Date(pubDate).toISOString() : null
      });
    }
  }
  return items;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

async function buildNewsPayload() {
  const settled = await Promise.allSettled(NEWS_QUERIES.map(fetchFeed));
  let items = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') items = items.concat(r.value);
  }
  items = dedupe(items);
  items.sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  items = items.slice(0, 12);
  if (items.length === 0) {
    return { items: FALLBACK_ITEMS, updated: new Date().toISOString(), fallback: true };
  }
  return { items, updated: new Date().toISOString(), fallback: false };
}

async function handleNewsRequest(request, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let payload;
  try {
    payload = await buildNewsPayload();
  } catch (err) {
    payload = { items: FALLBACK_ITEMS, updated: new Date().toISOString(), fallback: true };
  }

  const maxAge = payload.fallback ? 300 : 1800;
  const response = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + maxAge,
      'Access-Control-Allow-Origin': '*'
    }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/news') {
      return handleNewsRequest(request, ctx);
    }
    const resumableUploadMatch = url.pathname.match(/^\/api\/zonar\/tenants\/([^/]+)\/files\/uploads(?:\/([^/]+)(?:\/parts\/(\d+)|\/(complete|abort))?)?$/);
    if (resumableUploadMatch) {
      let tenantId, uploadId = null;
      try {
        tenantId = decodeURIComponent(resumableUploadMatch[1]);
        uploadId = resumableUploadMatch[2] ? decodeURIComponent(resumableUploadMatch[2]) : null;
      } catch { return zonarJson({ error: 'INVALID_RESOURCE' }, 400); }
      return handleZonarResumableUpload(
        request, env, tenantId, uploadId,
        resumableUploadMatch[3] || null, resumableUploadMatch[4] || null
      );
    }
    const tenantFilesMatch = url.pathname.match(/^\/api\/zonar\/tenants\/([^/]+)\/files$/);
    if (tenantFilesMatch) {
      let tenantId;
      try { tenantId = decodeURIComponent(tenantFilesMatch[1]); }
      catch { return zonarJson({ error: 'INVALID_TENANT' }, 400); }
      return handleZonarTenantFiles(request, env, tenantId);
    }
    const operationalEventMatch = url.pathname.match(/^\/api\/zonar\/tenants\/([^/]+)\/operational-events(?:\/([^/]+))?$/);
    if (operationalEventMatch) {
      let tenantId, eventId = null;
      try {
        tenantId = decodeURIComponent(operationalEventMatch[1]);
        eventId = operationalEventMatch[2] ? decodeURIComponent(operationalEventMatch[2]) : null;
      } catch { return zonarJson({ error: 'INVALID_RESOURCE' }, 400); }
      return handleZonarOperationalEvents(request, env, tenantId, eventId);
    }
    const reconciliationResultMatch = url.pathname.match(/^\/api\/zonar\/tenants\/([^/]+)\/reconciliation-runs\/([^/]+)$/);
    if (reconciliationResultMatch) {
      let tenantId, runId;
      try {
        tenantId = decodeURIComponent(reconciliationResultMatch[1]);
        runId = decodeURIComponent(reconciliationResultMatch[2]);
      } catch { return zonarJson({ error: 'INVALID_RESOURCE' }, 400); }
      return handleZonarReconciliationResult(request, env, tenantId, runId);
    }
    const asyncReconciliationMatch = url.pathname.match(/^\/api\/zonar\/tenants\/([^/]+)\/reconciliation-jobs$/);
    if (asyncReconciliationMatch) {
      let tenantId;
      try { tenantId = decodeURIComponent(asyncReconciliationMatch[1]); }
      catch { return zonarJson({ error: 'INVALID_TENANT' }, 400); }
      return handleZonarAsyncReconciliationEnqueue(request, env, tenantId);
    }
    const reconciliationRunMatch = url.pathname.match(/^\/api\/zonar\/tenants\/([^/]+)\/reconciliation-runs$/);
    if (reconciliationRunMatch) {
      let tenantId;
      try { tenantId = decodeURIComponent(reconciliationRunMatch[1]); }
      catch { return zonarJson({ error: 'INVALID_TENANT' }, 400); }
      return handleZonarReconciliationRun(request, env, tenantId);
    }
    const tenantAccessMatch = url.pathname.match(/^\/api\/zonar\/tenants\/([^/]+)\/access$/);
    if (tenantAccessMatch) {
      let tenantId;
      try { tenantId = decodeURIComponent(tenantAccessMatch[1]); }
      catch { return zonarJson({ error: 'INVALID_TENANT' }, 400); }
      return handleZonarTenantAccess(request, env, tenantId);
    }
    if (url.pathname === '/api/zonar/me') {
      return handleZonarIdentity(request, env);
    }
    if (url.pathname === '/api/zonar/profile') {
      return handleZonarProfile(request, env);
    }
    return env.ASSETS.fetch(request);
  },
  async queue(batch, env) {
    return handleZonarReconciliationQueueBatch(batch, env);
  },
  async scheduled(controller, env, ctx) {
    if (env.ZONAR_ASYNC_ENABLED !== 'true') return;
    ctx.waitUntil((async () => {
      await recoverZonarReconciliationLeases(env);
      await dispatchZonarReconciliationOutbox(env);
    })());
  }
};
 
const ZONAR_MAX_BYTES = 2 * 1024 * 1024;
const ZONAR_MAX_ROWS = 10000;
const ZONAR_ALIASES = {
  order_id: ['order_id', 'order_number', 'order_no', 'sales_order', 'transaction_id'],
  customer_id: ['customer_id', 'client_id', 'account_id', 'customer_code'],
  order_date: ['order_date', 'date_ordered', 'created_at'],
  sku: ['sku', 'item_code', 'product_code', 'stock_code'],
  quantity_ordered: ['quantity_ordered', 'ordered_quantity', 'order_qty', 'qty_ordered'],
  quantity_delivered: ['quantity_delivered', 'delivered_quantity', 'delivery_qty', 'qty_delivered'],
  unit_price: ['unit_price', 'selling_price', 'price_per_unit', 'rate'],
  order_value: ['order_value', 'total_order_value', 'sales_value', 'net_amount'],
  invoice_id: ['invoice_id', 'invoice_number', 'invoice_no'],
  delivery_id: ['delivery_id', 'delivery_number', 'delivery_no', 'shipment_id']
};

function zonarJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    }
  });
}

function zonarTokenMatches(a, b) {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function parseZonarCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some(v => v.trim())) rows.push(row);
      row = []; cell = '';
      if (rows.length > ZONAR_MAX_ROWS + 1) throw new Error('TOO_MANY_ROWS');
    } else cell += ch;
  }
  if (quoted) throw new Error('UNCLOSED_QUOTE');
  row.push(cell);
  if (row.some(v => v.trim())) rows.push(row);
  if (rows.length > ZONAR_MAX_ROWS + 1) throw new Error('TOO_MANY_ROWS');
  return rows;
}

function zonarNormaliseHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function handleZonarProfile(request, env) {
  if (request.method !== 'POST') {
    return zonarJson({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  // Read the incoming authorisation header.
  const authorization = request.headers.get('Authorization');
  const token = authorization || '';

  // Check that the Worker has a configured secret.
  if (!env.ZONAR_UPLOAD_TOKEN) {
    return zonarJson({
      error: 'AUTH_CONFIGURATION_MISSING',
      message: 'Zonar upload authentication is not configured on this Worker.'
    }, 503);
  }

  // Check that the request contains a valid Bearer prefix.
  if (!token.startsWith('Bearer ')) {
    return zonarJson({
      error: 'UNAUTHORISED',
      message: 'Valid authentication is required.'
    }, 401);
  }

  // Compare the supplied token with the configured Worker secret.
  const suppliedToken = token.slice(7);
  const configuredToken = env.ZONAR_UPLOAD_TOKEN;

  if (!zonarTokenMatches(suppliedToken, configuredToken)) {
    return zonarJson({
      error: 'UNAUTHORISED',
      message: 'Valid authentication is required.'
    }, 401);
  }

  // Reject an oversized declared body early; streaming byte enforcement below
  // remains authoritative because Content-Length is client-supplied.
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null && /^\\d+$/.test(declaredLength) &&
      Number(declaredLength) > ZONAR_MAX_BYTES) {
    return zonarJson({
      error: 'UPLOAD_TOO_LARGE',
      max_bytes: ZONAR_MAX_BYTES
    }, 413);
  }

  // Check the uploaded file content type.
  const type = (request.headers.get('Content-Type') || '').toLowerCase();

  if (!type.startsWith('text/csv') && !type.startsWith('text/plain')) {
    return zonarJson({
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Send the CSV as text/csv.'
    }, 415);
  }

  try {
    const reader = request.body?.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let csv = '';
    let bytes = 0;

    // Read the CSV while enforcing the upload size limit.
    if (reader) {
      while (true) {
        const part = await reader.read();

        if (part.done) break;

        bytes += part.value.byteLength;

        if (bytes > ZONAR_MAX_BYTES) {
          await reader.cancel();
          return zonarJson({
            error: 'UPLOAD_TOO_LARGE',
            max_bytes: ZONAR_MAX_BYTES
          }, 413);
        }

        csv += decoder.decode(part.value, { stream: true });
      }

      csv += decoder.decode();
    }

    csv = csv.replace(/^\uFEFF/, '');

    if (!csv.trim()) {
      return zonarJson({ error: 'EMPTY_FILE' }, 400);
    }

    const rows = parseZonarCsv(csv);

    if (rows.length < 2) {
      return zonarJson({ error: 'NO_DATA_ROWS' }, 400);
    }

    const headers = rows[0].map(v => v.trim());

    if (headers.length > 100) {
      return zonarJson({
        error: 'TOO_MANY_COLUMNS',
        max_columns: 100
      }, 413);
    }

    const normal = headers.map(zonarNormaliseHeader);

    const duplicateHeaders = [
      ...new Set(
        normal.filter((v, i) => v && normal.indexOf(v) !== i)
      )
    ];

    const blankHeaders = headers
      .map((v, i) => v ? null : i + 1)
      .filter(Boolean);

    const data = rows.slice(1);

    const malformed = data
      .map((r, i) => r.length === headers.length
        ? null
        : {
            row: i + 2,
            expected: headers.length,
            actual: r.length
          }
      )
      .filter(Boolean);

    // Map recognised CSV headers to standard Zonar fields.
    const mappings = {};

    for (const [field, aliases] of Object.entries(ZONAR_ALIASES)) {
      const index = normal.findIndex(v => aliases.includes(v));
      mappings[field] = index < 0 ? null : headers[index];
    }

    // Return the profile and a small preview.
    return zonarJson({
      success: true,
      profiler_version: '0.1.0',
      filename: (request.headers.get('X-Filename') || 'upload.csv').slice(0, 160),
      profile: {
        row_count: data.length,
        column_count: headers.length,
        headers,
        mappings,
        validation: {
          blank_header_positions: blankHeaders,
          duplicate_headers: duplicateHeaders,
          malformed_row_count: malformed.length,
          malformed_rows_sample: malformed.slice(0, 20),
          status: blankHeaders.length ||
            duplicateHeaders.length ||
            malformed.length
              ? 'review_required'
              : 'passed'
        },
        preview: data.slice(0, 5).map(r =>
          Object.fromEntries(
            headers.map((h, i) => [
              h || 'column_' + (i + 1),
              r[i] ?? ''
            ])
          )
        )
      },
      storage: 'not_stored'
    });

  } catch (error) {
    if (error.message === 'TOO_MANY_ROWS') {
      return zonarJson({
        error: 'TOO_MANY_ROWS',
        max_rows: ZONAR_MAX_ROWS
      }, 413);
    }

    if (error.message === 'UNCLOSED_QUOTE') {
      return zonarJson({
        error: 'INVALID_CSV',
        message: 'A quoted field was not closed.'
      }, 400);
    }

    if (error instanceof TypeError) {
      return zonarJson({
        error: 'INVALID_ENCODING',
        message: 'CSV must be UTF-8.'
      }, 400);
    }

    return zonarJson({ error: 'PROFILE_FAILED' }, 400);
  }
}


/**
 * Minimal authenticated tenant-access endpoint.
 * It exposes only the current tenant ID and verified role; no customer records.
 */
export async function handleZonarTenantAccess(request, env, tenantId) {
  if (request.method !== 'GET') {
    return zonarJson({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  const authentication = await authenticateZonarTenant(request, env, tenantId);
  if (!authentication.ok) {
    return zonarJson({ error: authentication.error }, authentication.status);
  }

  const authorization = authorizeZonarAction(authentication, 'tenant:read');
  if (!authorization.ok) {
    return zonarJson({ error: authorization.error }, authorization.status);
  }

  return zonarJson({
    success: true,
    tenant: {
      id: authorization.tenantId,
      role: authorization.role
    }
  });
}
