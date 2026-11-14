import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb, d1, openGate } from './helpers.mjs';
import { evaluateReadiness, requireGateOpen, verdictFrom, GateClosedError, logDecision } from '../src/readiness.js';

const UC = 'reconciliation_briefing';
const NOW = '2026-11-14T10:00:00.000Z';

test('verdict follows the first failing condition', () => {
  const all = { data: true, defined: true, governance: true, free: true };
  assert.equal(verdictFrom(all), 'build_now');
  assert.equal(verdictFrom({ ...all, data: false, defined: false }), 'on_data');
  assert.equal(verdictFrom({ ...all, free: false }), 'blocked_by_dependency');
  assert.equal(verdictFrom({ ...all, defined: false }), 'once_defined');
  assert.equal(verdictFrom({ ...all, governance: false }), 'on_governance');
});

test('an unregistered tenant or use case is closed, never open by default', async () => {
  const s = newDb(); const db = d1(s);
  const r = await evaluateReadiness(db, 't1', UC, NOW);
  assert.equal(r.open, false); assert.equal(r.verdict, 'not_registered');
  openGate(s, 't1');
  assert.equal((await evaluateReadiness(db, 't1', UC, NOW)).open, true);
  assert.equal((await evaluateReadiness(db, 't2', UC, NOW)).open, false, 'another tenant is not covered by t1');
  assert.equal((await evaluateReadiness(db, 't1', 'other_use_case', NOW)).open, false);
});

test('each of the four conditions can close the gate on its own, with a reason', async () => {
  const cases = [
    ['data', s => s.prepare("UPDATE halu_readiness SET data_ok=0 WHERE tenant_id='t1'").run(), 'on_data', /evidence/],
    ['data (no evidence text)', s => s.prepare("UPDATE halu_readiness SET data_evidence='  ' WHERE tenant_id='t1'").run(), 'on_data', /evidence/],
    ['free', s => s.prepare("UPDATE halu_readiness SET blocked_by='ERP migration in progress' WHERE tenant_id='t1'").run(), 'blocked_by_dependency', /ERP migration/],
    ['defined: draft', s => s.prepare("UPDATE halu_definitions SET status='draft' WHERE id='def-t1'").run(), 'once_defined', /not agreed/],
    ['defined: nobody signed', s => s.prepare("UPDATE halu_definitions SET agreed_by=NULL WHERE id='def-t1'").run(), 'once_defined', /not agreed/],
    ['defined: no owner', s => s.prepare("UPDATE halu_definitions SET owner='' WHERE id='def-t1'").run(), 'once_defined', /not agreed and owned/],
    ['defined: none linked', s => s.prepare("DELETE FROM halu_use_case_definitions").run(), 'once_defined', /no definitions/],
    ['governance: revoked', s => s.prepare("UPDATE halu_boundaries SET status='revoked'").run(), 'on_governance', /no active boundary/],
    ['governance: expired', s => s.prepare("UPDATE halu_boundaries SET valid_until='2026-11-10T00:00:00Z'").run(), 'on_governance', /expired/],
    ['governance: no escalation owner', s => s.prepare("UPDATE halu_boundaries SET escalation_owner=''").run(), 'on_governance', /signer or an escalation/],
    ['governance: action not permitted', s => s.prepare("UPDATE halu_boundaries SET allowed_actions='read_findings'").run(), 'on_governance', /does not permit/]
  ];
  for (const [name, mutate, verdict, reason] of cases) {
    const s = newDb(); openGate(s, 't1'); mutate(s);
    const r = await evaluateReadiness(d1(s), 't1', UC, NOW);
    assert.equal(r.open, false, name); assert.equal(r.verdict, verdict, name);
    assert.ok(r.reasons.some(x => reason.test(x)), `${name}: ${r.reasons}`);
  }
});

test('a boundary letter from another tenant or use case never opens the gate', async () => {
  const s = newDb(); openGate(s, 't1'); openGate(s, 't2');
  s.prepare("UPDATE halu_boundaries SET status='revoked' WHERE tenant_id='t1'").run();
  assert.equal((await evaluateReadiness(d1(s), 't1', UC, NOW)).verdict, 'on_governance');
  assert.equal((await evaluateReadiness(d1(s), 't2', UC, NOW)).open, true);
});

test('requireGateOpen throws and logs a withheld decision once per distinct reason; delivered rows are idempotent', async () => {
  const s = newDb(); const db = d1(s);
  await assert.rejects(requireGateOpen(db, 't1', UC, NOW), e => e instanceof GateClosedError && e.verdict === 'not_registered');
  await assert.rejects(requireGateOpen(db, 't1', UC, NOW), GateClosedError);
  assert.equal(s.prepare("SELECT COUNT(*) c FROM halu_decision_log WHERE decision='withheld'").get().c, 1, 'same reason is not logged every tick');
  openGate(s, 't1'); s.prepare("UPDATE halu_boundaries SET status='revoked'").run();
  await assert.rejects(requireGateOpen(db, 't1', UC, NOW), e => e.verdict === 'on_governance');
  assert.equal(s.prepare("SELECT COUNT(*) c FROM halu_decision_log WHERE decision='withheld'").get().c, 2, 'a new reason is logged');

  await logDecision(db, { tenantId: 't1', useCaseKey: UC, runId: 'r1', decision: 'delivered', verdict: 'build_now', boundaryId: 'bl-t1' });
  await logDecision(db, { tenantId: 't1', useCaseKey: UC, runId: 'r1', decision: 'delivered', verdict: 'build_now', boundaryId: 'bl-t1' });
  assert.equal(s.prepare("SELECT COUNT(*) c FROM halu_decision_log WHERE decision='delivered'").get().c, 1);
});
