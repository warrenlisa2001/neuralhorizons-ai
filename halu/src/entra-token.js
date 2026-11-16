// Entra ID client-credentials token provider for HALU -> ZONAR calls.
// The client secret is read by the caller from a secret store and passed in; it is
// never logged and never included in thrown errors.

export function createEntraTokenProvider({ authorityTenantId, clientId, clientSecret, scope, fetchImpl = fetch, now = () => Date.now() }) {
  if (!authorityTenantId || !clientId || !clientSecret || !scope) throw new Error('ENTRA_CONFIG_INCOMPLETE');
  let cached = null;
  let inflight = null;

  async function fetchToken() {
    const response = await fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(authorityTenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope
        }).toString(),
        redirect: 'manual'
      }
    );
    if (!response.ok) throw new Error('ENTRA_TOKEN_REQUEST_FAILED:' + response.status);
    const body = await response.json();
    if (typeof body.access_token !== 'string' || !body.access_token ||
        !Number.isFinite(Number(body.expires_in))) throw new Error('ENTRA_TOKEN_RESPONSE_INVALID');
    return { token: body.access_token, expiresAt: now() + Number(body.expires_in) * 1000 };
  }

  return async function getToken() {
    // Refresh one minute early; share a single in-flight request between callers.
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    if (!inflight) inflight = fetchToken().then(t => { cached = t; return t; }).finally(() => { inflight = null; });
    return (await inflight).token;
  };
}
