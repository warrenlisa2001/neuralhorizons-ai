// The HALU page: sign in with Microsoft (authorisation-code flow with PKCE, no secret, no
// library), read verified briefings, and ask questions about them. All dynamic text is
// written with textContent, never innerHTML. The page ships a per-request nonce CSP.

export function pageHeaders(nonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' https://login.microsoftonline.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  };
}

export function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, '');
}

const STYLE = `
:root{color-scheme:light dark;--bg:#0b1220;--panel:#121b2e;--ink:#e8eefc;--mute:#9db0d3;--line:#22304d;--acc:#5eead4;--hi:#f87171;--med:#fbbf24;--low:#93c5fd}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fc;--panel:#fff;--ink:#0f1a30;--mute:#52627f;--line:#d9e1ef;--acc:#0f766e;--hi:#b91c1c;--med:#a16207;--low:#1d4ed8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line)}
header h1{font-size:18px;margin:0;letter-spacing:.08em}header span{color:var(--mute);font-size:13px}header .sp{flex:1}
main{max-width:1100px;margin:0 auto;padding:20px;display:grid;gap:16px;grid-template-columns:260px 1fr}
@media (max-width:800px){main{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute);margin:0 0 10px}
button,select,textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px 12px}
button{cursor:pointer;background:var(--acc);color:#04201c;border-color:transparent;font-weight:600}button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
button:disabled{opacity:.5;cursor:default}textarea{width:100%;min-height:70px;resize:vertical}select{width:100%;margin-bottom:10px;background:var(--panel)}
.run{display:block;width:100%;text-align:left;margin:0 0 8px;background:transparent;color:var(--ink);border:1px solid var(--line);font-weight:400}
.run[aria-current=true]{border-color:var(--acc)}.run small{display:block;color:var(--mute)}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;margin-right:6px;border:1px solid var(--line)}
.hi{color:var(--hi)}.med{color:var(--med)}.low{color:var(--low)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:500}
.answer{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:10px}
.mute{color:var(--mute)}.err{color:var(--hi)}ul{margin:6px 0;padding-left:20px}
`;

