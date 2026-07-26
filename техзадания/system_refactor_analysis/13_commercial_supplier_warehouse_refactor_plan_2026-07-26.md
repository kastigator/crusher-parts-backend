# Commercial, supplier and warehouse refactor plan

Date: 2026-07-26

This note extends the current classifier/BOM handoff:

- `/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/12_current_handoff_2026-07-03.md`

Active architecture remains:

```text
Classifier -> equipment model -> manufacturer BOM -> catalog position card -> supplier/commercial/warehouse contour
```

Do not rebuild the commercial or warehouse contour around the old OEM/original-parts/standard-parts concepts. Legacy column names may still exist as migration debt, but they are not the product model.

## Core decision

The current warehouse implementation was intentionally started as a small training contour, but its conceptual anchor must change before the feature grows.

Correct model:

```text
catalog_position = what the system/user needs and searches for
supplier_part    = what a supplier actually sells or manufactures
warehouse stock  = physical quantity of supplier_part at a warehouse/place/lot
```

Therefore:

- a catalog position can be used to find stock;
- a catalog position can aggregate stock through linked supplier parts;
- but a warehouse balance must not be owned by catalog_position only;
- purchase orders and receipts must be based on supplier_part.

## Human workflow

### 1. Client request

A manager receives a client request and creates/imports request lines.

Each line should carry:

- client-visible number and description;
- quantity and unit from the shared measurement-unit dictionary;
- optional link to a catalog position;
- revision state.

The catalog position is the normalized internal anchor. It may come from classifier/BOM search, manual matching or later cleanup.

### 2. Procurement / RFQ

When the request is released, procurement works with an RFQ for a specific request revision.

The buyer needs to:

- see requested lines grouped by catalog position and structure;
- select candidate suppliers;
- reuse known supplier parts linked through `supplier_part_catalog_positions`;
- create new supplier parts from supplier replies when needed;
- keep the original supplier text/number as evidence.

RFQ is a procurement subprocess. It should not be the main place for sales quote, client contract and warehouse execution.

### 3. Supplier response

A supplier response line is an offer for a requested line or component.

It should resolve to:

- `supplier_part_id` when the supplier item is known or created;
- `catalog_position_id` through the requested line/component and/or supplier-part link;
- supplier price, currency, delivery terms, lead time and source evidence.

When a response creates or reuses a supplier part, the system should upsert a link:

```text
supplier_part_catalog_positions
(supplier_part_id, catalog_position_id, relationship_type, confidence, notes)
```

### 4. Coverage, economics and selection

Coverage and scenario calculations choose concrete supplier offers. Selection is the procurement decision.

Selection lines should preserve display snapshots for human documents, but their semantic chain should be:

```text
request line / RFQ item -> catalog_position -> supplier_part -> supplier response line -> selected commercial option
```

### 5. Sales quote and contract

The client quote is created from an approved selection. It belongs to the client request workspace, not to the RFQ workspace as the main operating surface.

After client approval, a contract locks the commercial deal. Purchase orders can be created only from this approved/signed commercial context.

### 6. Purchase order and warehouse

Supplier purchase orders are execution documents for selected supplier parts.

Warehouse receipt should be created from PO lines:

```text
supplier_purchase_order_line -> supplier_part -> warehouse_document_line -> stock movement
```

The stock page and catalog position card may search and aggregate by catalog position, but the physical stock row must keep `supplier_part_id`.

## Target workspaces

### Client Request Workspace

This should become the main commercial cockpit.

Recommended tabs:

- `Заявка`: positions, revision, client source text;
- `Закупка`: RFQ status, coverage status, link/open procurement workspace;
- `Выбор`: approved supplier scenario and selected lines;
- `КП и маржа`: sales quote revisions, margin and client-facing price;
- `Контракт`: client contract status and documents;
- `Исполнение`: supplier PO, receipts, reserves and stock impact.

### Client Workspace

The current client catalog already has a separate client card (`ClientDetailPage` + `ClientDock`), but `/clients` itself is still mostly a registry table. The next UX refactor should follow the supplier workspace pattern:

- left side: searchable client list/queue with filters;
- right side: selected client work area;
- `Обзор`: legal/basic client profile, primary contacts, quick health flags;
- `Контакты и адреса`: contacts, billing addresses, shipping addresses and bank details;
- `Оборудование`: client equipment units and linked models;
- `Номенклатура клиента`: client part numbers/drawings linked to catalog position cards;
- `Заявки и сделки`: client requests, sales quotes and contracts;
- `Исполнение`: supplier PO context, warehouse receipts, reserves and delivery status for this client.

Client workspace should not become a replacement for Client Request Workspace. The client card answers “who is the client and what history/context do we have?”, while Client Request Workspace answers “what is happening with this specific request/deal?”.

