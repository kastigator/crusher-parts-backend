ALTER TABLE warehouse_inventory_movements DROP CHECK chk_warehouse_inventory_type;
ALTER TABLE warehouse_inventory_movements
  ADD CONSTRAINT chk_warehouse_inventory_type CHECK (movement_type IN ('RECEIPT','PUTAWAY','MOVE','SPLIT_OUT','SPLIT_IN','RESERVE','UNRESERVE','ISSUE_DISPATCH','WRITE_OFF','COUNT_ADJUSTMENT','QUALITY_HOLD','QUALITY_RELEASE','REVERSAL'));

CREATE TABLE dispatch_orders (
  id BIGINT NOT NULL AUTO_INCREMENT, order_number VARCHAR(80) NOT NULL, client_id INT NOT NULL,
  source_contract_case_id BIGINT NOT NULL, source_contract_revision_id BIGINT NOT NULL,
  destination_snapshot_json JSON NOT NULL, contact_snapshot_json JSON NOT NULL,
  company_legal_snapshot_json JSON NOT NULL, source_trace_snapshot_json JSON NOT NULL,
  destination_hash CHAR(64) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'PLANNING',
  planned_release_at DATETIME(6) NULL, notes TEXT NULL, row_version INT UNSIGNED NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(128) NOT NULL, created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id), UNIQUE KEY uq_dispatch_order_number(order_number), UNIQUE KEY uq_dispatch_order_idempotency(idempotency_key),
  KEY idx_dispatch_order_queue(status,planned_release_at,updated_at),
  CONSTRAINT fk_dispatch_order_client FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_order_contract FOREIGN KEY(source_contract_case_id) REFERENCES contract_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_order_revision FOREIGN KEY(source_contract_revision_id) REFERENCES contract_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_order_actor FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_order_status CHECK(status IN ('PLANNING','WAITING_CONSOLIDATION','READY_FOR_PICKING','PICKING','PACKING','READY_TO_SHIP','PARTIALLY_DISPATCHED','DISPATCHED','PARTIALLY_DELIVERED','COMPLETED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_order_allocations (
  id BIGINT NOT NULL AUTO_INCREMENT, dispatch_order_id BIGINT NOT NULL, contract_commitment_id BIGINT NOT NULL,
  catalog_position_id INT NULL, required_quantity_snapshot DECIMAL(15,3) NOT NULL, allocated_quantity DECIMAL(15,3) NOT NULL,
  uom VARCHAR(24) NOT NULL, commitment_snapshot_json JSON NOT NULL, commitment_hash CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY(id),
  UNIQUE KEY uq_dispatch_order_commitment(dispatch_order_id,contract_commitment_id), KEY idx_dispatch_allocation_commitment(contract_commitment_id),
  CONSTRAINT fk_dispatch_allocation_order FOREIGN KEY(dispatch_order_id) REFERENCES dispatch_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_allocation_commitment FOREIGN KEY(contract_commitment_id) REFERENCES contract_commitments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_allocation_catalog FOREIGN KEY(catalog_position_id) REFERENCES catalog_positions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_allocation_qty CHECK(required_quantity_snapshot>0 AND allocated_quantity>0 AND allocated_quantity<=required_quantity_snapshot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_picking_requests (
  id BIGINT NOT NULL AUTO_INCREMENT, request_number VARCHAR(80) NOT NULL, dispatch_order_id BIGINT NOT NULL,
  warehouse_id INT NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'REQUESTED', evidence_reference VARCHAR(1000) NULL,
  idempotency_key VARCHAR(128) NOT NULL, row_version INT UNSIGNED NOT NULL DEFAULT 1, requested_by_user_id INT NULL,
  confirmed_by_user_id INT NULL, requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), confirmed_at DATETIME(6) NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_dispatch_pick_number(request_number), UNIQUE KEY uq_dispatch_pick_idempotency(idempotency_key),
  KEY idx_dispatch_pick_queue(status,warehouse_id,requested_at),
  CONSTRAINT fk_dispatch_pick_order FOREIGN KEY(dispatch_order_id) REFERENCES dispatch_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_pick_warehouse FOREIGN KEY(warehouse_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_pick_requester FOREIGN KEY(requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_pick_confirmer FOREIGN KEY(confirmed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_pick_status CHECK(status IN ('REQUESTED','ALLOCATED','PICKING','PICKED','STAGED','CANCELLED','EXCEPTION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_picking_request_lines (
  id BIGINT NOT NULL AUTO_INCREMENT, dispatch_picking_request_id BIGINT NOT NULL, dispatch_order_allocation_id BIGINT NOT NULL,
  warehouse_reservation_allocation_id BIGINT NOT NULL, stock_unit_id BIGINT NOT NULL, requested_quantity DECIMAL(15,3) NOT NULL,
  picked_quantity DECIMAL(15,3) NULL, uom VARCHAR(24) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'ALLOCATED',
  lineage_snapshot_json JSON NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY(id),
  UNIQUE KEY uq_dispatch_pick_reservation_allocation(dispatch_picking_request_id,warehouse_reservation_allocation_id),
  CONSTRAINT fk_dispatch_pick_line_request FOREIGN KEY(dispatch_picking_request_id) REFERENCES dispatch_picking_requests(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_pick_line_allocation FOREIGN KEY(dispatch_order_allocation_id) REFERENCES dispatch_order_allocations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_pick_line_reservation FOREIGN KEY(warehouse_reservation_allocation_id) REFERENCES warehouse_inventory_reservation_allocations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_pick_line_stock FOREIGN KEY(stock_unit_id) REFERENCES warehouse_stock_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_pick_line_status CHECK(status IN ('ALLOCATED','PICKED','STAGED','CANCELLED','EXCEPTION')),
  CONSTRAINT chk_dispatch_pick_line_qty CHECK(requested_quantity>0 AND (picked_quantity IS NULL OR (picked_quantity>=0 AND picked_quantity<=requested_quantity)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_packages (
  id BIGINT NOT NULL AUTO_INCREMENT, package_number VARCHAR(80) NOT NULL, dispatch_order_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN', package_type VARCHAR(40) NULL, weight_kg DECIMAL(15,3) NULL,
  dimensions_snapshot_json JSON NOT NULL, seals_snapshot_json JSON NOT NULL, row_version INT UNSIGNED NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(128) NOT NULL, created_by_user_id INT NULL, packed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id), UNIQUE KEY uq_dispatch_package_number(package_number), UNIQUE KEY uq_dispatch_package_idempotency(idempotency_key),
  KEY idx_dispatch_package_order(dispatch_order_id,status),
  CONSTRAINT fk_dispatch_package_order FOREIGN KEY(dispatch_order_id) REFERENCES dispatch_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_package_actor FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_package_status CHECK(status IN ('OPEN','PACKED','ASSIGNED','DISPATCHED','DELIVERED','CANCELLED')),
  CONSTRAINT chk_dispatch_package_weight CHECK(weight_kg IS NULL OR weight_kg>=0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_package_contents (
  id BIGINT NOT NULL AUTO_INCREMENT, dispatch_package_id BIGINT NOT NULL, dispatch_order_allocation_id BIGINT NOT NULL,
  dispatch_picking_request_line_id BIGINT NOT NULL, warehouse_reservation_allocation_id BIGINT NOT NULL,
  stock_unit_id BIGINT NOT NULL, quantity DECIMAL(15,3) NOT NULL, uom VARCHAR(24) NOT NULL,
  lineage_snapshot_json JSON NOT NULL, lineage_hash CHAR(64) NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id), UNIQUE KEY uq_dispatch_package_pick_line(dispatch_package_id,dispatch_picking_request_line_id),
  KEY idx_dispatch_content_allocation(dispatch_order_allocation_id), KEY idx_dispatch_content_stock(stock_unit_id),
  CONSTRAINT fk_dispatch_content_package FOREIGN KEY(dispatch_package_id) REFERENCES dispatch_packages(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_content_allocation FOREIGN KEY(dispatch_order_allocation_id) REFERENCES dispatch_order_allocations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_content_pick_line FOREIGN KEY(dispatch_picking_request_line_id) REFERENCES dispatch_picking_request_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_content_reservation FOREIGN KEY(warehouse_reservation_allocation_id) REFERENCES warehouse_inventory_reservation_allocations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_content_stock FOREIGN KEY(stock_unit_id) REFERENCES warehouse_stock_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_content_qty CHECK(quantity>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_shipments (
  id BIGINT NOT NULL AUTO_INCREMENT, shipment_number VARCHAR(80) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  destination_snapshot_json JSON NOT NULL, contact_snapshot_json JSON NOT NULL, company_legal_snapshot_json JSON NOT NULL,
  carrier_snapshot_json JSON NOT NULL, tracking_snapshot_json JSON NOT NULL, terms_snapshot_json JSON NOT NULL,
  destination_hash CHAR(64) NOT NULL, current_revision_number INT NOT NULL DEFAULT 1, row_version INT UNSIGNED NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(128) NOT NULL, warehouse_issue_hash CHAR(64) NULL, dispatched_at DATETIME(6) NULL,
  created_by_user_id INT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id), UNIQUE KEY uq_dispatch_shipment_number(shipment_number), UNIQUE KEY uq_dispatch_shipment_idempotency(idempotency_key),
  KEY idx_dispatch_shipment_queue(status,updated_at),
  CONSTRAINT fk_dispatch_shipment_actor FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_shipment_status CHECK(status IN ('DRAFT','READY','DISPATCHED','IN_TRANSIT','PARTIALLY_DELIVERED','DELIVERED','CANCELLED','EXCEPTION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_shipment_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT, dispatch_shipment_id BIGINT NOT NULL, revision_number INT NOT NULL,
  snapshot_json JSON NOT NULL, content_hash CHAR(64) NOT NULL, reason TEXT NULL, created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY(id),
  UNIQUE KEY uq_dispatch_shipment_revision(dispatch_shipment_id,revision_number),
  CONSTRAINT fk_dispatch_shipment_revision_header FOREIGN KEY(dispatch_shipment_id) REFERENCES dispatch_shipments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_shipment_revision_actor FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_shipment_packages (
  dispatch_shipment_id BIGINT NOT NULL, dispatch_package_id BIGINT NOT NULL, assigned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(dispatch_shipment_id,dispatch_package_id), UNIQUE KEY uq_dispatch_package_active_shipment(dispatch_package_id),
  CONSTRAINT fk_dispatch_shipment_package_shipment FOREIGN KEY(dispatch_shipment_id) REFERENCES dispatch_shipments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_shipment_package_package FOREIGN KEY(dispatch_package_id) REFERENCES dispatch_packages(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_delivery_confirmations (
  id BIGINT NOT NULL AUTO_INCREMENT, confirmation_number VARCHAR(80) NOT NULL, dispatch_shipment_id BIGINT NOT NULL,
  delivered_at DATETIME(6) NOT NULL, received_by VARCHAR(255) NOT NULL, evidence_reference VARCHAR(1000) NOT NULL,
  evidence_snapshot_json JSON NOT NULL, evidence_hash CHAR(64) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
  idempotency_key VARCHAR(128) NOT NULL, confirmed_by_user_id INT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id), UNIQUE KEY uq_dispatch_delivery_number(confirmation_number), UNIQUE KEY uq_dispatch_delivery_idempotency(idempotency_key),
  KEY idx_dispatch_delivery_shipment(dispatch_shipment_id,delivered_at),
  CONSTRAINT fk_dispatch_delivery_shipment FOREIGN KEY(dispatch_shipment_id) REFERENCES dispatch_shipments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_delivery_actor FOREIGN KEY(confirmed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_delivery_status CHECK(status IN ('CONFIRMED','CORRECTED','REVERSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_delivery_confirmation_lines (
  id BIGINT NOT NULL AUTO_INCREMENT, dispatch_delivery_confirmation_id BIGINT NOT NULL,
  dispatch_order_allocation_id BIGINT NOT NULL, delivered_quantity DECIMAL(15,3) NOT NULL, uom VARCHAR(24) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY(id),
  UNIQUE KEY uq_dispatch_delivery_allocation(dispatch_delivery_confirmation_id,dispatch_order_allocation_id),
  CONSTRAINT fk_dispatch_delivery_line_header FOREIGN KEY(dispatch_delivery_confirmation_id) REFERENCES dispatch_delivery_confirmations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_delivery_line_allocation FOREIGN KEY(dispatch_order_allocation_id) REFERENCES dispatch_order_allocations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_delivery_line_qty CHECK(delivered_quantity>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_exceptions (
  id BIGINT NOT NULL AUTO_INCREMENT, entity_type VARCHAR(48) NOT NULL, entity_id BIGINT NOT NULL,
  exception_type VARCHAR(64) NOT NULL, severity VARCHAR(16) NOT NULL DEFAULT 'MEDIUM', status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  details_json JSON NOT NULL, evidence_reference VARCHAR(1000) NULL, opened_by_user_id INT NULL, resolved_by_user_id INT NULL,
  opened_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), resolved_at DATETIME(6) NULL, PRIMARY KEY(id),
  KEY idx_dispatch_exception_queue(status,severity,opened_at),
  CONSTRAINT fk_dispatch_exception_opener FOREIGN KEY(opened_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_exception_resolver FOREIGN KEY(resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_exception_severity CHECK(severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_dispatch_exception_status CHECK(status IN ('OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_events (
  id BIGINT NOT NULL AUTO_INCREMENT, event_type VARCHAR(80) NOT NULL, aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id BIGINT NULL, source_domain VARCHAR(40) NULL, source_entity_type VARCHAR(64) NULL, source_entity_id BIGINT NULL,
  actor_user_id INT NULL, payload_json JSON NOT NULL, event_hash CHAR(64) NOT NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY(id),
  KEY idx_dispatch_event_aggregate(aggregate_type,aggregate_id,occurred_at), KEY idx_dispatch_event_type(event_type,occurred_at),
  CONSTRAINT fk_dispatch_event_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles(name,slug,description,is_system,is_super_admin) VALUES('Логист','logist','Dispatch planning, shipment and delivery evidence',1,0)
ON DUPLICATE KEY UPDATE description=VALUES(description),is_system=1,is_super_admin=0;

INSERT INTO capabilities(capability_key,name,description,section,sort_order,is_active,is_legacy) VALUES
 ('dispatch_delivery.access','Просмотр Dispatch & Delivery','Ready, dispatch, shipment and delivery read models','dispatch_delivery',1720,1,0),
 ('dispatch_delivery.orders.manage','Dispatch Orders','Создание и планирование Dispatch Orders из Contract Commitments','dispatch_delivery',1730,1,0),
 ('dispatch_delivery.picking.manage','Picking','Запрос и подтверждение Warehouse picking evidence','dispatch_delivery',1740,1,0),
 ('dispatch_delivery.packages.manage','Packages','Package composition with Stock Unit lineage','dispatch_delivery',1750,1,0),
 ('dispatch_delivery.shipments.manage','Shipments','Shipment planning, immutable revisions and consolidation','dispatch_delivery',1760,1,0),
 ('dispatch_delivery.shipments.dispatch','Shipment dispatch','Exactly-once Warehouse issue at ShipmentDispatched','dispatch_delivery',1770,1,0),
 ('dispatch_delivery.delivery.confirm','Delivery Confirmation','POD and confirmed delivered quantity','dispatch_delivery',1780,1,0),
 ('dispatch_delivery.exceptions.manage','Dispatch exceptions','Auditable exception management','dispatch_delivery',1790,1,0),
 ('dispatch_delivery.history.view','Dispatch history','Append-only dispatch and delivery history','dispatch_delivery',1800,1,0)
ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),section=VALUES(section),sort_order=VALUES(sort_order),is_active=1,is_legacy=0;

INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.section='dispatch_delivery'
WHERE r.slug IN ('admin','nachalnik-otdela-zakupok','logist') ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN ('dispatch_delivery.access','dispatch_delivery.picking.manage','dispatch_delivery.packages.manage','dispatch_delivery.history.view')
WHERE r.slug='kladovshchik' ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN ('dispatch_delivery.access','dispatch_delivery.history.view')
WHERE r.slug IN ('prodavec','zakupshchik','specialist-po-katalogam','nablyudatel','finansist') ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
