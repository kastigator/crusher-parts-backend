-- The model BOM now points to catalog_positions only.
-- Remove the old nullable oem_part_id column so new code cannot reintroduce legacy OEM links.

SET @has_bom_oem_part_id := (
  SELECT COUNT(*)
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'equipment_model_bom_items'
     AND COLUMN_NAME = 'oem_part_id'
);

SET @drop_bom_oem_part_id_sql := IF(
  @has_bom_oem_part_id > 0,
  'ALTER TABLE equipment_model_bom_items DROP COLUMN oem_part_id',
  'SELECT 1'
);

PREPARE stmt FROM @drop_bom_oem_part_id_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

