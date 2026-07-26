CREATE TABLE IF NOT EXISTS warehouse_locations (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  location_type ENUM('physical','office','transit') NOT NULL DEFAULT 'physical',
  country VARCHAR(80) NULL,
  city VARCHAR(120) NULL,
  address VARCHAR(255) NULL,
  notes TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_locations_code (code),
  KEY idx_warehouse_locations_active (is_active, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouse_storage_places (
  id INT NOT NULL AUTO_INCREMENT,
  warehouse_id INT NOT NULL,
  code VARCHAR(80) NOT NULL,
  zone VARCHAR(32) NULL,
  rack VARCHAR(32) NULL,
  section VARCHAR(32) NULL,
  tier VARCHAR(32) NULL,
  bin VARCHAR(32) NULL,
  notes TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_places_code (warehouse_id, code),
  KEY idx_warehouse_places_warehouse (warehouse_id, is_active, code),
  CONSTRAINT fk_warehouse_places_location
    FOREIGN KEY (warehouse_id) REFERENCES warehouse_locations (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouse_documents (
  id INT NOT NULL AUTO_INCREMENT,
  document_no VARCHAR(64) NULL,
  doc_type ENUM('receipt','transfer','writeoff','inventory','assembly','packing','shipment','minmax') NOT NULL,
  status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  document_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  warehouse_id INT NULL,
  source_warehouse_id INT NULL,
  target_warehouse_id INT NULL,
  basis_document VARCHAR(255) NULL,
  client_reference VARCHAR(255) NULL,
  notes TEXT NULL,
  created_by INT NULL,
  posted_by INT NULL,
  posted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_documents_no (document_no),
  KEY idx_warehouse_documents_date (document_date, id),
  KEY idx_warehouse_documents_status (status, doc_type),
  KEY idx_warehouse_documents_warehouse (warehouse_id, source_warehouse_id, target_warehouse_id),
  CONSTRAINT fk_warehouse_documents_warehouse
    FOREIGN KEY (warehouse_id) REFERENCES warehouse_locations (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_documents_source
    FOREIGN KEY (source_warehouse_id) REFERENCES warehouse_locations (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_documents_target
    FOREIGN KEY (target_warehouse_id) REFERENCES warehouse_locations (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_documents_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_documents_posted_by
    FOREIGN KEY (posted_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouse_document_lines (
  id INT NOT NULL AUTO_INCREMENT,
  document_id INT NOT NULL,
  catalog_position_id INT NOT NULL,
  storage_place_id INT NULL,
  target_storage_place_id INT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  unit_code VARCHAR(32) NULL,
  reason VARCHAR(120) NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_warehouse_lines_document (document_id, id),
  KEY idx_warehouse_lines_position (catalog_position_id),
  KEY idx_warehouse_lines_places (storage_place_id, target_storage_place_id),
  CONSTRAINT fk_warehouse_lines_document
    FOREIGN KEY (document_id) REFERENCES warehouse_documents (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_lines_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_lines_place
    FOREIGN KEY (storage_place_id) REFERENCES warehouse_storage_places (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_lines_target_place
    FOREIGN KEY (target_storage_place_id) REFERENCES warehouse_storage_places (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_lines_unit
    FOREIGN KEY (unit_code) REFERENCES measurement_units (code)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouse_stock_movements (
  id INT NOT NULL AUTO_INCREMENT,
  document_id INT NOT NULL,
  document_line_id INT NOT NULL,
  catalog_position_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  storage_place_id INT NULL,
  movement_type ENUM('receipt','transfer_out','transfer_in','writeoff','inventory_adjustment','assembly_in','assembly_out','packing','shipment','reserve','unreserve') NOT NULL,
  quantity_delta DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  reserved_delta DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_warehouse_movements_stock (warehouse_id, storage_place_id, catalog_position_id),
  KEY idx_warehouse_movements_position (catalog_position_id, occurred_at),
  KEY idx_warehouse_movements_document (document_id, document_line_id),
  CONSTRAINT fk_warehouse_movements_document
    FOREIGN KEY (document_id) REFERENCES warehouse_documents (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_movements_line
    FOREIGN KEY (document_line_id) REFERENCES warehouse_document_lines (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_movements_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_movements_warehouse
    FOREIGN KEY (warehouse_id) REFERENCES warehouse_locations (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_movements_place
    FOREIGN KEY (storage_place_id) REFERENCES warehouse_storage_places (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO warehouse_locations (code, name, location_type, country, city)
VALUES
  ('spb', 'Склад СПб', 'physical', 'Россия', 'Санкт-Петербург'),
  ('finland', 'Склад Финляндия', 'physical', 'Финляндия', NULL),
  ('china', 'Склад Китай', 'physical', 'Китай', NULL),
  ('kazakhstan', 'Склад Казахстан', 'physical', 'Казахстан', NULL),
  ('transit', 'Транзитный склад', 'transit', NULL, NULL)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  location_type = VALUES(location_type),
  country = VALUES(country),
  city = VALUES(city),
  is_active = 1;

INSERT INTO warehouse_storage_places (warehouse_id, code, zone, rack, section, tier, bin)
SELECT wl.id, 'A1/1-1-1', 'A', '1', '1', '1', '1'
FROM warehouse_locations wl
WHERE wl.code = 'spb'
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO warehouse_storage_places (warehouse_id, code, zone)
SELECT wl.id, 'TRANSIT', 'TRANSIT'
FROM warehouse_locations wl
WHERE wl.code = 'transit'
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO tabs (name, tab_name, path, icon, tooltip, is_active, sort_order)
SELECT 'Склад', 'warehouse', '/warehouse', 'warehouse', 'Склад: остатки, места хранения и документы движения', 1, 3
WHERE NOT EXISTS (
  SELECT 1 FROM tabs WHERE path = '/warehouse' OR tab_name = 'warehouse'
);

UPDATE tabs
SET name = 'Склад',
    tab_name = 'warehouse',
    path = '/warehouse',
    icon = 'warehouse',
    tooltip = 'Склад: остатки, места хранения и документы движения',
    is_active = 1
WHERE path = '/warehouse' OR tab_name = 'warehouse';

INSERT INTO role_permissions (role_id, tab_id, can_view)
SELECT r.id, t.id, 1
FROM roles r
JOIN tabs t ON t.path = '/warehouse'
WHERE NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    WHERE rp.role_id = r.id
      AND rp.tab_id = t.id
  );