### RFQ Workspace

This should become a focused procurement cockpit.

Recommended grouped stages:

- `Состав RFQ`;
- `Поставщики и отправка`;
- `Ответы и покрытие`;
- `Сценарии, экономика и выбор`.

Sales quote, client contract and PO may be visible as read-only context or links, but they should not make RFQ look like the whole company process.

### Supplier Workspace

The current split between `Suppliers` and `Supplier Parts` should be merged into one working area.

Supplier card tabs:

- `Обзор`: legal/name/status/quality summary;
- `Контакты и реквизиты`;
- `Номенклатура`: supplier parts and links to catalog positions;
- `Цены`: price history and sources;
- `RFQ и ответы`;
- `Заказы`;
- `Склад`.

### Warehouse Workspace

Warehouse should be an execution/availability workspace:

- search by supplier part number, supplier, catalog position, model/BOM number, location;
- balances by supplier part, warehouse, place and lot/status;
- documents: receipt, movement, write-off, reserve, release reserve;
- optional aggregation by catalog position for sales/procurement users.

## Current technical pressure points

The codebase already has a good bridge table:

```text
supplier_part_catalog_positions
```

But many active routes still use old field names in hot paths:

- `client_request_revision_items.oem_part_id`
- `rfq_items.oem_part_id`
- `rfq_item_components.oem_part_id`
- `rfq_response_lines.oem_part_id`
- `rfq_coverage_option_lines.oem_part_id`
- frontend props named `original_part_id`

These should be treated as legacy names until migrated. New code should introduce and prefer `catalog_position_id`.

The current warehouse migration (`2026-07-26_warehouse_core.sql`) stores stock movements by `catalog_position_id`. That must be corrected before warehouse becomes operational.

## Implementation order

### Phase 1: Data contract and compatibility layer

Goal: make the new model explicit while preserving existing screens.

- add `catalog_position_id` to request/RFQ/response/coverage/selection/order lines where missing;
- backfill from current classifier/BOM-linked data where possible;
- expose response fields as `catalog_position_id` while keeping legacy aliases only for compatibility;
- centralize display helpers so UI reads `catalog_position_*` names first.

### Phase 2: Supplier workspace merge

Goal: make supplier the entry point for supplier parts.

- keep existing `/suppliers` route as the main page;
- move supplier parts list into supplier card/workspace;
- keep `/supplier-parts` temporarily as a redirect or technical list until removed;
- add actions to link supplier parts to catalog positions from supplier context.

Progress on 2026-07-26:

- `/suppliers` was converted to a split workspace: supplier list on the left, selected supplier work area on the right.
- The supplier work area now reuses the same supplier card tabs and opens on supplier parts by default.
- Supplier parts can be managed from the supplier context through embedded `SupplierPartsMain`.
- `/supplier-parts` remains available as a compatibility/technical list, but it was removed from the catalog overview as a primary entry point.
- The old `/suppliers/:id` detail route still works and uses the same supplier work area, so existing links are not broken.
- Supplier part rows now have a direct action for managing links to catalog position cards from the supplier workspace.
- Supplier part dimension UI now displays and accepts millimeters, while converting to the current legacy `*_cm` API fields at the frontend boundary.

Next decisions for this phase:

- supplier part card should become the operational object for warehouse receipts and supplier price evidence;
- supplier part dimensions still use legacy `*_cm` database/API fields and should be migrated before warehouse becomes operational;
- supplier parts need a clearer inline action for linking to catalog positions from the supplier workspace.

### Phase 3: RFQ simplification

Goal: make RFQ focused on procurement.

- group the many RFQ tabs into fewer workflow stages;
- make supplier-part matching visible in responses and coverage;
- create/update supplier parts and catalog links from response import/manual entry.

### Phase 4: Warehouse correction

Goal: make physical stock belong to supplier parts.

- add `supplier_part_id` to warehouse document lines and stock movements;
- make it required for operational receipt/movement/reserve;
- keep `catalog_position_id` as derived/search context where useful;
- update catalog position card stock tab to show supplier-part-based balances.

Progress on 2026-07-26:

