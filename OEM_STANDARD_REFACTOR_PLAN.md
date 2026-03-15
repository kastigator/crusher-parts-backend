# OEM / Standard Parts Refactor Plan

## Purpose

This file is the single source of truth for the catalog refactor.

It exists so work can continue safely even if chat context is lost.
After each completed SQL block or major implementation step, this file must be updated with:

- what was planned
- what was executed
- what succeeded
- what still remains
- the date of the change

Current working mode:

1. First complete the database refactor via SQL blocks.
2. Only after all SQL blocks are applied successfully, start backend changes.
3. Only after backend is aligned with the final schema, start frontend changes.

## Document Status

Last updated: 2026-03-15 00:48 EET
Repository: `crusher-parts-backend`
Primary DB target: Google Cloud SQL (`crusher_parts_db`)
Current active DB dump: `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-15 (00_17_08).sql`

This document must be updated after:

- each completed SQL block
- each backend phase completion
- each frontend phase completion
- any change in target architecture or execution order

## Target Architecture

The system is being refactored from the legacy center:

- `original_parts`

to the new core:

- `oem_parts` as the main OEM/original part entity
- `standard_parts` as the normalized catalog of standard items
- `client_equipment_units` as the specific client machine / equipment unit
- `equipment_classifier_nodes` as the shared classification tree

### Domain Layers

1. Equipment classifier
- Common multi-level engineering taxonomy.

2. Equipment manufacturer
- Existing `equipment_manufacturers`.

3. Equipment model
- Existing `equipment_models`, extended with classifier linkage.

4. Client equipment unit
- Specific machine owned/used by a client.
- Example: `Client A / Metso MKII 60-89 / SN54321 / 2013`.

5. OEM part
- Main catalog object.
- Replaces legacy business meaning previously spread across `original_parts`.

6. Standard part
- Canonical standard item shared across different OEM numbers.
- Example: `Bolt M8x16 DIN 933 8.8`.

### Core Principles

1. Do not keep two business centers.
- `original_parts` must not remain a parallel source of truth.

2. RFQ / Client Requests / Selection / Coverage must move from `original_part_id` to `oem_part_id`.

3. Standard parts are not the same as alternative OEM parts.
- Standard parts = identity / normalization.
- Alternative OEM parts = interchangeability / cross references.

4. Client workflows should ultimately open catalogs in the context of a specific equipment unit, not only a model.

## High-Level Scope

### Database

Refactor / replace:

- catalog schema
- OEM fitments and BOM
- RFQ references
- client request references
- supplier part references
- bundles
- procurement rules

Add:

- classifier tree
- client equipment units
- standard parts
- OEM-to-standard linkage
- supplier-part-to-standard linkage

Remove later:

- legacy `original_part_*` tables
- `supplier_part_originals`
- `migration_original_to_oem`
- other obsolete compatibility structures

### Backend

Will be updated only after SQL is fully applied.

Major impacted modules:

- `routes/originalParts.js` and all `originalPart*` routes
- `routes/clientRequests.js`
- `routes/rfqs.js`
- `routes/coverage.js`
- `routes/selection.js`
- `routes/supplierResponses.js`
- `routes/supplierParts.js`
- `routes/supplierBundles.js`
- `routes/clientOrders.js`
- `routes/purchaseOrders.js`
- `routes/salesQuotes.js`
- `routes/economics.js`
- `utils/clientRequestStructure.js`
- `utils/rfqStructure.js`

### Frontend

Will be updated only after backend is aligned.

Major impacted UI areas:

- Original parts catalog page
- Original part detail page
- New standard parts catalog
- Client detail page with new `Equipment` tab
- Client requests page
- RFQ page / RFQ workspace
- Coverage / selection / supplier responses
- Supplier parts links and bundles
- Orders / POs / sales quotes consumers of selection data

## Execution Rules

1. SQL first.
2. Backend second.
3. Frontend third.
4. Do not start code changes while schema is still in transition.
5. Prefer clean replacement over legacy compatibility, because current DB contents are test data.

## SQL Block Plan

### SQL Block 1
Goal:

- add the new base entities without deleting legacy structures

Objects added / changed:

- `equipment_classifier_nodes`
- `equipment_models.classifier_node_id`
- `equipment_models.model_code`
- `equipment_models.notes`
- `client_equipment_units`
- `standard_parts`
- `oem_part_standard_parts`
- `supplier_part_standard_parts`

Status: completed
Applied date: 2026-03-14
Applied by user in Google Cloud SQL: yes
Result: success
Notes:

- Block 1 executed successfully.
- Verification screenshots confirmed:
  - new tables created
  - new columns added to `equipment_models`
- execution confirmed in Google Cloud SQL Studio on 2026-03-14

### SQL Block 2
Goal:

- build clean OEM-centered catalog structures

Planned objects:

- `oem_part_model_fitments`
- `oem_part_model_bom`
- `oem_part_alt_groups`
- `oem_part_alt_items`
- `oem_part_documents`
- `oem_part_materials`
- `oem_part_material_specs`
- change `supplier_bundles` to use `oem_part_id`
- change `supplier_procurement_rules` to use `oem_part_id`

