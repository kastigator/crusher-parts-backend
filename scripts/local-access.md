# Local Access Shortcuts

These scripts read connection settings from `.env.local`.

For the full project context, including `gcloud` activation, Cloud SQL proxy, Cloud Build deploys, and verified project resources, see:

- [`PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md)

## Database

Open SQL shell:

```bash
./scripts/db-connect.sh
```

Run one query:

```bash
./scripts/db-query.sh "SHOW TABLES"
```

Run SQL file:

```bash
./scripts/db-run.sh ./sql/some-migration.sql
```

## GCS bucket

List bucket root:

```bash
./scripts/bucket-ls.sh
```

List folder inside configured bucket:

```bash
./scripts/bucket-ls.sh exports
```

Copy file:

```bash
./scripts/bucket-cp.sh ./local.xlsx gs://shared-parts-bucket/path/local.xlsx
./scripts/bucket-cp.sh gs://shared-parts-bucket/path/local.xlsx ./local.xlsx
```

## Notes

- `.env.local` and `google-credentials.json` are already gitignored.
- If a password or key was shown on screen, rotate it.
- For GCS, the scripts use `GOOGLE_APPLICATION_CREDENTIALS` from `.env.local`.
