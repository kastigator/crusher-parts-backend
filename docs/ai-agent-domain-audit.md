# AI Agent Domain Audit

Updated: 2026-07-03

This file is intentionally short. Older AI/domain audit notes were removed because they described obsolete OEM/original-parts and standalone standard-parts flows.

## Current Domain Model

The active system logic is:

```text
Classifier -> equipment model -> model BOM -> position card -> supplier/commercial/warehouse contour
```

Use this language in prompts, tool descriptions and AI actions:

- `classifier section`;
- `equipment model`;
- `model BOM`;
- `BOM row`;
- `position card`;
- `catalog position`;
- `supplier part`;
- `supplier link`;
- `material dictionary`;
- `TN VED dictionary`;
- `measurement unit dictionary`.

## What The Agent Should Do

When helping a user with the classifier:

1. Start from the visible classifier path.
2. If the user is inside an equipment model, treat the BOM as the manufacturer's catalog/tree for that model.
3. A BOM row is a place in the tree with its own quantity and parent.
4. A position card is the user-facing card opened from the BOM row.
5. If the same physical/catalog item appears in several places, use one position card with several BOM applications.
6. Link to a normalized/shared position only when the user explicitly knows it is a common item, for example a standard bolt, material, service or universal part.

## What The Agent Must Avoid

Do not propose workflows based on old standalone:

- OEM catalog screens;
- original-parts pages;
- standard-parts tables;
- old `oem_parts` terminology as the main product path.

If these words appear in code, database leftovers or old branches, treat them as cleanup/migration context.

## Data Safety

The agent may inspect local code, Cloud SQL data and GCP configuration when the user asks, but must not print or commit:

- database passwords;
- service-account JSON contents;
- tokens;
- `.env.local` secrets;
- private keys.

For connection instructions, read:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md
/Users/aleksandrlubimov/project/crusher-parts-backend/scripts/local-access.md
```

## Current AI Work Needed Later

The AI agent/import logic should wait until the database and classifier/BOM/card rules are stable.

Possible future work:

- PDF parts-book import into a structured BOM draft;
- Excel BOM import template;
- suggestions for matching BOM rows to existing normalized catalog positions;
- supplier-part matching suggestions.

These must follow the current classifier-first architecture.