Status: completed
Applied date: 2026-03-14
Last attempt date: 2026-03-14
Last attempt result: success
Failure note:

- Cloud SQL returned `Error 1826 (HY000): Duplicate foreign key constraint name 'fk_opai_group'`.
- Cause: MySQL requires foreign key names to be unique across the whole schema, not only inside one table.
- Because MySQL DDL can auto-commit, Block 2 may be partially applied and must be repaired before rerun.
Recovery status:

- legacy transitional OEM tables and legacy original-part catalog substructures were explicitly removed
- Block 2 will now proceed as a clean schema creation step, without data migration from dropped legacy catalog tables
Completion note:

- Clean Block 2 schema creation completed successfully after cleanup.
- New OEM-centered tables now exist.
- `supplier_bundles.oem_part_id` and `supplier_procurement_rules.oem_part_id` were added successfully.

### SQL Block 3
Goal:

- move operational request / RFQ tables from legacy original parts to OEM parts

Planned objects:

- `client_request_revision_items`
- `client_request_revision_item_components`
- `rfq_item_components`
- `rfq_response_lines`
- `rfq_coverage_option_lines`
- `rfq_supplier_line_selections`
- related FK/index updates

Status: completed
Applied date: 2026-03-14
Result: success
Notes:

- Operational tables were extended with OEM references.
- Verified additions include:
  - `client_request_revision_items.oem_part_id`
  - `client_request_revision_item_components.oem_part_id`
  - `rfq_items.oem_part_id`
  - `rfq_item_components.oem_part_id`
  - `rfq_response_lines.oem_part_id`
  - `rfq_response_lines.requested_oem_part_id`
  - `rfq_coverage_option_lines.oem_part_id`
  - `rfq_supplier_line_selections.oem_part_id`
  - `rfq_supplier_line_selections.alt_oem_part_id`
- User created a fresh post-block dump:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_00_00).sql`

### SQL Block 4
Goal:

- extend operational flow with `standard_part_id`

Planned objects:

- `client_request_revision_items.standard_part_id`
- `client_request_revision_item_components.standard_part_id`
- `rfq_items.standard_part_id`
- `rfq_item_components.standard_part_id`
- `rfq_response_lines.standard_part_id`
- `rfq_response_lines.requested_standard_part_id`
- `rfq_coverage_option_lines.standard_part_id`
- `rfq_supplier_line_selections.standard_part_id`

Status: completed
Applied date: 2026-03-14
Result: success
Notes:

- Standard-part references were added to the operational request / RFQ layer.
- User created a fresh post-block dump:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_13_41).sql`

### SQL Block 5
Goal:

- remove legacy `original_parts` foreign-key dependencies where OEM/standard replacements now exist
- prepare the schema for final retirement of `original_parts`

Status: completed
Applied date: 2026-03-14
Result: success
Notes:

- Legacy foreign keys to `original_parts` were removed from operational and supplier tables where OEM/standard references already exist.
- `supplier_part_originals` was dropped.
- User created a fresh post-block dump:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_22_34).sql`

### SQL Block 6
Goal:

- remove remaining legacy view dependence on `original_parts`
- align `supplier_quality_events` with OEM/standard references

Status: completed
Applied date: 2026-03-14
Result: success
Notes:

- `supplier_quality_events` was extended with:
  - `oem_part_id`
  - `standard_part_id`
- RFQ views were rebuilt to use OEM/standard references instead of `original_parts`:
  - `vw_rfq_supplier_latest_lines`
  - `vw_rfq_cost_base`
- User created a fresh post-block dump:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_31_28).sql`

### SQL Block 7
Goal:

- remove the last remaining hard foreign-key dependencies on `original_parts`
- prepare the schema for final retirement of `original_parts` and legacy original-part columns

Status: completed
Applied date: 2026-03-14
Result: success
Notes:

- Remaining hard foreign keys to `original_parts` were removed from:
  - `rfq_coverage_option_lines`
  - `rfq_item_components`
- User created a fresh post-block dump:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_39_23).sql`

### SQL Block 8
Goal:

- remove the legacy `original_parts` table after all hard dependencies are detached

Status: completed
Applied date: 2026-03-14
Result: success
Notes:

- `original_parts` was dropped successfully.
- User verified that `SHOW TABLES LIKE 'original_parts'` returned no rows.
- User created a fresh post-block dump:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (20_19_06).sql`

## Backend Implementation Plan

Do not start before all SQL blocks are complete.

### Backend Phase 1
- add APIs for:
  - classifier
  - client equipment units
  - standard parts
  - OEM-standard linking

Status: in progress
Started date: 2026-03-14
Implementation note:

- backend route scaffolding added for:
  - `equipment_classifier_nodes`
  - `client_equipment_units`
  - `standard_parts`
  - `oem_part_standard_parts`
- `equipment_models` API extended with:
  - `classifier_node_id`
  - `model_code`
  - `notes`
- routes registered in backend router for catalog access
- smoke-checked against local backend:
  - `/standard-parts`
  - `/client-equipment-units`
  - `/equipment-classifier-nodes`
  - `/oem-part-standard-parts`
  - all returned HTTP 200 on local run

