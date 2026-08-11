# AI context generation and review preflight

The backend repository owns the small tooling used to refresh the persistent `ai-context` branch. GitHub remains the code source of truth; Google Drive remains the architecture/task/report source of truth.

## Ownership boundary

- Machine-generated: `SYSTEM_STATE.json`, `DATABASE_STATE.md`.
- Semantic/manual: `AI_CONTEXT.md`, `CHATGPT_REVIEW_INSTRUCTIONS.md`.
- The generator never copies business rows, credentials, connection strings or secret values.
- `ai-context` is a persistent non-deployment branch. It describes feature branches; it never contains feature-code merges.

## One-time worktree setup

Keep a separate checkout of `ai-context` so generated files cannot enter the active feature branch:

```bash
git fetch origin ai-context:ai-context
git worktree add ../.worktrees/crusher-parts-backend-ai-context ai-context
```

The tooling discovers a worktree whose branch is `ai-context`. Alternatively set `AI_CONTEXT_DIR` explicitly.

The frontend is resolved in this order:

1. `ERP_FRONTEND_REPO`;
2. `crusher-parts-frontend` beside the primary backend `main` worktree;
3. `../crusher-parts-frontend` relative to the active backend worktree.

Missing frontend state is a hard error. The generator never silently reuses an old frontend SHA.

## Generate current state

Primary command:

```bash
npm run ai-context:update
```

For a completion run that must prove live database and GCP access:

```bash
npm run ai-context:update -- --require-db --require-gcp
```

When `.env.local` points to `127.0.0.1`, start the existing Cloud SQL Auth Proxy first. The tooling checks the active worktree and then the primary backend `main` worktree for `.env.local`. Only `DB_*` values are loaded into the process; they are never rendered.

Offline generation is safe for CI and fixture work:

```bash
npm run ai-context:update -- --offline
```

Unavailable live facts become `UNKNOWN`; they are never copied from conversational memory. `NOT_DEPLOYED` means the verified deployed backend commit differs from the active feature HEAD. `UNKNOWN` means the run could not prove the fact.

## Review preflight

```bash
npm run review:preflight
```

Preflight regenerates machine state, validates required files/JSON/freshness, checks both repository HEADs, migration health when available, feature-branch isolation, deployment mismatch, command discoverability and secret patterns. Real inconsistencies return a non-zero status.

Completion-grade strictness:

```bash
REVIEW_REQUIRE_DB=1 \
REVIEW_REQUIRE_GCP=1 \
REVIEW_REQUIRE_CLEAN=1 \
npm run review:preflight
```

Use `REVIEW_DEPLOYMENT_AUTHORIZED=1` only when the governing task explicitly authorizes deployment.

## Required handoff sequence

1. Finish scoped code changes.
2. Run applicable tests, builds and UI acceptance.
3. Commit the feature/tooling implementation so the HEAD SHA is final.
4. Run `npm run ai-context:update` with required live sources.
5. Run `npm run review:preflight`.
6. Inspect generated files and confirm that they contain no rows or secrets.
7. Update semantic `AI_CONTEXT.md` with phase, task/report, blockers and exact feature branches.
8. Commit/push the non-main implementation branch and the independent `ai-context` branch.
9. Create the Completion Report using `docs/completion-report-template.md`.
10. Report exact SHAs and stop for ChatGPT review unless merge/deployment is separately authorized.

See [Definition of Done](./definition-of-done.md).
