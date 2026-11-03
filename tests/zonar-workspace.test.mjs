import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../dist/zonar-os/workspace/index.html', import.meta.url), 'utf8');

test('Zonar workspace exposes a functional local demo dashboard', () => {
  assert.match(page, /Business overview/);
  assert.match(page, /Data intake &amp; profiling/);
  assert.match(page, /Recommended next actions/);
  assert.match(page, /type="file" accept="\.csv,text\/csv"/);
  assert.match(page, /No file was uploaded to a server/);
  assert.match(page, /function csvRows/);
  assert.match(page, /function renderSignals/);
});

test('Zonar workspace does not embed shared upload credentials or call the legacy profile API', () => {
  assert.doesNotMatch(page, /ZONAR_UPLOAD_TOKEN/);
  assert.doesNotMatch(page, /\/api\/zonar\/profile/);
  assert.doesNotMatch(page, /Authorization\s*:/);
});
