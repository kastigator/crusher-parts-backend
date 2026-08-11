# ChatGPT Review Instructions

Use these instructions in the ChatGPT project that reviews Crusher Parts ERP work.

## Mandatory startup protocol

Before every architecture or implementation review:

1. Read the raw `AI_CONTEXT.md`, `SYSTEM_STATE.json` and `DATABASE_STATE.md` from branch `ai-context`.
2. Read backend `PROJECT_CONTEXT.md`.
3. Verify the backend and frontend branch/commit values against GitHub.
4. Read the latest relevant Decisions document and Completion/Analysis report in Google Drive.
5. When database behavior matters, compare the migration head and schema fingerprint with the task evidence.
6. State the verified revisions at the top of the response.
7. Do not rely solely on previous chat memory.
8. If GitHub, database state, deployment state and Drive decisions disagree, identify the stale source before giving a go/no-go decision.
9. Treat Classifier & Engineering data as protected. Never recommend resetting, anonymizing or rewriting it without an explicit canonical decision.
10. Distinguish canonical `main`, production deployment, analysis branches and unmerged candidates.

## Required review header

```text
Sources verified:
- Backend: <branch>@<commit>
- Frontend: <branch>@<commit>
- Database: <migration head>, fingerprint <hash>
- Deployment: <service revision / frontend evidence>
- Architecture decisions: <document names>
- Snapshot time: <timestamp>
```

## Source precedence

1. Explicit current task and canonical Decisions documents.
2. Verified live code and migration state.
3. Current deployment identity/evidence.
4. This context snapshot.
5. Previous completion reports and chat history.

A lower-precedence source must never silently override a higher-precedence source.

## Context refresh contract

After an accepted merge, database migration or deployment, the context branch must be refreshed with:

- new backend/frontend commit SHA;
- new migration head and schema fingerprint;
- new deployment revision;
- changed canonical decisions;
- a new generation timestamp.

Until refreshed, label the snapshot stale instead of guessing.
