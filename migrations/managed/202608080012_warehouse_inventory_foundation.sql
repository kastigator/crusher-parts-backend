CREATE TABLE warehouse_inbound_expectations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  expectation_number VARCHAR(80) NOT NULL,
  source_supplier_confirmation_id BIGINT NOT NULL,
  source_po_id BIGINT NOT NULL,
  source_po_revision_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  source_snapshot_json JSON NOT NULL,
  blocker_reasons_json JSON NOT NULL,
  source_hash CHAR(64) NOT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_expectation_number (expectation_number),
  UNIQUE KEY uq_warehouse_expectation_confirmation (source_supplier_confirmation_id),
  KEY idx_warehouse_expectation_queue (status, updated_at),
  CONSTRAINT fk_warehouse_expectation_confirmation FOREIGN KEY (source_supplier_confirmation_id) REFERENCES procurement_supplier_confirmations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_po FOREIGN KEY (source_po_id) REFERENCES procurement_purchase_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_revision FOREIGN KEY (source_po_revision_id) REFERENCES procurement_purchase_order_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_expectation_status CHECK (status IN ('OPEN','PARTIALLY_RECEIVED','RECEIVED','BLOCKED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_inbound_expectation_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  warehouse_inbound_expectation_id BIGINT NOT NULL,
  source_confirmation_line_id BIGINT NULL,
  source_po_line_id BIGINT NOT NULL,
  procurement_execution_item_id BIGINT NOT NULL,
  catalog_position_id INT NULL,
  supplier_part_id INT NULL,
  line_number INT NOT NULL,
  expected_quantity DECIMAL(15,3) NOT NULL,
  uom VARCHAR(24) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  blocker_reasons_json JSON NOT NULL,
  lineage_snapshot_json JSON NOT NULL,
  lineage_hash CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_expectation_po_line (warehouse_inbound_expectation_id, source_po_line_id),
  KEY idx_warehouse_expectation_line_queue (status, catalog_position_id),
  CONSTRAINT fk_warehouse_expectation_line_header FOREIGN KEY (warehouse_inbound_expectation_id) REFERENCES warehouse_inbound_expectations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_line_confirmation FOREIGN KEY (source_confirmation_line_id) REFERENCES procurement_supplier_confirmation_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_line_po FOREIGN KEY (source_po_line_id) REFERENCES procurement_purchase_order_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_line_item FOREIGN KEY (procurement_execution_item_id) REFERENCES procurement_execution_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_line_catalog FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_expectation_line_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_expectation_line_status CHECK (status IN ('OPEN','PARTIALLY_RECEIVED','RECEIVED','BLOCKED','CANCELLED')),
  CONSTRAINT chk_warehouse_expectation_line_qty CHECK (expected_quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_receipts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  receipt_number VARCHAR(80) NOT NULL,
  warehouse_inbound_expectation_id BIGINT NOT NULL,
  warehouse_id INT NOT NULL,
  receiving_place_id INT NULL,
  received_at DATETIME(6) NOT NULL,
  evidence_reference VARCHAR(1000) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'POSTED',
  received_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_receipt_number (receipt_number),
  UNIQUE KEY uq_warehouse_receipt_idempotency (idempotency_key),
  KEY idx_warehouse_receipt_inbound (warehouse_inbound_expectation_id, received_at),
  CONSTRAINT fk_warehouse_receipt_expectation FOREIGN KEY (warehouse_inbound_expectation_id) REFERENCES warehouse_inbound_expectations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_receipt_location FOREIGN KEY (warehouse_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_receipt_place FOREIGN KEY (receiving_place_id) REFERENCES warehouse_storage_places(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_receipt_actor FOREIGN KEY (received_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_receipt_status CHECK (status IN ('POSTED','REVERSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_receipt_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  warehouse_receipt_id BIGINT NOT NULL,
  warehouse_inbound_expectation_line_id BIGINT NOT NULL,
  received_quantity DECIMAL(15,3) NOT NULL,
  damaged_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  missing_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  supplier_lot_number VARCHAR(160) NULL,
  evidence_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_receipt_expectation_line (warehouse_receipt_id, warehouse_inbound_expectation_line_id),
  CONSTRAINT fk_warehouse_receipt_line_receipt FOREIGN KEY (warehouse_receipt_id) REFERENCES warehouse_receipts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_receipt_line_expectation FOREIGN KEY (warehouse_inbound_expectation_line_id) REFERENCES warehouse_inbound_expectation_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_receipt_line_qty CHECK (received_quantity > 0 AND damaged_quantity >= 0 AND damaged_quantity <= received_quantity AND missing_quantity >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_stock_units (
  id BIGINT NOT NULL AUTO_INCREMENT,
  stock_unit_code VARCHAR(100) NOT NULL,
  root_receipt_line_id BIGINT NOT NULL,
  parent_stock_unit_id BIGINT NULL,
  catalog_position_id INT NOT NULL,
  supplier_part_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  current_storage_place_id INT NULL,
  supplier_lot_number VARCHAR(160) NULL,
  internal_lot_number VARCHAR(160) NOT NULL,
  uom VARCHAR(24) NOT NULL,
  quality_status VARCHAR(24) NOT NULL DEFAULT 'RELEASED',
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  lineage_snapshot_json JSON NOT NULL,
  lineage_hash CHAR(64) NOT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_stock_unit_code (stock_unit_code),
  KEY idx_warehouse_stock_unit_catalog (catalog_position_id, quality_status, status),
  KEY idx_warehouse_stock_unit_supplier (supplier_part_id, warehouse_id, status),
  CONSTRAINT fk_warehouse_stock_unit_receipt FOREIGN KEY (root_receipt_line_id) REFERENCES warehouse_receipt_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_stock_unit_parent FOREIGN KEY (parent_stock_unit_id) REFERENCES warehouse_stock_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_stock_unit_catalog FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_stock_unit_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_stock_unit_location FOREIGN KEY (warehouse_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_stock_unit_place FOREIGN KEY (current_storage_place_id) REFERENCES warehouse_storage_places(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_stock_unit_quality CHECK (quality_status IN ('RELEASED','HOLD','REJECTED')),
  CONSTRAINT chk_warehouse_stock_unit_status CHECK (status IN ('ACTIVE','DEPLETED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_inventory_movements (
  id BIGINT NOT NULL AUTO_INCREMENT,
  stock_unit_id BIGINT NOT NULL,
  movement_type VARCHAR(32) NOT NULL,
  quantity_delta DECIMAL(15,3) NOT NULL DEFAULT 0,
  reserved_delta DECIMAL(15,3) NOT NULL DEFAULT 0,
  from_warehouse_id INT NULL,
  from_storage_place_id INT NULL,
  to_warehouse_id INT NULL,
  to_storage_place_id INT NULL,
  reason_code VARCHAR(80) NULL,
  evidence_snapshot_json JSON NOT NULL,
  operation_key VARCHAR(160) NOT NULL,
  reversal_of_movement_id BIGINT NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_inventory_operation (operation_key),
  KEY idx_warehouse_inventory_unit (stock_unit_id, occurred_at, id),
  KEY idx_warehouse_inventory_location (to_warehouse_id, to_storage_place_id, occurred_at),
  CONSTRAINT fk_warehouse_inventory_unit FOREIGN KEY (stock_unit_id) REFERENCES warehouse_stock_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_inventory_from_location FOREIGN KEY (from_warehouse_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_inventory_from_place FOREIGN KEY (from_storage_place_id) REFERENCES warehouse_storage_places(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_inventory_to_location FOREIGN KEY (to_warehouse_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_inventory_to_place FOREIGN KEY (to_storage_place_id) REFERENCES warehouse_storage_places(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_inventory_reversal FOREIGN KEY (reversal_of_movement_id) REFERENCES warehouse_inventory_movements(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_inventory_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_inventory_type CHECK (movement_type IN ('RECEIPT','PUTAWAY','MOVE','SPLIT_OUT','SPLIT_IN','RESERVE','UNRESERVE','WRITE_OFF','COUNT_ADJUSTMENT','QUALITY_HOLD','QUALITY_RELEASE','REVERSAL')),
  CONSTRAINT chk_warehouse_inventory_delta CHECK (quantity_delta <> 0 OR reserved_delta <> 0 OR movement_type IN ('PUTAWAY','MOVE','QUALITY_HOLD','QUALITY_RELEASE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_inventory_reservations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  reservation_number VARCHAR(80) NOT NULL,
  source_domain VARCHAR(40) NOT NULL,
  source_entity_type VARCHAR(64) NOT NULL,
  source_entity_id BIGINT NOT NULL,
  source_revision_id BIGINT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  evidence_snapshot_json JSON NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_by_user_id INT NULL,
  released_by_user_id INT NULL,
  released_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_reservation_number (reservation_number),
  UNIQUE KEY uq_warehouse_reservation_idempotency (idempotency_key),
  KEY idx_warehouse_reservation_source (source_domain, source_entity_type, source_entity_id, status),
  CONSTRAINT fk_warehouse_reservation_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_reservation_releaser FOREIGN KEY (released_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_reservation_status CHECK (status IN ('ACTIVE','RELEASED','CONSUMED','REVERSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_inventory_reservation_allocations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  warehouse_inventory_reservation_id BIGINT NOT NULL,
  stock_unit_id BIGINT NOT NULL,
  quantity DECIMAL(15,3) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_reservation_unit (warehouse_inventory_reservation_id, stock_unit_id),
  KEY idx_warehouse_reservation_allocation_unit (stock_unit_id, status),
  CONSTRAINT fk_warehouse_reservation_allocation_header FOREIGN KEY (warehouse_inventory_reservation_id) REFERENCES warehouse_inventory_reservations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_reservation_allocation_unit FOREIGN KEY (stock_unit_id) REFERENCES warehouse_stock_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_reservation_allocation_status CHECK (status IN ('ACTIVE','RELEASED','CONSUMED','REVERSED')),
  CONSTRAINT chk_warehouse_reservation_allocation_qty CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_inventory_counts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  count_number VARCHAR(80) NOT NULL,
  warehouse_id INT NOT NULL,
  storage_place_id INT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  reason_code VARCHAR(80) NOT NULL,
  created_by_user_id INT NULL,
  approved_by_user_id INT NULL,
  approved_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_count_number (count_number),
  KEY idx_warehouse_count_queue (status, warehouse_id, storage_place_id),
  CONSTRAINT fk_warehouse_count_location FOREIGN KEY (warehouse_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_count_place FOREIGN KEY (storage_place_id) REFERENCES warehouse_storage_places(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_count_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_count_approver FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_count_status CHECK (status IN ('OPEN','COUNTED','RECOUNT_REQUIRED','APPROVED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_inventory_count_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  warehouse_inventory_count_id BIGINT NOT NULL,
  stock_unit_id BIGINT NOT NULL,
  expected_quantity_snapshot DECIMAL(15,3) NOT NULL,
  counted_quantity DECIMAL(15,3) NULL,
  variance_quantity DECIMAL(15,3) NULL,
  evidence_snapshot_json JSON NOT NULL,
  counted_by_user_id INT NULL,
  counted_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_count_unit (warehouse_inventory_count_id, stock_unit_id),
  CONSTRAINT fk_warehouse_count_line_header FOREIGN KEY (warehouse_inventory_count_id) REFERENCES warehouse_inventory_counts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_count_line_unit FOREIGN KEY (stock_unit_id) REFERENCES warehouse_stock_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_warehouse_count_line_actor FOREIGN KEY (counted_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_warehouse_count_line_qty CHECK (expected_quantity_snapshot >= 0 AND (counted_quantity IS NULL OR counted_quantity >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_inventory_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(80) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id BIGINT NULL,
  source_domain VARCHAR(40) NULL,
  source_entity_type VARCHAR(64) NULL,
  source_entity_id BIGINT NULL,
  actor_user_id INT NULL,
  payload_json JSON NOT NULL,
  event_hash CHAR(64) NOT NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_warehouse_event_aggregate (aggregate_type, aggregate_id, occurred_at),
  KEY idx_warehouse_event_type (event_type, occurred_at),
  CONSTRAINT fk_warehouse_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles (name,slug,description,is_system,is_super_admin)
VALUES ('Кладовщик','kladovshchik','Warehouse receiving, stock, reservations and counts',1,0)
ON DUPLICATE KEY UPDATE description=VALUES(description),is_system=1,is_super_admin=0;

INSERT INTO capabilities (capability_key,name,description,section,sort_order,is_active,is_legacy) VALUES
 ('warehouse_inventory.access','Просмотр Warehouse & Inventory','Доступ к warehouse workspace и read models','warehouse_inventory',1600,1,0),
 ('warehouse_inventory.master_data.manage','Склады и места хранения','Управление физическими складами и местами хранения','warehouse_inventory',1610,1,0),
 ('warehouse_inventory.inbound.manage','Ожидаемые поставки','Материализация expected inbound только из accepted confirmation','warehouse_inventory',1620,1,0),
 ('warehouse_inventory.receiving','Приёмка','Фиксация фактической приёмки и Stock Unit lineage','warehouse_inventory',1630,1,0),
 ('warehouse_inventory.movements','Перемещения и put-away','Auditable движения Stock Unit','warehouse_inventory',1640,1,0),
 ('warehouse_inventory.reservations','Резервы','Создание и снятие first-class reservations','warehouse_inventory',1650,1,0),
 ('warehouse_inventory.quality','Warehouse quality hold','Operational hold/release without separate QMS','warehouse_inventory',1660,1,0),
 ('warehouse_inventory.counts','Инвентаризация','Blind count и recount workflow','warehouse_inventory',1670,1,0),
 ('warehouse_inventory.adjustments','Складские корректировки','Approved compensating adjustments and write-offs','warehouse_inventory',1680,1,0),
 ('warehouse_inventory.availability.view','Просмотр доступности','Physical, held, reserved and available projections','warehouse_inventory',1690,1,0),
 ('warehouse_inventory.history.view','История склада','Movement and evidence history','warehouse_inventory',1700,1,0)
ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),section=VALUES(section),sort_order=VALUES(sort_order),is_active=1,is_legacy=0;

INSERT INTO role_capabilities (role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.section='warehouse_inventory'
WHERE r.slug IN ('admin','nachalnik-otdela-zakupok','kladovshchik')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities (role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN ('warehouse_inventory.access','warehouse_inventory.availability.view','warehouse_inventory.history.view')
WHERE r.slug IN ('zakupshchik','prodavec','specialist-po-katalogam','nablyudatel','finansist')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
