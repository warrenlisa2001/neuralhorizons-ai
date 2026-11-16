// D1-backed state for HALU: per-tenant poll cursor and the delivered-briefing log.

export function createD1CursorStore(db, tenantId) {
  return {
    async get() {
      const row = await db.prepare('SELECT cursor FROM halu_cursors WHERE tenant_id=?1').bind(tenantId).first();
      return row ? row.cursor : null;
    },
    async set(cursor) {
      await db.prepare(
        `INSERT INTO halu_cursors (tenant_id, cursor) VALUES (?1, ?2)
         ON CONFLICT(tenant_id) DO UPDATE SET cursor=excluded.cursor, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).bind(tenantId, cursor).run();
    }
  };
}

/** Idempotent: a re-delivered run never creates a second row or overwrites the first. */
export async function saveBriefing(db, payload) {
  await db.prepare(
    `INSERT OR IGNORE INTO halu_briefings (idempotency_key, tenant_id, run_id, completed_at, briefing_json, finance_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(payload.idempotency_key, payload.tenant_id, payload.run_id, payload.briefing.completed_at ?? null,
    JSON.stringify(payload.briefing), JSON.stringify(payload.finance)).run();
}

export async function markWebhookSent(db, idempotencyKey) {
  await db.prepare(
    `UPDATE halu_briefings SET webhook_sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE idempotency_key=?1 AND webhook_sent_at IS NULL`
  ).bind(idempotencyKey).run();
}

export async function webhookAlreadySent(db, idempotencyKey) {
  const row = await db.prepare('SELECT webhook_sent_at FROM halu_briefings WHERE idempotency_key=?1').bind(idempotencyKey).first();
  return Boolean(row && row.webhook_sent_at);
}