### Backend Phase 2
- replace legacy original-part catalog routes with OEM-centered routes
- port:
  - BOM
  - alternatives
  - materials
  - documents
  - bundles
  - supplier links

Status: pending

### Backend Phase 3
- rewrite client request structure from `original_part_id` to `oem_part_id`

Status: pending

### Backend Phase 4
- rewrite RFQ / coverage / selection / supplier responses to OEM-centered references

Status: pending

### Backend Phase 5
- adapt economics / purchase orders / client orders / sales quotes

Status: pending

## Frontend Implementation Plan

Do not start before backend is complete enough for end-to-end usage.

### Frontend Phase 1
- client page:
  - add `Equipment` tab
  - create/edit/delete client equipment units

Status: pending

### Frontend Phase 2
- replace original parts catalog UX with OEM-centered catalog UX
- support navigation by:
  - client equipment
  - manufacturer/model
  - classifier
  - standard parts

Status: pending

### Frontend Phase 3
- replace original part detail with OEM part detail
- preserve major tabs:
  - BOM
  - where used
  - alternative OEM
  - suppliers
  - materials
  - bundles
  - documents
- add new tab:
  - standard parts

Status: pending

### Frontend Phase 4
- update client requests screen to support:
  - OEM part
  - standard part
  - free text item

Status: pending

### Frontend Phase 5
- update RFQ workspace / coverage / selection / supplier responses

Status: pending

### Frontend Phase 6
- update downstream consumers:
  - orders
  - purchase orders
  - sales quotes

Status: pending

## Known Impact Zones

These areas are known to be affected and must be rechecked during implementation:

- catalogs
- client detail
- client requests
- RFQ
- coverage
- selection
- supplier responses
- supplier parts
- supplier bundles
- procurement rules
- economics
- client orders
- purchase orders
- sales quotes

## Current Progress Snapshot

Current date: 2026-03-14

Completed:

- architecture direction agreed
- broad dependency analysis completed
- SQL Blocks 1, 2, 3, 4, 5, 6, and 7 applied successfully
- SQL Blocks 1, 2, 3, 4, 5, 6, 7, and 8 applied successfully
- post-cleanup RFQ views repaired successfully after legacy column removal
- fresh valid Cloud SQL dump created after view repair

In progress:

- Backend Phase 1 implementation

Not started:

- backend changes beyond Phase 1
- frontend changes beyond initial standard-parts wiring

## Continuation Instructions For New Chat

If this file is opened in a new chat, continue from the latest completed checkpoint.

Current checkpoint:

- SQL schema cleanup completed far enough to resume implementation work
- next step is Backend Phase 1

Before any backend or frontend changes:

- confirm all SQL blocks are fully applied
- update this file after each completed block

## Execution Log

### 2026-03-14
- SQL Block 1 applied successfully in Google Cloud SQL.
- Verified objects:
  - `equipment_classifier_nodes`
  - `client_equipment_units`
  - `standard_parts`
  - `oem_part_standard_parts`
  - `supplier_part_standard_parts`
  - new columns in `equipment_models`
- Current active next step:
  - prepare and apply SQL Block 2
- SQL Block 2 first attempt failed due to duplicate foreign key name collision with legacy schema.
- Next action:
  - run repair SQL for Block 2 with globally unique FK names
- Cleanup step completed successfully:
  - removed legacy catalog detail tables:
    - `oem_part_bom`
    - `oem_part_fitments`
    - `migration_original_to_oem`
    - `original_part_alt_*`
    - `original_part_bom`
    - `original_part_documents`
    - `original_part_material*`
    - `original_part_substitution*`
- New next action:
  - apply clean version of SQL Block 2
- Clean SQL Block 2 applied successfully.
- Verified objects:
  - `oem_part_model_fitments`
  - `oem_part_model_bom`
  - `oem_part_alt_groups`
  - `oem_part_alt_items`
  - `oem_part_documents`
  - `oem_part_materials`
  - `oem_part_material_specs`
  - `supplier_bundles.oem_part_id`
  - `supplier_procurement_rules.oem_part_id`
- Current active next step:
  - prepare and apply SQL Block 3
- SQL Block 3 applied successfully after schema-specific repair.
- Current active DB snapshot:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_00_00).sql`
- New next action:
  - prepare cleanup block for legacy `original_part_id` dependencies and final schema cleanup
- SQL Block 4 applied successfully.
- Current active DB snapshot:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_13_41).sql`
- SQL Block 5 applied successfully.
- Legacy foreign keys to `original_parts` were removed where OEM/standard replacements already exist.
- `supplier_part_originals` was dropped.
- Current active DB snapshot:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_22_34).sql`
- SQL Block 6 applied successfully.
- Verified changes:
  - `supplier_quality_events.oem_part_id`
  - `supplier_quality_events.standard_part_id`
  - `vw_rfq_supplier_latest_lines` rebuilt on OEM/standard fields
  - `vw_rfq_cost_base` rebuilt on OEM/standard fields
- Current active DB snapshot:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_31_28).sql`
- Current active next step:
  - prepare final cleanup SQL for remaining hard dependencies on `original_parts`
