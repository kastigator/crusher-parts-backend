-- Remove the old standalone OEM/original-parts catalog.
-- The classifier + equipment model BOM + catalog_positions are the only catalog path.

DELETE FROM role_permissions
 WHERE tab_id IN (
   SELECT id FROM tabs
    WHERE path IN ('/original-parts', '/oem-parts')
       OR tab_name IN ('original_parts', 'oem_parts')
 );

DELETE FROM tabs
 WHERE path IN ('/original-parts', '/oem-parts')
    OR tab_name IN ('original_parts', 'oem_parts');

UPDATE catalog_positions
   SET description = TRIM(
         REGEXP_REPLACE(
           REGEXP_REPLACE(COALESCE(description, ''), '(^|\\n)Источник legacy oem_parts\\.id=[0-9]+', ''),
           '(^|\\n)Позиция в BOM: [^\\n]+',
           ''
         )
       ),
       meta_json = CASE
         WHEN JSON_VALID(meta_json) THEN JSON_REMOVE(meta_json, '$.legacy_oem_part_id')
         ELSE meta_json
       END
 WHERE description LIKE '%legacy oem_parts.id=%'
    OR description LIKE '%Позиция в BOM:%'
    OR JSON_EXTRACT(meta_json, '$.legacy_oem_part_id') IS NOT NULL;

UPDATE catalog_positions
   SET description = NULL
 WHERE description = '';

UPDATE equipment_model_bom_items
   SET oem_part_id = NULL
 WHERE oem_part_id IS NOT NULL;

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

CALL drop_fk_if_exists('client_equipment_unit_bom_overrides', 'fk_ceu_bom_overrides_replacement_oem');
CALL drop_fk_if_exists('client_parts', 'fk_client_parts_base_oem');
CALL drop_fk_if_exists('client_request_revision_item_components', 'fk_crric_oem_part');
CALL drop_fk_if_exists('client_request_revision_items', 'fk_crri_oem_part');
CALL drop_fk_if_exists('equipment_model_bom_items', 'fk_equipment_model_bom_items_oem_part');
CALL drop_fk_if_exists('rfq_coverage_option_lines', 'fk_rcol_oem_part');
CALL drop_fk_if_exists('rfq_item_components', 'fk_rfq_ic_oem_part');
CALL drop_fk_if_exists('rfq_items', 'fk_rfq_items_oem_part');
CALL drop_fk_if_exists('rfq_response_lines', 'fk_rrl_oem_part');
CALL drop_fk_if_exists('rfq_response_lines', 'fk_rrl_requested_oem_part');
CALL drop_fk_if_exists('rfq_response_lines', 'fk_rrl_presentation_profile');
CALL drop_fk_if_exists('rfq_supplier_line_selections', 'fk_rsls_oem_part');
CALL drop_fk_if_exists('rfq_supplier_line_selections', 'fk_rsls_alt_oem_part');
CALL drop_fk_if_exists('rfq_supplier_line_selections', 'fk_rsls_presentation_profile');
CALL drop_fk_if_exists('supplier_procurement_rules', 'fk_spr_new_oem_part');
CALL drop_fk_if_exists('supplier_quality_events', 'fk_sq_event_oem_part');
CALL drop_fk_if_exists('supplier_bundles', 'fk_sb_new_oem');
CALL drop_fk_if_exists('rfq_item_strategies', 'fk_rfq_item_strategy_bundle');
CALL drop_fk_if_exists('rfq_response_lines', 'fk_rfq_resp_line_bundle');
CALL drop_fk_if_exists('rfq_supplier_line_selections', 'fk_rfq_sel_bundle');
CALL drop_fk_if_exists('rfq_supplier_line_selections', 'fk_rfq_sel_bundle_item');
CALL drop_fk_if_exists('supplier_bundle_item_links', 'fk_sbil_item');
CALL drop_fk_if_exists('supplier_bundle_item_links', 'fk_sbil_supplier_part');
CALL drop_fk_if_exists('supplier_bundle_items', 'fk_sbi_bundle');

