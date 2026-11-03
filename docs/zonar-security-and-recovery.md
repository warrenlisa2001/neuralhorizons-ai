# Zonar security, backup and recovery baseline

## Purpose

Security, backup and recoverability are product requirements for Zonar. This document records the verified starting point and the controls required before customer data is stored or operational workflows are enabled.

## Verified current state

- The Cloudflare Worker serves the static site and exposes `POST /api/zonar/profile`.
- The profile endpoint authenticates with one Worker secret, `ZONAR_UPLOAD_TOKEN`.
- The endpoint reads CSV data in memory and returns a structural profile; it does not persist uploads.
- The Worker configuration currently declares the static-assets binding only. No R2 bucket or D1 database binding is configured.
- The endpoint has request-size, row-count and column-count limits and rejects unsupported media types and invalid UTF-8.
- The endpoint currently has no user identity, role-based permissions, per-user revocation, durable upload history, or independent backup workflow.
- The public Zonar page is a static HTML page; the current repository search did not identify a production upload form connected to the profile endpoint.
- A single shared bearer secret is a temporary integration control, not a complete user access-management system.

## Multi-business tenancy decision

Zonar is being designed as a multi-business platform from the beginning. Each business (tenant) must have a private workspace and its own users, data, files, processing history and audit records.

Mandatory tenant-isolation rules:
- Every tenant-owned record and object must carry a server-assigned tenant identifier.
- The server must derive tenant access from the authenticated identity and its membership; never trust a tenant identifier supplied by the browser as proof of access.
- Every read, write, export, delete, background job and agent action must enforce tenant membership and permissions.
- Storage object keys and database queries must be tenant-scoped, with deny-by-default access.
- Users must not be able to enumerate other tenants, access their files, infer their records through error messages, or change tenant ownership.
- Administrative and support access must be separately permissioned, logged and reviewable.
- Automated tests must attempt cross-tenant reads, writes, exports, object access and identifier substitution, and confirm denial.
- Tenant isolation must be verified before customer data is accepted or agents are connected.

## Security baseline

### Identity and access
- Replace the shared upload secret as the user-facing access model with individual authenticated identities.
- Require MFA for privileged users.
- Enforce role-based access and least privilege on every protected API route.
- Support immediate account/session revocation and credential rotation.
- Keep all privileged credentials server-side; never embed them in browser JavaScript or static HTML.

### Application and API
- Use Cloudflare WAF and rate limiting at the edge, with explicit rules for Zonar routes.
- Validate HTTP method, content type, body size, file type, encoding and input structure server-side.
- Return generic authentication errors; never reveal credential lengths, comparison details, or whether a particular account exists.
- Add CSRF protection where cookie-based sessions are used, strict CORS allow-lists where cross-origin access is required, and secure session cookie settings.
- Add security headers for the public site and application, including a carefully tested Content Security Policy, HSTS, frame restrictions, and content-type protection.
- Avoid logging uploaded business data, credentials, session tokens, or sensitive response bodies.
- Scan dependencies and run automated tests and static analysis on every pull request.

### Data protection
- Encrypt data in transit and use provider-managed or customer-managed encryption at rest where available.
- Keep original uploads immutable and associate every derived profile, validation and reconciliation result with its source and version.
- Separate customer/workspace data and enforce tenant boundaries in every read and write.
- Record access, export, deletion, permission changes and administrative actions in an audit trail.
- Define retention and deletion with the data owner and applicable legal obligations; do not silently expire data on an arbitrary timer.

### Backup and recovery
- Keep production data separate from backups.
- Maintain encrypted, versioned backups in a separate account or security boundary, with separate credentials and least-privilege access.
- Use immutable or retention-locked copies where the chosen services and plan support them.
- Back up source data, metadata, derived outputs, schemas, configuration and recovery documentation.
- Back up application source through Git history and maintain an independent repository/export backup.
- Never store plaintext secrets in Git; maintain a controlled secret-recovery and rotation procedure.
- Monitor backup success and failures, and alert on deletion or configuration changes.
- Test restoration regularly and record recovery time and recovery point results.

## Implementation sequence

1. **Harden the current endpoint:** remove verbose authentication diagnostics, keep generic 401 responses, and test missing and incorrect credentials. This change is being prepared on a separate branch and is not a production deployment.
2. **Establish identity:** choose the identity provider and implement individual users, MFA, roles, tenant boundaries and revocation before exposing uploads through the browser.
3. **Design durable storage:** select private object storage for original uploads and a database for metadata, versions, processing status and audit records.
4. **Design independent backups:** select a separate backup destination/account, encryption, versioning/immutability, schedules, alerts and restoration procedures.
5. **Secure the edge and application:** configure WAF, rate limits, CORS, CSRF where applicable, security headers, logging and monitoring.
6. **Connect the Zonar interface:** use authenticated sessions and short-lived scoped upload authorisation; do not expose the Worker secret to the browser.
7. **Test before production:** run automated security tests, access-control tests, upload abuse tests, backup restore tests and a production readiness review.

## Release gate

Do not enable persistent customer-data ingestion or connect autonomous agents to customer data until identity and access control, tenant isolation, encryption, audit logging, independent backups, alerting and a successful restore test have been verified.

## Important limitations

This is an initial source-code and configuration review, not a penetration test or a certification. Cloudflare account settings, DNS, WAF rules, account MFA, access logs, secret rotation history, GitHub repository permissions and actual backup configuration have not been independently inspected. Their status must be verified in the relevant provider dashboards.
