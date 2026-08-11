# Crusher Parts ERP — AI Context Entry Point

Generated: 2026-08-11T07:40:33.154Z

This branch is a reloadable, non-secret context source for ChatGPT and Codex. It is intentionally separate from `main`, so context-only updates do not trigger the production Cloud Build deployment.

## Read order

1. [SYSTEM_STATE.json](./SYSTEM_STATE.json) — exact repository revisions, database fingerprint and deployment identity.
2. [DATABASE_STATE.md](./DATABASE_STATE.md) — live schema/ledger summary and complete table/view inventory.
3. [CHATGPT_REVIEW_INSTRUCTIONS.md](./CHATGPT_REVIEW_INSTRUCTIONS.md) — mandatory review protocol.
4. [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) — project map inherited from backend `main`.
5. Canonical architecture decisions and the latest execution report in Google Drive.

## Current code boundary

- Backend canonical code: [`main@afff423`](https://github.com/kastigator/crusher-parts-backend/commit/afff423ca96887cde07c423c9d712e092417e41c).
- Frontend canonical/default code: [`main@36cfd29`](https://github.com/kastigator/crusher-parts-frontend/commit/36cfd2954c7147a748c2ad478535680b56616535).
- Frontend v2 analysis branch: [`frontend-v2-client-request@f5cf804`](https://github.com/kastigator/crusher-parts-frontend/commit/f5cf804a7347030f1d427c22fcb1ff93178da7dc). This branch is not identified as canonical production in this snapshot.
- Backend production revision reports release commit `afff423`.

## Canonical product flow

```text
Classifier
  -> Client Request
  -> Technical Identification
  -> Procurement Release
  -> Sourcing
  -> Pricing
  -> Commercial Offer
  -> Contract
  -> Purchase Order
  -> Financial Operations
  -> Warehouse
  -> Dispatch & Delivery
  -> Completion
  -> After Sales & Traceability
```

Classifier and Engineering data are protected. Never infer permission to alter them from the presence of schema information.

## Freshness rule

This snapshot is evidence, not memory. At the start of every review, report:

- backend branch and commit;
- frontend branch and commit;
- database migration head and schema fingerprint;
- deployment revision if production behavior is discussed;
- snapshot generation time.

If live sources differ from this branch, mark this context stale and use the newer verified source. Never silently combine different revisions.

## Persistent URLs for ChatGPT

- Entry point: https://raw.githubusercontent.com/kastigator/crusher-parts-backend/ai-context/AI_CONTEXT.md
- Machine state: https://raw.githubusercontent.com/kastigator/crusher-parts-backend/ai-context/SYSTEM_STATE.json
- Database state: https://raw.githubusercontent.com/kastigator/crusher-parts-backend/ai-context/DATABASE_STATE.md
- Review instructions: https://raw.githubusercontent.com/kastigator/crusher-parts-backend/ai-context/CHATGPT_REVIEW_INSTRUCTIONS.md

## Architecture sources

- [ERP Architecture Drive folder](https://drive.google.com/drive/folders/1DKVc06GsgdBKWN2Fol0cz4Y75z8TQBOW)
- [Report 94 — Classifier Technical Identification & Mass Intake Analysis](https://docs.google.com/document/d/1Ldu81bACY8OpcdgIH_xUAnyeBFBJJVvkNoI--dUlBb8/edit)