UPDATE client_equipment_unit_bom_overrides SET replacement_oem_part_id = NULL WHERE replacement_oem_part_id IS NOT NULL;
UPDATE client_parts SET base_oem_part_id = NULL WHERE base_oem_part_id IS NOT NULL;
UPDATE client_request_revision_item_components SET oem_part_id = NULL WHERE oem_part_id IS NOT NULL;
UPDATE client_request_revision_items SET oem_part_id = NULL WHERE oem_part_id IS NOT NULL;
UPDATE rfq_coverage_option_lines SET oem_part_id = NULL WHERE oem_part_id IS NOT NULL;
UPDATE rfq_item_components SET oem_part_id = NULL WHERE oem_part_id IS NOT NULL;
UPDATE rfq_items SET oem_part_id = NULL WHERE oem_part_id IS NOT NULL;
UPDATE rfq_response_lines
   SET oem_part_id = NULL,
       requested_oem_part_id = NULL,
       presentation_profile_id = NULL,
       bundle_id = NULL
 WHERE oem_part_id IS NOT NULL
    OR requested_oem_part_id IS NOT NULL
    OR presentation_profile_id IS NOT NULL
    OR bundle_id IS NOT NULL;
UPDATE rfq_supplier_line_selections
   SET oem_part_id = NULL,
       alt_oem_part_id = NULL,
       presentation_profile_id = NULL,
       bundle_id = NULL,
       bundle_item_id = NULL
 WHERE oem_part_id IS NOT NULL
    OR alt_oem_part_id IS NOT NULL
    OR presentation_profile_id IS NOT NULL
    OR bundle_id IS NOT NULL
    OR bundle_item_id IS NOT NULL;
UPDATE supplier_procurement_rules SET oem_part_id = NULL WHERE oem_part_id IS NOT NULL;
UPDATE supplier_quality_events SET oem_part_id = NULL WHERE oem_part_id IS NOT NULL;
UPDATE rfq_item_strategies SET selected_bundle_id = NULL WHERE selected_bundle_id IS NOT NULL;

DROP TABLE IF EXISTS supplier_bundle_item_links;
DROP TABLE IF EXISTS supplier_bundle_items;
DROP TABLE IF EXISTS supplier_bundles;
DROP TABLE IF EXISTS oem_part_unit_material_specs;
DROP TABLE IF EXISTS oem_part_unit_material_overrides;
DROP TABLE IF EXISTS oem_part_unit_overrides;
DROP TABLE IF EXISTS oem_part_presentation_profiles;
DROP TABLE IF EXISTS oem_part_documents;
DROP TABLE IF EXISTS oem_part_alt_items;
DROP TABLE IF EXISTS oem_part_alt_groups;
DROP TABLE IF EXISTS oem_part_material_specs;
DROP TABLE IF EXISTS oem_part_materials;
DROP TABLE IF EXISTS oem_part_model_bom;
DROP TABLE IF EXISTS oem_part_model_fitments;
DROP TABLE IF EXISTS oem_parts;
DROP TABLE IF EXISTS original_part_groups;

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
  NULL AS oem_part_id,
  NULL AS requested_oem_part_id,
  NULL AS bundle_id,
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
  NULL AS base_oem_part_id,
  NULL AS original_cat_number,
  NULL AS original_description_ru,
  NULL AS original_description_en,
  NULL AS tnved_code_id,
  NULL AS tnved_code,
  NULL AS duty_rate_base_pct,
  NULL AS duty_rate_override_pct,
  NULL AS duty_rate_pct,
  NULL AS vat_rate_pct,
  NULL AS origin_restriction_level,
  NULL AS origin_restriction_note
FROM vw_rfq_supplier_latest_lines l
JOIN rfq_items ri ON ri.id = l.rfq_item_id
LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
JOIN part_suppliers ps ON ps.id = l.supplier_id
LEFT JOIN rfq_response_lines rl ON rl.id = l.response_line_id;
