# Zonar tenant audit trail

## Scope

`src/zonar-audit.js` provides append and read primitives for the existing D1 `audit_events` table. It does not add an HTTP route or enable live audit storage.

## Controls

- Append operations require a server-derived tenant ID and optional server-derived actor ID.
- Event type and outcome are validated; all values are parameter-bound.
- Detail payloads are restricted to an explicit metadata key allow-list. Access tokens, passwords, email addresses and arbitrary free-form fields are not accepted.
- Audit reads always filter by tenant ID and use bounded, stable pagination.
- No update or delete function is exposed. Audit rows are append-only by application policy; database-level administrative access remains a separate control.
- Callers must authenticate and enforce the relevant permission before calling this module. Audit readers require `audit:read`.

## Exposed functions

- `appendTenantAuditEvent(db, input)`
- `listTenantAuditEvents(db, tenantId, options)`

## Not enabled yet

D1 is not provisioned or bound. No route currently writes or displays these events, and no live audit stream is active. The unit tests inspect SQL and parameter binding using a D1-shaped test double; run integration tests against a disposable D1 database before enabling customer workloads.

Do not put customer content, credentials, tokens, full email addresses or other sensitive payloads in audit details. Store compact operational metadata only.
