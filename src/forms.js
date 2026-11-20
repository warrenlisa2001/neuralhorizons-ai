// Website form handlers: /api/contact and /api/newsletter.
// Submissions are forwarded to the site owner's inbox through Web3Forms.
// Requires the Worker secret FORM_ACCESS_KEY. If it is missing the handlers
// answer 503 so the page falls back to opening a pre-filled email.

const ALLOWED_HOSTS = new Set(['neuralhorizonsai.com', 'www.neuralhorizonsai.com']);
const MAX_BODY_BYTES = 8 * 1024;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const WEB3FORMS_URL = 'https://api.web3forms.com/submit';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser caller; still subject to validation below
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_HOSTS.has(host) || host === 'localhost' || host === '127.0.0.1';
  } catch (err) {
    return false;
  }
}

export async function handleFormRequest(request, env, kind) {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  if (!originAllowed(request)) return json(403, { ok: false, error: 'forbidden' });

  let raw;
  try {
    raw = await request.text();
  } catch (err) {
    return json(400, { ok: false, error: 'bad_request' });
  }
  if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'too_large' });

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return json(400, { ok: false, error: 'bad_json' });
  }
  if (!data || typeof data !== 'object') return json(400, { ok: false, error: 'bad_request' });

  // Honeypot: real visitors never fill this in. Pretend success so bots move on.
  if (clean(data.website, 200) || clean(data.botcheck, 200)) return json(200, { ok: true });

  const email = clean(data.email, 254);
  if (!EMAIL_RE.test(email)) return json(422, { ok: false, error: 'invalid_email' });

  let payload;
  if (kind === 'contact') {
    const name = clean(data.name, 120);
    const message = clean(data.message, 4000);
    if (!name || !message) return json(422, { ok: false, error: 'missing_fields' });
    payload = {
      subject: 'New website enquiry from ' + name,
      from_name: 'Neural Horizons AI website',
      name,
      email,
      replyto: email,
      phone: clean(data.phone, 40),
      message
    };
  } else {
    payload = {
      subject: 'New Friday AI Insights subscriber',
      from_name: 'Neural Horizons AI website',
      email,
      replyto: email,
      message: 'Please add this email to the Friday AI Insights list.',
      source: clean(data.source, 60) || 'website'
    };
  }

  if (!env || !env.FORM_ACCESS_KEY) return json(503, { ok: false, error: 'not_configured' });

  try {
    const res = await fetch(WEB3FORMS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(Object.assign({ access_key: env.FORM_ACCESS_KEY }, payload))
    });
    let result = null;
    try { result = await res.json(); } catch (err) { /* ignore */ }
    if (res.ok && result && result.success) return json(200, { ok: true });
    return json(502, { ok: false, error: 'delivery_failed' });
  } catch (err) {
    return json(502, { ok: false, error: 'delivery_failed' });
  }
}
