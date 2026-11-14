// Deterministic operations briefing built from verified ZONAR findings.
// No model involved: every line is a counted fact with traceable evidence, so a
// language-model layer can later explain it but cannot invent it.

const SEVERITY_ORDER = ['high', 'medium', 'low'];
const MAX_EVIDENCE_PER_GROUP = 5;

export function buildBriefing({ run, findings }) {
  if (!run || run.status !== 'succeeded') throw new Error('BRIEFING_REQUIRES_VERIFIED_RUN');
  const groups = new Map();
  for (const finding of findings) {
    const key = finding.code + '|' + finding.severity + '|' + finding.source.dataset;
    let group = groups.get(key);
    if (!group) {
      group = { code: finding.code, severity: finding.severity, dataset: finding.source.dataset, count: 0, evidence: [] };
      groups.set(key, group);
    }
    group.count++;
    if (group.evidence.length < MAX_EVIDENCE_PER_GROUP) {
      group.evidence.push({
        finding_id: finding.id, file_id: finding.source.file_id, row_number: finding.source.row_number,
        record_id: finding.source.record_id, order_id: finding.source.order_id,
        expected: finding.expected, actual: finding.actual
      });
    }
  }
  const ordered = [...groups.values()].sort((a, b) =>
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.count - a.count || a.code.localeCompare(b.code));
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map(s => [s, findings.filter(f => f.severity === s).length]));
  return {
    run_id: run.id,
    source_processor: run.processor_version,
    completed_at: run.completed_at,
    total_findings: findings.length,
    by_severity: bySeverity,
    groups: ordered,
    // Evidence is capped per group; the full set stays in ZONAR and is reachable by finding id.
    evidence_truncated: ordered.some(g => g.count > g.evidence.length)
  };
}
