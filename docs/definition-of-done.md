# ERP implementation Definition of Done

Every substantial task must record each applicable gate as `PASS`, `FAIL`, `NOT APPLICABLE` with justification, or `BLOCKED`. Missing evidence is not a pass.

## Scope and architecture

- Task scope is satisfied without unauthorized adjacent work.
- Canonical domain ownership and architecture boundaries are preserved.
- Protected Classifier and Engineering invariants are unchanged unless explicitly authorized.
- Legacy orchestration is not reintroduced.

## Data and commands

- Schema changes use immutable managed migrations.
- Migration ledger remains valid, pending migrations are zero and schema drift is false after an applied migration.
- Idempotency, retry and concurrency behavior are tested when commands, bulk operations or workflow transitions change.
- No secrets or business rows enter GitHub context artifacts.

## Verification

- Affected backend tests pass.
- Affected frontend tests pass where a frontend test command exists.
- Production frontend build passes when frontend code changes.
- Realistic UI acceptance is performed when a user workflow changes.
- 10/50/100 scale acceptance is performed for volume-sensitive UI.
- RBAC/capability behavior is checked when permissions or protected reads/writes change.

## Handoff

- Implementation is committed on the authorized non-main branch.
- `npm run ai-context:update` has regenerated current machine state.
- `npm run review:preflight` passes with the live-source strictness required by the task.
- Semantic `AI_CONTEXT.md` names the current phase, task/report, branches, merge and deployment status.
- Completion Report is created from the reusable template and contains real evidence, not placeholder PASS values.
- Exact ending backend/frontend SHAs are reported.
- Merge and deployment occur only when separately authorized.
- Codex stops at the task stop condition and waits for ChatGPT review.
