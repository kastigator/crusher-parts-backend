# Activity Entity Types

Канонические `entity_type` для `activity_logs` и `user_activity_events`.

## Бизнес-процессы

- `client_requests`
- `client_request_revision_items`
- `client_request_revision_item_components`
- `rfqs`
- `rfq_item_components`
- `rfq_scenarios`
- `sales_quotes`
- `sales_quote_lines`
- `client_contracts`
- `supplier_purchase_orders`
- `supplier_purchase_order_lines`

## Клиенты и поставщики

- `clients`
- `client_contacts`
- `client_billing_addresses`
- `client_shipping_addresses`
- `client_bank_details`
- `client_equipment_units`
- `suppliers`
- `supplier_contacts`
- `supplier_addresses`
- `supplier_bank_details`
- `supplier_parts`
- `supplier_part_prices`
- `supplier_part_materials`
- `supplier_part_oem_parts`
- `supplier_part_standard_parts`
- `supplier_price_lists`
- `supplier_price_list_lines`
- `supplier_bundles`
- `supplier_bundle_items`
- `supplier_bundle_item_links`

## Каталоги

- `oem_parts`
- `oem_part_model_bom`
- `oem_part_model_fitments`
- `oem_part_alt_groups`
- `oem_part_alt_items`
- `oem_part_documents`
- `oem_part_materials`
- `oem_part_material_specs`
- `oem_part_presentation_profiles`
- `oem_part_standard_parts`
- `oem_part_unit_overrides`
- `oem_part_unit_material_overrides`
- `standard_parts`
- `standard_part_classes`
- `standard_part_class_fields`
- `standard_part_field_options`
- `equipment_manufacturers`
- `equipment_models`
- `equipment_classifier_nodes`
- `materials`
- `tnved_codes`
- `logistics_route_templates`

## Система

- `users`
- `roles`
- `tabs`

## Legacy Aliases

Эти значения считаются устаревшими и должны приводиться к канону:

- `client_request` -> `client_requests`
- `client_orders` -> `client_requests`
- `client_order_items` -> `client_request_revision_items`
- `client_order_contracts` -> `client_contracts`
- `rfq` -> `rfqs`
- `sales_quote` -> `sales_quotes`
- `client_contract` -> `client_contracts`
- `supplier_purchase_order` -> `supplier_purchase_orders`
- `part_suppliers` -> `suppliers`
- `original_parts` -> `oem_parts`
- `original_part_bom` -> `oem_part_model_bom`
- `original_part_alt_groups` -> `oem_part_alt_groups`
- `original_part_alt_items` -> `oem_part_alt_items`
- `supplier_part_originals` -> `supplier_part_oem_parts`
- `user` -> `users`
