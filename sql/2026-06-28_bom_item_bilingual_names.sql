DELIMITER $$

DROP PROCEDURE IF EXISTS add_column_if_missing $$
CREATE PROCEDURE add_column_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_column_name VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table_name
      AND COLUMN_NAME = p_column_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE ', p_table_name, ' ADD COLUMN ', p_column_name, ' ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

CALL add_column_if_missing(
  'equipment_model_bom_items',
  'manufacturer_part_name_en',
  'VARCHAR(255) NULL AFTER manufacturer_part_name'
);

CALL add_column_if_missing(
  'equipment_model_bom_items',
  'manufacturer_part_name_ru',
  'VARCHAR(255) NULL AFTER manufacturer_part_name_en'
);

UPDATE equipment_model_bom_items
SET manufacturer_part_name_en = manufacturer_part_name
WHERE manufacturer_part_name_en IS NULL
  AND manufacturer_part_name IS NOT NULL;

DROP PROCEDURE IF EXISTS add_column_if_missing;
