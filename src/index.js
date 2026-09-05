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
    return env.ASSETS.fetch(request);
  }
};
