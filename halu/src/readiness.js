// The four-condition readiness gate. A use case runs for a tenant only when all four hold:
// data, defined, governance, free. Pure rules plus D1 lookups; no side effects except the
// decision log. An absent condition is a reason, never a default.

export const USE_CASE_RECONCILIATION_BRIEFING = 'reconciliation_briefing';
export const REQUIRED_ACTION = 'deliver_briefing';

export class GateClosedError extends Error {
  constructor(verdict, reasons) { super('GATE_CLOSED'); this.name = 'GateClosedError'; this.code = 'GATE_CLOSED'; this.verdict = verdict; this.reasons = reasons; }
}

/** First failing condition decides the verdict; data is checked first because it is the slowest to fix. */
export function verdictFrom(c) {
  if (!c.data) return 'on_data';
  if (!c.free) return 'blocked_by_dependency';
  if (!c.defined) return 'once_defined';
  if (!c.governance) return 'on_governance';
  return 'build_now';
}

export async function evaluateReadiness(db, tenantId, useCaseKey, nowIso = new Date().toISOString()) {
  const reasons = [];
  const useCase = await db.prepare(
    "SELECT status FROM halu_use_cases WHERE tenant_id=?1 AND use_case_key=?2"
  ).bind(tenantId, useCaseKey).first();
  if (!useCase || useCase.status !== 'active') {
    return { open: false, verdict: 'not_registered', conditions: { data: false, defined: false, governance: false, free: false },
      reasons: ['use case is not registered and active for this tenant'], boundaryId: null };
  }

  const readiness = await db.prepare(
    'SELECT data_ok, data_evidence, blocked_by FROM halu_readiness WHERE tenant_id=?1 AND use_case_key=?2'
  ).bind(tenantId, useCaseKey).first();
  const data = Boolean(readiness && readiness.data_ok === 1 && String(readiness.data_evidence || '').trim());
  if (!data) reasons.push('no recorded evidence that the required data exists and is trustworthy');
  const free = Boolean(readiness) && !String(readiness.blocked_by || '').trim();
  if (readiness && !free) reasons.push('blocked by a dependency: ' + String(readiness.blocked_by).trim());
  if (!readiness) reasons.push('no readiness assessment recorded');

  const defs = (await db.prepare(
    `SELECT d.term, d.owner, d.status, d.agreed_by
     FROM halu_use_case_definitions u JOIN halu_definitions d ON d.id=u.definition_id AND d.tenant_id=u.tenant_id
     WHERE u.tenant_id=?1 AND u.use_case_key=?2`
  ).bind(tenantId, useCaseKey).all()).results || [];
  const unagreed = defs.filter(d => d.status !== 'agreed' || !String(d.agreed_by || '').trim() || !String(d.owner || '').trim());
  const defined = defs.length > 0 && unagreed.length === 0;
  if (!defs.length) reasons.push('no definitions are linked to this use case');
  for (const d of unagreed) reasons.push(`definition "${d.term}" is not agreed and owned`);

  const boundary = await db.prepare(
    `SELECT id, allowed_actions, escalation_owner, signed_by, valid_until FROM halu_boundaries
     WHERE tenant_id=?1 AND use_case_key=?2 AND status='active' ORDER BY signed_at DESC, id DESC LIMIT 1`
  ).bind(tenantId, useCaseKey).first();
  let governance = false;
  if (!boundary) reasons.push('no active boundary letter');
  else if (!String(boundary.signed_by || '').trim() || !String(boundary.escalation_owner || '').trim()) reasons.push('boundary letter lacks a signer or an escalation owner');
  else if (boundary.valid_until && boundary.valid_until <= nowIso) reasons.push('boundary letter has expired');
  else if (!String(boundary.allowed_actions || '').split(/\s+/).includes(REQUIRED_ACTION)) reasons.push(`boundary letter does not permit "${REQUIRED_ACTION}"`);
  else governance = true;

  const conditions = { data, defined, governance, free };
  const verdict = verdictFrom(conditions);
  return { open: verdict === 'build_now', verdict, conditions, reasons, boundaryId: governance ? boundary.id : null };
}

/** Record a decision. Delivered rows are idempotent per run; withheld rows are written only when the reason changes. */
export async function logDecision(db, { tenantId, useCaseKey, runId = null, decision, verdict, boundaryId = null, detail = null }) {
  if (decision === 'delivered') {
    await db.prepare(
      `INSERT OR IGNORE INTO halu_decision_log (id, tenant_id, use_case_key, run_id, decision, verdict, boundary_id, detail_json)
       VALUES (?1,?2,?3,?4,'delivered',?5,?6,?7)`
    ).bind(`dl_${tenantId}:${useCaseKey}:${runId}`, tenantId, useCaseKey, runId, verdict, boundaryId, detail ? JSON.stringify(detail) : null).run();
    return;
  }
  const last = await db.prepare(
    `SELECT decision, verdict, detail_json FROM halu_decision_log WHERE tenant_id=?1 AND use_case_key=?2 ORDER BY created_at DESC, id DESC LIMIT 1`
  ).bind(tenantId, useCaseKey).first();
  const detailJson = detail ? JSON.stringify(detail) : null;
  if (last && last.decision === 'withheld' && last.verdict === verdict && last.detail_json === detailJson) return;
  await db.prepare(
    `INSERT INTO halu_decision_log (id, tenant_id, use_case_key, run_id, decision, verdict, boundary_id, detail_json)
     VALUES (?1,?2,?3,?4,'withheld',?5,NULL,?6)`
  ).bind('dl_' + crypto.randomUUID(), tenantId, useCaseKey, runId, verdict, detailJson).run();
}

/** Throws GateClosedError (after logging) unless every condition holds. Returns the evaluation when open. */
export async function requireGateOpen(db, tenantId, useCaseKey = USE_CASE_RECONCILIATION_BRIEFING, nowIso) {
  const result = await evaluateReadiness(db, tenantId, useCaseKey, nowIso);
  if (!result.open) {
    await logDecision(db, { tenantId, useCaseKey, decision: 'withheld', verdict: result.verdict, detail: { reasons: result.reasons } });
    throw new GateClosedError(result.verdict, result.reasons);
  }
  return result;
}
