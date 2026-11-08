# ZONAR live operational intelligence foundation

## Product boundary

ZONAR OS is the reusable, multi-tenant Neural Horizons AI product. MASAFIOS remains a separate internal reference implementation and source of anonymised operational examples. Do not link the MASAFIOS repository, expose client-identifying names, or copy raw client records into public assets.

The ZONAR application must remain independent of MASAFIOS. Any demonstration dataset must be explicitly sanitised, reviewed for re-identification risk and imported through the same tenant-scoped ingestion path intended for customer data.

## Current verified starting point

The repository already contains:
- Provider-neutral OIDC/JWT verification and tenant membership checks.
- Role-to-permission policy and tenant-scoped D1 access patterns.
- Tenant-scoped CSV upload/list endpoints using D1 metadata and R2 objects.
- A deterministic orders/invoices/deliveries reconciliation pipeline.
- Reconciliation run and result persistence code with source/result checksum verification.
- Unit tests for the above boundaries.

The current Worker configuration does not declare the ZONAR D1 or R2 bindings. The migrations have not been applied to a live ZONAR database, no identity provider is configured, and live staging end-to-end tests have not been evidenced. Reconciliation is synchronous and bounded. Do not accept customer data or describe the service as production-live until the release gates below pass.

## New schema in migration 0003

The file migrations/0003_operational_intelligence.sql introduces two distinct business-intelligence stores:

1. **operational_events**: tenant-scoped business exceptions and operational signals, separate from security audit_events. Each event has a controlled event code, severity, lifecycle status, source provenance, timestamps and optional monetary exposure stored as integer minor units plus ISO currency.
2. **metric_snapshots**: immutable, tenant-scoped point-in-time metric calculations associated with a reconciliation run where applicable.

The schema enforces same-tenant reconciliation provenance, immutable source attribution, bounded metric JSON, non-negative integer monetary exposure and status timestamps. It does not itself generate events or metrics, expose an API, provision Cloudflare resources or create a live feed.

## Target data flow

1. **Source intake** — authenticated tenant uploads, approved connector webhooks or scheduled connector pulls.
2. **Validation and staging** — file type/encoding/shape checks, source checksum, schema mapping, data-quality results and immutable source provenance.
3. **Processing** — server-side normalisation, reconciliation, exception detection and calculation of exposure. Distinguish calculated exposure, suspected leakage, confirmed loss and verified recovery; never label a discrepancy as recovered revenue.
4. **Operational event creation** — convert validated exceptions into durable operational_events rows. Deduplicate by tenant, source and business record so retries do not create duplicate alerts.
5. **Metric snapshots** — persist reproducible metric snapshots tied to the source run and processor version.
6. **Workspace API** — tenant-authorised endpoints return current metrics, event history, event status and processing freshness.
7. **Live presentation** — begin with authenticated polling and a visible last-successful-sync timestamp. Add streaming only when the data source and event lifecycle justify it.
8. **HALU action layer** — recommendations first; any external action requires explicit policy, scoped credentials, human approval where configured, idempotency and a complete audit record.

## Honest meaning of “live”

A live workspace means new, persisted, server-processed source events or connector updates change the dashboard. It does not mean a browser timer, random counter, rotating sample values or a timestamp that says “now”.

When a demo uses a fixed anonymised dataset, the page must call it an illustrative replay or demonstration dataset. A replay can demonstrate the event-processing interface, but it must never be presented as a live customer feed. Every feed item must expose its source type and event time; every metric must show its source and calculation/update time.

## Scale and reliability requirements

The current CSV path is a bounded first implementation (2 MB, 10,000 rows and synchronous request processing). Those are not acceptable production ceilings. Before production, replace the request-bound processing path with streamed/chunked uploads and asynchronous queue or workflow processing, with configurable tenant quotas, file-size controls, row/column limits, job concurrency, retries, dead-letter handling, cancellation, idempotency and progress state. Browser-local profiling must not be the production processing engine.

Use D1 for tenant metadata, event state and metric history; private R2 for source files and larger result artefacts; and Cloudflare Queues or Workflows for durable background processing when the workload and retry model are defined. Keep raw source data out of logs and event summaries.

## Identity and Microsoft positioning

The authentication boundary is provider-neutral and requires exact issuer, audience, JWKS and delegated API-scope configuration. Microsoft Entra ID is the intended identity-provider integration to validate in a dedicated staging environment; it is not currently connected or production-configured. Do not claim Microsoft partnership, certification, Azure hosting or a completed Entra integration. ZONAR remains platform-independent and can be integrated with customer systems through approved connectors.

## Build sequence

- **Foundation (this branch):** add durable operational event and metric snapshot schema plus migration tests.
- **Event generation:** map reconciliation outputs to deterministic, deduplicated operational events and metric snapshots.
- **Read APIs:** add tenant-authorised, permission-checked metrics and event-history endpoints with bounded pagination.
- **Workspace connection:** replace hard-coded sample KPIs and event cards with API responses; show source, freshness and empty/error states.
- **Sanitised demo tenant:** import the reviewed anonymised operational dataset using the same ingestion/reconciliation path; label historical/replayed data clearly.
- **Production hardening:** provision isolated staging D1/R2, configure identity, apply migrations, run live cross-tenant tests, backup/restore tests, observability and security review.
- **Scale and HALU:** move large jobs to durable asynchronous processing; add governed recommendations and then authorised actions.

## Release gates

Do not deploy this migration to production or enable customer ingestion merely because the code is merged. First provision separate staging resources, apply migrations in order, configure a verified identity provider and secrets, provision tenant membership, test tenant isolation and failure paths against live D1/R2, prove backup restoration, and review monitoring and retention. Only then consider a controlled customer pilot.
