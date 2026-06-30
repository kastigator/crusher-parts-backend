SET FOREIGN_KEY_CHECKS = 0;

DROP TEMPORARY TABLE IF EXISTS tmp_demo_clients;
CREATE TEMPORARY TABLE tmp_demo_clients AS
SELECT id
FROM clients
WHERE company_name LIKE '%DEMO%'
   OR company_name LIKE '%TEST%'
   OR company_name LIKE '%ТЕСТ%'
   OR company_name LIKE '%тест%'
   OR notes LIKE '%DEMO%'
   OR notes LIKE '%TEST%'
   OR notes LIKE '%ТЕСТ%'
   OR notes LIKE '%тест%';

DROP TEMPORARY TABLE IF EXISTS tmp_demo_client_requests;
CREATE TEMPORARY TABLE tmp_demo_client_requests AS
SELECT id
FROM client_requests
WHERE client_id IN (SELECT id FROM tmp_demo_clients)
   OR internal_number LIKE '%DEMO%'
   OR internal_number LIKE '%TEST%'
   OR client_reference LIKE '%DEMO%'
   OR client_reference LIKE '%TEST%'
   OR comment_internal LIKE '%DEMO%'
   OR comment_internal LIKE '%TEST%'
   OR comment_client LIKE '%DEMO%'
   OR comment_client LIKE '%TEST%';

DROP TEMPORARY TABLE IF EXISTS tmp_demo_revisions;
CREATE TEMPORARY TABLE tmp_demo_revisions AS
SELECT id
FROM client_request_revisions
WHERE client_request_id IN (SELECT id FROM tmp_demo_client_requests);

DROP TEMPORARY TABLE IF EXISTS tmp_demo_revision_items;
CREATE TEMPORARY TABLE tmp_demo_revision_items AS
SELECT id
FROM client_request_revision_items
WHERE client_request_revision_id IN (SELECT id FROM tmp_demo_revisions);

DROP TEMPORARY TABLE IF EXISTS tmp_demo_rfqs;
CREATE TEMPORARY TABLE tmp_demo_rfqs AS
SELECT id
FROM rfqs
WHERE client_request_id IN (SELECT id FROM tmp_demo_client_requests)
   OR client_request_revision_id IN (SELECT id FROM tmp_demo_revisions)
   OR rfq_number LIKE '%DEMO%'
   OR rfq_number LIKE '%TEST%'
   OR note LIKE '%DEMO%'
   OR note LIKE '%TEST%';

DROP TEMPORARY TABLE IF EXISTS tmp_demo_rfq_items;
CREATE TEMPORARY TABLE tmp_demo_rfq_items AS
SELECT id
FROM rfq_items
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs)
   OR client_request_revision_item_id IN (SELECT id FROM tmp_demo_revision_items);

DROP TEMPORARY TABLE IF EXISTS tmp_demo_rfq_suppliers;
CREATE TEMPORARY TABLE tmp_demo_rfq_suppliers AS
SELECT id
FROM rfq_suppliers
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs);

DROP TEMPORARY TABLE IF EXISTS tmp_demo_rfq_supplier_responses;
CREATE TEMPORARY TABLE tmp_demo_rfq_supplier_responses AS
SELECT id
FROM rfq_supplier_responses
WHERE rfq_supplier_id IN (SELECT id FROM tmp_demo_rfq_suppliers);

DROP TEMPORARY TABLE IF EXISTS tmp_demo_rfq_response_revisions;
CREATE TEMPORARY TABLE tmp_demo_rfq_response_revisions AS
SELECT id
FROM rfq_response_revisions
WHERE rfq_supplier_response_id IN (SELECT id FROM tmp_demo_rfq_supplier_responses);

DROP TEMPORARY TABLE IF EXISTS tmp_demo_suppliers;
CREATE TEMPORARY TABLE tmp_demo_suppliers AS
SELECT id
FROM part_suppliers
WHERE name LIKE '%DEMO%'
   OR name LIKE '%TEST%'
   OR name LIKE '%ТЕСТ%'
   OR name LIKE '%тест%'
   OR notes LIKE '%DEMO%'
   OR notes LIKE '%TEST%'
   OR notes LIKE '%ТЕСТ%'
   OR notes LIKE '%тест%';

