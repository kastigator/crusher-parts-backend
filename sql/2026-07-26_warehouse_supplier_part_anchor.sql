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

CALL add_column_if_missing(
  'supplier_part_catalog_positions',
  'priority_rank',
  'priority_rank INT NULL AFTER confidence'
);

CALL add_column_if_missing(
  'supplier_part_catalog_positions',
  'is_preferred',
  'is_preferred TINYINT(1) NOT NULL DEFAULT 0 AFTER priority_rank'
);

CALL add_column_if_missing(
  'warehouse_document_lines',
  'supplier_part_id',
  'supplier_part_id INT NULL AFTER catalog_position_id'
);

CALL add_column_if_missing(
  'warehouse_stock_movements',
  'supplier_part_id',
  'supplier_part_id INT NULL AFTER catalog_position_id'
);

ALTER TABLE warehouse_document_lines
  MODIFY catalog_position_id INT NULL;

ALTER TABLE warehouse_stock_movements
  MODIFY catalog_position_id INT NULL;

CALL add_index_if_missing(
  'supplier_part_catalog_positions',
  'idx_spcp_position_preferred',
  'INDEX idx_spcp_position_preferred (catalog_position_id, is_preferred, supplier_part_id)'
);

CALL add_index_if_missing(
  'supplier_part_catalog_positions',
  'idx_spcp_part_preferred',
  'INDEX idx_spcp_part_preferred (supplier_part_id, is_preferred, catalog_position_id)'
);

CALL add_index_if_missing(
  'warehouse_document_lines',
  'idx_warehouse_lines_supplier_part',
  'INDEX idx_warehouse_lines_supplier_part (supplier_part_id)'
);

CALL add_index_if_missing(
  'warehouse_stock_movements',
  'idx_warehouse_movements_supplier_stock',
  'INDEX idx_warehouse_movements_supplier_stock (warehouse_id, storage_place_id, supplier_part_id)'
);

CALL add_index_if_missing(
  'warehouse_stock_movements',
  'idx_warehouse_movements_supplier_part',
  'INDEX idx_warehouse_movements_supplier_part (supplier_part_id, occurred_at)'
);

CALL add_fk_if_missing(
  'fk_warehouse_lines_supplier_part',
  'warehouse_document_lines',
  'fk_warehouse_lines_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id) ON DELETE RESTRICT ON UPDATE CASCADE'
);

CALL add_fk_if_missing(
  'fk_warehouse_movements_supplier_part',
  'warehouse_stock_movements',
  'fk_warehouse_movements_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id) ON DELETE RESTRICT ON UPDATE CASCADE'
);

DROP TEMPORARY TABLE IF EXISTS tmp_warehouse_catalog_supplier_part;
CREATE TEMPORARY TABLE tmp_warehouse_catalog_supplier_part AS
SELECT
  spcp.catalog_position_id,
  MIN(spcp.supplier_part_id) AS supplier_part_id
FROM supplier_part_catalog_positions spcp
JOIN (
  SELECT
    catalog_position_id,
    MAX(COALESCE(is_preferred, 0)) AS preferred_rank
  FROM supplier_part_catalog_positions
  GROUP BY catalog_position_id
) pref
  ON pref.catalog_position_id = spcp.catalog_position_id
 AND pref.preferred_rank = COALESCE(spcp.is_preferred, 0)
GROUP BY spcp.catalog_position_id;

UPDATE warehouse_document_lines line
JOIN tmp_warehouse_catalog_supplier_part link
  ON link.catalog_position_id = line.catalog_position_id
SET line.supplier_part_id = link.supplier_part_id
WHERE line.supplier_part_id IS NULL;

UPDATE warehouse_stock_movements movement
JOIN tmp_warehouse_catalog_supplier_part link
  ON link.catalog_position_id = movement.catalog_position_id
SET movement.supplier_part_id = link.supplier_part_id
WHERE movement.supplier_part_id IS NULL;

DROP TEMPORARY TABLE IF EXISTS tmp_warehouse_catalog_supplier_part;

DROP PROCEDURE IF EXISTS add_fk_if_missing;
DROP PROCEDURE IF EXISTS add_index_if_missing;
DROP PROCEDURE IF EXISTS add_column_if_missing;
