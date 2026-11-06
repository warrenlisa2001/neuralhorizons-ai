import { authenticateZonarIdentity } from './zonar-auth.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    }
  });
}

/**
 * Return only active workspaces belonging to the authenticated identity.
 * No tenant identifier is accepted from the browser, preventing enumeration
 * and avoiding confusion between the Entra directory and a ZONAR workspace.
 */
export async function handleZonarIdentity(request, env) {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!env.ZONAR_DB || typeof env.ZONAR_DB.prepare !== 'function') {
    return json({ error: 'TENANT_AUTH_NOT_CONFIGURED' }, 503);
  }

  const authentication = await authenticateZonarIdentity(request, env);
  if (!authentication.ok) return json({ error: authentication.error }, authentication.status);

  try {
    const rows = await env.ZONAR_DB.prepare(
      `SELECT t.id, t.name, m.role
       FROM users u
       INNER JOIN memberships m ON m.user_id = u.id
       INNER JOIN tenants t ON t.id = m.tenant_id
       WHERE u.identity_issuer = ?1
         AND u.identity_subject = ?2
         AND u.status = 'active'
         AND m.status = 'active'
         AND t.status = 'active'
       ORDER BY t.name COLLATE NOCASE
       LIMIT 50`
    ).bind(authentication.identity.issuer, authentication.identity.subject).all();

    return json({
      authenticated: true,
      workspaces: (rows.results || []).map(row => ({
        id: row.id,
        name: row.name,
        role: row.role
      }))
    });
  } catch {
    return json({ error: 'TENANT_AUTH_UNAVAILABLE' }, 503);
  }
}