DROP TEMPORARY TABLE IF EXISTS tmp_demo_supplier_parts;
CREATE TEMPORARY TABLE tmp_demo_supplier_parts AS
SELECT id
FROM supplier_parts
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers)
   OR supplier_part_number LIKE '%DEMO%'
   OR supplier_part_number LIKE '%TEST%'
   OR canonical_part_number LIKE '%DEMO%'
   OR canonical_part_number LIKE '%TEST%'
   OR description_ru LIKE '%DEMO%'
   OR description_ru LIKE '%TEST%'
   OR description_en LIKE '%DEMO%'
   OR description_en LIKE '%TEST%'
   OR comment LIKE '%DEMO%'
   OR comment LIKE '%TEST%';

DROP TEMPORARY TABLE IF EXISTS tmp_demo_models;
CREATE TEMPORARY TABLE tmp_demo_models AS
SELECT em.id
FROM equipment_models em
LEFT JOIN equipment_model_bom_items bi ON bi.equipment_model_id = em.id
LEFT JOIN catalog_positions cp ON cp.equipment_model_id = em.id
LEFT JOIN client_equipment_units ceu ON ceu.equipment_model_id = em.id
WHERE (
    em.model_name LIKE '%DEMO%'
    OR em.model_name LIKE '%TEST%'
    OR em.model_name LIKE '%ТЕСТ%'
    OR em.model_name LIKE '%тест%'
  )
GROUP BY em.id
HAVING COUNT(DISTINCT bi.id) = 0
   AND COUNT(DISTINCT cp.id) = 0
   AND COUNT(DISTINCT ceu.id) = 0;

DELETE FROM sales_quote_lines
WHERE client_request_revision_item_id IN (SELECT id FROM tmp_demo_revision_items);
DELETE FROM sales_quotes
WHERE client_request_revision_id IN (SELECT id FROM tmp_demo_revisions);

DELETE FROM client_request_revision_item_components
WHERE client_request_revision_item_id IN (SELECT id FROM tmp_demo_revision_items);
DELETE FROM client_request_revision_item_strategies
WHERE client_request_revision_item_id IN (SELECT id FROM tmp_demo_revision_items);
DELETE FROM client_request_revision_items
WHERE id IN (SELECT id FROM tmp_demo_revision_items);
DELETE FROM client_request_revisions
WHERE id IN (SELECT id FROM tmp_demo_revisions);
DELETE FROM client_request_events
WHERE client_request_id IN (SELECT id FROM tmp_demo_client_requests);
DELETE FROM client_requests
WHERE id IN (SELECT id FROM tmp_demo_client_requests);

DELETE FROM rfq_response_lines
WHERE rfq_response_revision_id IN (SELECT id FROM tmp_demo_rfq_response_revisions)
   OR rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items);
DELETE FROM rfq_response_revisions
WHERE id IN (SELECT id FROM tmp_demo_rfq_response_revisions);
DELETE FROM rfq_supplier_responses
WHERE id IN (SELECT id FROM tmp_demo_rfq_supplier_responses);
DELETE FROM rfq_documents
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs)
   OR rfq_supplier_id IN (SELECT id FROM tmp_demo_rfq_suppliers);
DELETE FROM rfq_supplier_dispatches
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs)
   OR rfq_supplier_id IN (SELECT id FROM tmp_demo_rfq_suppliers);
DELETE FROM rfq_supplier_line_selections
WHERE rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items)
   OR rfq_supplier_id IN (SELECT id FROM tmp_demo_rfq_suppliers);
DELETE FROM rfq_supplier_line_status
WHERE rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items)
   OR rfq_supplier_id IN (SELECT id FROM tmp_demo_rfq_suppliers);
DELETE FROM rfq_supplier_metrics
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs)
   OR rfq_supplier_id IN (SELECT id FROM tmp_demo_rfq_suppliers);
DELETE FROM rfq_supplier_scorecards
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs)
   OR supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM rfq_supplier_revision_state
WHERE rfq_supplier_id IN (SELECT id FROM tmp_demo_rfq_suppliers);
DELETE FROM rfq_suppliers
WHERE id IN (SELECT id FROM tmp_demo_rfq_suppliers);
DELETE FROM rfq_coverage_option_lines
WHERE rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items)
   OR supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM rfq_coverage_options
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs)
   OR rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items);
