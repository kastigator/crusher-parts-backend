SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'equipment_classifier_nodes'
    AND COLUMN_NAME = 'card_image_url'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE equipment_classifier_nodes ADD COLUMN card_image_url VARCHAR(1000) NULL AFTER notes',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
