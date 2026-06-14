CREATE TABLE IF NOT EXISTS equipment_model_bom_items (
  id INT NOT NULL AUTO_INCREMENT,
  equipment_model_id INT NOT NULL,
  parent_item_id INT NULL,
  oem_part_id INT NULL,
  title VARCHAR(255) NULL,
  quantity DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  sort_order INT NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_model_parent_sort (equipment_model_id, parent_item_id, sort_order, id),
  KEY idx_parent_item (parent_item_id),
  KEY idx_oem_part (oem_part_id),
  CONSTRAINT fk_equipment_model_bom_items_model
    FOREIGN KEY (equipment_model_id) REFERENCES equipment_models(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_equipment_model_bom_items_parent
    FOREIGN KEY (parent_item_id) REFERENCES equipment_model_bom_items(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_equipment_model_bom_items_oem_part
    FOREIGN KEY (oem_part_id) REFERENCES oem_parts(id)
    ON DELETE SET NULL ON UPDATE CASCADE
);
