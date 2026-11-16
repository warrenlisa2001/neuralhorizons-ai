# ZONAR operational events API

This document describes the tenant-scoped operational event foundation introduced by migration `0004_operational_event_delivery.sql`.

## Event creation

A successful reconciliation run materialises its deterministic exceptions into `operational_events` before the run is marked successful. Each event is linked to the tenant and reconciliation run that produced it.

- Source kind: `reconciliation`
- Source reference: deterministic exception code, dataset and record reference
- Idempotency: unique tenant/run/source-reference index plus `INSERT OR IGNORE`
- Provenance: source facts, severity, summary and details are immutable
- Details: only an explicit allowlist of exception attributes is persisted; raw source rows are not copied into event details
- Monetary exposure: no value is inferred from quantity/value mismatches; exposure remains null unless a later trusted calculation supplies both amount and currency

Event inserts are batched in groups of 50. A failed reconciliation removes any partially materialised events for that run before marking the run failed. This is an incremental synchronous implementation; it is not yet the production asynchronous ingestion/job architecture.

## API

All endpoints require a verified ZONAR access token and active membership in the tenant named in the path.

### List events

`GET /api/zonar/tenants/{tenantId}/operational-events?limit=50&status=open&severity=high`

- Permission: `events:read`
- Limit: 1–100 (default 50)
- Optional status: `open`, `acknowledged`, `resolved`, `dismissed`
- Optional severity: `info`, `low`, `medium`, `high`, `critical`
- Results are tenant-scoped and ordered newest first.
- Response details may contain tenant-owned source identifiers; never expose this feed across tenant boundaries.

### Acknowledge, resolve or dismiss

`PATCH /api/zonar/tenants/{tenantId}/operational-events/{eventId}`

Body examples:

```json
{"status":"acknowledged"}
```

```json
{"status":"resolved"}
```

```json
{"status":"dismissed"}
```

- Permission: `events:manage`
- Allowed transitions: `open → acknowledged → resolved` or `open → acknowledged → dismissed`
- Each transition records the authenticated actor and timestamp.
- Invalid transitions return `409`; cross-tenant IDs are not discoverable through this API.

## Role policy

| Role | Read events | Manage events |
|---|---:|---:|
| Tenant owner | Yes | Yes |
| Tenant admin | Yes | Yes |
| Analyst | Yes | No |
| Operator | Yes | Yes |
| Viewer | Yes | No |

## Deployment boundary

Migration 0004 must be applied to the intended D1 database before these endpoints can operate. This PR does not apply migrations, create production bindings, configure the identity provider, deploy the Worker, or enable a customer-facing live feed.
