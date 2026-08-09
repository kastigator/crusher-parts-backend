# Current Handoff: classifier, model BOM, catalog position cards

Last updated: 2026-07-30

This is the current handoff for a new Codex/ChatGPT session. Read it after:

- `/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md`

Then, for commercial/supplier/warehouse work, also read:

- `/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/13_commercial_supplier_warehouse_refactor_plan_2026-07-26.md`

Old markdown files from this folder were intentionally removed because they described obsolete OEM/original-parts or standalone standard-parts approaches. If old `01`-`11` files reappear from Git history or another branch, do not treat them as current architecture.

## Repositories and environment

Backend:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend
```

Frontend:

```text
/Users/aleksandrlubimov/project/crusher-parts-frontend
```

Main production resources:

- GCP project: `partsfinsad`
- Cloud Run backend: `crusher-backend` in `europe-west4`
- Backend URL: `https://crusher-backend-hawidorxpa-ez.a.run.app`
- Cloud SQL instance: `partsfinsad:europe-west4:parts`
- Database: `crusher_parts_db`
- Frontend bucket: `frontend-parts-site`
- Public frontend URL: `https://storage.googleapis.com/frontend-parts-site/index.html`

Use `PROJECT_CONTEXT.md` and `scripts/local-access.md` for exact local Cloud SQL and GCP commands. Do not copy secrets into docs or chat.

## Active product architecture

The active path is:

```text
Classifier -> equipment model -> manufacturer BOM -> catalog position card -> supplier/commercial/warehouse contour
```

Do not rebuild active UX or data work around old OEM/original-parts/standard-parts flows. Legacy column names may remain as compatibility debt, but the product model is classifier-first.

For the user, the core flow should feel simple:

1. Open classifier.
2. Choose an equipment model.
3. Work with the model BOM as the manufacturer's parts book/catalog.
4. Click a BOM row to open the position card in the side panel.
5. Fill or review mass, dimensions, TN VED, materials, applicability, suppliers and stock from the card/workspaces.

## Core concepts

### BOM row

A BOM row is a row in the manufacturer's model catalog tree:

- manufacturer catalog number;
- EN/RU names;
- quantity in this specific place;
- parent row or model root;
- optional comment for this BOM place.

Current decision: do not maintain a separate user-facing "row type" selector such as assembly/detail/kit/document/service for manual BOM work. If a row has child rows, it is effectively an assembly by structure. If it has no children, it is a normal position. Artificial "kit" logic in the classifier is not useful right now because real kits are better modeled later through supplier parts and commercial offers.

### Catalog position card

A catalog position card is the object opened from a BOM row. It stores useful system-wide information:

- image/photo;
- mass and dimensions;
- TN VED code from `tnved_codes`;
- materials/executions from `materials`;
- description;
- where the position is used;
- supplier links and warehouse aggregation later.

Default behavior: a new BOM row creates its own catalog position card unless the user explicitly links it as an analog to an existing card.

### Applicability

Applicability means the same catalog position card is used in one or more BOM places.

Example:

```text
AM9.3073-007.001 Rails set
- appears under AM9.3073-007.000 in Finsad Group LH3073-2
- may appear in other assemblies or models later
```

Applicability is not an analog relation. It is a list of BOM places where the same card is used.

Current UX decision:

- use the `Применяемость` tab as the place to view and add applications;
- do not keep a separate row-menu action "Добавить применение";
- the tab supports an inline add form: model, BOM parent, quantity, comment;
- there can be many applications across the classifier, so keep this as a table/list, not as one field on the main tab.

### Analogs

Analogs are different catalog position cards that represent equivalent positions from different manufacturer contexts or catalog systems.

Example confirmed in the training DB:

```text
Primary/main analog target:
AM9.3073-007.000 — Rail set
Manufacturer/model: Finsad Group / LH3073-2

Analog:
MM0621245 — RAIL ASSAMBLY
Manufacturer/model: Metso / LH3073-2
```