const SCRIPT = String.raw`
'use strict';
const $ = id => document.getElementById(id);
const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const kid of kids) e.append(kid instanceof Node ? kid : String(kid ?? '')); return e; };
const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); };
const S = { cfg: null, token: null, tenant: null, run: null };
const KEY = 'halu.session', PKCE = 'halu.pkce';

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

function loadSession() { try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s && s.exp > Date.now() + 30000) return s.token; } catch {} sessionStorage.removeItem(KEY); return null; }
function saveSession(token, seconds) { try { sessionStorage.setItem(KEY, JSON.stringify({ token, exp: Date.now() + seconds * 1000 })); } catch {} }
function signOut() { try { sessionStorage.removeItem(KEY); } catch {} S.token = null; location.replace(location.pathname); }

async function signIn() {
  const verifier = rand(48), state = rand(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state }));
  const c = S.cfg.sign_in, u = new URL('https://login.microsoftonline.com/' + encodeURIComponent(c.authority_tenant) + '/oauth2/v2.0/authorize');
  u.search = new URLSearchParams({ client_id: c.client_id, response_type: 'code', redirect_uri: location.origin + location.pathname, response_mode: 'query', scope: c.scope, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  location.assign(u.toString());
}

async function finishSignIn() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  const saved = JSON.parse(sessionStorage.getItem(PKCE) || 'null'); sessionStorage.removeItem(PKCE);
  history.replaceState(null, '', location.pathname);
  if (q.has('error')) throw new Error('Sign-in was not completed.');
  if (!saved || saved.state !== q.get('state')) throw new Error('Sign-in could not be verified. Please try again.');
  const c = S.cfg.sign_in;
  const res = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(c.authority_tenant) + '/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, grant_type: 'authorization_code', code: q.get('code'), redirect_uri: location.origin + location.pathname, code_verifier: saved.verifier, scope: c.scope }).toString()
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('Sign-in failed.');
  saveSession(body.access_token, Number(body.expires_in) || 3000);
}

async function api(path, init) {
  const res = await fetch(path, { ...init, headers: { ...(init && init.headers), Authorization: 'Bearer ' + S.token } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { try { sessionStorage.removeItem(KEY); } catch {} S.token = null; throw Object.assign(new Error('Your session has ended. Please sign in again.'), { auth: true }); }
  if (!res.ok) throw Object.assign(new Error(body.error || 'REQUEST_FAILED'), { code: body.error });
  return body;
}

const fmt = iso => { try { return new Date(iso).toLocaleString(); } catch { return iso || ''; } };
const sevClass = s => s === 'high' ? 'hi' : s === 'medium' ? 'med' : 'low';

function setMsg(text, isErr) { const m = $('msg'); m.textContent = text || ''; m.className = isErr ? 'err' : 'mute'; }

async function loadRuns() {
  const list = $('runs'); clear(list);
  const data = await api('/api/halu/tenants/' + encodeURIComponent(S.tenant) + '/briefings?limit=20');
  if (!data.briefings.length) { list.append(h('p', { class: 'mute' }, 'No verified runs yet. Briefings appear here a few minutes after a reconciliation run completes.')); clear($('detail')); return; }
  for (const b of data.briefings) {
    list.append(h('button', { class: 'run', 'data-run': b.run_id, onclick: () => showRun(b.run_id) }, fmt(b.completed_at), h('small', {}, (b.total_findings ?? '?') + ' findings')));
  }
  await showRun(S.run && data.briefings.some(b => b.run_id === S.run) ? S.run : data.briefings[0].run_id);
}

async function showRun(runId) {
  S.run = runId;
  for (const b of document.querySelectorAll('.run')) b.setAttribute('aria-current', String(b.getAttribute('data-run') === runId));
  const d = await api('/api/halu/tenants/' + encodeURIComponent(S.tenant) + '/briefings/' + encodeURIComponent(runId));
  const el = $('detail'); clear(el);
  const f = d.finance || {}, b = d.briefing || {};
  el.append(h('h2', {}, 'Finance view · ' + fmt(d.completed_at)));
  const ul = h('ul'); for (const line of (f.headline || [])) ul.append(h('li', {}, line)); el.append(ul);
  const sev = b.by_severity || {};
  el.append(h('p', {}, h('span', { class: 'pill hi' }, 'High ' + (sev.high ?? 0)), h('span', { class: 'pill med' }, 'Medium ' + (sev.medium ?? 0)), h('span', { class: 'pill low' }, 'Low ' + (sev.low ?? 0)), h('span', { class: 'mute' }, (b.total_findings ?? 0) + ' findings in total')));
  const big = f.largest_value_differences || [];
  if (big.length) {
    const t = h('table', {}, h('tr', {}, h('th', {}, 'Order'), h('th', {}, 'Record'), h('th', {}, 'Expected'), h('th', {}, 'Invoiced'), h('th', {}, 'Difference')));
    for (const r of big) t.append(h('tr', {}, h('td', {}, r.order_id ?? ''), h('td', {}, r.record_id ?? ''), h('td', {}, r.expected), h('td', {}, r.actual), h('td', {}, r.difference)));
    el.append(h('h2', {}, 'Largest value differences'), t);
  }
  const groups = b.groups || [];
  if (groups.length) {
    const t = h('table', {}, h('tr', {}, h('th', {}, 'Finding'), h('th', {}, 'Severity'), h('th', {}, 'Dataset'), h('th', {}, 'Count')));
    for (const g of groups) t.append(h('tr', {}, h('td', {}, g.code), h('td', { class: sevClass(g.severity) }, g.severity), h('td', {}, g.dataset), h('td', {}, g.count)));
    el.append(h('h2', {}, 'All findings by type'), t);
  }
  if (f.units_note) el.append(h('p', { class: 'mute' }, f.units_note));
  $('ask').hidden = !S.cfg.ask_enabled; clear($('answer'));
}

async function ask() {
  const q = $('q').value.trim(); if (!q) return;
  const btn = $('go'); btn.disabled = true; const out = $('answer'); clear(out); out.append(h('p', { class: 'mute' }, 'Thinking…'));
  try {
    const r = await api('/api/halu/tenants/' + encodeURIComponent(S.tenant) + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, run_id: S.run }) });
    clear(out); out.append(h('div', { class: 'answer' }, r.answer), h('p', { class: 'mute' }, 'Answered from the verified run of ' + fmt(r.completed_at) + ' only.'));
  } catch (e) {
    clear(out);
    if (e.auth) return start();
    const text = { ASK_RATE_LIMITED: 'Too many questions this hour. Please try again later.', ASK_NOT_CONFIGURED: 'Asking is not switched on yet.', INVALID_QUESTION: 'Please ask a shorter question.' }[e.code] || 'HALU could not answer just now. Please try again.';
    out.append(h('p', { class: 'err' }, text));
  } finally { btn.disabled = false; }
}

function whoami() {
  try { const c = JSON.parse(atob(S.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return ' Your sign-in details for your administrator: iss=' + c.iss + ' sub=' + c.sub; } catch { return ''; }
}

async function openWorkspace() {
  $('auth').hidden = true; $('app').hidden = false; $('out').hidden = false;
  const w = await api('/api/halu/workspaces');
  const sel = $('ws'); clear(sel);
  if (!w.workspaces.length) { setMsg('You are signed in, but you do not have access to a HALU workspace. Ask your administrator.' + whoami(), true); $('app').hidden = true; return; }
  for (const x of w.workspaces) sel.append(h('option', { value: x.id }, x.name || x.id));
  S.tenant = sel.value; sel.onchange = () => { S.tenant = sel.value; S.run = null; loadRuns().catch(fail); };
  await loadRuns();
}

function fail(e) { if (e && e.auth) return start(); setMsg(e && e.message === 'TENANT_ACCESS_DENIED' ? 'You do not have access to that workspace.' : 'Something went wrong loading HALU. Please refresh.' + whoami(), true); }

async function start() {
  S.token = loadSession();
  if (!S.token) {
    $('app').hidden = true; $('out').hidden = true; $('auth').hidden = false;
    if (!S.cfg.sign_in) { $('login').disabled = true; setMsg('Sign-in is not configured for this HALU yet.', true); }
    return;
  }
  try { await openWorkspace(); } catch (e) { fail(e); }
}

(async () => {
  $('login').addEventListener('click', () => signIn().catch(() => setMsg('Could not start sign-in.', true)));
  $('out').addEventListener('click', signOut); $('go').addEventListener('click', ask);
  try {
    S.cfg = await (await fetch('/api/halu/config')).json();
    await finishSignIn();
  } catch (e) { setMsg(e.message || 'Sign-in failed.', true); }
  if (S.cfg) await start();
})();
`;

export function renderPage(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HALU</title><style nonce="${nonce}">${STYLE}</style></head><body>
<header><h1>HALU</h1><span>Cross-department intelligence from verified findings</span><span class="sp"></span><button id="out" class="ghost" hidden>Sign out</button></header>
<main>
<section id="auth" class="card" style="grid-column:1/-1" hidden><h2>Sign in</h2><p>Use your work account to see the verified briefings for your workspace.</p><button id="login">Sign in with Microsoft</button></section>
<p id="msg" class="mute" role="status" style="grid-column:1/-1;margin:0"></p>
<aside id="app" class="card" hidden><h2>Workspace</h2><select id="ws" aria-label="Workspace"></select><h2>Verified runs</h2><div id="runs"></div></aside>
<section style="display:grid;gap:16px;align-content:start"><div id="detail" class="card"></div>
<div id="ask" class="card" hidden><h2>Ask HALU</h2><textarea id="q" maxlength="1000" placeholder="e.g. Which invoices are over-billed, and by how much?" aria-label="Your question"></textarea><p><button id="go">Ask</button></p><div id="answer" aria-live="polite"></div></div></section>
</main><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
