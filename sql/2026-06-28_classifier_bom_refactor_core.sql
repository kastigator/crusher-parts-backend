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

CREATE TABLE IF NOT EXISTS equipment_model_bom_import_batches (
  id INT NOT NULL AUTO_INCREMENT,
  equipment_model_id INT NOT NULL,
  source_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  source_file_name VARCHAR(255) NULL,
  source_document_id INT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  rows_total INT NOT NULL DEFAULT 0,
  rows_committed INT NOT NULL DEFAULT 0,
  warnings_json JSON NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  committed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_bom_import_batches_model (equipment_model_id, created_at, id),
  KEY idx_bom_import_batches_document (source_document_id),
  CONSTRAINT fk_bom_import_batches_model
    FOREIGN KEY (equipment_model_id) REFERENCES equipment_models (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_bom_import_batches_document
    FOREIGN KEY (source_document_id) REFERENCES equipment_model_documents (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CALL add_column_if_missing(
  'catalog_positions',
  'position_kind',
  "position_kind VARCHAR(32) NOT NULL DEFAULT 'part' AFTER classifier_node_id"
);
CALL add_column_if_missing(
  'catalog_positions',
  'source_kind',
  "source_kind VARCHAR(32) NOT NULL DEFAULT 'classifier' AFTER position_kind"
);
CALL add_column_if_missing(
  'catalog_positions',
  'drawing_number',
  'drawing_number VARCHAR(120) NULL AFTER description'
);
CALL add_column_if_missing(
  'catalog_positions',
  'status',
  "status VARCHAR(32) NOT NULL DEFAULT 'active' AFTER is_active"
);
CALL add_column_if_missing(
  'catalog_positions',
  'meta_json',
  'meta_json JSON NULL AFTER status'
);

CALL add_column_if_missing(
  'equipment_model_bom_items',
  'row_kind',
  "row_kind VARCHAR(32) NOT NULL DEFAULT 'assembly' AFTER parent_item_id"
);
CALL add_column_if_missing(
  'equipment_model_bom_items',
  'client_part_id',
  'client_part_id INT NULL AFTER catalog_position_id'
);
CALL add_column_if_missing(
  'equipment_model_bom_items',
  'source_document_id',
  'source_document_id INT NULL AFTER notes'
);
CALL add_column_if_missing(
  'equipment_model_bom_items',
  'source_ref',
  'source_ref VARCHAR(255) NULL AFTER source_document_id'
);
CALL add_column_if_missing(
  'equipment_model_bom_items',
  'import_batch_id',
  'import_batch_id INT NULL AFTER source_ref'
);
CALL add_column_if_missing(
  'equipment_model_bom_items',
  'import_confidence',
  'import_confidence DECIMAL(5,4) NULL AFTER import_batch_id'
);
CALL add_column_if_missing(
  'equipment_model_bom_items',
  'source_note',
  'source_note TEXT NULL AFTER import_confidence'
);

CALL add_index_if_missing(
  'equipment_model_bom_items',
  'idx_bom_client_part',
  'KEY idx_bom_client_part (client_part_id)'
);
CALL add_index_if_missing(
  'equipment_model_bom_items',
  'idx_bom_source_document',
  'KEY idx_bom_source_document (source_document_id)'
);
CALL add_index_if_missing(
  'equipment_model_bom_items',
  'idx_bom_import_batch',
  'KEY idx_bom_import_batch (import_batch_id)'
);
CALL add_index_if_missing(
  'equipment_model_bom_items',
  'idx_bom_row_kind',
  'KEY idx_bom_row_kind (equipment_model_id, row_kind)'
);

CALL add_fk_if_missing(
  'fk_equipment_model_bom_items_client_part',
  'equipment_model_bom_items',
  'fk_equipment_model_bom_items_client_part FOREIGN KEY (client_part_id) REFERENCES client_parts (id) ON DELETE SET NULL ON UPDATE CASCADE'
);
CALL add_fk_if_missing(
  'fk_equipment_model_bom_items_source_document',
  'equipment_model_bom_items',
  'fk_equipment_model_bom_items_source_document FOREIGN KEY (source_document_id) REFERENCES equipment_model_documents (id) ON DELETE SET NULL ON UPDATE CASCADE'
);
CALL add_fk_if_missing(
  'fk_equipment_model_bom_items_import_batch',
  'equipment_model_bom_items',
  'fk_equipment_model_bom_items_import_batch FOREIGN KEY (import_batch_id) REFERENCES equipment_model_bom_import_batches (id) ON DELETE SET NULL ON UPDATE CASCADE'
);

CREATE TABLE IF NOT EXISTS supplier_part_catalog_positions (
  supplier_part_id INT NOT NULL,
  catalog_position_id INT NOT NULL,
  relationship_type VARCHAR(32) NOT NULL DEFAULT 'can_supply',
  confidence DECIMAL(5,4) NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (supplier_part_id, catalog_position_id),
  KEY idx_spcp_catalog_position (catalog_position_id),
  CONSTRAINT fk_spcp_supplier_part
    FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_spcp_catalog_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE equipment_model_bom_items
SET row_kind = CASE
  WHEN catalog_position_id IS NOT NULL THEN 'part'
  WHEN oem_part_id IS NOT NULL THEN 'part'
  WHEN LOWER(COALESCE(item_type, '')) IN ('document', 'drawing', 'schema', 'schematic') THEN 'document'
  WHEN LOWER(COALESCE(title, manufacturer_part_name, '')) REGEXP 'schematic|drawing|document|чертеж|схем' THEN 'document'
  WHEN LOWER(COALESCE(title, manufacturer_part_name, '')) REGEXP 'kit|комплект' THEN 'kit'
  ELSE 'assembly'
END
WHERE row_kind IS NULL OR row_kind = '' OR row_kind = 'assembly';

DROP PROCEDURE IF EXISTS add_fk_if_missing;
DROP PROCEDURE IF EXISTS add_index_if_missing;
DROP PROCEDURE IF EXISTS add_column_if_missing;
