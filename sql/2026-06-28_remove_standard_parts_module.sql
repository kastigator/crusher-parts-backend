-- Remove the old standalone standard_parts module.
-- Standard/type products must be represented by the classifier, not by a parallel catalog.

DELETE FROM role_permissions
 WHERE tab_id IN (SELECT id FROM tabs WHERE path = '/standard-parts');

DELETE FROM tabs WHERE path = '/standard-parts';

DROP VIEW IF EXISTS vw_rfq_cost_base;
DROP VIEW IF EXISTS vw_rfq_supplier_latest_lines;

DROP PROCEDURE IF EXISTS drop_fk_if_exists;
DELIMITER //
CREATE PROCEDURE drop_fk_if_exists(IN p_table_name VARCHAR(128), IN p_constraint_name VARCHAR(128))
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = p_table_name
       AND CONSTRAINT_NAME = p_constraint_name
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table_name, '` DROP FOREIGN KEY `', p_constraint_name, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL drop_fk_if_exists('client_request_revision_item_components', 'fk_crric_standard_part');
CALL drop_fk_if_exists('client_request_revision_items', 'fk_crri_standard_part');
CALL drop_fk_if_exists('rfq_coverage_option_lines', 'fk_rcol_standard_part');
CALL drop_fk_if_exists('rfq_item_components', 'fk_rfq_ic_standard_part');
CALL drop_fk_if_exists('rfq_items', 'fk_rfq_items_standard_part');
CALL drop_fk_if_exists('rfq_response_lines', 'fk_rrl_requested_standard_part');
CALL drop_fk_if_exists('rfq_response_lines', 'fk_rrl_standard_part');
CALL drop_fk_if_exists('rfq_supplier_line_selections', 'fk_rsls_standard_part');
CALL drop_fk_if_exists('supplier_quality_events', 'fk_sq_event_standard_part');
CALL drop_fk_if_exists('oem_part_standard_parts', 'fk_opsp_oem_part');
CALL drop_fk_if_exists('oem_part_standard_parts', 'fk_opsp_standard_part');
CALL drop_fk_if_exists('supplier_part_standard_parts', 'fk_spsp_supplier_part');
CALL drop_fk_if_exists('supplier_part_standard_parts', 'fk_spsp_standard_part');
CALL drop_fk_if_exists('standard_part_values', 'fk_standard_part_values_part');
CALL drop_fk_if_exists('standard_part_values', 'fk_standard_part_values_field');
CALL drop_fk_if_exists('standard_part_field_options', 'fk_standard_part_field_options_field');
CALL drop_fk_if_exists('standard_part_class_fields', 'fk_standard_part_class_fields_class');
CALL drop_fk_if_exists('standard_parts', 'fk_standard_parts_class');
CALL drop_fk_if_exists('standard_part_classes', 'fk_standard_part_classes_parent');

DROP TABLE IF EXISTS oem_part_standard_parts;
DROP TABLE IF EXISTS supplier_part_standard_parts;
DROP TABLE IF EXISTS standard_part_values;
DROP TABLE IF EXISTS standard_part_field_options;
DROP TABLE IF EXISTS standard_part_class_fields;
DROP TABLE IF EXISTS standard_parts;
DROP TABLE IF EXISTS standard_part_classes;

DROP PROCEDURE IF EXISTS drop_fk_if_exists;

CREATE OR REPLACE VIEW vw_rfq_supplier_latest_lines AS
SELECT
  x.rfq_supplier_id,
  x.rfq_id,
  x.supplier_id,
  x.rfq_item_id,
  x.selection_key,
  x.selection_key_norm,
  x.response_line_id,
  x.response_created_at,
  x.supplier_reply_status,
  x.offer_type,
  x.price,
  x.currency,
  x.offered_qty,
  x.lead_time_days,
  x.moq,
  x.packaging,
  x.incoterms,
  x.oem_part_id,
  x.requested_oem_part_id,
  x.bundle_id,
  x.rfq_item_component_id
FROM (
  SELECT
    rs.id AS rfq_supplier_id,
    rs.rfq_id,
    rs.supplier_id,
    rl.rfq_item_id,
    rl.selection_key,
    COALESCE(NULLIF(TRIM(rl.selection_key), ''), '__NO_SELECTION__') AS selection_key_norm,
    rl.id AS response_line_id,
    rl.created_at AS response_created_at,
    rl.supplier_reply_status,
    rl.offer_type,
    rl.price,
    rl.currency,
    rl.offered_qty,
    rl.lead_time_days,
    rl.moq,
    rl.packaging,
    rl.incoterms,
    rl.oem_part_id,
    rl.requested_oem_part_id,
    rl.bundle_id,
    rl.rfq_item_component_id,
    ROW_NUMBER() OVER (
      PARTITION BY rs.id, rl.rfq_item_id, COALESCE(NULLIF(TRIM(rl.selection_key), ''), '__NO_SELECTION__')
      ORDER BY rr.rev_number DESC, rl.id DESC
    ) AS rn
  FROM rfq_response_lines rl
  JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
  JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
  JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
) x
WHERE x.rn = 1;

CREATE OR REPLACE VIEW vw_rfq_cost_base AS
SELECT
  l.rfq_id,
  l.rfq_supplier_id,
  l.supplier_id,
  ps.name AS supplier_name,
  ps.country AS supplier_country,
  l.rfq_item_id,
  ri.line_number AS rfq_line_number,
  l.selection_key,
  l.selection_key_norm,
  l.response_line_id,
  l.supplier_reply_status,
  l.offer_type,
  l.price,
  l.currency,
  l.offered_qty,
  cri.requested_qty,
  COALESCE(l.offered_qty, cri.requested_qty) AS effective_qty,
  l.lead_time_days,
  l.moq,
  l.packaging,
  l.incoterms,
  NULLIF(UPPER(TRIM(rl.origin_country)), '') AS origin_country,
  COALESCE(l.requested_oem_part_id, cri.oem_part_id, l.oem_part_id) AS base_oem_part_id,
  op.part_number AS original_cat_number,
  op.description_ru AS original_description_ru,
  op.description_en AS original_description_en,
  op.tnved_code_id,
  t.code AS tnved_code,
  t.duty_rate AS duty_rate_base_pct,
  NULL AS duty_rate_override_pct,
  t.duty_rate AS duty_rate_pct,
  NULL AS vat_rate_pct,
  NULL AS origin_restriction_level,
  NULL AS origin_restriction_note
FROM vw_rfq_supplier_latest_lines l
JOIN rfq_items ri ON ri.id = l.rfq_item_id
LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
JOIN part_suppliers ps ON ps.id = l.supplier_id
LEFT JOIN rfq_response_lines rl ON rl.id = l.response_line_id
LEFT JOIN oem_parts op ON op.id = COALESCE(l.requested_oem_part_id, cri.oem_part_id, l.oem_part_id)
LEFT JOIN tnved_codes t ON t.id = op.tnved_code_id;