- Added migration `sql/2026-07-26_warehouse_supplier_part_anchor.sql`.
- `warehouse_document_lines` and `warehouse_stock_movements` now have `supplier_part_id`; `catalog_position_id` is nullable context.
- New warehouse documents require a supplier part in every line; backend resolves/checks the catalog-position context through `supplier_part_catalog_positions`.
- Warehouse stock and reservation aggregation is now grouped by supplier part, warehouse and storage place.
- `/warehouse/supplier-parts` was added for document line picking by supplier, supplier part number, description and linked catalog position.
- `/warehouse/positions/:id` still supports opening stock from a catalog position card, but returns supplier-part-based balances.
- Frontend warehouse documents now pick `Деталь поставщика`, while catalog position filters the candidate list when opened from a card.
- The catalog position card warehouse tab now shows supplier part, supplier and stock/reserve/movement rows instead of an abstract position balance.
- Added migration `sql/2026-07-26_warehouse_document_line_sources.sql`.
- `warehouse_document_lines` now stores line-level source fields (`source_type`, `source_id`, `source_line_id`, `source_label`), so a receipt can be tied to the exact `supplier_purchase_order_line`.
- Warehouse receipt validation rejects PO-based receipts that reference a missing PO line, use the wrong supplier part, or exceed the ordered quantity already received/prepared.
- `GET /purchase-orders/:id/lines` now returns supplier-part context, catalog-position context, `received_qty`, `pending_receipt_qty` and `remaining_receipt_qty`.
- The purchase orders page now has `Принять на склад`: it creates a posted warehouse receipt from remaining PO lines by `supplier_part_id` and line source, without re-searching details in the warehouse screen.

### Phase 4.1: Purchase order execution workspace

Goal: make `Заказы поставщикам` a focused execution workspace instead of a passive document registry.

Progress on 2026-07-26:

- Added read-only `GET /purchase-orders/:id/receipts` to show warehouse receipts tied to a PO through line-level source fields.
- The purchase order drawer was converted into tabs: `Сводка`, `Состав`, `Приемки`, `Документ`, `Качество`.
- `Сводка` shows ordered/received/remaining quantities and warns when PO lines are not tied to supplier parts.
- `Приемки` shows receipt documents and receipt lines for the selected PO without requiring a jump to the warehouse workspace.
- `Качество` shows PO-specific supplier quality events and refreshes after adding a new event.

### Phase 5: Client commercial cockpit

Goal: make the client request the main commercial workspace.

- move RFQ summary, selected scenario, sales quote, contract, PO and stock state into one readable request lifecycle;
- reduce duplication between Client Request Workspace and RFQ Workspace;
- keep dedicated pages for bulk queues only.

Progress on 2026-07-26:

- Added read-only `GET /client-requests/:id/commercial-summary`.
- The endpoint aggregates the current request revision, RFQ state, supplier responses, approved/selected scenario, sales quotes, contracts, supplier purchase orders and PO-linked warehouse receipts.
- No warehouse or commercial records are created by this summary endpoint; it only reads the normalized chain already present in the training DB.
- Client Request Workspace now opens on a new `Сводка` tab.
- `Сводка` shows the request lifecycle, blockers, purchasing economics, quote/contract status and execution state in one place.
- The first verified training request was `FG036SP-26` / `RFQ-FG036SP-26`.
- Added a single `Расчет и КП` section in Client Request Workspace.
- The old top-level `Маржа`, `КП` and `Контракт` tabs are now presented as inner stages: `Расчет` -> `КП` -> `Контракт`.
- Existing legacy tab keys (`margin`, `quote`, `contract`) still work as aliases, so RFQ and saved links can open the right commercial stage without breaking navigation.
- Added read-only `GET /client-requests/:id/execution-summary`.
- Client Request Workspace now has an `Исполнение` tab that shows active contract state, supplier PO rows, PO lines, posted/draft receipts, remaining receipt quantities, supplier-part stock and active reservations for the selected request.
- `Сводка` now links to `Исполнение` from the PO/receipts block.
- No warehouse, PO, commercial or test records are created by the execution summary; it only reads the existing request -> RFQ -> selection -> PO -> receipt/reserve chain.
- Verified on training request `FG036SP-26`; the current DB state has no PO for this request, so the execution tab correctly reports an empty execution state with a warning.
- Added a purchase-order creation path from Client Request Workspace execution:
  - `GET /purchase-orders/from-client-request/:id/preview` returns what can be created, what already exists and what is blocked;
  - `POST /purchase-orders/from-client-request/:id` creates one draft PO per supplier/execution profile only after a signed/in_execution contract;
  - existing active PO groups are skipped, so repeated execution does not duplicate orders;
  - blocked groups include rows without supplier part, because warehouse execution must be supplier-part based.

Margin-map calculator adoption decision:

- The calculator from `/Users/aleksandrlubimov/project/margin-map-local` belongs to the `Расчет` stage inside `Расчет и КП`, not to `Исполнение`.
- In this system, RFQ/selection remains the purchasing cost base; the calculator should work on a sales quote revision and produce client-facing sell prices, margin and tax/overhead allocation.
- Useful parts to transfer:
  - proportional distribution of common expenses across quote lines;
  - global inputs for route/overhead buckets, financial losses, VAT and regional markup;
  - line inputs for purchase price, quantity, weight, customs percent and line-level markups;
  - logistics-rate request/application pattern, but wired to the existing logistics/economics data rather than a separate pilot registry.