DELETE FROM rfq_item_components
WHERE rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items);
DELETE FROM rfq_item_strategies
WHERE rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items);
DELETE FROM rfq_revision_item_changes
WHERE rfq_revision_id IN (SELECT id FROM rfq_revisions WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs))
   OR rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items)
   OR client_request_revision_item_id IN (SELECT id FROM tmp_demo_revision_items);
DELETE FROM rfq_scenario_lines
WHERE rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items);
DELETE FROM selection_lines
WHERE rfq_item_id IN (SELECT id FROM tmp_demo_rfq_items)
   OR supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM selections
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs);
DELETE FROM landed_cost_snapshots
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs);
DELETE FROM logistics_route_usage_events
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs);
DELETE FROM rfq_econ_settings
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs);
DELETE FROM rfq_econ2_candidate_suppliers
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM rfq_scenarios
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs);
DELETE FROM shipment_groups
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs);
DELETE FROM rfq_revisions
WHERE rfq_id IN (SELECT id FROM tmp_demo_rfqs)
   OR client_request_revision_id IN (SELECT id FROM tmp_demo_revisions);
DELETE FROM rfq_items
WHERE id IN (SELECT id FROM tmp_demo_rfq_items);
DELETE FROM rfqs
WHERE id IN (SELECT id FROM tmp_demo_rfqs);

DELETE FROM supplier_price_list_lines
WHERE matched_supplier_part_id IN (SELECT id FROM tmp_demo_supplier_parts);
DELETE FROM supplier_price_lists
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM supplier_part_catalog_positions
WHERE supplier_part_id IN (SELECT id FROM tmp_demo_supplier_parts);
DELETE FROM supplier_part_aliases
WHERE supplier_part_id IN (SELECT id FROM tmp_demo_supplier_parts)
   OR supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM supplier_part_materials
WHERE supplier_part_id IN (SELECT id FROM tmp_demo_supplier_parts);
DELETE FROM supplier_part_prices
WHERE supplier_part_id IN (SELECT id FROM tmp_demo_supplier_parts);
DELETE FROM supplier_procurement_rules
WHERE supplier_part_id IN (SELECT id FROM tmp_demo_supplier_parts)
   OR supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM supplier_quality_events
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM supplier_parts
WHERE id IN (SELECT id FROM tmp_demo_supplier_parts);
DELETE FROM supplier_contacts
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM supplier_addresses
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM supplier_bank_details
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM supplier_risk_overrides
WHERE supplier_id IN (SELECT id FROM tmp_demo_suppliers);
DELETE FROM part_suppliers
WHERE id IN (SELECT id FROM tmp_demo_suppliers);

DELETE FROM client_part_applications
WHERE equipment_model_id IN (SELECT id FROM tmp_demo_models);
DELETE FROM equipment_model_bom_import_batches
WHERE equipment_model_id IN (SELECT id FROM tmp_demo_models);
DELETE FROM equipment_model_documents
WHERE equipment_model_id IN (SELECT id FROM tmp_demo_models);
DELETE FROM equipment_model_media
WHERE equipment_model_id IN (SELECT id FROM tmp_demo_models);
DELETE FROM equipment_models
WHERE id IN (SELECT id FROM tmp_demo_models);

DELETE FROM client_bank_details
WHERE client_id IN (SELECT id FROM tmp_demo_clients);
DELETE FROM client_billing_addresses
WHERE client_id IN (SELECT id FROM tmp_demo_clients);
DELETE FROM client_contacts
WHERE client_id IN (SELECT id FROM tmp_demo_clients);
DELETE FROM client_equipment_units
WHERE client_id IN (SELECT id FROM tmp_demo_clients);
DELETE FROM client_parts
WHERE client_id IN (SELECT id FROM tmp_demo_clients);
DELETE FROM client_shipping_addresses
WHERE client_id IN (SELECT id FROM tmp_demo_clients);
DELETE FROM clients
WHERE id IN (SELECT id FROM tmp_demo_clients);

SET FOREIGN_KEY_CHECKS = 1;
