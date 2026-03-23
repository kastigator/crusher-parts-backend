START TRANSACTION;

DELETE FROM oem_part_standard_parts;
DELETE FROM supplier_part_standard_parts;

UPDATE client_request_revision_item_components SET standard_part_id = NULL WHERE standard_part_id IS NOT NULL;
UPDATE client_request_revision_items SET standard_part_id = NULL WHERE standard_part_id IS NOT NULL;
UPDATE rfq_coverage_option_lines SET standard_part_id = NULL WHERE standard_part_id IS NOT NULL;
UPDATE rfq_item_components SET standard_part_id = NULL WHERE standard_part_id IS NOT NULL;
UPDATE rfq_items SET standard_part_id = NULL WHERE standard_part_id IS NOT NULL;
UPDATE rfq_response_lines
   SET standard_part_id = NULL,
       requested_standard_part_id = NULL
 WHERE standard_part_id IS NOT NULL
    OR requested_standard_part_id IS NOT NULL;
UPDATE rfq_supplier_line_selections SET standard_part_id = NULL WHERE standard_part_id IS NOT NULL;
UPDATE supplier_quality_events SET standard_part_id = NULL WHERE standard_part_id IS NOT NULL;

DELETE FROM standard_parts;

CREATE TABLE IF NOT EXISTS standard_part_classes (
  id INT NOT NULL AUTO_INCREMENT,
  parent_id INT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_standard_part_classes_code (code),
  KEY idx_standard_part_classes_parent (parent_id),
  KEY idx_standard_part_classes_active (is_active),
  CONSTRAINT fk_standard_part_classes_parent
    FOREIGN KEY (parent_id) REFERENCES standard_part_classes (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS standard_part_class_fields (
  id INT NOT NULL AUTO_INCREMENT,
  class_id INT NOT NULL,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  field_type ENUM('text','textarea','number','boolean','select','multiselect','date') NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_in_title TINYINT(1) NOT NULL DEFAULT 0,
  is_in_list TINYINT(1) NOT NULL DEFAULT 0,
  is_in_filters TINYINT(1) NOT NULL DEFAULT 0,
  is_searchable TINYINT(1) NOT NULL DEFAULT 0,
  unit VARCHAR(50) NULL,
  placeholder VARCHAR(255) NULL,
  help_text TEXT NULL,
  default_value VARCHAR(255) NULL,
  settings_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_standard_part_class_fields_class_code (class_id, code),
  KEY idx_standard_part_class_fields_class (class_id),
  KEY idx_standard_part_class_fields_sort (class_id, sort_order, id),
  KEY idx_standard_part_class_fields_type (field_type),
  CONSTRAINT fk_standard_part_class_fields_class
    FOREIGN KEY (class_id) REFERENCES standard_part_classes (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS standard_part_field_options (
  id INT NOT NULL AUTO_INCREMENT,
  field_id INT NOT NULL,
  value_code VARCHAR(100) NOT NULL,
  value_label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_standard_part_field_options_field_code (field_id, value_code),
  KEY idx_standard_part_field_options_field (field_id),
  CONSTRAINT fk_standard_part_field_options_field
    FOREIGN KEY (field_id) REFERENCES standard_part_class_fields (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS standard_part_values (
  id INT NOT NULL AUTO_INCREMENT,
  standard_part_id INT NOT NULL,
  field_id INT NOT NULL,
  value_text TEXT NULL,
  value_number DECIMAL(18,6) NULL,
  value_boolean TINYINT(1) NULL,
  value_date DATE NULL,
  value_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_standard_part_values_part_field (standard_part_id, field_id),
  KEY idx_standard_part_values_part (standard_part_id),
  KEY idx_standard_part_values_field (field_id),
  KEY idx_standard_part_values_number (value_number),
  KEY idx_standard_part_values_boolean (value_boolean),
  KEY idx_standard_part_values_date (value_date),
  CONSTRAINT fk_standard_part_values_part
    FOREIGN KEY (standard_part_id) REFERENCES standard_parts (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_standard_part_values_field
    FOREIGN KEY (field_id) REFERENCES standard_part_class_fields (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE standard_parts
  DROP INDEX idx_standard_parts_type,
  DROP INDEX idx_standard_parts_designation_norm,
  DROP INDEX idx_standard_parts_standard_system,
  DROP COLUMN designation_norm,
  DROP COLUMN part_type,
  DROP COLUMN standard_system,
  DROP COLUMN strength_class,
  DROP COLUMN material_spec,
  DROP COLUMN coating,
  DROP COLUMN thread_spec,
  DROP COLUMN size_note,
  ADD COLUMN class_id INT NULL AFTER id,
  ADD COLUMN display_name VARCHAR(500) NOT NULL AFTER class_id,
  ADD COLUMN display_name_norm VARCHAR(500) NULL AFTER display_name,
  ADD COLUMN attributes_search_text TEXT NULL AFTER notes;

ALTER TABLE standard_parts
  MODIFY COLUMN designation VARCHAR(255) NULL,
  MODIFY COLUMN class_id INT NOT NULL;

ALTER TABLE standard_parts
  ADD KEY idx_standard_parts_class (class_id),
  ADD KEY idx_standard_parts_display_name (display_name),
  ADD CONSTRAINT fk_standard_parts_class
    FOREIGN KEY (class_id) REFERENCES standard_part_classes (id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