Meaning: `MM0621245` is an analog of `AM9.3073-007.000`. These remain two separate catalog position cards with their own BOM usages. The UI should not present this as "one common card used by two BOM rows" and should not show blue explanatory blocks.

Current UX decision:

- in the main tab, show analog relation compactly as a row such as `Аналог к`;
- if the card is the main/primary card, analogs can be listed compactly under `Аналоги`;
- analog rows are clickable and should open the linked catalog position card in the same side panel/context;
- do not show a card as linked to itself.

## Manual BOM row creation/editing

The add/edit BOM row form should be human and compact.

Current fields:

- catalog number of manufacturer;
- quantity;
- name EN;
- name RU;
- parent in BOM;
- mass, kg;
- dimensions, mm: length, width, height;
- TN VED code picker;
- description;
- optional comment for the BOM row;
- optional "link with existing card" switch near the end.

Current UX decisions:

- remove the disabled `шт` field from the form; quantity already says `1 шт`, and the unit is still owned by the measurement-unit dictionary internally;
- do not expose row type in the form;
- do not force the user to decide assembly/detail/kit at creation time;
- if the row is placed inside another row, the parent row becomes an assembly by structure;
- keep the optional existing-card/analog link as a switch near the end of the form, not as a separate top tab;
- when linking an existing card as an analog, keep row-specific fields for the current BOM row and create/show analog relation explicitly.

Editing a BOM row should not feel like a second separate product. The preferred direction is:

- opening/clicking a row shows the side card;
- `Редактировать` should let the user edit the row/card data from that side context;
- avoid a separate modal if the same fields are already available in the card side panel.

## Excel BOM import

Users tested the previous hierarchy/level import and rejected it. It was too easy to get confused with nested levels.

Current decision: Excel import is a flat primary import.

The user imports rows into the root of the model BOM, then manually arranges nesting in the UI.

Template columns:

- `Каталожный номер производителя`
- `Название EN`
- `Название RU`
- `Количество`
- `Масса, кг`
- `Длина, мм`
- `Ширина, мм`
- `Высота, мм`
- `Код ТН ВЭД`

Current import rules:

- no `Уровень`;
- no `N позиции`;
- no `Чертеж`;
- no `Заметки`;
- no sample data rows in the template;
- template should be formatted as a readable Excel table with useful column widths;
- TN VED import accepts only the code; backend/frontend should resolve it against `tnved_codes`;
- duplicate detection must flag duplicate catalog numbers inside the import and against the current model/BOM where relevant;
- import should not create disconnected garbage rows or duplicate cards silently.

The import modal should not contain large blue instructional blocks. Keep title, upload action, replace-current-BOM checkbox, preview table and actions.

## Side card main tab

The side card should be readable as a position card, not as a database dump.

Current tab set:

- `Основное`
- `Состав`
- `Применяемость`
- `Склад`
- `Поставщики`

Materials are intentionally not the next focus. Do not expand materials UI unless the user explicitly returns to it.

Current `Основное` direction:

- compact header with title, manufacturer number and quantity;
- top facts table with image placeholder/action and only meaningful rows:
  - manufacturer;
  - model;
  - name RU;
  - quantity in BOM;
  - where located;
  - analog relation when present.
- no redundant tags like `Сборка`, `Отдельная позиция этой модели`, `4 внутри` if the same meaning is clear from structure/tabs;
- no disabled unit field;
- no TN VED recommendation block by default; users said recommendations grow and disturb reading;
- TN VED picker remains available, but suggestions should be hidden on this main tab unless intentionally opened from a dictionary/search action;
- characteristics block contains mass, dimensions in mm, TN VED and description;
- units are still governed by `measurement_units`, but not every fixed unit needs a visible disabled input.

## TN VED

Single source of truth:

```text
tnved_codes
```

The TN VED dictionary was upgraded earlier so it is not just a table:

- list/search codes;
- show usage count;
- open code details;
- see where a code is applied;
- see candidate positions without a code;
- apply code from context when useful.

For the side card:

