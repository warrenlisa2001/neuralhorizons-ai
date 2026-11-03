# Zonar storage, backup and recovery architecture

## Design decision

Use Cloudflare-native services for the first implementation because the current application already runs on Cloudflare Workers, but do not treat Cloudflare's internal redundancy or point-in-time recovery as the complete backup strategy.

Proposed components:
- **R2 primary object storage:** private bucket for original uploads and immutable source artefacts. No public bucket or public custom domain.
- **D1 application database:** tenant records, users/memberships, file metadata, processing states, validation results, reconciliation metadata and audit events. Store large original files in R2, not D1.
- **Independent backup destination:** a separately administered account or a second provider (S3-compatible object storage) for encrypted copies of R2 objects and D1 exports. It must not share the production account's credentials or deletion permissions.
- **Recovery manifests:** record backup run ID, source object/database version, checksums, tenant ID, timestamps, encryption key reference and restore-test status.

## Tenant-safe object layout

Use server-generated opaque IDs; never use customer names or user-supplied paths as authority.

Example logical key layout:
`tenant/<tenant-id>/uploads/<upload-id>/original.csv`
`tenant/<tenant-id>/derived/<upload-id>/<artifact-id>.json`
`tenant/<tenant-id>/exports/<export-id>/result.csv`

The server must authorize tenant membership before resolving any object key. Do not expose R2 bucket credentials or unrestricted object URLs to browsers. Use short-lived, narrowly scoped upload/download authorisation or proxy the operation through the Worker.

## Backup policy requirements

- Back up original files, derived artefacts, database contents, schemas/migrations, audit history, Worker source and deployment configuration.
- Keep at least one independent copy outside the production Cloudflare account, encrypted and access-controlled separately.
- Use separate backup credentials that production Worker code cannot use to delete or overwrite backup copies.
- Use object versioning or immutable retention controls where supported, and alert on any change to those controls.
- Keep checksums and manifests; verify backup completeness and integrity.
- Run scheduled backups and alert on missed/failed jobs.
- Test full and partial restores to an isolated environment before declaring the backup process operational.
- Define recovery point objective (maximum tolerable data loss) and recovery time objective (maximum tolerable outage) before production. Initial planning targets to review: RPO 1 hour for metadata, RPO 24 hours maximum for independent off-account copy, RTO 8 hours. These are proposed targets, not guarantees.
- Do not tell customers that backups are complete until the independent copy has been verified.

## Important Cloudflare capability boundaries

- R2 provides high durability, but durability within the primary provider is not an independent backup. A separate account/provider copy is still required.
- R2 bucket locks can prevent matching objects from being overwritten or deleted for a configured duration, until a date, or indefinitely. This is useful against accidental or malicious deletion, but retention settings must be approved against contractual and data-protection deletion requirements. A lock is not a substitute for an off-account backup.
- D1 Time Travel provides point-in-time recovery for up to 30 days on Workers Paid plans and 7 days on Free plans (per current Cloudflare documentation). It is a recovery feature, not the only backup. Schedule encrypted D1 exports to the independent backup destination.
- D1 restores overwrite the active database state. Before any restore, take a fresh export and restore into a staging database where practical; require an approval and a recorded recovery event.

Official Cloudflare references (checked 3 November 2026):
- R2 durability: https://developers.cloudflare.com/r2/reference/durability/
- R2 bucket locks: https://developers.cloudflare.com/r2/buckets/bucket-locks/
- D1 overview and Time Travel: https://developers.cloudflare.com/d1/
- D1 limits and Time Travel duration: https://developers.cloudflare.com/d1/platform/limits/
- D1 export: https://developers.cloudflare.com/d1/best-practices/import-export-data/

## Security requirements

- R2 buckets remain private; access only through Worker bindings or narrowly scoped server-side credentials.
- Encrypt backup exports before transfer; manage encryption keys separately from the backup storage account.
- Do not put secrets, customer data or backup credentials in GitHub.
- Log backup creation, verification, restore, deletion and retention-policy changes without logging file contents.
- Restrict restore privileges to named administrators with MFA and require a second approval for production restores or destructive actions.
- Keep an incident-response runbook for ransomware, credential compromise, accidental deletion and provider outage.

## Before implementation

The following require explicit configuration in Cloudflare and the chosen backup provider:
1. Create the private production R2 bucket.
2. Create a separate backup bucket/account, ideally outside the production Cloudflare account.
3. Create the D1 database.
4. Configure narrowly scoped Worker bindings and backup-only credentials.
5. Set R2 bucket-lock rules only after the retention/deletion policy has been agreed.
6. Configure scheduled exports/copies, integrity checks, alerts and restore tests.

No storage resources or backup jobs have been created by this document. Do not add placeholder binding names to production configuration or claim backups are active until the resources exist and a restore test passes.