- SQL Block 7 applied successfully.
- Verified changes:
  - removed hard FK dependency from `rfq_coverage_option_lines` to `original_parts`
  - removed hard FK dependency from `rfq_item_components` to `original_parts`
- Current active DB snapshot:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (17_39_23).sql`
- Current active next step:
  - prepare final cleanup SQL for `original_parts` table and remaining legacy original-part columns
- SQL Block 8 applied successfully.
- Verified changes:
  - `original_parts` table removed
  - post-check confirmed `SHOW TABLES LIKE 'original_parts'` returned no rows
- Current active DB snapshot:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (20_19_06).sql`
- Legacy-column cleanup caused RFQ dump/export failure because `vw_rfq_cost_base` became invalid.
- Repair step completed successfully:
  - `vw_rfq_supplier_latest_lines` recreated without legacy original-part columns
  - `vw_rfq_cost_base` recreated without legacy original-part columns
  - validation query against both views returned rows successfully
- New current active DB snapshot:
  - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-14 (20_46_26).sql`
- Current active next step:
- start Backend Phase 1 on the finalized OEM/standard schema
- Backend Phase 1 started in codebase.
- Implemented initial backend endpoints:
  - `/equipment-classifier-nodes`
  - `/client-equipment-units`
  - `/standard-parts`
  - `/oem-part-standard-parts`
- Extended `/equipment-models` to expose classifier fields needed by the new equipment flow.
- Added initial frontend wiring for the new standard-parts catalog:
  - route `/standard-parts`
  - sidebar/catalogs navigation entry
  - first working list/create/edit page for `standard_parts`
- Added initial client-side equipment UI:
  - new `Equipment` tab on the client detail page
  - list/create/edit/delete flow for `client_equipment_units`
  - manufacturer/model selection wired to `equipment-manufacturers` and `equipment-models`
- Added initial classifier UI:
  - route and catalogs/sidebar entry for the equipment classifier
  - tree-based page for `equipment_classifier_nodes`
  - create root/child, edit, delete, and inspect node details
- OEM catalog replacement started on the frontend/backend edge:
  - new backend route `/oem-parts` added and wired into `routerIndex.js`
  - legacy user route `/original-parts` now renders a new OEM-centered catalog screen backed by `/oem-parts`
  - detail route `/original-parts/:id` now loads OEM part cards from `/oem-parts/:id/full`
  - catalog labels in navigation changed from `Оригинальные детали` to `OEM детали` while keeping the old path for compatibility
- Frontend production build completed successfully after the OEM catalog replacement pass.
- Local backend smoke for `/oem-parts` with an ad-hoc token returned `403` due to tab-access/auth context, so route validity is currently confirmed by syntax check and frontend build wiring rather than a privileged runtime call.
- Client request migration started with a compatibility bridge:
  - `utils/clientRequestStructure.js` now reads OEM data from `oem_parts` / `oem_part_model_bom` / OEM-based item components
  - `routes/clientRequests.js` manual revision-item CRUD paths were updated to write `oem_part_id` / `standard_part_id` while still exposing legacy alias fields (`original_part_id`, `original_cat_number`) to avoid a full frontend rewrite in one step
  - `ClientRequestsPage.jsx` search/add pickers for request items now query `/oem-parts` and normalize OEM rows into the legacy UI shape expected by the page
  - syntax checks passed for `routes/clientRequests.js` and `utils/clientRequestStructure.js`
- Frontend production build completed successfully after the client-request OEM compatibility bridge.
- Client request import/create-missing migration completed:
  - import preview now resolves parts against `oem_parts` + `oem_part_model_fitments`
  - import commit now creates missing OEM parts in `oem_parts` and links them to equipment models through `oem_part_model_fitments`
  - direct references to `original_parts` were removed from `routes/clientRequests.js`
- Frontend production build completed successfully after the client-request import migration.
- RFQ migration started with a compatibility pass:
  - `utils/rfqStructure.js` now reads RFQ structure data from `oem_parts`, `oem_part_model_bom`, `supplier_bundles.oem_part_id`, and `supplier_part_oem_parts`
  - `routes/rfqs.js` basic item list, strategy/rebuild endpoints, item create/bulk add, and RFQ component CRUD now read/write OEM-backed fields while still exposing legacy alias fields to the frontend where needed
  - syntax checks passed for `utils/rfqStructure.js` and `routes/rfqs.js`
- Frontend production build completed successfully after the initial RFQ compatibility pass.
- Remaining RFQ legacy work is now concentrated mainly in selection / accepted-existing-price / supplier-response flows, plus downstream `coverage`, `supplierResponses`, and `economics` routes.
- RFQ selection/response write-path migration advanced:
  - `rfq_supplier_line_selections` write/read paths in `routes/rfqs.js` now use OEM-backed columns (`oem_part_id`, `alt_oem_part_id`, `standard_part_id`) while still exposing legacy alias names in API payloads
  - accepted-existing-price creation now inserts into `rfq_response_lines` using `oem_part_id` / `requested_oem_part_id` / standard-part counterparts
  - supplier response import path now creates response lines on OEM-backed columns and links supplier parts through `supplier_part_oem_parts`
- Frontend production build completed successfully after the RFQ selection/response write-path pass.
- `supplierResponses` migration started with a compatibility pass:
  - `routes/supplierResponses.js` now resolves active RFQ items and RFQ components against OEM-backed columns
  - supplier-response create/update helper paths now write `rfq_response_lines` through OEM-backed fields while preserving legacy alias names in request/response payloads
  - workspace/lines/revision-lines queries were partially migrated to read from `oem_parts`, `rfq_item_components.oem_part_id`, and OEM-backed selection/response fields
  - direct references to `original_parts` and `supplier_part_originals` were removed from `routes/supplierResponses.js`
- Frontend production build completed successfully after the supplier-responses compatibility pass.
- `coverage` migration completed with OEM-backed persistence:
  - `routes/coverage.js` now reads option/item line metadata from `oem_parts`
  - manual coverage option save/replace now writes `rfq_coverage_option_lines.oem_part_id` / `standard_part_id` instead of legacy original-part columns
  - API responses still expose compatibility alias fields like `original_part_id` / `original_cat_number` for the current frontend
- Frontend production build completed successfully after the coverage compatibility pass.
- `economics` migration completed with OEM-backed source joins:
  - `routes/economics.js` no longer joins `original_parts` in scenario lines, shipment groups, coverage option summaries, or scenario detail responses
  - economics responses now source part labels from `oem_parts.part_number` while still exposing compatibility fields like `original_part_id` / `original_cat_number` for the current frontend
  - direct legacy reads from `original_parts` were removed from `routes/economics.js`
- Frontend production build completed successfully after the economics compatibility pass.
- downstream quote/order read models advanced:
  - `routes/salesQuotes.js` quote revision lines now source part labels from `oem_parts.part_number` and expose compatibility fields from `cri.oem_part_id`
  - `routes/purchaseOrders.js` purchase-order lines now source part labels from `oem_parts.part_number` and expose compatibility fields from `cri.oem_part_id`
  - direct `original_parts` joins were removed from these two downstream read paths
- Frontend production build completed successfully after the sales-quotes / purchase-orders compatibility pass.
- `selection` read model aligned with OEM-backed RFQ components:
  - `routes/selection.js` selection lines now resolve component metadata through `rfq_item_components.oem_part_id` and `oem_parts.part_number`
  - response payload keeps the same compatibility field names (`component_original_part_id`, `component_cat_number`) for the current frontend
- Frontend production build completed successfully after the selection compatibility pass.
- client-request equipment-context UI introduced without breaking the current schema:
  - `ClientRequestsPage` now supports selecting a concrete client equipment unit as request context for OEM picking
  - add/edit/quick-add/import flows now pass `equipment_model_id` from the selected equipment context into request items, which fits the current DB schema safely
  - request item list now shows equipment model/manufacturer context sourced from `client_request_revision_items.equipment_model_id`
  - `ClientEquipmentUnitsMain` now exposes direct actions to create a new client request from a specific unit and to open the OEM catalog filtered by that equipment
  - OEM catalog frontend now reads `manufacturer_id` / `equipment_model_id` from URL params, so deep links from client equipment are usable
- Frontend production build completed successfully after the client-request equipment-context pass.
- OEM equipment-aware visibility extended into catalog/detail:
  - `routes/oemParts.js` list payload now includes `client_usage_count`
  - `GET /oem-parts/:id/full` now returns `client_usage` rows showing concrete client equipment units whose model matches this OEM part fitment
  - OEM catalog list now shows a `Client usage` column
  - OEM detail now shows both summary count and a dedicated `У клиентов` tab with client, machine, serial number, and site
  - add-position modal messaging now explicitly states when the list is already filtered to details matching the selected equipment context
- Frontend production build completed successfully after the OEM client-usage visibility pass.
- equipment-aware UX polish added for testing:
  - add-position modal now marks OEM rows with a visible `Fits selected equipment` badge when a request equipment context is active
  - OEM detail `У клиентов` tab now provides a direct `Создать заявку` action for each concrete client equipment unit
  - clicking that action opens `Client Requests` prefilled for the corresponding client and equipment unit
- Frontend production build completed successfully after the equipment-aware UX polish pass.
- 2026-03-14 22:59 EET: Russian UI labels normalized on newly added equipment/OEM flows:
  - client card tab `Equipment` renamed to `Оборудование`
  - request workspace/edit/add-position equipment-context labels translated to Russian
  - OEM catalog/detail metric labels translated to Russian
  - client equipment table empty-state `No data` replaced with `Нет оборудования клиента`
- 2026-03-14 23:06 EET: corrective compatibility rollback after manual regression review:
  - restored `/original-parts` list and `/original-parts/:id` detail to the legacy full-featured UI (`OriginalPartsMain` + `DetailDock`) so import/BOM/materials/documents/alternatives/supplier-links remain available
  - restored catalog/sidebar naming for `/original-parts` back to `Оригинальные детали`
  - migrated `routes/supplierParts.js` and `routes/supplierPartOriginals.js` from removed `supplier_part_originals` / `original_parts` tables to compatibility reads/writes over `supplier_part_oem_parts` / `oem_parts`, preserving legacy response field names for the current frontend
- 2026-03-14 23:14 EET: OEM catalog UX corrected to the intended transition shape:
  - `/original-parts` remains the rich working catalog UI, but is again labeled for users as `OEM детали`
  - OEM catalog now opens immediately in global catalog mode (`showAll` + `all`) instead of forcing model-first navigation
  - manufacturer/model selection remains available as a filter/context for create/import without blocking catalog browsing
  - detail/header text updated to `OEM деталь` while preserving legacy rich tabs and workflows
- 2026-03-14 23:21 EET: `routes/originalParts.js` started acting as an OEM compatibility facade for the rich catalog UI:
  - `GET /original-parts` now returns legacy-shaped catalog rows from `oem_parts` / `oem_part_model_fitments` / `oem_part_model_bom`
  - `GET /original-parts/:id/full` now returns legacy-shaped detail payload from `oem_parts` with `application_models` resolved from fitments
  - `POST /original-parts` and `PUT /original-parts/:id` now create/update OEM parts through compatibility mapping while preserving the current rich frontend forms
  - this unblocks the main OEM catalog search/list/create/edit flow on the new schema, while deeper detail tabs still need follow-up migration to OEM-backed endpoints
- `clientOrders` requires a schema-first pass before deeper migration:
  - backend code still contains many legacy `original_part_id` write-paths
  - the current exported Cloud SQL dump does not expose `client_order_*` table DDL in the same way as the already migrated RFQ/client-request tables, so this module should be advanced carefully instead of by blind replacement
- Frontend production build completed successfully after the standard-parts UI wiring.
- Frontend production build completed successfully after the client equipment UI wiring.
- Frontend production build completed successfully after the classifier UI wiring.
- Current active next step:
  - Backend Phase 1 is functionally covered with first UI consumers
  - validate the new client-request equipment-context UX manually
  - validate `Equipment -> OEM catalog -> OEM detail -> client usage` manually
  - resolve `clientOrders` schema shape, then continue that migration
  - in parallel, keep shaving safe legacy read-paths and OEM-detail submodules without breaking existing tabs
- 2026-03-14 23:45 EET: reconciled frontend direction with the original product note from `Тестирование программы.docx`:
  - confirmed the intended UX is not a simplified replacement of the old detail screen, but a rich `OEM детали` catalog with multiple entry points: by manufacturer/model, by client equipment, and by classifier
  - confirmed `Клиенты -> Оборудование` remains the place where concrete client machines with serial numbers are created and edited; that context is not supposed to replace the OEM catalog, but to refine it
  - documented the current frontend gap explicitly: the equipment-context layer exists in client card / requests, but the rich OEM detail tabs were only partially migrated and therefore behaved like a broken hybrid
- 2026-03-14 23:52 EET: restored OEM-backed compatibility for the most visibly broken rich detail submodules:
  - `routes/originalPartDocuments.js` now resolves current detail IDs against `oem_parts` and stores/reads documents through `original_part_documents.oem_part_id`, updating `oem_parts.has_drawing`
  - `routes/originalPartMaterials.js` and `routes/originalPartMaterialSpecs.js` now read/write through `oem_part_materials` / `oem_part_material_specs` while preserving legacy request/response field names expected by the current frontend
  - `routes/originalParts.js` supplier-options path now uses `supplier_part_oem_parts` + `oem_parts` instead of removed `supplier_part_originals` / `original_parts`
  - `routes/supplierBundles.js` now resolves and persists bundle ownership through `supplier_bundles.oem_part_id` while preserving the legacy `original_part_id` field shape for the current frontend bundle tab
  - frontend labels were additionally aligned so the user now sees `OEM детали` more consistently in the active rich catalog/detail flow
- Verification:
  - `node --check` passed for updated backend routes (`originalPartDocuments.js`, `originalPartMaterials.js`, `originalPartMaterialSpecs.js`, `originalParts.js`, `supplierBundles.js`)
  - frontend production build (`vite build`) passed after the OEM rich-detail compatibility pass
- 2026-03-15 00:08 EET: OEM catalog entry flow moved closer to the originally agreed UX:
  - `ManufacturerModelPicker.jsx` was expanded from a simple manufacturer/model drawer into a unified catalog-context picker with three entry modes:
    - by manufacturer and model
    - by client and concrete equipment unit (including serial number / year / site)
    - by equipment classifier node
  - `OriginalPartsMain.jsx` now stores and shows the selected catalog context, so when the user enters the OEM catalog through a client machine or classifier branch, the current context remains visible in tags above the table
  - list/detail roundtrip now preserves this catalog context through navigation state
  - `routes/clientEquipmentUnits.js` now exposes `manufacturer_id` in addition to `manufacturer_name`, which makes the client-equipment path usable as a first-class OEM catalog context instead of a UI-only badge
- Verification:
  - `node --check routes/clientEquipmentUnits.js` passed
  - frontend production build (`vite build`) passed after the unified OEM catalog picker/context pass
- 2026-03-15 00:24 EET: deep OEM detail-card migration advanced into remaining legacy-heavy tabs:
  - `routes/originalPartBom.js` now uses `oem_parts` + `oem_part_model_bom` for list/tree/used-in/create/update/delete while preserving the current `/original-part-bom` API shape expected by the rich frontend
  - `routes/originalPartAlt.js` now uses `oem_part_alt_groups` / `oem_part_alt_items` + `oem_parts` while preserving current `original_part_id` / `alt_part_id` field names for the rich frontend alternatives tab
  - this removes the deepest remaining direct dependency of the rich OEM detail tabs on the dropped legacy BOM/alt catalog substructures
- 2026-03-15 00:33 EET: unit-specific OEM override schema was added successfully in Google Cloud SQL:
  - created `oem_part_unit_overrides`
  - created `oem_part_unit_material_overrides`
  - created `oem_part_unit_material_specs`
  - first DDL attempt failed because Cloud SQL / MySQL rejected a `CHECK` that referenced `replacement_oem_part_id` together with an FK using `ON DELETE SET NULL`
  - corrected DDL was applied successfully without that incompatible `CHECK`, with the `replaced -> replacement_oem_part_id` rule moved to backend validation
  - user created a fresh post-DDL Cloud SQL dump:
    - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-15 (00_17_08).sql`