- keep TN VED code as a controlled picker tied to the dictionary;
- do not show large recommendation cards inline on `Основное`;
- use recommendations only when the user explicitly searches/opens the dictionary-style helper.

## Measurement units

Single source of truth:

```text
measurement_units
```

Important decision from the recent work:

- dimensions must be displayed and edited in `мм`, not `см`;
- supplier part/RFQ legacy APIs may still have `*_cm` field names, but active UI should convert/display millimeters at the boundary;
- do not create extra unit dictionaries or hardcoded competing truth.

## Delete, archive and trash

Deletion is not a hard delete in normal user workflows.

Current backend behavior:

- deleting a BOM row deletes/removes the selected BOM subtree through the trash flow;
- autogenerated catalog cards created only from the deleted BOM rows are archived when safe;
- shared/manual cards or cards referenced elsewhere are kept active;
- trash preview/restore knows about archived generated catalog position cards;
- `GET /catalog-positions` hides archived cards by default;
- `include_archived=1` can be used only when an archive/trash view needs them.

This was added to prevent the bug where a deleted card disappeared from BOM but still appeared in normal search.

Recent backend commit:

```text
5313409 Archive generated BOM cards through trash
```

## Current DB sanity notes

Training DB was checked through Cloud SQL proxy after analog and delete fixes.

Known good state at the last check:

- relation `AM9.3073-007.000` / `MM0621245` exists as an `analog` relation;
- `AM9.3073-007.000` is the primary/main analog target;
- `MM0621245` is the Metso analog;
- no self-link should be shown for `AM9.3073-007.001 Rails set`;
- old test `lubricant` generated card was archived, not active;
- active generated orphan check returned zero for the checked training state.

Do not create extra training rows just for demonstration unless the user explicitly asks. If test rows are created, clean them through the system/trash flow or direct DB cleanup when appropriate.

## Important backend files

- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/equipmentClassifierNodes.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/equipmentModels.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/catalogPositions.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/materials.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/tnvedCodes.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/routes/measurementUnits.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/utils/trashPreview.js`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/utils/trashRestore.js`

## Important frontend file

The classifier/BOM/card UI is currently concentrated mainly in:

```text
/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/equipmentClassifier/EquipmentClassifierMain.jsx
```

Recent frontend commit:

```text
5a371a7 Refine equipment BOM card workflows
```

## Supplier/commercial/warehouse pointer

The commercial contour was analyzed and partially refactored separately. Before touching it, read:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/13_commercial_supplier_warehouse_refactor_plan_2026-07-26.md
```

Core supplier/warehouse rule:

```text
catalog_position = what the system/user searches and normalizes against
supplier_part    = what a supplier actually sells or manufactures
warehouse stock  = physical quantity of supplier_part at a warehouse/place/lot
```

Do not make warehouse stock belong only to catalog positions.

## Verification commands

Backend syntax checks used recently:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
node -c routes/equipmentModels.js
node -c routes/catalogPositions.js
node -c utils/trashRestore.js
node -c utils/trashPreview.js
git diff --check
```

Frontend build used recently:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run build
git diff --check
```

The frontend build passed; Vite emitted only the existing large-chunk warning.

## Open work

Highest-priority next work:

1. Verify the deployed UI after Cloud Build/GCS update, especially side-card navigation, analog links, applicability, edit mode and deletion search.
2. Finish the edit model for BOM rows: prefer side-card editing over a separate modal, and avoid duplicated edit concepts.
3. Keep refining `Применяемость`: it should be the place to add and manage all BOM applications of a card.
4. Continue cleanup of legacy `oem/original/standard` labels and aliases only when it supports the classifier-first architecture.
5. Do not touch materials/executions next unless explicitly asked; the user said to pause materials for now.
6. Continue commercial contour in order from the commercial handoff: supplier response -> supplier_part creation/linking, supplier/client workspaces, warehouse supplier_part stock.
7. If database cleanup is needed, use the training DB carefully and avoid creating garbage. Prefer system routes/trash; use direct SQL only for diagnostics or deliberate cleanup.
