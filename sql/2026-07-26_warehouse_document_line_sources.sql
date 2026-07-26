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

DROP PROCEDURE IF EXISTS add_index_if_missing;
DELIMITER //
CREATE PROCEDURE add_index_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_index_name VARCHAR(64),
  IN p_index_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND index_name = p_index_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD ', p_index_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_column_if_missing(
  'warehouse_document_lines',
  'source_type',
  'source_type VARCHAR(64) NULL AFTER notes'
);

CALL add_column_if_missing(
  'warehouse_document_lines',
  'source_id',
  'source_id VARCHAR(64) NULL AFTER source_type'
);

CALL add_column_if_missing(
  'warehouse_document_lines',
  'source_line_id',
  'source_line_id VARCHAR(64) NULL AFTER source_id'
);

CALL add_column_if_missing(
  'warehouse_document_lines',
  'source_label',
  'source_label VARCHAR(255) NULL AFTER source_line_id'
);

CALL add_index_if_missing(
  'warehouse_document_lines',
  'idx_warehouse_lines_source',
  'INDEX idx_warehouse_lines_source (source_type, source_id, source_line_id)'
);

DROP PROCEDURE IF EXISTS add_index_if_missing;
DROP PROCEDURE IF EXISTS add_column_if_missing;