- 2026-03-15 00:48 EET: rich OEM detail UI gained the two missing business tabs that close the main product gaps discussed after the schema migration:
  - new backend compatibility route `routes/originalPartUnitOverrides.js` added under `/original-parts/*` for machine-specific override CRUD and machine-specific material/spec override CRUD
  - rich `DetailDock` now includes `Стандартные детали`, backed by existing `/oem-part-standard-parts` links, so OEM-to-standard normalization is visible and editable inside the current working card instead of only in the new standalone OEM screen
  - rich `DetailDock` now includes `По машинам клиентов`, showing all client equipment units that inherit this OEM part through model fitment, plus per-machine override status (`applies`, `excluded`, `replaced`, `variant`)
  - the new machine-specific tab also supports:
    - choosing a replacement OEM part for a concrete machine
    - storing a machine-specific note and effective dates
    - maintaining machine-specific material overrides and machine-specific material specs
  - this is the first end-to-end implementation of the agreed rule that an OEM part stays a single master object, while client-machine differences are stored as overrides instead of duplicating the OEM part itself
- Verification:
  - `node --check` passed for `routes/originalPartUnitOverrides.js` and `routes/routerIndex.js`
  - frontend production build (`vite build`) passed after adding the `Стандартные детали` and `По машинам клиентов` tabs to the rich OEM detail card
