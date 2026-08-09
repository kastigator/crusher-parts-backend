# Managed database migrations

Only migrations created after the accepted legacy baseline belong here.

Filename convention:

```text
YYYYMMDDNNNN_lowercase_description.sql
```

The 12-digit numeric prefix is the immutable ordered version. IDs and versions
must be unique. After a migration is applied, neither its filename nor contents
may change. Historical files in `/sql` predate the runner and must not be moved,
rewritten, replayed, or marked `APPLIED` one by one.

The runner executes trusted repository SQL explicitly with MySQL multi-statement
support. Do not add transaction/rollback claims to a migration: MySQL DDL can
auto-commit. A failure stops the sequence and requires manual inspection and a
reviewed forward-fix.

If MySQL has partially committed DDL, keep the failed file immutable, add a
later managed forward-fix, and explicitly acknowledge the observed failed
fingerprint with `migrate recover`. The FAILED row remains visible evidence;
acknowledgement only permits the named later file to repair that exact state.
