import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()
  .map(n => readFileSync(new URL('../migrations/' + n, import.meta.url), 'utf8')).join('\n');

export function d1(sqlite) {
  return { prepare(sql) { return { bind(...v) { return {
    async run() { const r = sqlite.prepare(sql).run(...v); return { meta: { changes: Number(r.changes || 0) } }; },
    async first() { return sqlite.prepare(sql).get(...v) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...v) }; } }; } }; } };
}
export const newDb = () => { const s = new DatabaseSync(':memory:'); s.exec(migrations); return s; };

/** Seed a tenant with every gate condition satisfied. Override pieces to close one gate. */
export function openGate(sqlite, tenant = 't1', useCase = 'reconciliation_briefing') {
  sqlite.prepare("INSERT OR REPLACE INTO halu_use_cases(tenant_id,use_case_key,title) VALUES(?,?, 'Reconciliation briefing')").run(tenant, useCase);
  sqlite.prepare(`INSERT OR REPLACE INTO halu_definitions(id,tenant_id,term,definition,owner,agreed_by,agreed_at,status)
    VALUES(?,?, 'cancelled order', 'An order withdrawn after confirmation', 'Head of Sales', 'COO', '2026-11-01T00:00:00Z', 'agreed')`).run('def-' + tenant, tenant);
  sqlite.prepare('INSERT OR REPLACE INTO halu_use_case_definitions(tenant_id,use_case_key,definition_id) VALUES(?,?,?)').run(tenant, useCase, 'def-' + tenant);
  sqlite.prepare(`INSERT OR REPLACE INTO halu_readiness(tenant_id,use_case_key,data_ok,data_evidence,blocked_by,assessed_by)
    VALUES(?,?,1,'Checked 3 extracts against source ledgers',NULL,'Data lead')`).run(tenant, useCase);
  sqlite.prepare(`INSERT OR REPLACE INTO halu_boundaries(id,tenant_id,use_case_key,allowed_actions,escalation_owner,signed_by,signed_at)
    VALUES(?,?,?, 'deliver_briefing','Finance Director','CEO','2026-11-02T00:00:00Z')`).run('bl-' + tenant, tenant, useCase);
}
