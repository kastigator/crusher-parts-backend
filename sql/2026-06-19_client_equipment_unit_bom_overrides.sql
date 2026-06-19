CREATE TABLE IF NOT EXISTS client_equipment_unit_bom_overrides (
  id INT NOT NULL AUTO_INCREMENT,
  client_equipment_unit_id INT NOT NULL,
  equipment_model_bom_item_id INT NOT NULL,
  status ENUM(
    'as_original',
    'replaced',
    'client_drawing',
    'unknown_oem',
    'not_applicable',
    'needs_review'
  ) NOT NULL DEFAULT 'as_original',
  difference_summary TEXT NULL,
  client_part_number VARCHAR(120) NULL,
  client_drawing_number VARCHAR(120) NULL,
  client_revision VARCHAR(80) NULL,
  replacement_oem_part_id INT NULL,
  replacement_catalog_position_id INT NULL,
  client_part_id INT NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_unit_bom_item (client_equipment_unit_id, equipment_model_bom_item_id),
  KEY idx_unit_status (client_equipment_unit_id, status),
  KEY idx_bom_item (equipment_model_bom_item_id),
  KEY idx_replacement_oem (replacement_oem_part_id),
  KEY idx_replacement_catalog_position (replacement_catalog_position_id),
  KEY idx_client_part (client_part_id),
  CONSTRAINT fk_ceu_bom_overrides_unit
    FOREIGN KEY (client_equipment_unit_id) REFERENCES client_equipment_units (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ceu_bom_overrides_bom_item
    FOREIGN KEY (equipment_model_bom_item_id) REFERENCES equipment_model_bom_items (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ceu_bom_overrides_replacement_oem
    FOREIGN KEY (replacement_oem_part_id) REFERENCES oem_parts (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ceu_bom_overrides_replacement_catalog
    FOREIGN KEY (replacement_catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ceu_bom_overrides_client_part
    FOREIGN KEY (client_part_id) REFERENCES client_parts (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
