# Crusher Parts Project Context

This is the single local entrypoint for a new Codex/ChatGPT work session on the Crusher Parts project.

The file is intended for local project work. It must not contain secret values, private keys, token values, database passwords, or copied JSON key contents.

Last cleaned and synchronized for a new chat: 2026-07-30.

## Quick Start For A New Chat

Ask the assistant:

```text
Open /Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md and work from that context.
```

Then the assistant should treat this as the main project map for backend, frontend, Google Cloud, Cloud SQL, Cloud Run, Cloud Build, buckets, local development and deploy.

Current classifier/BOM/card handoff, refreshed on 2026-07-30:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/12_current_handoff_2026-07-03.md
```

For classifier, model BOM, catalog position cards, legacy cleanup and current UX decisions, read that file after this project map.

Current commercial/supplier/warehouse handoff:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/13_commercial_supplier_warehouse_refactor_plan_2026-07-26.md
```

For client requests, RFQ, suppliers, supplier parts, warehouse and the commercial contour, read that file after the classifier/BOM/card handoff.

Old task documents that described obsolete OEM/original-parts or standalone standard-parts flows were intentionally removed on 2026-07-03. If they reappear from another branch or old copy, do not treat them as current architecture.

## Local Repositories

Project root:

```text
/Users/aleksandrlubimov/project
```

Backend:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend
```

Frontend:

```text
/Users/aleksandrlubimov/project/crusher-parts-frontend
```

## Current System Purpose

Crusher Parts is a parts/RFQ workflow system:

- equipment classifier;
- equipment model cards;
- manufacturer BOM for equipment models;
- catalog position cards created from BOM lines;
- shared dictionaries for materials, TN VED codes and measurement units;
- supplier parts and supplier links to catalog positions;
- client requests;
- RFQ and supplier responses;
- supplier selection and economics;
- sales quotes to clients;
- client contracts;
- supplier purchase orders;
- clients and suppliers;
- catalog quality checks;
- user activity;
- AI assistant.

Current architecture principle:

```text
Classifier -> equipment model -> model BOM -> position card -> supplier/commercial/warehouse contour
```

Do not treat old OEM/original-parts or standalone standard-parts flows as the active architecture. They may still appear in old docs or legacy cleanup areas, but the working product path is classifier-first.

Current implementation notes as of 2026-07-30:

- BOM row creation/import is intentionally simple: create manufacturer catalog rows first, then arrange assembly structure in the model BOM manually.
- A BOM row is not the same thing as a catalog position card. The card is the shared identity opened from one or more BOM rows.
- Applicability means one card appears in multiple BOM places. Analogs mean different cards are equivalent across manufacturers/models.
- Measurement units and TN VED codes must come from their dictionaries; do not hardcode display units in UI or scripts.
- Warehouse stock should be based on supplier parts, not directly on abstract classifier/BOM rows.

## Google Cloud

GCP project:

```text
partsfinsad
```

Project number:

```text
138584652803
```

Known resources:

- Cloud Run backend service: `crusher-backend`
- Cloud Run region: `europe-west4`
- Backend URL: `https://crusher-backend-hawidorxpa-ez.a.run.app`
- Cloud SQL instance: `partsfinsad:europe-west4:parts`
- Database name: `crusher_parts_db`
- Frontend bucket: `frontend-parts-site`
- Shared documents bucket: `shared-parts-bucket`
- Backend/site bucket: `backend-parts-site`
- Cloud Build backend trigger: `deploy-crusher-backend`
- Cloud Build frontend trigger: `deploy-crusher-frontend`

Public frontend URL:

```text
https://storage.googleapis.com/frontend-parts-site/index.html
```

## Local Google Cloud Access

`gcloud` is installed locally.

Known local key paths:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/google-credentials.json
/Users/aleksandrlubimov/project/crusher-parts-backend/keys/codex-gcp-service-account.json
```

Do not print, copy, commit, or expose the contents of these key files.

Useful service accounts:

- `138584652803-compute@developer.gserviceaccount.com`
- `codex-ops@partsfinsad.iam.gserviceaccount.com`
- `crusher-backend-runtime@partsfinsad.iam.gserviceaccount.com`

Activate direct `gcloud` access when needed:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
gcloud auth activate-service-account \
  138584652803-compute@developer.gserviceaccount.com \
  --key-file=/Users/aleksandrlubimov/project/crusher-parts-backend/google-credentials.json \
  --project=partsfinsad
gcloud config set project partsfinsad
```

Check active account and project:

```bash
gcloud auth list --filter=status:ACTIVE --format='value(account)'
gcloud config get-value project
```

Expected project:

```text
partsfinsad
```

## Local Database Access

Local backend config is loaded from:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/.env.local
```

Expected local database route:

- `DB_HOST=127.0.0.1`
- `DB_PORT=3306`
- `DB_NAME=crusher_parts_db`

If password or exact credentials are needed, read `.env.local` locally. Do not copy secrets into docs, commits, or chat.

Start backend with Cloud SQL proxy:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run start:local
```

