import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const customer = readFileSync('dist/zonar-os/workspace/customer.html', 'utf8');
const signIn = readFileSync('dist/zonar-os/workspace/sign-in.html', 'utf8');

test('customer workspace is distinct from the illustrative demo workspace', () => {
  assert.match(customer, /Authenticated customer workspace/);
  assert.match(customer, /api\/zonar\/tenants\//);
  assert.doesNotMatch(customer, /DEMO TENANT|Demo Operations|SO-10481/);
  assert.match(customer, /tenant-scoped storage API/);
});

test('customer workspace re-verifies tenant membership before enabling uploads', () => {
  assert.match(customer, /zonar\.selectedWorkspace/);
  assert.match(customer, /\/access/);
  assert.match(customer, /workspaceReady = true/);
  assert.match(customer, /files\/uploads/);
});

test('customer workspace uses persisted upload checkpoints and bounded multipart parts', () => {
  assert.match(customer, /uploaded_parts/);
  assert.match(customer, /8 \* 1024 \* 1024/);
  assert.match(customer, /sessionStorage\.setItem\(checkpointKey\(\)/);
  assert.match(customer, /sessionStorage\.removeItem\(checkpointKey\(\)/);
});

test('customer workspace does not claim that stored uploads are reconciled', () => {
  assert.match(customer, /whole-file integrity verification and the large-file processing pipeline are complete/);
  assert.match(customer, /streaming reconciliation are not yet enabled/);
});

test('verified workspace selection opens the authenticated customer workspace', () => {
  assert.match(signIn, /zonar\.selectedWorkspaceName/);
  assert.match(signIn, /\/zonar-os\/workspace\/customer\.html/);
  assert.doesNotMatch(signIn, /authenticated workspace interface is the next integration step/);
});