- 2026-03-15 01:09 EET: supplier-part linking and classifier UX were aligned with the agreed product logic without adding new mandatory DB fields:
  - new backend route `routes/supplierPartStandardParts.js` added for `supplier_part_standard_parts`, so supplier parts can now be linked directly to normalized standard items in addition to OEM parts
  - supplier-part UI no longer depends conceptually on a separate “OEM-only” linking workflow:
    - the existing `Добавить привязку` flow in `OriginalsLinkTab.jsx` now asks what is being linked:
      - `OEM деталь / сборка`
      - `Стандартное изделие`
    - the links table now shows both link types in one place instead of implying that every supplier item must be attached only to OEM
  - this matches the intended business rule:
    - supplier OEM-specific items link to OEM parts
    - supplier bolts/bearings/other standard goods link to standard parts
  - classifier schema review showed that no additional mandatory SQL is needed right now:
    - `equipment_classifier_nodes` already has `parent_id`, `node_type`, `code`, `sort_order`, `is_active`, `notes`
    - `equipment_models` already has `classifier_node_id`, `model_code`, `notes`
    - the current blocker was UX clarity, not missing relational structure
  - the OEM catalog context picker and classifier page were relabeled away from technical wording:
    - `По классификатору` -> `По типу оборудования`
    - node-type labels translated from enum values to user-facing Russian
    - classifier page help text clarified that the tree is configured first and then used to navigate into models and OEM catalog contexts
