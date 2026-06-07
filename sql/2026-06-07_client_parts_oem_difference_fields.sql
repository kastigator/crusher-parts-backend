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

CALL add_column_if_missing(
  'client_parts',
  'base_oem_part_id',
  'base_oem_part_id INT NULL AFTER classifier_node_id'
);

CALL add_column_if_missing(
  'client_parts',
  'relationship_type',
  'relationship_type ENUM(''client_drawing'',''oem_variant'',''oem_replacement'',''unknown_oem'') NOT NULL DEFAULT ''client_drawing'' AFTER base_oem_part_id'
);

CALL add_column_if_missing(
  'client_parts',
  'difference_summary',
  'difference_summary TEXT NULL AFTER description_ru'
);

DROP PROCEDURE IF EXISTS add_column_if_missing;

DROP PROCEDURE IF EXISTS add_index_if_missing;
DELIMITER //
CREATE PROCEDURE add_index_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_index_name VARCHAR(64),
  IN p_index_sql TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND index_name = p_index_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD ', p_index_sql);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_index_if_missing(
  'client_parts',
  'idx_client_parts_base_oem',
  'INDEX idx_client_parts_base_oem (base_oem_part_id)'
);

CALL add_index_if_missing(
  'client_parts',
  'idx_client_parts_relationship',
  'INDEX idx_client_parts_relationship (relationship_type)'
);

DROP PROCEDURE IF EXISTS add_index_if_missing;

DROP PROCEDURE IF EXISTS add_fk_if_missing;
DELIMITER //
CREATE PROCEDURE add_fk_if_missing(
  IN p_constraint_name VARCHAR(64),
  IN p_table_name VARCHAR(64),
  IN p_fk_sql TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND constraint_name = p_constraint_name
       AND constraint_type = 'FOREIGN KEY'
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD CONSTRAINT ', p_fk_sql);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_fk_if_missing(
  'fk_client_parts_base_oem',
  'client_parts',
  'fk_client_parts_base_oem FOREIGN KEY (base_oem_part_id) REFERENCES oem_parts (id) ON DELETE SET NULL ON UPDATE CASCADE'
);

DROP PROCEDURE IF EXISTS add_fk_if_missing;
