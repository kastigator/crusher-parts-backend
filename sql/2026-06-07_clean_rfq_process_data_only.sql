-- Data-only cleanup: keep RFQ code and schema, remove old RFQ process records and descendants.
-- This intentionally clears RFQ-derived commercial/procurement records so new RFQ can start clean.

DELETE FROM supplier_quality_events
WHERE rfq_response_line_id IS NOT NULL
   OR selection_id IS NOT NULL
   OR selection_line_id IS NOT NULL
   OR sales_quote_id IS NOT NULL
   OR sales_quote_line_id IS NOT NULL
   OR supplier_purchase_order_id IS NOT NULL
   OR supplier_purchase_order_line_id IS NOT NULL;

DELETE FROM supplier_part_prices
WHERE source_type IN ('RFQ', 'RFQ_RESPONSE');

DELETE FROM activity_logs
WHERE entity_type IN (
  'rfqs',
  'rfq',
  'rfq_items',
  'rfq_item_components',
  'rfq_scenarios',
  'rfq_supplier_responses',
  'supplier_responses',
  'selections',
  'selection_lines',
  'sales_quotes',
  'sales_quote_lines',
  'client_contracts',
  'supplier_purchase_orders',
  'supplier_purchase_order_lines'
);

DELETE FROM user_activity_events
WHERE entity_type IN (
  'rfqs',
  'rfq',
  'rfq_items',
  'rfq_item_components',
  'rfq_scenarios',
  'rfq_supplier_responses',
  'supplier_responses',
  'selections',
  'selection_lines',
  'sales_quotes',
  'sales_quote_lines',
  'client_contracts',
  'supplier_purchase_orders',
  'supplier_purchase_order_lines'
)
   OR event_type LIKE 'rfq_%';

UPDATE client_requests
   SET rfq_assigned_at = NULL,
       rfq_assigned_by_user_id = NULL
 WHERE rfq_assigned_at IS NOT NULL
    OR rfq_assigned_by_user_id IS NOT NULL;

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE client_contracts;
TRUNCATE TABLE sales_quote_lines;
TRUNCATE TABLE sales_quote_revisions;
TRUNCATE TABLE sales_quote_pricing_policies;
TRUNCATE TABLE sales_quotes;

TRUNCATE TABLE supplier_purchase_order_lines;
TRUNCATE TABLE supplier_purchase_orders;

TRUNCATE TABLE economic_scenarios;
TRUNCATE TABLE shipment_group_items;
TRUNCATE TABLE shipment_groups;
TRUNCATE TABLE selection_lines;
TRUNCATE TABLE selections;

TRUNCATE TABLE landed_cost_snapshots;
TRUNCATE TABLE logistics_route_usage_events;

TRUNCATE TABLE rfq_response_line_actions;
TRUNCATE TABLE rfq_line_scorecard_items;
TRUNCATE TABLE rfq_line_scorecards;
TRUNCATE TABLE rfq_supplier_scorecard_items;
TRUNCATE TABLE rfq_supplier_scorecards;
TRUNCATE TABLE rfq_supplier_line_status;
TRUNCATE TABLE rfq_supplier_revision_state;
TRUNCATE TABLE rfq_supplier_dispatches;
TRUNCATE TABLE rfq_documents;
TRUNCATE TABLE rfq_coverage_option_lines;
TRUNCATE TABLE rfq_shipment_group_lines;
TRUNCATE TABLE rfq_shipment_group_routes;
TRUNCATE TABLE rfq_shipment_groups;
TRUNCATE TABLE rfq_scenario_line_costs;
TRUNCATE TABLE rfq_scenario_lines;
TRUNCATE TABLE rfq_scenarios;
TRUNCATE TABLE rfq_econ2_scenario_other_costs;
TRUNCATE TABLE rfq_econ2_candidate_suppliers;
TRUNCATE TABLE rfq_supplier_metrics;
TRUNCATE TABLE rfq_response_lines;
TRUNCATE TABLE rfq_response_revisions;
TRUNCATE TABLE rfq_supplier_responses;
TRUNCATE TABLE rfq_supplier_line_selections;
TRUNCATE TABLE rfq_revision_item_changes;
TRUNCATE TABLE rfq_item_strategies;
TRUNCATE TABLE rfq_item_components;
TRUNCATE TABLE rfq_coverage_options;
TRUNCATE TABLE rfq_items;
TRUNCATE TABLE rfq_suppliers;
TRUNCATE TABLE rfq_econ_settings;
TRUNCATE TABLE rfq_revisions;
TRUNCATE TABLE rfqs;

SET FOREIGN_KEY_CHECKS = 1;
