CREATE TABLE catalog_positions (
  id INT NOT NULL AUTO_INCREMENT,
  classifier_node_id INT NOT NULL,
  display_name VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  position_code VARCHAR(120) COLLATE utf8mb4_unicode_ci NULL,
  description TEXT COLLATE utf8mb4_unicode_ci NULL,
  uom VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_positions_code (position_code),
  KEY idx_catalog_positions_node (classifier_node_id, is_active),
  KEY idx_catalog_positions_name (display_name),
  KEY idx_catalog_positions_uom (uom),
  CONSTRAINT fk_catalog_positions_classifier_node
    FOREIGN KEY (classifier_node_id) REFERENCES equipment_classifier_nodes (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_catalog_positions_uom
    FOREIGN KEY (uom) REFERENCES measurement_units (code)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE equipment_attribute_values
  MODIFY entity_type ENUM('equipment_model', 'client_equipment_unit', 'catalog_position')
  COLLATE utf8mb4_unicode_ci NOT NULL;

ALTER TABLE equipment_model_bom_items
  ADD COLUMN catalog_position_id INT NULL AFTER oem_part_id,
  ADD KEY idx_catalog_position (catalog_position_id),
  ADD CONSTRAINT fk_equipment_model_bom_items_catalog_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE SET NULL ON UPDATE CASCADE;