Start only Cloud SQL proxy:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./cloud-sql-proxy --port 3306 partsfinsad:europe-west4:parts --credentials-file=./google-credentials.json
```

Keep the proxy process running while using DB scripts.

Check DB access:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/db-query.sh "SELECT 1 AS ok, DATABASE() AS db"
```

When writing temporary Node.js diagnostics against the DB, prefer requiring `utils/db.js` with `NODE_ENV=local` instead of manually loading `.env` first. `utils/db.js` knows how to load `.env.local` for local work; loading the wrong env file first can point scripts at the wrong database.

## Local Development

Start backend and frontend together:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run dev:all
```

Start backend only:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run start:local
```

Start frontend only:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run dev
```

Common local login for browser testing:

```text
login: admin
password: 1234
```

## Deploy

Backend deploy:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:backend
```

Frontend deploy from backend helper:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:frontend
```

Frontend deploy from frontend repo:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run deploy:cloud
```

Deploy both:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:all
```

The project also has automatic Cloud Build/deploy behavior after pushes to the connected repositories.

## Production Configuration

Backend production configuration is not `.env.local`.

Production backend uses:

- Cloud Run environment variables;
- Secret Manager.

Known backend secrets:

- `backend-db-password`
- `backend-jwt-secret`
- `backend-refresh-secret`
- OpenAI API key secret, if configured for AI assistant runtime.

Frontend production configuration is controlled by:

- frontend `cloudbuild.yaml`;
- Cloud Build trigger substitutions.

Important frontend build variable:

- `_VITE_API_URL=https://crusher-backend-hawidorxpa-ez.a.run.app`

## Cloud Storage

Shared documents bucket:

```text
shared-parts-bucket
```

Frontend hosting bucket:

```text
frontend-parts-site
```

Useful scripts:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/bucket-ls.sh
./scripts/bucket-cp.sh ./local.xlsx gs://shared-parts-bucket/path/local.xlsx
./scripts/bucket-cp.sh gs://shared-parts-bucket/path/local.xlsx ./local.xlsx
```

## Verification Commands

Backend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
node -c routes/aiAgent.js
node -c utils/aiAgentContext.js
npm run smoke
```

Frontend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run build
```

Cloud Build:

```bash
gcloud builds list --project partsfinsad --limit=8 \
  --format='table(id,status,source.repoSource.repoName,source.repoSource.revisionId,createTime)'
```

Cloud Run backend:

```bash
gcloud run services describe crusher-backend \
  --project partsfinsad \
  --region europe-west4 \
  --format='value(status.latestReadyRevisionName,status.url)'
```

## AI Assistant Context

The system has an embedded AI assistant in the frontend drawer.

Backend route:

```text
/api/ai-agent/chat
```

Key backend files:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/routes/aiAgent.js
/Users/aleksandrlubimov/project/crusher-parts-backend/utils/aiAgentContext.js
/Users/aleksandrlubimov/project/crusher-parts-backend/utils/aiAgentDomainContext.js
/Users/aleksandrlubimov/project/crusher-parts-backend/utils/aiAgentFiles.js
/Users/aleksandrlubimov/project/crusher-parts-backend/utils/aiAgentSystemDocuments.js
```

Frontend files:

```text
/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/ai/AIAssistantDrawer.jsx
/Users/aleksandrlubimov/project/crusher-parts-frontend/src/styles/global.css
```

The assistant currently supports:

- system/domain explanations;
- business search;
- client timeline;
- RFQ timeline;
- catalog quality queues;
- measurement unit usage;
- TN VED duty lookup;
- draft TN VED assignment candidates;
- system document lookup/read from GCS for supported scopes;
- file upload analysis for PDF/images/Excel/Word/CSV/text;
- analytics charts/tables for selected metrics.

Analytics visualizations currently include:

- contracts by month;
- client requests by month;
- client requests by status;
- RFQ by status;
- supplier purchase orders by supplier;
- TN VED duty distribution.

## Important Work Rules

- Do not commit secret files, key files, `.env.local`, or copied secret values.
- Do not print key contents or passwords.
- Do not revert user changes unless explicitly requested.
- When committing, include only files relevant to the task.
- If a Cloud SQL proxy is started manually, stop it before finishing the turn.
- Prefer safe backend tools over direct SQL for user-facing AI-agent behavior.
- Direct SQL is acceptable for developer diagnostics, but the embedded AI assistant should not expose SQL/table/column names to normal users.

## What May Need Extra Access

Some operations may still require extra IAM or user login:

- changing project-level IAM;
- enabling/disabling APIs;
- changing sensitive Cloud Run/Cloud SQL settings;
- changing Cloud Build trigger configuration;
- editing bucket IAM policies.

For normal project work, the current local GCP context is enough for:

- reading buckets;
- checking Cloud Build;
- checking Cloud Run;
- checking Cloud SQL;
- reading Secret Manager metadata;
- reading Cloud Logging;
- deploying through existing scripts/triggers.
