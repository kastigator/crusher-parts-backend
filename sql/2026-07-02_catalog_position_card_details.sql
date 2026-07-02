CREATE TABLE IF NOT EXISTS catalog_position_media (
  id INT NOT NULL AUTO_INCREMENT,
  catalog_position_id INT NOT NULL,
  file_url VARCHAR(1024) NOT NULL,
  file_name VARCHAR(255) NULL,
  mime_type VARCHAR(120) NULL,
  file_size BIGINT NULL,
  caption VARCHAR(255) NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  uploaded_by INT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_catalog_position_media_position (catalog_position_id, is_primary, sort_order, id),
  CONSTRAINT fk_catalog_position_media_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_position_materials (
  id INT NOT NULL AUTO_INCREMENT,
  catalog_position_id INT NOT NULL,
  material_id INT NOT NULL,
  variant_name VARCHAR(255) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_catalog_position_materials_position (catalog_position_id, is_default, id),
  KEY idx_catalog_position_materials_material (material_id),
  CONSTRAINT fk_catalog_position_materials_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_catalog_position_materials_material
    FOREIGN KEY (material_id) REFERENCES materials (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
