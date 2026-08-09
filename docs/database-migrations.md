# Database migration baseline and ledger

The backend uses a small project-native runner. It is deliberately separate
from `server.js`; normal application startup never creates or changes schema.

## Current boundary

- `/sql` is historical, pre-baseline evidence. The runner never replays it.
- `migrations/baseline/schema-manifest.json` records the accepted live legacy
  schema, excluding only the migration ledger itself.
- `migrations/managed` is the only directory for future managed migrations.
- No business-domain migration is included in the baseline task.

## Commands

```bash
npm run migrate -- list
npm run migrate -- status
npm run migrate -- run --dry-run
npm run migrate -- run
```

Creating the one legacy baseline marker is an explicit, separately confirmed
operation:

```bash
MIGRATION_ACTOR='<operator>' \
MIGRATION_RELEASE_ID='<release-or-worktree-identity>' \
npm run migrate -- baseline --confirm BASELINE_CURRENT_SCHEMA
```

`manifest` is read-only and prints a fresh deterministic manifest for review:

```bash
npm run migrate -- manifest
```

## Safety semantics

The runner acquires the MySQL advisory lock
`crusher_parts_db:schema_migrations:v1`. It verifies ordered unique migration
versions, immutable SQL checksums, ledger history, and the latest stored schema
fingerprint before applying anything. Existing successful migrations are
skipped. Drift, a missing applied file, a held lock, an out-of-order ledger, or
a `RUNNING`/`FAILED` record fails closed.

Before each migration the ledger writes `RUNNING`. On success it stores
`APPLIED`, duration, actor/release identity, SQL checksum, and the resulting
schema fingerprint. On error it stores a redacted summary and `FAILED`, then
stops. The runner does not claim automatic rollback for MySQL DDL; inspect the
database and prepare a reviewed forward-fix.

If the failure partially committed MySQL DDL, keep the failed file immutable,
add a later managed migration, verify that the current fingerprint still equals
the fingerprint captured by the FAILED row, then acknowledge only that named
forward-fix:

```bash
npm run migrate -- recover \
  --migration <failed-migration-id> \
  --forward-fix <later-forward-fix-id> \
  --confirm ACKNOWLEDGE_PARTIAL_DDL_FORWARD_FIX
```

The FAILED row and error remain in the ledger. Recovery metadata names the
forward-fix and permits the runner to use the observed partial fingerprint as
its next expected state; no failed SQL is edited or replayed.

Before a high-risk database change, independently verify a recent backup or
accepted dump and keep an application rollback target. The baseline manifest
records the evidence used for the initial marker.
