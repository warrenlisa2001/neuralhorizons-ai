import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFormRequest } from '../src/forms.js';

const post = (body, headers = {}) => new Request('https://www.neuralhorizonsai.com/api/contact', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.neuralhorizonsai.com', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});
const good = { name: 'Sam', email: 'sam@example.com', message: 'Hello' };

test('rejects non-POST', async () => {
  const res = await handleFormRequest(new Request('https://x.test/api/contact'), {}, 'contact');
  assert.equal(res.status, 405);
});
test('rejects foreign origin', async () => {
  const res = await handleFormRequest(post(good, { Origin: 'https://evil.example' }), { FORM_ACCESS_KEY: 'k' }, 'contact');
  assert.equal(res.status, 403);
});
test('validates email and fields', async () => {
  assert.equal((await handleFormRequest(post({ ...good, email: 'nope' }), { FORM_ACCESS_KEY: 'k' }, 'contact')).status, 422);
  assert.equal((await handleFormRequest(post({ email: 'a@b.co' }), { FORM_ACCESS_KEY: 'k' }, 'contact')).status, 422);
});
test('honeypot returns success without sending', async () => {
  let called = false; const orig = globalThis.fetch; globalThis.fetch = async () => { called = true; return new Response('{}'); };
  const res = await handleFormRequest(post({ ...good, website: 'spam' }), { FORM_ACCESS_KEY: 'k' }, 'contact');
  globalThis.fetch = orig; assert.equal(res.status, 200); assert.equal(called, false);
});
test('503 when key missing so the page can fall back to email', async () => {
  assert.equal((await handleFormRequest(post(good), {}, 'contact')).status, 503);
});
test('forwards a valid contact enquiry', async () => {
  let sent; const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ success: true }), { status: 200 }); };
  const res = await handleFormRequest(post(good), { FORM_ACCESS_KEY: 'secret' }, 'contact');
  globalThis.fetch = orig;
  assert.equal(res.status, 200); assert.equal(sent.body.access_key, 'secret'); assert.equal(sent.body.replyto, 'sam@example.com');
});
test('newsletter needs only an email', async () => {
  const orig = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  const res = await handleFormRequest(post({ email: 'a@b.co', source: 'blog-listing' }), { FORM_ACCESS_KEY: 'k' }, 'newsletter');
  globalThis.fetch = orig; assert.equal(res.status, 200);
});
test('delivery failure returns 502', async () => {
  const orig = globalThis.fetch; globalThis.fetch = async () => new Response('{}', { status: 500 });
  const res = await handleFormRequest(post(good), { FORM_ACCESS_KEY: 'k' }, 'contact');
  globalThis.fetch = orig; assert.equal(res.status, 502);
});
