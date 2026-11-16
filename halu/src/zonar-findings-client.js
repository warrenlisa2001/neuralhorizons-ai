// Read-only client for ZONAR's verified-findings feed (zonar.findings.v1).
// HALU never writes to ZONAR and only ever sees completed, verified runs.

export const SUPPORTED_SCHEMA = 'zonar.findings.v1';

export class ZonarFeedError extends Error {
  constructor(code, status, detail) { super(code); this.name = 'ZonarFeedError'; this.code = code; this.status = status; this.detail = detail; }
}

// Conditions that mean "do not use this run", not "try again".
const PERMANENT = new Set(['RUN_NOT_FOUND', 'RUN_NOT_COMPLETE', 'RUN_NOT_VERIFIED', 'FINDINGS_UNAVAILABLE_FOR_PROCESSOR',
  'TENANT_ACCESS_DENIED', 'PERMISSION_DENIED', 'UNAUTHORISED', 'INVALID_CURSOR', 'INVALID_LIMIT',
  'INVALID_SEVERITY_FILTER', 'INVALID_DATASET_FILTER', 'INVALID_RESOURCE', 'INVALID_TENANT']);

export function createFindingsClient({ baseUrl, tenantId, getToken, fetchImpl = fetch, maxPages = 200, maxRetries = 3, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!baseUrl || !tenantId || typeof getToken !== 'function') throw new Error('FINDINGS_CLIENT_CONFIG_INCOMPLETE');
  const root = baseUrl.replace(/\/+$/, '');

  async function fetchPage(runId, { cursor, limit, severity, dataset }) {
    const url = runId === null
      ? new URL(`${root}/api/zonar/tenants/${encodeURIComponent(tenantId)}/verified-runs`)
      : new URL(`${root}/api/zonar/tenants/${encodeURIComponent(tenantId)}/reconciliation-runs/${encodeURIComponent(runId)}/findings`);
    if (cursor) url.searchParams.set('cursor', cursor);
    if (limit) url.searchParams.set('limit', String(limit));
    if (severity) url.searchParams.set('severity', severity);
    if (dataset) url.searchParams.set('dataset', dataset);

    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + await getToken(), Accept: 'application/json' }, redirect: 'manual' });
      if (response.ok) {
        const body = await response.json();
        if (body.schema_version !== SUPPORTED_SCHEMA) throw new ZonarFeedError('UNSUPPORTED_SCHEMA_VERSION', 200, body.schema_version);
        return body;
      }
      let error = 'UNKNOWN';
      let detail;
      try { const parsed = await response.json(); error = parsed.error || error; detail = parsed.run; } catch { /* non-JSON error body */ }
      const transient = !PERMANENT.has(error) && (response.status === 429 || response.status >= 500);
      if (!transient || attempt >= maxRetries) throw new ZonarFeedError(error, response.status, detail);
      await sleep(250 * 2 ** attempt);
    }
  }

  return {
    /** Async-iterate every finding of a verified run; yields { run, finding }. */
    async *iterateFindings(runId, filters = {}) {
      let cursor = null;
      for (let page = 0; page < maxPages; page++) {
        const body = await fetchPage(runId, { ...filters, cursor });
        for (const finding of body.findings) yield { run: body.run, finding };
        cursor = body.page.next_cursor;
        if (!cursor) return;
      }
      throw new ZonarFeedError('PAGE_LIMIT_EXCEEDED', 0);
    },
    /** One page of verified, completed runs after an opaque cursor (null = from the start). */
    async listVerifiedRuns({ cursor = null, limit = 50 } = {}) {
      const body = await fetchPage(null, { cursor, limit });
      return { runs: body.runs, nextCursor: body.page.next_cursor, hasMore: body.page.has_more === true };
    },
    /** All findings of a verified run plus its metadata (present even when there are zero findings). */
    async collectFindings(runId, filters = {}) {
      const findings = [];
      let run = null;
      let cursor = null;
      for (let page = 0; page < maxPages; page++) {
        const body = await fetchPage(runId, { ...filters, cursor });
        run = body.run;
        findings.push(...body.findings);
        cursor = body.page.next_cursor;
        if (!cursor) return { run, findings };
      }
      throw new ZonarFeedError('PAGE_LIMIT_EXCEEDED', 0);
    }
  };
}
