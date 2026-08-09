CREATE TABLE procurement_execution_cases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  case_number VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'READINESS_REVIEW',
  owner_user_id INT NULL,
  request_key VARCHAR(128) NOT NULL,
  created_by_user_id INT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_case_number (case_number),
  UNIQUE KEY uq_procurement_case_request (request_key),
  KEY idx_procurement_case_queue (status, owner_user_id, updated_at),
  CONSTRAINT fk_procurement_case_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_case_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_case_status CHECK (status IN ('READINESS_REVIEW','READY_FOR_PO','PO_DRAFTING','AWAITING_CONFIRMATION','CHANGE_REQUIRED','BLOCKED','CLOSED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_execution_items (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_execution_case_id BIGINT NOT NULL,
  contract_commitment_id BIGINT NOT NULL,
  effective_contract_revision_id BIGINT NOT NULL,
  sourcing_decision_id BIGINT NOT NULL,
  sourcing_decision_line_id BIGINT NOT NULL,
  supplier_offer_line_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  supplier_part_id INT NULL,
  supplier_snapshot_json JSON NOT NULL,
  supplier_part_snapshot_json JSON NOT NULL,
  contract_trace_snapshot_json JSON NOT NULL,
  sourcing_trace_snapshot_json JSON NOT NULL,
  allocated_quantity DECIMAL(15,3) NOT NULL,
  purchase_quantity DECIMAL(15,3) NOT NULL,
  excess_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  uom VARCHAR(24) NOT NULL,
  purchase_unit_price DECIMAL(18,6) NOT NULL,
  purchase_currency CHAR(3) NOT NULL,
  moq DECIMAL(15,3) NULL,
  pack_quantity DECIMAL(15,3) NULL,
  payment_terms VARCHAR(255) NULL,
  incoterms VARCHAR(16) NULL,
  incoterms_place VARCHAR(255) NULL,
  validity_until DATE NULL,
  readiness_status VARCHAR(40) NOT NULL DEFAULT 'RECONFIRMATION_REQUIRED',
  readiness_reasons_json JSON NOT NULL,
  source_hash CHAR(64) NOT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_item_commitment (contract_commitment_id),
  KEY idx_procurement_item_queue (procurement_execution_case_id, readiness_status),
  KEY idx_procurement_item_supplier (supplier_id, readiness_status),
  CONSTRAINT fk_procurement_item_case FOREIGN KEY (procurement_execution_case_id) REFERENCES procurement_execution_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_item_commitment FOREIGN KEY (contract_commitment_id) REFERENCES contract_commitments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_item_contract_revision FOREIGN KEY (effective_contract_revision_id) REFERENCES contract_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_item_sourcing_decision FOREIGN KEY (sourcing_decision_id) REFERENCES sourcing_decisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_item_sourcing_line FOREIGN KEY (sourcing_decision_line_id) REFERENCES sourcing_decision_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_item_offer_line FOREIGN KEY (supplier_offer_line_id) REFERENCES supplier_offer_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_item_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_item_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_item_readiness CHECK (readiness_status IN ('READY','RECONFIRMATION_REQUIRED','SOURCING_UPDATE_REQUIRED','PRICING_RECHECK_REQUIRED','BLOCKED')),
  CONSTRAINT chk_procurement_item_quantities CHECK (allocated_quantity > 0 AND purchase_quantity >= allocated_quantity AND excess_quantity = purchase_quantity - allocated_quantity AND purchase_unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_uom_resolutions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_execution_item_id BIGINT NOT NULL,
  original_uom VARCHAR(24) NOT NULL,
  resolved_uom VARCHAR(24) NOT NULL,
  authority_type VARCHAR(40) NOT NULL,
  authority_entity_id BIGINT NOT NULL,
  evidence_snapshot_json JSON NOT NULL,
  resolved_by_user_id INT NULL,
  resolved_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_uom_item (procurement_execution_item_id),
  CONSTRAINT fk_procurement_uom_item FOREIGN KEY (procurement_execution_item_id) REFERENCES procurement_execution_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_uom_actor FOREIGN KEY (resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_uom_authority CHECK (authority_type IN ('SOURCING_COVERAGE_SNAPSHOT','CONTRACT_COMMITMENT'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_supplier_reconfirmations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_execution_item_id BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL,
  confirmed_snapshot_json JSON NOT NULL,
  comparison_snapshot_json JSON NOT NULL,
  evidence_reference VARCHAR(1000) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  confirmed_by_user_id INT NULL,
  confirmed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_procurement_reconfirmation_item (procurement_execution_item_id, confirmed_at),
  CONSTRAINT fk_procurement_reconfirmation_item FOREIGN KEY (procurement_execution_item_id) REFERENCES procurement_execution_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_reconfirmation_actor FOREIGN KEY (confirmed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_reconfirmation_status CHECK (status IN ('MATCHED','NON_MATERIAL_DIFFERENCE','SOURCING_UPDATE_REQUIRED','PRICING_RECHECK_REQUIRED','SUPPLY_FAILURE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_change_requests (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_execution_case_id BIGINT NOT NULL,
  procurement_execution_item_id BIGINT NULL,
  target_domain VARCHAR(24) NOT NULL,
  reason_code VARCHAR(80) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  before_snapshot_json JSON NOT NULL,
  requested_change_json JSON NOT NULL,
  evidence_snapshot_json JSON NOT NULL,
  requested_by_user_id INT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  resolved_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  KEY idx_procurement_change_queue (target_domain, status, requested_at),
  CONSTRAINT fk_procurement_change_case FOREIGN KEY (procurement_execution_case_id) REFERENCES procurement_execution_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_change_item FOREIGN KEY (procurement_execution_item_id) REFERENCES procurement_execution_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_change_actor FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_change_domain CHECK (target_domain IN ('SOURCING','PRICING','CONTRACT')),
  CONSTRAINT chk_procurement_change_status CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_po_candidates (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_execution_case_id BIGINT NOT NULL,
  candidate_code VARCHAR(80) NOT NULL,
  supplier_id INT NOT NULL,
  grouping_key CHAR(64) NOT NULL,
  grouping_snapshot_json JSON NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'READY',
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_candidate_code (candidate_code),
  UNIQUE KEY uq_procurement_candidate_group (procurement_execution_case_id, grouping_key),
  CONSTRAINT fk_procurement_candidate_case FOREIGN KEY (procurement_execution_case_id) REFERENCES procurement_execution_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_candidate_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_candidate_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_candidate_status CHECK (status IN ('READY','CONVERTED','SUPERSEDED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_po_candidate_items (
  procurement_po_candidate_id BIGINT NOT NULL,
  procurement_execution_item_id BIGINT NOT NULL,
  source_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (procurement_po_candidate_id, procurement_execution_item_id),
  UNIQUE KEY uq_procurement_candidate_item (procurement_execution_item_id),
  CONSTRAINT fk_procurement_candidate_item_candidate FOREIGN KEY (procurement_po_candidate_id) REFERENCES procurement_po_candidates(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_candidate_item_source FOREIGN KEY (procurement_execution_item_id) REFERENCES procurement_execution_items(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_purchase_orders (
  id BIGINT NOT NULL AUTO_INCREMENT,
  po_number VARCHAR(80) NOT NULL,
  procurement_execution_case_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  current_revision_id BIGINT NULL,
  created_by_user_id INT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_po_number (po_number),
  KEY idx_procurement_po_queue (status, supplier_id, updated_at),
  CONSTRAINT fk_procurement_po_case FOREIGN KEY (procurement_execution_case_id) REFERENCES procurement_execution_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_po_status CHECK (status IN ('DRAFT','ISSUED','SENT','AWAITING_CONFIRMATION','CONFIRMED','CHANGE_REQUIRED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_purchase_order_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_purchase_order_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  supplier_snapshot_json JSON NOT NULL,
  buyer_snapshot_json JSON NOT NULL,
  delivery_snapshot_json JSON NOT NULL,
  payment_snapshot_json JSON NOT NULL,
  legal_basis_type VARCHAR(40) NOT NULL,
  legal_basis_status VARCHAR(32) NOT NULL DEFAULT 'APPROVAL_REQUIRED',
  legal_basis_snapshot_json JSON NOT NULL,
  presentation_snapshot_json JSON NOT NULL,
  source_trace_snapshot_json JSON NOT NULL,
  content_hash CHAR(64) NULL,
  supersedes_revision_id BIGINT NULL,
  created_by_user_id INT NULL,
  issued_by_user_id INT NULL,
  issued_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_po_revision (procurement_purchase_order_id, revision_number),
  CONSTRAINT fk_procurement_po_revision_order FOREIGN KEY (procurement_purchase_order_id) REFERENCES procurement_purchase_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_revision_supersedes FOREIGN KEY (supersedes_revision_id) REFERENCES procurement_purchase_order_revisions(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_revision_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_revision_issuer FOREIGN KEY (issued_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_po_revision_status CHECK (status IN ('DRAFT','ISSUED','SENT','SUPERSEDED')),
  CONSTRAINT chk_procurement_po_legal_basis CHECK (legal_basis_type IN ('SUPPLIER_AGREEMENT','PURCHASE_ORDER_AS_CONTRACT')),
  CONSTRAINT chk_procurement_po_legal_status CHECK (legal_basis_status IN ('READY','AGREEMENT_REQUIRED','AGREEMENT_EXPIRED','SCOPE_MISMATCH','APPROVAL_REQUIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE procurement_purchase_orders ADD CONSTRAINT fk_procurement_po_current_revision FOREIGN KEY (current_revision_id) REFERENCES procurement_purchase_order_revisions(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE procurement_purchase_order_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_purchase_order_revision_id BIGINT NOT NULL,
  procurement_execution_item_id BIGINT NOT NULL,
  line_number INT NOT NULL,
  supplier_part_snapshot_json JSON NOT NULL,
  quantity DECIMAL(15,3) NOT NULL,
  allocated_quantity DECIMAL(15,3) NOT NULL,
  excess_quantity DECIMAL(15,3) NOT NULL,
  uom VARCHAR(24) NOT NULL,
  unit_price DECIMAL(18,6) NOT NULL,
  currency CHAR(3) NOT NULL,
  source_trace_snapshot_json JSON NOT NULL,
  line_hash CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_po_revision_line (procurement_purchase_order_revision_id, line_number),
  UNIQUE KEY uq_procurement_po_revision_item (procurement_purchase_order_revision_id, procurement_execution_item_id),
  CONSTRAINT fk_procurement_po_line_revision FOREIGN KEY (procurement_purchase_order_revision_id) REFERENCES procurement_purchase_order_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_line_item FOREIGN KEY (procurement_execution_item_id) REFERENCES procurement_execution_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_po_line_qty CHECK (quantity > 0 AND allocated_quantity > 0 AND excess_quantity = quantity - allocated_quantity AND unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_purchase_order_documents (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_purchase_order_revision_id BIGINT NOT NULL,
  document_type VARCHAR(24) NOT NULL,
  format VARCHAR(16) NOT NULL,
  content_snapshot_json JSON NOT NULL,
  document_hash CHAR(64) NOT NULL,
  file_reference VARCHAR(1000) NULL,
  generated_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_procurement_po_document_revision (procurement_purchase_order_revision_id, created_at),
  CONSTRAINT fk_procurement_po_document_revision FOREIGN KEY (procurement_purchase_order_revision_id) REFERENCES procurement_purchase_order_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_document_actor FOREIGN KEY (generated_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_purchase_order_sends (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_purchase_order_revision_id BIGINT NOT NULL,
  procurement_purchase_order_document_id BIGINT NOT NULL,
  channel VARCHAR(24) NOT NULL,
  recipient_snapshot_json JSON NOT NULL,
  evidence_reference VARCHAR(1000) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  sent_by_user_id INT NULL,
  sent_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_po_send_revision (procurement_purchase_order_revision_id),
  CONSTRAINT fk_procurement_po_send_revision FOREIGN KEY (procurement_purchase_order_revision_id) REFERENCES procurement_purchase_order_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_send_document FOREIGN KEY (procurement_purchase_order_document_id) REFERENCES procurement_purchase_order_documents(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_po_send_actor FOREIGN KEY (sent_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_supplier_confirmations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_purchase_order_revision_id BIGINT NOT NULL,
  confirmation_reference VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
  evidence_reference VARCHAR(1000) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  received_by_user_id INT NULL,
  received_at DATETIME(6) NOT NULL,
  accepted_by_user_id INT NULL,
  accepted_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_confirmation_ref (procurement_purchase_order_revision_id, confirmation_reference),
  CONSTRAINT fk_procurement_confirmation_revision FOREIGN KEY (procurement_purchase_order_revision_id) REFERENCES procurement_purchase_order_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_confirmation_receiver FOREIGN KEY (received_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_confirmation_acceptor FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_confirmation_status CHECK (status IN ('RECEIVED','MATCHED','DISCREPANCY','ACCEPTED','REJECTED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_supplier_confirmation_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_supplier_confirmation_id BIGINT NOT NULL,
  procurement_purchase_order_line_id BIGINT NOT NULL,
  confirmed_snapshot_json JSON NOT NULL,
  comparison_snapshot_json JSON NOT NULL,
  discrepancy_class VARCHAR(24) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_confirmation_line (procurement_supplier_confirmation_id, procurement_purchase_order_line_id),
  CONSTRAINT fk_procurement_confirmation_line_confirmation FOREIGN KEY (procurement_supplier_confirmation_id) REFERENCES procurement_supplier_confirmations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_confirmation_line_po FOREIGN KEY (procurement_purchase_order_line_id) REFERENCES procurement_purchase_order_lines(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_discrepancy_class CHECK (discrepancy_class IN ('NONE','NON_MATERIAL','COMMERCIAL','QUANTITY','TECHNICAL','SUPPLY_FAILURE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_execution_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  procurement_execution_case_id BIGINT NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id BIGINT NULL,
  actor_user_id INT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_procurement_event_case (procurement_execution_case_id, created_at, id),
  CONSTRAINT fk_procurement_event_case FOREIGN KEY (procurement_execution_case_id) REFERENCES procurement_execution_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO capabilities (capability_key,name,description,section,sort_order,is_active,is_legacy) VALUES
 ('procurement_execution.access','Просмотр Procurement Execution','Очередь readiness, commitments, PO и confirmations','procurement_execution',1400,1,0),
 ('procurement_execution.manage','Управление Procurement Execution','Приём effective Contract Commitments и readiness','procurement_execution',1410,1,0),
 ('procurement_execution.reconfirm','Reconfirmation поставщика','Фиксация неизменяемого supplier reconfirmation evidence','procurement_execution',1420,1,0),
 ('procurement_execution.change_requests','Upstream change request','Явный возврат в Sourcing, Pricing или Contract без cross-domain write','procurement_execution',1430,1,0),
 ('procurement_purchase_orders.manage','Управление Supplier PO','PO candidates и draft revisions','procurement_execution',1440,1,0),
 ('procurement_purchase_orders.legal_basis','Проверка legal basis PO','Supplier Agreement либо PO-as-contract policy evidence','procurement_execution',1450,1,0),
 ('procurement_purchase_orders.issue','Выпуск Supplier PO','Immutable issue и send evidence','procurement_execution',1460,1,0),
 ('procurement_purchase_orders.confirmations','Supplier confirmations','Регистрация и сравнение подтверждений поставщика','procurement_execution',1470,1,0),
 ('procurement_purchase_orders.confirmations.accept','Принятие supplier confirmation','Фиксация SupplierConfirmationAccepted без finance objects','procurement_execution',1480,1,0)
ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),section=VALUES(section),sort_order=VALUES(sort_order),is_active=1,is_legacy=0;

INSERT INTO role_capabilities (role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.section='procurement_execution'
WHERE r.slug IN ('admin','nachalnik-otdela-zakupok')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities (role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN (
 'procurement_execution.access','procurement_execution.manage','procurement_execution.reconfirm','procurement_execution.change_requests',
 'procurement_purchase_orders.manage','procurement_purchase_orders.issue','procurement_purchase_orders.confirmations'
) WHERE r.slug='zakupshchik'
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities (role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key='procurement_execution.access'
WHERE r.slug IN ('prodavec','specialist-po-katalogam','nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