- Verification:
  - `node --check` passed for `routes/supplierPartStandardParts.js` and `routes/routerIndex.js`
  - frontend production build (`vite build`) passed after the unified supplier-linking flow and classifier UX pass
- 2026-03-15 01:28 EET: classifier stopped being a standalone tree editor and gained the first real working workspace above models and client machines:
  - new backend endpoint `GET /equipment-classifier-nodes/:id/workspace` added in `routes/equipmentClassifierNodes.js`
  - this endpoint uses the existing schema only (`equipment_classifier_nodes`, `equipment_models.classifier_node_id`, `client_equipment_units.equipment_model_id`, `oem_part_model_fitments.equipment_model_id`) and therefore required no extra SQL migration
  - selected classifier node now returns:
    - subtree stats
    - manufacturers present in the subtree
    - models assigned to the subtree
    - client equipment units whose models belong to the subtree
    - OEM-parts count through model fitments
  - `EquipmentClassifierMain.jsx` right panel was rebuilt into a workspace view:
    - node summary
    - subtree counters
    - manufacturers table
    - models table
    - client machines table
    - quick actions to create a model inside the node and to open OEM catalog
  - OEM catalog compatibility route `routes/originalParts.js` now accepts `classifier_node_id`, so opening OEM catalog from a classifier node shows relevant OEM parts instead of a generic list
  - `OriginalPartsMain.jsx` now restores catalog context from URL query params, including `classifier_node_id`, which makes cross-navigation from classifier/client-equipment/model contexts actually work
