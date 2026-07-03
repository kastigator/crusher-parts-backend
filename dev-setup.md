# Dev Setup: Crusher Parts

Updated: 2026-07-03

This file is a practical local setup note. The product/domain entrypoint is:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md
```

For current classifier, model BOM and position-card logic, read:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/12_current_handoff_2026-07-03.md
```

## Repositories

Backend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
```

Frontend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
```

## Install

Install backend dependencies:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm install
```

Install frontend dependencies:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm install
```

## Local Backend

Local backend config is read from:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/.env.local
```

Do not commit or print `.env.local`, JSON keys, passwords or tokens.

Start backend with local settings and Cloud SQL access:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run start:local
```

Expected backend port:

```text
http://localhost:5050
```

## Local Frontend

Start Vite:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run dev
```

Expected frontend URL:

```text
http://localhost:5173
```

## Backend And Frontend Together

From the backend repo:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run dev:all
```

## Database Shortcuts

See:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/scripts/local-access.md
```

Useful check:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
./scripts/db-query.sh "SELECT 1 AS ok, DATABASE() AS db"
```

## Deploy

GitHub/Cloud Build deploy is configured for the project. Current known deploy resources are listed in `PROJECT_CONTEXT.md`.

Backend deploy helper:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:backend
```

Frontend deploy helper:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run deploy:cloud
```

## Active Architecture Reminder

The active product path is:

```text
Classifier -> equipment model -> model BOM -> position card -> supplier/commercial/warehouse contour
```

Do not use old standalone OEM/original-parts or standard-parts flows as current architecture.
