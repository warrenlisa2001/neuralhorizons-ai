# ZONAR staging — Microsoft Entra ID

## Scope

This branch introduces an isolated staging Worker configuration, a Microsoft Entra sign-in screen, a delegated-scope check in the API token verifier, and an authenticated workspace-discovery endpoint.

It does **not** deploy anything, configure DNS, create Cloudflare resources, provision a ZONAR customer workspace, or make the existing demo dashboard production-ready.

## Entra application values

Directory (tenant) ID: `c6993c9c-10dd-4cfe-ba91-157272624bd6`

Client application — ZONAR Staging Client:
- Client ID: `3a58f4fa-a366-4b64-9798-d2d5995183b5`
- Account type: single tenant
- Platform: Single-page application (SPA)
- Redirect URI to add after the staging hostname is attached to the Worker:
  `https://zonar-staging.neuralhorizonsai.com/zonar-os/workspace/sign-in.html`

Resource application — ZONAR Staging API:
- Application/client ID: `68673793-9332-440b-ab12-d181b1128a17`
- Application ID URI: `api://68673793-9332-440b-ab12-d181b1128a17`
- Delegated permission: `access_as_user`

The client registration already has Microsoft Graph `User.Read` and the API's `access_as_user` delegated permission, with admin consent granted. The browser uses the MSAL redirect flow; no client secret is used or placed in browser code.

## Staging Worker

Configuration file: `wrangler.zonar-staging.jsonc`

The staging Worker is named `zonar-staging` and serves the repository's `dist` assets. It is separate from the production Worker configuration in `wrangler.jsonc`.

Before deployment:
1. Create a new Cloudflare D1 database named `zonar-staging-db`.
2. Replace `REPLACE_WITH_STAGING_D1_DATABASE_ID` in the staging config with the ID returned by Cloudflare.
3. Create a separate R2 bucket named `zonar-staging-files`.
4. Apply migrations to the staging D1 database, in order, using the staging configuration.
5. Attach the custom domain `zonar-staging.neuralhorizonsai.com` to the staging Worker. Do not add this hostname to the production Worker.
6. Confirm the tenant-specific OpenID metadata at:
   `https://login.microsoftonline.com/c6993c9c-10dd-4cfe-ba91-157272624bd6/v2.0/.well-known/openid-configuration`
   The configured issuer and JWKS URL must exactly match the returned `issuer` and `jwks_uri`.

The staging config sets:
- `ZONAR_ISSUER`: tenant-specific Entra v2 issuer
- `ZONAR_AUDIENCE`: API application/client ID
- `ZONAR_JWKS_URL`: tenant-specific Entra v2 signing keys
- `ZONAR_REQUIRED_SCOPE`: `access_as_user`

No client secret is required. Do not add one to the SPA.

## API behaviour

`GET /api/zonar/me`:
- Requires a Bearer access token issued for the ZONAR API.
- Verifies RS256 signature, issuer, audience, expiry and the delegated `scp` claim containing `access_as_user`.
- Resolves the user's active identity and memberships from D1.
- Returns only active workspaces and their server-held roles.
- Does not accept a customer tenant ID from the browser and does not auto-provision users or memberships.

Existing tenant-scoped endpoints use the same token verifier and D1 membership checks. A valid Microsoft sign-in alone is not sufficient for customer workspace access.

## Current boundary / remaining work

The sign-in screen is an authentication and membership-discovery foundation. The existing `workspace/index.html` remains a demo dashboard with illustrative sample orders and local-only CSV profiling. It must not be represented as a live customer workspace.

Before customer use, complete and test:
- D1/R2 resource creation and migrations on staging only.
- Explicit user and tenant membership provisioning.
- Entra redirect URI registration after the hostname is live.
- A real browser sign-in and API token test.
- Protected workspace integration, including tenant selection and server-side API calls.
- Upload and reconciliation workflow integration with the authenticated tenant endpoints.
- Negative tests for missing scope, wrong audience, expired token and cross-tenant access.

## Deployment safety

Never deploy `wrangler.jsonc` changes or the staging config to the production Worker by accident. Use the explicit staging config file for all staging commands. Do not merge this branch until the staging resources, redirect URI and tests have been reviewed.
