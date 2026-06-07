CREATE TEMPORARY TABLE tmp_obvious_demo_oem_parts AS
SELECT id
FROM oem_parts
WHERE UPPER(part_number) LIKE 'DEMO-%'
   OR UPPER(part_number) LIKE 'TEST-%'
   OR UPPER(part_number) LIKE 'OEM-DEMO%'
   OR UPPER(part_number) LIKE 'OEM-TEST%'
   OR UPPER(part_number) LIKE 'OEM_DEMO%'
   OR UPPER(part_number) LIKE 'OEM_TEST%'
   OR UPPER(part_number) REGEXP '^OEM[0-9]{8,}$';

DELETE FROM client_part_applications
WHERE client_part_id IN (
  SELECT cp.id
  FROM client_parts cp
  JOIN tmp_obvious_demo_oem_parts t ON t.id = cp.base_oem_part_id
);

DELETE FROM client_parts
WHERE base_oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE client_request_revision_items
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE client_request_revision_item_components
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE supplier_quality_events
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE rfq_items
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE rfq_item_components
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE rfq_response_lines
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE rfq_coverage_option_lines
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE rfq_supplier_line_selections
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE rfq_supplier_line_selections
SET alt_oem_part_id = NULL
WHERE alt_oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE supplier_bundles
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

UPDATE supplier_procurement_rules
SET oem_part_id = NULL
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM supplier_part_oem_parts
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_standard_parts
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_material_specs
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_materials
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_unit_material_specs
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_unit_material_overrides
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_unit_overrides
WHERE replacement_oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_unit_overrides
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_model_bom
WHERE child_oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_model_bom
WHERE parent_oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_model_fitments
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE ai
FROM oem_part_alt_items ai
JOIN oem_part_alt_groups ag ON ag.id = ai.group_id
WHERE ag.oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_alt_items
WHERE alt_oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_alt_groups
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_documents
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_part_presentation_profiles
WHERE oem_part_id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DELETE FROM oem_parts
WHERE id IN (SELECT id FROM tmp_obvious_demo_oem_parts);

DROP TEMPORARY TABLE IF EXISTS tmp_obvious_demo_oem_parts;