- Do not persist calculator drafts as disconnected records. First safe implementation should be:
  1. backend calculator service with preview-only endpoint for a `sales_quote_revision_id`;
  2. UI panel in `RequestMarginTabContent` that shows inputs and previewed line prices;
  3. explicit `Применить к ревизии КП` action that updates `sales_quote_lines.sell_price/margin_pct` and stores a calculation snapshot for audit.
- After quote is sent/approved or contract is signed, calculator inputs become read-only. `Исполнение` must only create PO, receipts and reserves from the locked commercial context.

Progress on 2026-07-26:

- Added backend calculation utility `utils/commercialCalculator.js` based on the recovered margin-map formula.
- Added read-only `POST /sales-quotes/revisions/:revisionId/calculation-preview`.
- The preview reads saved active `sales_quote_lines`, applies shared route/overhead/percent inputs and returns line totals plus aggregate purchase, DAP RK, without VAT, with VAT and margin figures.
- The endpoint does not create records, update quote lines or log activity; missing costs, inactive lines, zero quantity and mixed currency are returned as warnings.
- Added a compact calculator panel to the `Расчет` stage in `RequestMarginTabContent`.
- The UI groups inputs by human workflow: route, customs/documentation and markup/tax percentages.
- The calculator is blocked while quote line drafts are unsaved, because preview is intentionally based on the saved revision state.
- Added migration `sql/2026-07-26_sales_quote_calculation_snapshots.sql`.
- Added `sales_quote_calculations` and `sales_quote_calculation_lines` as revision-bound audit snapshots.
- Added `POST /sales-quotes/revisions/:revisionId/calculation-apply`.
- Applying a calculation is allowed only for the editable latest sales quote revision and blocks zero quantity, missing purchase price or zero calculated sell price.
- Applying updates active `sales_quote_lines.sell_price` with the calculated price without VAT, recomputes margin fields and stores the full calculation snapshot including VAT totals.
- The `Расчет` UI now has a confirmed `Применить в КП` action after preview.
- The local training DB schema was updated with the snapshot migration; no business/test rows were inserted.

Next decisions for this phase:

- keep RFQ as procurement input and make client-facing economics live in the client request workspace;
- add controlled actions from `Исполнение`: receive remaining PO lines into warehouse and reserve/release stock for the request.
- add calculation history/viewing in the `Расчет` stage and decide how VAT should appear in generated КП/contract documents.

### Phase 6: Legacy cleanup

Goal: remove old conceptual paths.

- remove user-facing `original/oem/standard` labels from active UI;
- migrate API consumers to `catalog_position_id`;
- drop or archive obsolete compatibility code after data is migrated.

## First safe code step

The first implementation step should be small and non-destructive:

1. Add a backend compatibility helper for resolving a request/RFQ line's effective catalog position.
2. Add API fields named `catalog_position_id`, `catalog_position_code`, `catalog_position_name` to commercial/RFQ responses that currently emit only `original_part_id`.
3. Update frontend display code to prefer `catalog_position_*` while accepting old aliases.
4. Do not change warehouse persistence in the same patch.

This creates a stable surface for later supplier and warehouse refactors without breaking the current training data or existing RFQ screens.

## Progress 2026-07-26

Phase 1 started and partially implemented.

- Added migration `sql/2026-07-26_commercial_catalog_position_links.sql`.
- Added `catalog_position_id` to request/RFQ/component/response/coverage lines.
- Kept legacy `oem_part_id` / `original_part_id` aliases as compatibility only.
- API responses in client requests, RFQ structure, RFQ items and coverage now expose `catalog_position_*` fields.
- Supplier response import and accepted existing price now persist `catalog_position_id`.
- Supplier response import/accepted price also creates `supplier_part_catalog_positions` links when a supplier part and catalog position are known.
- Frontend display helpers and client request item payloads now prefer `catalog_position_*` fields.
- Backend smoke route list was updated away from removed `originalParts` route.

DB status:

- Migration applied to training DB `crusher_parts_db` through Cloud SQL proxy.
- Safe exact-number backfill linked 28 client request lines, 3 RFQ lines and 3 coverage lines.
- Existing old response lines had no usable RFQ/catalog anchor and were left unmodified.

Next implementation step:

1. Merge `Поставщики` and `Детали поставщиков` into one supplier workspace.
2. Make supplier part the operational item for prices, offers and stock.
3. Then correct warehouse tables/UI from `catalog_position_id` stock to `supplier_part_id` stock, keeping catalog position only as search/grouping context.