- Verification:
  - `node --check` passed for `routes/equipmentClassifierNodes.js` and `routes/originalParts.js`
  - frontend production build (`vite build`) passed after the classifier workspace pass
- 2026-03-15 01:42 EET: Cloud SQL classifier seed was applied successfully and the existing equipment models were mapped into the first usable engineering tree:
  - created root and first production classifier branches:
    - `Горное оборудование`
    - `Дробильное оборудование`
    - `Навесное и вспомогательное оборудование`
    - `Измельчительное оборудование`
    - `Прочее оборудование`
    - subtypes `Дробилки гирационные`, `Дробилки конусные`, `Дробилки щековые`, `Манипуляторы`, `Гидромолоты`, `Мельницы`
  - assigned all current `equipment_models` to classifier nodes through `equipment_models.classifier_node_id`
  - classifier workspace now works against real seeded data instead of an empty tree
  - new Cloud SQL dump after the successful classifier seed:
    - `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-15 (01_21_59).sql`
- 2026-03-15 01:58 EET: classifier UX was tightened for daily work:
  - `EquipmentClassifierMain.jsx` layout was switched to a stable two-column workspace so the right side no longer looks empty on wide screens
  - added quick manufacturer creation directly inside the `Создать модель в узле` flow:
    - if the needed equipment manufacturer does not exist, it can now be created inline and is immediately selected in the model form
  - added tree search by node name/code, so the classifier remains usable when the hierarchy grows
- 2026-03-15 02:08 EET: classifier workspace got the first practical in-node search layer:
  - added `Поиск в узле` field inside the selected-node workspace
  - this search now filters, in one place:
    - manufacturers in the subtree
    - models in the subtree
    - client machines in the subtree
  - intended UX:
    - left search finds classifier nodes
    - workspace search finds the actual working entities inside the selected equipment type
- Verification:
  - frontend production build (`vite build`) passed after the classifier layout, inline-manufacturer-create, tree-search, and in-node workspace-search pass
- Verification:
  - `node --check` passed for `routes/originalPartBom.js` and `routes/originalPartAlt.js`
- 2026-03-15 02:24 EET: machine-specific OEM tab UX was simplified to match the agreed business logic:
  - `OriginalPartUnitOverridesTab.jsx` no longer exposes two competing primary actions (`Override` + `Материалы`) on every machine row
  - the row action is now a single Russian-labeled entry point: `Настроить`
  - the old English `Override` wording was removed from the main machine-specific flow
  - the machine settings modal was rewritten as `Настройка для машины`, with Russian action buttons and status guidance text explaining what each status really means:
    - базово используется
    - исключить для этой машины
    - заменена другой OEM деталью
    - особое исполнение / вариант
  - materials/specs were kept as optional secondary clarification inside the same machine-settings flow:
    - they are now opened from the bottom section `Дополнительные уточнения по этой машине`
    - this matches the agreed rule that materials are only one possible example of a machine-specific difference, not the main action itself
  - machine-material labels were also translated away from technical English (`machine-specific`) to plain Russian
- Verification:
  - frontend production build (`vite build`) passed after the machine-specific OEM tab UX simplification

### 2026-03-15 02:55 EET - OEM catalog show-all UX clarified
- In `/original-parts` the `show all OEM catalog` mode now renders as a separate mode instead of looking like an active manufacturer/model filter.
- Added explicit `Режим: весь OEM каталог` / `Контекст: ...` badges in `OriginalPartsMain.jsx` so global list mode is no longer visually confused with model-scoped filtering.
- Verified with `vite build`.

### 2026-03-15 03:00 EET - OEM catalog got client-aware columns in global mode
- In the global OEM catalog table (`show all OEM catalog`) added client-aware visibility:
  - `Клиенты`
  - `Машины клиентов`
- Backend list query in `routes/originalParts.js` now returns:
  - `client_names`
  - `clients_count`
  - `client_units_count`
  based on `oem_part_model_fitments -> client_equipment_units -> clients`.
- Frontend table in `OriginalPartsTable.jsx` now:
  - renders a dedicated `Клиенты` column
  - supports filtering by exact client from that column
  - renders `Машины клиентов` as a sortable numeric column
- `OriginalPartsMain.jsx` now includes these columns in the default `showAll:*` column set.
- For users who already had saved column visibility, the new columns are softly appended into existing `showAll` views so the feature appears without manual reset.
- Verification:
  - frontend production build (`vite build`) passed
