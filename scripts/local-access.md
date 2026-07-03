# Local Access Shortcuts

Updated: 2026-07-03

These scripts are for local backend/database and bucket work. They read settings from:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/.env.local
```

Do not print, copy, commit, or paste secrets from `.env.local`, `google-credentials.json`, or files under `keys/`.

For full project context, GCP resources and deploy notes, see:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md
```

## Google Cloud

Project:

```text
partsfinsad
```

Cloud SQL instance:

```text
partsfinsad:europe-west4:parts
```

Database:

```text
crusher_parts_db
```

Activate local `gcloud` access when needed:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
gcloud auth activate-service-account \
  138584652803-compute@developer.gserviceaccount.com \
  --key-file=/Users/aleksandrlubimov/project/crusher-parts-backend/google-credentials.json \
  --project=partsfinsad
gcloud config set project partsfinsad
```

Check active project/account:

```bash
gcloud auth list --filter=status:ACTIVE --format='value(account)'
gcloud config get-value project
```

## Database

Start only Cloud SQL proxy:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./cloud-sql-proxy --port 3306 partsfinsad:europe-west4:parts --credentials-file=./google-credentials.json
```

Open SQL shell:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/db-connect.sh
```

Run one query:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/db-query.sh "SELECT 1 AS ok, DATABASE() AS db"
```

Run SQL file:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/db-run.sh ./sql/some-migration.sql
```

When writing one-off Node.js DB diagnostics, prefer requiring `utils/db.js` with `NODE_ENV=local`. That module knows how to load `.env.local`.

## GCS Bucket

List bucket root:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/bucket-ls.sh
```

List folder:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/bucket-ls.sh exports
```

Copy file:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/bucket-cp.sh ./local.xlsx gs://shared-parts-bucket/path/local.xlsx
./scripts/bucket-cp.sh gs://shared-parts-bucket/path/local.xlsx ./local.xlsx
```

## Current Product Path

For classifier/BOM/card work, always start from:

```text
Classifier -> equipment model -> model BOM -> position card
```

Old standalone OEM/original-parts and standard-parts paths are not current product paths.
