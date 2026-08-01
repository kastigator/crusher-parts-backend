-- Explicit attribute applicability and durable classifier import previews.
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS equipment_classifier_attribute_scopes (
  attribute_id INT NOT NULL,
  entity_type ENUM('equipment_model','client_equipment_unit','catalog_position') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (attribute_id, entity_type),
  KEY idx_classifier_attribute_scopes_entity (entity_type, attribute_id),
  CONSTRAINT fk_classifier_attribute_scopes_attribute
    FOREIGN KEY (attribute_id) REFERENCES equipment_classifier_node_attributes (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS add_classifier_attribute_import_columns;
DELIMITER $$
CREATE PROCEDURE add_classifier_attribute_import_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'equipment_classifier_node_attributes'
      AND column_name = 'is_importable'
  ) THEN
    ALTER TABLE equipment_classifier_node_attributes
      ADD COLUMN is_importable TINYINT(1) NOT NULL DEFAULT 1 AFTER is_filterable;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'equipment_classifier_node_attributes'
      AND column_name = 'is_identity'
  ) THEN
    ALTER TABLE equipment_classifier_node_attributes
      ADD COLUMN is_identity TINYINT(1) NOT NULL DEFAULT 0 AFTER is_importable;
  END IF;
END$$
DELIMITER ;
CALL add_classifier_attribute_import_columns();
DROP PROCEDURE IF EXISTS add_classifier_attribute_import_columns;

-- Existing configured equipment leaves describe equipment models.
INSERT IGNORE INTO equipment_classifier_attribute_scopes (attribute_id, entity_type)
SELECT a.id, 'equipment_model'
FROM equipment_classifier_node_attributes a
JOIN equipment_classifier_nodes n ON n.id = a.classifier_node_id
WHERE n.card_kind = 'equipment_model';

-- Existing commodity/material/service leaves describe catalog positions.
INSERT IGNORE INTO equipment_classifier_attribute_scopes (attribute_id, entity_type)
SELECT a.id, 'catalog_position'
FROM equipment_classifier_node_attributes a
JOIN equipment_classifier_nodes n ON n.id = a.classifier_node_id
WHERE n.card_kind IN ('catalog_position', 'material', 'service');

-- Preserve every scope that is already evidenced by stored values.
INSERT IGNORE INTO equipment_classifier_attribute_scopes (attribute_id, entity_type)
SELECT DISTINCT attribute_id, entity_type
FROM equipment_attribute_values;

CREATE TABLE IF NOT EXISTS classifier_import_batches (
  id BIGINT NOT NULL AUTO_INCREMENT,
  classifier_node_id INT NOT NULL,
  entity_type ENUM('equipment_model','catalog_position') NOT NULL,
  source_file_name VARCHAR(255) NULL,
  source_file_sha256 CHAR(64) NOT NULL,
  template_version INT NOT NULL DEFAULT 1,
  schema_hash CHAR(64) NOT NULL,
  status ENUM('previewed','committing','committed','failed','cancelled') NOT NULL DEFAULT 'previewed',
  rows_total INT NOT NULL DEFAULT 0,
  rows_create INT NOT NULL DEFAULT 0,
  rows_update INT NOT NULL DEFAULT 0,
  rows_skip INT NOT NULL DEFAULT 0,
  rows_error INT NOT NULL DEFAULT 0,
  preview_json JSON NOT NULL,
  result_json JSON NULL,
  created_by_user_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  committed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_classifier_import_batches_node_created (classifier_node_id, created_at),
  KEY idx_classifier_import_batches_status (status, created_at),
  CONSTRAINT fk_classifier_import_batches_node
    FOREIGN KEY (classifier_node_id) REFERENCES equipment_classifier_nodes (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_classifier_import_batches_user
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Normalize the known legacy select value: options are stored by stable code,
-- while labels remain presentation-only.
UPDATE equipment_attribute_values v
JOIN equipment_classifier_node_attributes a ON a.id = v.attribute_id
JOIN equipment_classifier_attribute_options o
  ON o.attribute_id = a.id
 AND LOWER(o.value_label) = LOWER(v.value_text)
SET v.value_text = o.value_code
WHERE a.value_type = 'select'
  AND v.value_text IS NOT NULL
  AND v.value_text <> o.value_code;
