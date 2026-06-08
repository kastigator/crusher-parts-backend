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

CALL add_column_if_missing('equipment_models', 'storage_uom', 'storage_uom VARCHAR(32) NULL AFTER model_code');
CALL add_column_if_missing('equipment_models', 'weight_kg', 'weight_kg DECIMAL(14,3) NULL AFTER storage_uom');
CALL add_column_if_missing('equipment_models', 'length_mm', 'length_mm DECIMAL(14,3) NULL AFTER weight_kg');
CALL add_column_if_missing('equipment_models', 'width_mm', 'width_mm DECIMAL(14,3) NULL AFTER length_mm');
CALL add_column_if_missing('equipment_models', 'height_mm', 'height_mm DECIMAL(14,3) NULL AFTER width_mm');

DROP PROCEDURE IF EXISTS add_column_if_missing;

CREATE TABLE IF NOT EXISTS equipment_model_media (
  id INT NOT NULL AUTO_INCREMENT,
  equipment_model_id INT NOT NULL,
  file_url VARCHAR(1000) NOT NULL,
  file_name VARCHAR(255) NULL,
  mime_type VARCHAR(120) NULL,
  file_size BIGINT NULL,
  caption VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  uploaded_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_equipment_model_media_model (equipment_model_id, sort_order, id),
  KEY idx_equipment_model_media_primary (equipment_model_id, is_primary),
  CONSTRAINT fk_equipment_model_media_model
    FOREIGN KEY (equipment_model_id) REFERENCES equipment_models (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
