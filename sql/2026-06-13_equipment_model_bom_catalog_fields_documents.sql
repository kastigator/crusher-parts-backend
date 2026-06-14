DROP PROCEDURE IF EXISTS add_column_if_missing;
DELIMITER //
CREATE PROCEDURE add_column_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_column_name VARCHAR(64),
  IN p_column_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND column_name = p_column_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD COLUMN ', p_column_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_column_if_missing('equipment_model_bom_items', 'item_type', "item_type VARCHAR(32) NOT NULL DEFAULT 'group' AFTER parent_item_id");
CALL add_column_if_missing('equipment_model_bom_items', 'item_no', 'item_no VARCHAR(64) NULL AFTER item_type');
CALL add_column_if_missing('equipment_model_bom_items', 'manufacturer_part_number', 'manufacturer_part_number VARCHAR(120) NULL AFTER item_no');
CALL add_column_if_missing('equipment_model_bom_items', 'manufacturer_part_name', 'manufacturer_part_name VARCHAR(255) NULL AFTER manufacturer_part_number');
CALL add_column_if_missing('equipment_model_bom_items', 'drawing_number', 'drawing_number VARCHAR(120) NULL AFTER manufacturer_part_name');

DROP PROCEDURE IF EXISTS add_column_if_missing;

UPDATE equipment_model_bom_items
SET item_type = CASE
  WHEN oem_part_id IS NOT NULL THEN 'oem_part'
  WHEN catalog_position_id IS NOT NULL THEN 'catalog_position'
  ELSE 'group'
END
WHERE item_type IS NULL OR item_type = '' OR item_type = 'group';

CREATE TABLE IF NOT EXISTS equipment_model_documents (
  id INT NOT NULL AUTO_INCREMENT,
  equipment_model_id INT NOT NULL,
  file_url VARCHAR(1000) NOT NULL,
  file_name VARCHAR(255) NULL,
  file_type VARCHAR(120) NULL,
  file_size BIGINT NULL,
  description VARCHAR(500) NULL,
  uploaded_by INT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_equipment_model_documents_model (equipment_model_id, uploaded_at, id),
  CONSTRAINT fk_equipment_model_documents_model
    FOREIGN KEY (equipment_model_id) REFERENCES equipment_models (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
