CREATE TABLE after_sales_cases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  case_number VARCHAR(80) NOT NULL,
  client_id INT NOT NULL,
  contract_case_id BIGINT NOT NULL,
  completion_case_id BIGINT NULL,
  completion_snapshot_id BIGINT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  problem_classification VARCHAR(64) NOT NULL,
  problem_summary VARCHAR(500) NOT NULL,
  description TEXT NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  client_reference VARCHAR(255) NULL,
  assigned_to_user_id INT NULL,
  current_resolution_id BIGINT NULL,
  source_snapshot_json JSON NOT NULL,
  source_hash CHAR(64) NOT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(128) NOT NULL,
  opened_by_user_id INT NULL,
  opened_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  closed_by_user_id INT NULL,
  closed_at DATETIME(6) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_case_number (case_number),
  UNIQUE KEY uq_after_sales_case_idempotency (idempotency_key),
  KEY idx_after_sales_active (status,severity,updated_at),
  KEY idx_after_sales_client (client_id,opened_at),
  KEY idx_after_sales_contract (contract_case_id,opened_at),
  CONSTRAINT fk_after_sales_case_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_case_contract FOREIGN KEY (contract_case_id) REFERENCES contract_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_case_completion FOREIGN KEY (completion_case_id) REFERENCES completion_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_case_completion_snapshot FOREIGN KEY (completion_snapshot_id) REFERENCES completion_snapshots(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_case_assignee FOREIGN KEY (assigned_to_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_case_opener FOREIGN KEY (opened_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_case_closer FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_after_sales_case_status CHECK (status IN ('DRAFT','OPEN','UNDER_REVIEW','AWAITING_INFORMATION','INVESTIGATION','RESOLUTION_PROPOSED','RESOLVED','CLOSED','REJECTED','CANCELLED')),
  CONSTRAINT chk_after_sales_case_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE after_sales_case_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  after_sales_case_id BIGINT NOT NULL,
  contract_commitment_id BIGINT NOT NULL,
  contract_line_id BIGINT NOT NULL,
  dispatch_delivery_confirmation_line_id BIGINT NOT NULL,
  dispatch_order_allocation_id BIGINT NOT NULL,
  dispatch_shipment_id BIGINT NOT NULL,
  dispatch_package_content_id BIGINT NULL,
  stock_unit_id BIGINT NULL,
  warehouse_receipt_line_id BIGINT NULL,
  procurement_purchase_order_line_id BIGINT NULL,
  supplier_part_id INT NULL,
  supplier_id INT NULL,
  client_equipment_unit_id INT NULL,
  catalog_position_id INT NULL,
  affected_quantity DECIMAL(15,3) NOT NULL,
  uom VARCHAR(24) NOT NULL,
  serial_or_lot_reference VARCHAR(255) NULL,
  source_snapshot_json JSON NOT NULL,
  trace_gaps_json JSON NOT NULL,
  trace_hash CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_case_delivery_line (after_sales_case_id,dispatch_delivery_confirmation_line_id,dispatch_package_content_id),
  KEY idx_after_sales_line_contract (contract_line_id),
  KEY idx_after_sales_line_supplier (supplier_id,supplier_part_id),
  KEY idx_after_sales_line_stock (stock_unit_id),
  CONSTRAINT fk_after_sales_line_case FOREIGN KEY (after_sales_case_id) REFERENCES after_sales_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_commitment FOREIGN KEY (contract_commitment_id) REFERENCES contract_commitments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_contract_line FOREIGN KEY (contract_line_id) REFERENCES contract_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_delivery FOREIGN KEY (dispatch_delivery_confirmation_line_id) REFERENCES dispatch_delivery_confirmation_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_allocation FOREIGN KEY (dispatch_order_allocation_id) REFERENCES dispatch_order_allocations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_shipment FOREIGN KEY (dispatch_shipment_id) REFERENCES dispatch_shipments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_package_content FOREIGN KEY (dispatch_package_content_id) REFERENCES dispatch_package_contents(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_stock FOREIGN KEY (stock_unit_id) REFERENCES warehouse_stock_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_receipt FOREIGN KEY (warehouse_receipt_line_id) REFERENCES warehouse_receipt_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_po FOREIGN KEY (procurement_purchase_order_line_id) REFERENCES procurement_purchase_order_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_installation FOREIGN KEY (client_equipment_unit_id) REFERENCES client_equipment_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_line_catalog FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_after_sales_line_quantity CHECK (affected_quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE after_sales_evidence (
  id BIGINT NOT NULL AUTO_INCREMENT,
  after_sales_case_id BIGINT NOT NULL,
  evidence_type VARCHAR(32) NOT NULL,
  evidence_reference VARCHAR(1000) NOT NULL,
  description TEXT NOT NULL,
  evidence_snapshot_json JSON NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  added_by_user_id INT NULL,
  added_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_evidence_idempotency (idempotency_key),
  KEY idx_after_sales_evidence_case (after_sales_case_id,added_at,id),
  CONSTRAINT fk_after_sales_evidence_case FOREIGN KEY (after_sales_case_id) REFERENCES after_sales_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_evidence_actor FOREIGN KEY (added_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_after_sales_evidence_type CHECK (evidence_type IN ('PHOTO','DOCUMENT','CORRESPONDENCE','INSPECTION','DELIVERY','OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE after_sales_investigation_entries (
  id BIGINT NOT NULL AUTO_INCREMENT,
  after_sales_case_id BIGINT NOT NULL,
  entry_type VARCHAR(32) NOT NULL,
  summary VARCHAR(500) NOT NULL,
  details_json JSON NOT NULL,
  evidence_references_json JSON NOT NULL,
  entry_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  recorded_by_user_id INT NULL,
  recorded_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_investigation_idempotency (idempotency_key),
  KEY idx_after_sales_investigation_case (after_sales_case_id,recorded_at,id),
  CONSTRAINT fk_after_sales_investigation_case FOREIGN KEY (after_sales_case_id) REFERENCES after_sales_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_investigation_actor FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_after_sales_investigation_type CHECK (entry_type IN ('NOTE','FINDING','INFORMATION_REQUEST','INFORMATION_RECEIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE after_sales_resolutions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  after_sales_case_id BIGINT NOT NULL,
  revision_number INT UNSIGNED NOT NULL,
  classification VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
  proposal TEXT NOT NULL,
  result TEXT NULL,
  execution_boundary VARCHAR(255) NOT NULL,
  evidence_reference VARCHAR(1000) NOT NULL,
  resolution_snapshot_json JSON NOT NULL,
  resolution_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  proposed_by_user_id INT NULL,
  proposed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_by_user_id INT NULL,
  completed_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_resolution_revision (after_sales_case_id,revision_number),
  UNIQUE KEY uq_after_sales_resolution_idempotency (idempotency_key),
  CONSTRAINT fk_after_sales_resolution_case FOREIGN KEY (after_sales_case_id) REFERENCES after_sales_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_resolution_proposer FOREIGN KEY (proposed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_resolution_completer FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_after_sales_resolution_class CHECK (classification IN ('REPLACEMENT','REPAIR_REWORK','CREDIT_REFUND','ADDITIONAL_SUPPLY','TECHNICAL_EXPLANATION','SUPPLIER_ESCALATION','NO_DEFECT_CONFIRMED','COMMERCIAL_SETTLEMENT')),
  CONSTRAINT chk_after_sales_resolution_status CHECK (status IN ('PROPOSED','COMPLETED','REJECTED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE after_sales_cases ADD CONSTRAINT fk_after_sales_case_resolution
  FOREIGN KEY (current_resolution_id) REFERENCES after_sales_resolutions(id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE after_sales_supplier_escalations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  after_sales_case_id BIGINT NOT NULL,
  after_sales_case_line_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  procurement_purchase_order_line_id BIGINT NOT NULL,
  warehouse_receipt_line_id BIGINT NOT NULL,
  supplier_part_id INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  external_reference VARCHAR(500) NULL,
  evidence_reference VARCHAR(1000) NOT NULL,
  source_snapshot_json JSON NOT NULL,
  source_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  opened_by_user_id INT NULL,
  opened_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_supplier_escalation_idempotency (idempotency_key),
  KEY idx_after_sales_supplier_quality (supplier_id,status,opened_at),
  CONSTRAINT fk_after_sales_escalation_case FOREIGN KEY (after_sales_case_id) REFERENCES after_sales_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_escalation_line FOREIGN KEY (after_sales_case_line_id) REFERENCES after_sales_case_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_escalation_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_escalation_po FOREIGN KEY (procurement_purchase_order_line_id) REFERENCES procurement_purchase_order_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_escalation_receipt FOREIGN KEY (warehouse_receipt_line_id) REFERENCES warehouse_receipt_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_escalation_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_escalation_actor FOREIGN KEY (opened_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_after_sales_escalation_status CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE after_sales_downstream_handoffs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  after_sales_case_id BIGINT NOT NULL,
  resolution_id BIGINT NOT NULL,
  target_domain VARCHAR(40) NOT NULL,
  action_type VARCHAR(32) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
  request_reference VARCHAR(160) NOT NULL,
  external_entity_type VARCHAR(64) NULL,
  external_entity_id BIGINT NULL,
  payload_snapshot_json JSON NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  evidence_reference VARCHAR(1000) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  requested_by_user_id INT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_handoff_reference (request_reference),
  UNIQUE KEY uq_after_sales_handoff_idempotency (idempotency_key),
  KEY idx_after_sales_handoff_status (target_domain,status,requested_at),
  CONSTRAINT fk_after_sales_handoff_case FOREIGN KEY (after_sales_case_id) REFERENCES after_sales_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_handoff_resolution FOREIGN KEY (resolution_id) REFERENCES after_sales_resolutions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_handoff_actor FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_after_sales_handoff_domain CHECK (target_domain IN ('SOURCING','PROCUREMENT_EXECUTION','WAREHOUSE_INVENTORY','DISPATCH_DELIVERY','FINANCIAL_OPERATIONS')),
  CONSTRAINT chk_after_sales_handoff_action CHECK (action_type IN ('REPLACEMENT','REPAIR_REWORK','CREDIT_REFUND','ADDITIONAL_SUPPLY','SUPPLIER_ESCALATION','COMMERCIAL_SETTLEMENT')),
  CONSTRAINT chk_after_sales_handoff_status CHECK (status IN ('REQUESTED','ACKNOWLEDGED','LINKED','COMPLETED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE after_sales_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  after_sales_case_id BIGINT NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  reason_code VARCHAR(80) NULL,
  explanation TEXT NULL,
  evidence_reference VARCHAR(1000) NULL,
  actor_user_id INT NULL,
  payload_json JSON NOT NULL,
  event_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_after_sales_event_idempotency (idempotency_key),
  KEY idx_after_sales_event_case (after_sales_case_id,occurred_at,id),
  CONSTRAINT fk_after_sales_event_case FOREIGN KEY (after_sales_case_id) REFERENCES after_sales_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_after_sales_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles(name,slug,description,is_system,is_super_admin) VALUES
 ('Специалист по рекламациям','specialist-po-reklamatsiyam','After Sales claim investigation, traceability and resolution',1,0)
ON DUPLICATE KEY UPDATE description=VALUES(description),is_system=1,is_super_admin=0;

INSERT INTO capabilities(capability_key,name,description,section,sort_order,is_active,is_legacy) VALUES
 ('after_sales.access','Просмотр After Sales','Open, active, closed claims and traceability','after_sales',1880,1,0),
 ('after_sales.manage','Управление claims','Create claims and manage owned lifecycle','after_sales',1890,1,0),
 ('after_sales.investigate','Evidence и investigation','Append-only evidence, notes and findings','after_sales',1900,1,0),
 ('after_sales.resolve','Resolution и handoff','Propose resolution and explicit external-domain handoff','after_sales',1910,1,0),
 ('after_sales.close','Закрытие и reopen claim','Audited close and exceptional reopen without upstream mutation','after_sales',1920,1,0),
 ('after_sales.history.view','История After Sales','Append-only claim history and historical search','after_sales',1930,1,0)
ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),section=VALUES(section),sort_order=VALUES(sort_order),is_active=1,is_legacy=0;

INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.section='after_sales'
WHERE r.slug IN ('admin','nachalnik-otdela-zakupok','specialist-po-reklamatsiyam')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN ('after_sales.access','after_sales.manage','after_sales.history.view')
WHERE r.slug='prodavec' ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN ('after_sales.access','after_sales.history.view')
WHERE r.slug IN ('zakupshchik','specialist-po-katalogam','finansist','kladovshchik','logist','nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
