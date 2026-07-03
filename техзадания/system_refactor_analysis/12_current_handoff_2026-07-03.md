# Current Handoff: classifier, model BOM, catalog position cards

Date: 2026-07-03

Last working context before opening a new chat: 2026-07-03, classifier/model BOM/position-card cleanup.

This file is the current handoff for a new Codex/ChatGPT session. Read it after:

- `/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md`

Older markdown files from this folder were intentionally removed on 2026-07-03 because they described obsolete OEM/original-parts or standalone standard-parts approaches. If an old file reappears from Git history or another branch, do not treat it as the current architecture.

## Repositories and environment

Backend:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend
```

Frontend:

```text
/Users/aleksandrlubimov/project/crusher-parts-frontend
```

The frontend repo currently has no markdown documentation. The shared project handoff lives in the backend repo.

Main production resources:

- GCP project: `partsfinsad`
- Cloud Run backend: `crusher-backend` in `europe-west4`
- Backend URL: `https://crusher-backend-hawidorxpa-ez.a.run.app`
- Cloud SQL instance: `partsfinsad:europe-west4:parts`
- Database: `crusher_parts_db`
- Frontend bucket: `frontend-parts-site`
- Public frontend URL: `https://storage.googleapis.com/frontend-parts-site/index.html`

Use `PROJECT_CONTEXT.md` and `scripts/local-access.md` for exact local Cloud SQL and GCP commands. Do not copy secrets into docs or chat.

## Current product direction

The active path is:

```text
Classifier -> equipment model -> manufacturer BOM -> position card -> commercial/supplier/warehouse contour
```

For the user, this should feel simple:

1. They open the classifier.
2. They navigate to a model, for example `Metso HP 800`.
3. They open the model BOM.
4. The BOM is the manufacturer parts book/catalog tree for that model.
5. Clicking a BOM line opens the card of that line.
6. The card is where they later fill mass, dimensions, material, TN VED, images, applicability, suppliers and warehouse data.

Avoid reintroducing separate "OEM catalog", "original parts" or standalone "standard parts" as primary user paths. Those words may still exist in old docs or some legacy code, but the target UI and data model should be classifier-first.

## Core data logic

### BOM line

A BOM line is a place in a manufacturer catalog tree:

- parent assembly or root of model;
- quantity in that place;
- manufacturer catalog number;
- English/Russian names;
- line type by meaning: assembly, detail, material, document, service, kit.

Example:

```text
Model: Metso HP 800
BOM line: 1093080005 Tramp Release
Parent: root of model
Quantity: 1
Type: assembly
```

### Position card

Every BOM line must be openable as a card. Usually a new BOM line creates its own card automatically.

The card is where system-wide information is collected:

- photo/images;
- mass and dimensions;
- material or material variants;
- TN VED code;
- documents or drawings later if needed;
- where this item is used;
- supplier offers, analogs and stock later.

### Reusing an existing card

One physical/catalog position can appear in several places:

- in two assemblies of the same model;
- in another model of the same manufacturer;
- rarely in another manufacturer context if it is truly the same normalized/common item.

Therefore the same position card can be used by multiple BOM lines. Each BOM line still has its own parent and quantity.

Example:

```text
1093080129 Adjustment Ring
- appears under one assembly with quantity 1;
- appears in another place with quantity 3;
- both applications can point to one card, while BOM rows remain separate.
```

This is not a duplicate card. It is one card with several applications.

### Normalized/shared positions

A BOM line can be linked to an existing normalized position only when the user really knows it is the same universal item.

Example:

```text
Metso catalog line: "Hex bolt M20x80 10.9 DIN 931"
Classifier already has a normalized fastener card with the same dimensions and standard.
The BOM line can link to that normalized card.
```

This is the exception, not the default. Default behavior: create/keep the card from the BOM line itself.

## Duplicate and nesting rules

Rules agreed with users:

- A BOM item must not be inserted into itself or into its own descendant. Show a clear error.
- Within one manufacturer, do not silently create duplicate cards with the same manufacturer part number.
- If the same part number is found under another manufacturer, warn the user and ask for confirmation before creating a separate card.
- "Add application" should reuse the same card and create another BOM line/application in a selected model/parent.
- In the add-application modal, model choices should be filtered by the current manufacturer. For example, from `Metso HP 800`, show only Metso models.

## Important tables

Current important tables for classifier/BOM/card work:

- `classifier_nodes`
- `equipment_models`
- `equipment_model_bom_items`
- `catalog_positions`
- `catalog_position_materials`
- `materials`
- `tnved_codes`
- `measurement_units`
- `part_suppliers`
- `supplier_parts`
- `supplier_part_catalog_positions`
- `supplier_part_materials`
- `supplier_part_prices`

Commercial/RFQ tables may still contain training/test data. The user explicitly allowed deleting/refactoring training commercial data later because the commercial contour will be redesigned after classifier/BOM cleanup.

## Important backend routes

Key backend route files:

- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/equipmentClassifierNodes.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/catalogPositions.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/materials.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/tnvedCodes.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/measurementUnits.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/supplierPartCatalogPositions.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/supplierPartMaterials.js`

The backend route `routes/measurementUnits.js` was fixed so usage counting does not fail after BOM refactor removed old direct unit columns.

## BOM screen UX decisions

Current BOM screen direction:

- Do not show row numbering purely for system order if it confuses users.
- Do not show redundant gray text repeating the same name under each row.
- Do not show technical "card count" badges.
- Do not show a plus button that duplicates "Add row".
- A row menu is enough for actions: edit, add same position/application, delete.
- The manufacturer part number remains clickable and opens the side card.
- Keep expand/collapse all for BOM tree.
- Dynamic columns can show values from the card, such as TN VED, mass, dimensions, material and description.

Known UI issue:

- When many dynamic columns are enabled, long text can overlap. The next frontend pass should change this to a readable grid/table layout with fixed/minmax columns, wrapping or horizontal scroll. Text must not overlap.
- Dynamic BOM columns should be readable as columns, not as several inline labels that collide. Use stable widths, wrapping/truncation with tooltips, or horizontal scroll.
- If card fields are empty, show a compact dash, not long repeated empty text.

## BOM filters

Filters must depend on context.

On high-level classifier sections, filters may be equipment/model characteristics.

Inside a model BOM, filters must be BOM/card filters:

- type of row;
- TN VED: multiselect from TN VED codes actually present in this BOM;
- material: multiselect from materials actually present in this BOM;
- mass: numeric range;
- dimensions: numeric ranges;
- later: warehouse availability and suppliers.

Avoid "filled/not filled" as the main filter for mass or dimensions. Users expect real ranges.

Current user decision:

- mass: numeric range;
- dimensions: numeric ranges, not just filled/not filled;
- TN VED: dynamic multiselect from TN VED codes actually present in the current BOM;
- material: dynamic multiselect from materials actually present in the current BOM.

## Classifier tree UX decisions

The classifier tree should be sorted alphabetically by default.

Favorites are per-user. The desired behavior is inline ordering, not a separate "Favorites" block:

- If user A stars `Электрика`, that node rises to the top for user A.
- If user B stars `СИЗ`, that node rises to the top for user B.
- Non-starred nodes remain alphabetically sorted.
- Favorites should work at each sibling level of the tree.
- Do not create a separate `Избранное` block in the tree. It duplicates the classifier.

## Equipment model card

The active model card should focus on:

- Passport;
- BOM model.

Tabs for "Machines of clients" and "Client executions" were discussed as not needed on the current model card and should not distract users while classifier/BOM are being stabilized.

## Side card / position card

The side card should be readable by a human, not look like a database dump.

Desired tabs:

- `Основное`
- `Характеристики`
- `Материалы и ТН ВЭД`
- `Применяемость`
- `Поставщики`
- `Состав`

Remove/avoid:

- separate `Документы` tab for now;
- separate `Данные` tab;
- technical legacy/source fields such as old OEM ids;
- duplicated "edit row" vs "edit card" controls when one clear `Редактировать` action is enough.

`Основное` should include the most useful first-glance information:

- image/photo placeholder and upload action;
- manufacturer part number;
- name EN/RU;
- row type;
- model and current BOM location;
- quantity in this BOM place;
- whether this card is reused in other places.
- Basic editable fields that previously lived in a separate `Данные` tab should be moved into `Основное`.

`Характеристики` should support:

- mass;
- dimensions;
- other typed characteristics;
- units from the shared measurement-units dictionary.

`Материалы и ТН ВЭД` should support:

- material selection from the existing material dictionary;
- several material variants/executions when needed;
- TN VED selection from the existing TN VED dictionary.

`Применяемость` should show all places where this card is used, including other assemblies/models.

`Поставщики` should later show supplier parts, prices, analogs and stock. There are existing supplier tables/routes, but that contour still needs cleanup.

`Состав` is important for assemblies. It should show child BOM rows of this assembly.

User feedback from 2026-07-03:

- The side card should not read like a database table.
- `Состав` should be a separate tab.
- `Документы` tab should be removed for now.
- `Данные` tab should be removed; its useful fields belong in `Основное`.
- The top action should be one clear `Редактировать`, not duplicated "edit row/edit card" concepts.

## Existing dictionaries

Do not create duplicate local dictionaries for these:

- Units: use `measurement_units`.
- Materials: use `materials`.
- TN VED: use `tnved_codes`.

The measurement-unit page had a backend usage-count issue after refactor. It was fixed in commit `7f01f20`; `/measurement-units?include_usage=1` returned HTTP 200 with rows after the fix.

## Supplier/commercial contour

The system already has supplier entities, supplier parts, materials, price history and links from supplier parts to catalog positions.

However, this contour still contains older logic and must be reviewed before being treated as final. The user prefers to finish classifier/BOM/card architecture first, then refactor suppliers and the commercial contour around the normalized catalog-position model.

Useful idea to preserve:

```text
Catalog position/card = what the manufacturer/model catalog says.
Supplier part = what a supplier can sell or make.
Supplier link = this supplier part can replace/supply this catalog position.
```

## Legacy cleanup warning

Avoid rebuilding features around old "OEM/original parts" screens or standalone "standard parts" tables. They caused confusion.

If legacy words still appear in code, prompts, route names or old docs, treat them as cleanup candidates unless the current classifier/BOM path explicitly depends on them.

Known cleanup candidates:

- AI assistant prompts may still mention OEM/standard terminology.
- Supplier/RFQ code may still have older fields/labels.
- If old markdown files `01`-`11` reappear, ignore them as current architecture and delete or archive them again.

## Recent commits to know

Recent backend commits relevant to this handoff:

- `d9a885c Remove legacy OEM catalog paths`
- `ad18520 Add catalog position card details endpoint`
- `0818157 Add editable catalog position card data`
- `ca2a941 Expose catalog card fields in model BOM`
- `7f01f20 Fix measurement unit usage after BOM refactor`

## Open work

Highest-priority next work:

1. Make BOM dynamic columns readable when several columns are enabled.
2. Finish BOM-specific right filters: TN VED multiselect, material multiselect, mass range, dimensions range.
3. Confirm add-application modal filters target models by current manufacturer.
4. Continue side-card implementation: real editing for images, characteristics, materials, TN VED and supplier links.
5. Clean remaining legacy labels/code that can lead a future assistant back to OEM/original-parts logic.
6. Later refactor supplier and commercial contour around catalog positions, not old OEM entities.
