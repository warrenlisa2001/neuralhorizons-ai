import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEntraTokenProvider } from '../src/entra-token.js';
import { createFindingsClient } from '../src/zonar-findings-client.js';

const here = dirname(fileURLToPath(import.meta.url));

function sources(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.js') ? [full] : [];
  });
}

// The Cloudflare Workers runtime throws on redirect: 'error' ("won't be implemented"), so a
// request using it fails before it is sent. Use 'manual' and treat any 3xx as a failure.
test('no Worker source uses redirect: error', () => {
  const offenders = [...sources(join(here, '..', 'src')), ...sources(join(here, '..', '..', 'src'))]
    .filter(file => /redirect\s*:\s*['"]error['"]/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('a redirect from Entra is a failure, not a token', async () => {
  let seen;
  const fetchImpl = async (_url, init) => { seen = init.redirect; return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/' } }); };
  const getToken = createEntraTokenProvider({ authorityTenantId: 't', clientId: 'c', clientSecret: 's', scope: 'x/.default', fetchImpl });
  await assert.rejects(getToken(), /ENTRA_TOKEN_REQUEST_FAILED:302/);
  assert.equal(seen, 'manual');
});

test('a redirect from ZONAR is a failure, not data', async () => {
  let seen;
  const fetchImpl = async (_url, init) => { seen = init.redirect; return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/' } }); };
  const client = createFindingsClient({ baseUrl: 'https://zonar.example', tenantId: 'tenant_a', getToken: async () => 'tok', fetchImpl });
  await assert.rejects(client.listVerifiedRuns({}), error => error.status === 302);
  assert.equal(seen, 'manual');
});
