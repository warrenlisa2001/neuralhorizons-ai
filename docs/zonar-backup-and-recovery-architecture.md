# Zonar backup and recovery architecture

## Non-negotiable outcome

Customer data must remain recoverable after accidental deletion, application defects, compromised application credentials, account compromise, ransomware-style destructive actions, and infrastructure failure. A successful upload is not considered safely onboarded until its backup path and restore test are in place.

## Proposed data layout

- Cloudflare R2 primary bucket: immutable original upload objects, derived outputs and report artefacts. Use opaque server-generated object keys, never user filenames as paths. Tenant ID is a server-derived prefix/metadata attribute; authorization is checked before every read, write, list, download or delete.
- Cloudflare D1: tenant, user, membership, invitation, file metadata, processing jobs, report references, retention state and audit-event metadata.
- GitHub: application source and migration history. Keep secrets and customer data out of Git.
- Independent backup destination: separate provider or separately administered cloud account, with separate credentials and access policies. Copy encrypted object data and scheduled D1 exports there. Do not treat a second bucket under the same compromised admin identity as the only independent backup.

## R2 protection

Cloudflare documents R2 encryption at rest and TLS for data in transit. R2 durability is not the same as protection from intentional or accidental deletion. Bucket Locks can prevent overwrite and deletion for a configured period or indefinitely.

Recommended configuration, subject to legal retention and customer contracts:
1. Primary customer objects are versioned by application-level immutable object keys; every replacement creates a new object and new metadata version.
2. Enable a Bucket Lock retention rule on the backup prefix/bucket after deciding a retention period with legal review.
3. Backup writer credentials can create backup objects but cannot list/delete/alter bucket-lock policy; normal application credentials cannot administer backup retention.
4. Separate backup account/provider credentials and alert on policy changes, mass deletion, unexpected export or backup failures.
5. Keep customer-requested deletion workflow distinct from backup retention. Deletion requests must be tracked and completed across primary and backup copies when legally required; a lock policy must not silently contradict contractual or legal deletion duties.

Important: Indefinite lock is not automatically the right answer. It can conflict with data minimisation, privacy rights and customer deletion commitments. Choose retention periods deliberately.

## D1 protection

D1 Time Travel provides point-in-time restore. Current Cloudflare documentation states up to 30 days on Workers Paid and 7 days on Workers Free; confirm the actual account plan and database storage version before relying on it. A restore overwrites the database in place.

Therefore:
- Use D1 Time Travel as an operational recovery mechanism, not the only long-term backup.
- Schedule regular D1 SQL exports to the independent backup destination.
- Retain schema migrations and a tested rebuild procedure.
- Before any restore, export the current state, identify the recovery point, stop writes, restore into a controlled recovery environment where possible, validate tenant counts/relationships/audit continuity, then cut over.
- Record recovery operator, timestamp, selected bookmark/export, validation results and approval.

## Backup schedule and targets (proposed, not yet agreed)

- D1 independent export: daily, plus before schema migrations and high-risk data changes.
- R2 customer objects: backup/copy on successful ingest and after each derived artefact is committed.
- GitHub source: repository history plus scheduled independent repository export.
- Backup monitoring: alert on missed schedule, failed copy, unexpected volume drop, access-policy changes and backup destination access.
- Restore exercise: quarterly at minimum and after material architecture changes.

Initial service objectives to validate with Lisa and customer contracts:
- RPO (maximum tolerable data loss): 24 hours for metadata; zero loss after a successfully acknowledged object copy for original uploads.
- RTO (target restoration time): 8 business hours for core service, subject to tested scale and dependencies.

These are proposed targets, not achieved guarantees.

## Recovery test requirements

A restore test is successful only when it proves:
1. A D1 export can be restored to a separate recovery database.
2. Original R2 objects and derived outputs can be recovered from the independent destination.
3. Metadata references resolve to the correct objects.
4. Tenant boundaries remain intact after restoration.
5. A user in tenant A cannot access tenant B's restored data.
6. Audit events and retention/deletion state are reconciled.
7. The application can run against the restored environment.
8. Evidence, duration, data counts, exceptions and operator are recorded.

## Current verified state and limitations

- Existing `wrangler.jsonc` declares only the static assets binding `ASSETS`; no D1 or R2 binding is currently declared.
- The existing CSV profile endpoint processes in memory and explicitly reports `storage: not_stored`.
- No customer data persistence or backup destination is implemented by this design document.
- No Cloudflare account, R2 bucket, D1 database, bucket lock, independent backup account, alerting policy or restore test has been inspected or configured from this repository connection.
- This document is architecture and release criteria, not proof of deployed protection.

## Release gate

Do not enable customer data persistence, customer CSV upload UI, or autonomous agents operating on customer data until:
- Identity and tenant authorization are implemented and independently tested.
- R2 and D1 access is tenant-scoped server-side.
- Encryption, secrets handling, audit events and security alerts are verified.
- Independent backups are running.
- At least one end-to-end restore test has passed.
- Retention and deletion policy has been reviewed against applicable law and customer contracts.
