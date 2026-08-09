CREATE TABLE sourcing_cases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  case_number VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  priority VARCHAR(24) NOT NULL DEFAULT 'normal',
  owner_user_id INT NULL,
  response_deadline DATETIME(6) NULL,
  legacy_rfq_id INT NULL,
  created_by_user_id INT NULL,
  accepted_by_user_id INT NULL,
  accepted_at DATETIME(6) NULL,
  decided_at DATETIME(6) NULL,
  archived_by_user_id INT NULL,
  archived_at DATETIME(6) NULL,
  archive_reason TEXT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sourcing_case_number (case_number),
  UNIQUE KEY uq_sourcing_case_legacy_rfq (legacy_rfq_id),
  KEY idx_sourcing_case_queue (status, owner_user_id, priority, response_deadline),
  CONSTRAINT fk_sourcing_case_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_case_legacy_rfq FOREIGN KEY (legacy_rfq_id) REFERENCES rfqs (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_case_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_case_accepted_by FOREIGN KEY (accepted_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_case_archived_by FOREIGN KEY (archived_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_sourcing_case_status CHECK (status IN (
    'new', 'in_progress', 'waiting_responses', 'offer_review', 'decision_pending',
    'decision_ready', 'decided', 'released_to_pricing', 'closed', 'blocked',
    'on_hold', 'archived', 'cancelled'
  )),
  CONSTRAINT chk_sourcing_case_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sourcing_case_release_links (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_case_id BIGINT NOT NULL,
  procurement_release_id INT NOT NULL,
  linked_by_user_id INT NULL,
  linked_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sourcing_case_release (sourcing_case_id, procurement_release_id),
  KEY idx_sourcing_release_case (procurement_release_id, sourcing_case_id),
  CONSTRAINT fk_sourcing_case_release_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_case_release_release FOREIGN KEY (procurement_release_id) REFERENCES procurement_releases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_case_release_actor FOREIGN KEY (linked_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sourcing_demands (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_case_id BIGINT NOT NULL,
  procurement_release_id INT NOT NULL,
  procurement_release_item_id INT NOT NULL,
  client_request_id INT NOT NULL,
  client_request_revision_id INT NOT NULL,
  client_request_revision_item_id INT NOT NULL,
  stable_item_key_snapshot CHAR(36) NOT NULL,
  line_number_snapshot INT NOT NULL,
  catalog_position_id_snapshot INT NULL,
  requested_quantity_snapshot DECIMAL(15,3) NOT NULL,
  admitted_quantity DECIMAL(15,3) NOT NULL,
  uom_snapshot VARCHAR(16) NOT NULL,
  substitution_policy_snapshot VARCHAR(40) NOT NULL,
  source_data_snapshot_json JSON NOT NULL,
  identification_snapshot_json JSON NOT NULL,
  requirements_snapshot_json JSON NOT NULL,
  document_refs_snapshot_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'received',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sourcing_demand_case_item (sourcing_case_id, procurement_release_item_id),
  KEY idx_sourcing_demand_release_item (procurement_release_item_id, status),
  KEY idx_sourcing_demand_case_status (sourcing_case_id, status, line_number_snapshot),
  KEY idx_sourcing_demand_catalog (catalog_position_id_snapshot),
  CONSTRAINT fk_sourcing_demand_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_demand_release FOREIGN KEY (procurement_release_id) REFERENCES procurement_releases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_demand_release_item FOREIGN KEY (procurement_release_item_id) REFERENCES procurement_release_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_demand_request FOREIGN KEY (client_request_id) REFERENCES client_requests (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_demand_revision FOREIGN KEY (client_request_revision_id) REFERENCES client_request_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_demand_revision_item FOREIGN KEY (client_request_revision_item_id) REFERENCES client_request_revision_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_demand_catalog FOREIGN KEY (catalog_position_id_snapshot) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_sourcing_demand_qty CHECK (requested_quantity_snapshot > 0 AND admitted_quantity > 0 AND admitted_quantity <= requested_quantity_snapshot),
  CONSTRAINT chk_sourcing_demand_status CHECK (status IN (
    'received', 'strategy_defined', 'sourcing_active', 'offers_available',
    'preliminary_covered', 'ready_for_decision', 'decided', 'cancelled'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sourcing_case_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_case_id BIGINT NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NULL,
  entity_id BIGINT NULL,
  actor_user_id INT NULL,
  payload_json JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_sourcing_case_event (sourcing_case_id, created_at, id),
  CONSTRAINT fk_sourcing_case_event_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_case_event_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_inquiries (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_case_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  language VARCHAR(8) NOT NULL DEFAULT 'en',
  response_due_at DATETIME(6) NULL,
  legacy_rfq_supplier_id INT NULL,
  created_by_user_id INT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_inquiry_legacy (legacy_rfq_supplier_id),
  KEY idx_supplier_inquiry_case (sourcing_case_id, status, supplier_id),
  KEY idx_supplier_inquiry_supplier (supplier_id, status),
  CONSTRAINT fk_supplier_inquiry_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_inquiry_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_inquiry_legacy FOREIGN KEY (legacy_rfq_supplier_id) REFERENCES rfq_suppliers (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_inquiry_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_supplier_inquiry_status CHECK (status IN ('draft', 'ready', 'sent', 'responded', 'closed', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_inquiry_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  supplier_inquiry_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  subject_snapshot VARCHAR(255) NULL,
  message_snapshot TEXT NULL,
  contact_snapshot_json JSON NULL,
  payload_hash CHAR(64) NULL,
  legacy_rfq_revision_id INT NULL,
  finalized_by_user_id INT NULL,
  finalized_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inquiry_revision_number (supplier_inquiry_id, revision_number),
  KEY idx_inquiry_revision_legacy (legacy_rfq_revision_id),
  CONSTRAINT fk_inquiry_revision_inquiry FOREIGN KEY (supplier_inquiry_id) REFERENCES supplier_inquiries (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_revision_legacy FOREIGN KEY (legacy_rfq_revision_id) REFERENCES rfq_revisions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_revision_finalized_by FOREIGN KEY (finalized_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_revision_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_inquiry_revision_status CHECK (status IN ('draft', 'finalized', 'superseded'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_inquiry_revision_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  supplier_inquiry_revision_id BIGINT NOT NULL,
  sourcing_demand_id BIGINT NOT NULL,
  requested_quantity_snapshot DECIMAL(15,3) NOT NULL,
  uom_snapshot VARCHAR(16) NOT NULL,
  request_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inquiry_revision_demand (supplier_inquiry_revision_id, sourcing_demand_id),
  KEY idx_inquiry_line_demand (sourcing_demand_id),
  CONSTRAINT fk_inquiry_line_revision FOREIGN KEY (supplier_inquiry_revision_id) REFERENCES supplier_inquiry_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_line_demand FOREIGN KEY (sourcing_demand_id) REFERENCES sourcing_demands (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_inquiry_line_qty CHECK (requested_quantity_snapshot > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_inquiry_dispatches (
  id BIGINT NOT NULL AUTO_INCREMENT,
  supplier_inquiry_id BIGINT NOT NULL,
  supplier_inquiry_revision_id BIGINT NOT NULL,
  channel VARCHAR(24) NOT NULL,
  recipient_snapshot_json JSON NOT NULL,
  payload_hash CHAR(64) NULL,
  document_id INT NULL,
  legacy_dispatch_id BIGINT NULL,
  dispatched_by_user_id INT NULL,
  dispatched_at DATETIME(6) NOT NULL,
  note TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inquiry_dispatch_legacy (legacy_dispatch_id),
  KEY idx_inquiry_dispatch_revision (supplier_inquiry_revision_id, dispatched_at),
  CONSTRAINT fk_inquiry_dispatch_inquiry FOREIGN KEY (supplier_inquiry_id) REFERENCES supplier_inquiries (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_dispatch_revision FOREIGN KEY (supplier_inquiry_revision_id) REFERENCES supplier_inquiry_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_dispatch_document FOREIGN KEY (document_id) REFERENCES rfq_documents (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_dispatch_legacy FOREIGN KEY (legacy_dispatch_id) REFERENCES rfq_supplier_dispatches (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_inquiry_dispatch_actor FOREIGN KEY (dispatched_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_offers (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_case_id BIGINT NOT NULL,
  supplier_inquiry_id BIGINT NULL,
  supplier_id INT NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  legacy_response_id INT NULL,
  created_by_user_id INT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_offer_legacy (legacy_response_id),
  KEY idx_supplier_offer_case (sourcing_case_id, status, supplier_id),
  CONSTRAINT fk_supplier_offer_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_offer_inquiry FOREIGN KEY (supplier_inquiry_id) REFERENCES supplier_inquiries (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_offer_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_offer_legacy FOREIGN KEY (legacy_response_id) REFERENCES rfq_supplier_responses (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_offer_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_supplier_offer_source CHECK (source_type IN ('inquiry', 'email', 'phone', 'portal', 'price_list', 'historic', 'negotiation', 'manual', 'legacy')),
  CONSTRAINT chk_supplier_offer_status CHECK (status IN ('draft', 'received', 'finalized', 'superseded', 'withdrawn', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_offer_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  supplier_offer_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  currency CHAR(3) NULL,
  offer_reference VARCHAR(120) NULL,
  source_evidence_json JSON NOT NULL,
  note TEXT NULL,
  legacy_response_revision_id INT NULL,
  finalized_by_user_id INT NULL,
  finalized_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_offer_revision_number (supplier_offer_id, revision_number),
  UNIQUE KEY uq_offer_revision_legacy (legacy_response_revision_id),
  CONSTRAINT fk_offer_revision_offer FOREIGN KEY (supplier_offer_id) REFERENCES supplier_offers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_offer_revision_legacy FOREIGN KEY (legacy_response_revision_id) REFERENCES rfq_response_revisions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_offer_revision_finalized_by FOREIGN KEY (finalized_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_offer_revision_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_offer_revision_status CHECK (status IN ('draft', 'finalized', 'superseded', 'withdrawn'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_offer_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  supplier_offer_revision_id BIGINT NOT NULL,
  supplier_part_id INT NULL,
  offered_catalog_position_id INT NULL,
  relationship_type VARCHAR(32) NOT NULL DEFAULT 'unknown',
  supplier_part_number_snapshot VARCHAR(255) NULL,
  description_snapshot TEXT NULL,
  supplier_reply_status VARCHAR(32) NOT NULL DEFAULT 'quoted',
  offered_quantity DECIMAL(15,3) NULL,
  moq DECIMAL(15,3) NULL,
  pack_quantity DECIMAL(15,3) NULL,
  unit_price DECIMAL(18,4) NULL,
  currency CHAR(3) NULL,
  lead_time_days INT NULL,
  validity_until DATE NULL,
  payment_terms VARCHAR(255) NULL,
  incoterms VARCHAR(16) NULL,
  incoterms_place VARCHAR(255) NULL,
  origin_country CHAR(2) NULL,
  evidence_json JSON NOT NULL,
  legacy_response_line_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_offer_line_legacy (legacy_response_line_id),
  KEY idx_offer_line_revision (supplier_offer_revision_id, supplier_reply_status),
  KEY idx_offer_line_supplier_part (supplier_part_id),
  KEY idx_offer_line_catalog (offered_catalog_position_id),
  CONSTRAINT fk_offer_line_revision FOREIGN KEY (supplier_offer_revision_id) REFERENCES supplier_offer_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_offer_line_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_offer_line_catalog FOREIGN KEY (offered_catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_offer_line_legacy FOREIGN KEY (legacy_response_line_id) REFERENCES rfq_response_lines (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_offer_line_relationship CHECK (relationship_type IN ('exact', 'analog', 'substitute', 'kit', 'component', 'unknown')),
  CONSTRAINT chk_offer_line_reply CHECK (supplier_reply_status IN ('quoted', 'no_stock', 'discontinued', 'needs_clarification', 'no_response')),
  CONSTRAINT chk_offer_line_values CHECK (
    (offered_quantity IS NULL OR offered_quantity >= 0) AND
    (moq IS NULL OR moq > 0) AND (pack_quantity IS NULL OR pack_quantity > 0) AND
    (unit_price IS NULL OR unit_price >= 0) AND (lead_time_days IS NULL OR lead_time_days >= 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_offer_line_demands (
  id BIGINT NOT NULL AUTO_INCREMENT,
  supplier_offer_line_id BIGINT NOT NULL,
  sourcing_demand_id BIGINT NOT NULL,
  capable_quantity DECIMAL(15,3) NULL,
  match_basis_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_offer_line_demand (supplier_offer_line_id, sourcing_demand_id),
  KEY idx_offer_demand_demand (sourcing_demand_id, supplier_offer_line_id),
  CONSTRAINT fk_offer_demand_line FOREIGN KEY (supplier_offer_line_id) REFERENCES supplier_offer_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_offer_demand_demand FOREIGN KEY (sourcing_demand_id) REFERENCES sourcing_demands (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_offer_demand_qty CHECK (capable_quantity IS NULL OR capable_quantity >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sourcing_coverage_options (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_case_id BIGINT NOT NULL,
  option_code VARCHAR(80) NOT NULL,
  option_type VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  title VARCHAR(255) NULL,
  blocker_json JSON NOT NULL,
  legacy_coverage_option_id BIGINT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sourcing_coverage_case_code (sourcing_case_id, option_code),
  UNIQUE KEY uq_sourcing_coverage_legacy (legacy_coverage_option_id),
  KEY idx_sourcing_coverage_case (sourcing_case_id, status),
  CONSTRAINT fk_sourcing_coverage_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_coverage_legacy FOREIGN KEY (legacy_coverage_option_id) REFERENCES rfq_coverage_options (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_coverage_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_sourcing_coverage_type CHECK (option_type IN ('single', 'split', 'kit', 'partial', 'mixed', 'manual')),
  CONSTRAINT chk_sourcing_coverage_status CHECK (status IN ('draft', 'valid', 'partial', 'blocked', 'selected', 'superseded'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sourcing_coverage_option_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_coverage_option_id BIGINT NOT NULL,
  sourcing_demand_id BIGINT NOT NULL,
  supplier_offer_line_id BIGINT NULL,
  supplier_id INT NOT NULL,
  allocated_quantity DECIMAL(15,3) NOT NULL,
  purchase_quantity DECIMAL(15,3) NOT NULL,
  surplus_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  uom_snapshot VARCHAR(16) NOT NULL,
  validation_json JSON NOT NULL,
  legacy_coverage_option_line_id BIGINT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_coverage_option_line_legacy (legacy_coverage_option_line_id),
  KEY idx_coverage_option_line (sourcing_coverage_option_id, sourcing_demand_id),
  KEY idx_coverage_line_offer (supplier_offer_line_id),
  CONSTRAINT fk_coverage_line_option FOREIGN KEY (sourcing_coverage_option_id) REFERENCES sourcing_coverage_options (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_coverage_line_demand FOREIGN KEY (sourcing_demand_id) REFERENCES sourcing_demands (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_coverage_line_offer FOREIGN KEY (supplier_offer_line_id) REFERENCES supplier_offer_lines (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_coverage_line_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_coverage_line_legacy FOREIGN KEY (legacy_coverage_option_line_id) REFERENCES rfq_coverage_option_lines (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_coverage_line_qty CHECK (allocated_quantity > 0 AND purchase_quantity >= allocated_quantity AND surplus_quantity = purchase_quantity - allocated_quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sourcing_decisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_case_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  decision_note TEXT NULL,
  validation_snapshot_json JSON NOT NULL,
  finalized_by_user_id INT NULL,
  finalized_at DATETIME(6) NULL,
  supersedes_decision_id BIGINT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sourcing_decision_revision (sourcing_case_id, revision_number),
  KEY idx_sourcing_decision_status (sourcing_case_id, status),
  CONSTRAINT fk_sourcing_decision_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_decision_finalized_by FOREIGN KEY (finalized_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_decision_supersedes FOREIGN KEY (supersedes_decision_id) REFERENCES sourcing_decisions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sourcing_decision_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_sourcing_decision_status CHECK (status IN ('draft', 'finalized', 'superseded', 'withdrawn'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sourcing_decision_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sourcing_decision_id BIGINT NOT NULL,
  sourcing_demand_id BIGINT NOT NULL,
  sourcing_coverage_option_id BIGINT NOT NULL,
  supplier_offer_line_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  supplier_part_id INT NULL,
  offered_catalog_position_id INT NULL,
  procurement_release_item_id INT NOT NULL,
  decided_quantity DECIMAL(15,3) NOT NULL,
  trace_snapshot_json JSON NOT NULL,
  rationale TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_decision_line_decision (sourcing_decision_id, sourcing_demand_id),
  KEY idx_decision_line_release_item (procurement_release_item_id),
  CONSTRAINT fk_decision_line_decision FOREIGN KEY (sourcing_decision_id) REFERENCES sourcing_decisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_decision_line_demand FOREIGN KEY (sourcing_demand_id) REFERENCES sourcing_demands (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_decision_line_option FOREIGN KEY (sourcing_coverage_option_id) REFERENCES sourcing_coverage_options (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_decision_line_offer FOREIGN KEY (supplier_offer_line_id) REFERENCES supplier_offer_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_decision_line_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_decision_line_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_decision_line_catalog FOREIGN KEY (offered_catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_decision_line_release_item FOREIGN KEY (procurement_release_item_id) REFERENCES procurement_release_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_decision_line_qty CHECK (decided_quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_master_data_promotion_requests (
  id BIGINT NOT NULL AUTO_INCREMENT,
  supplier_offer_line_id BIGINT NOT NULL,
  request_type VARCHAR(40) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  proposed_values_json JSON NOT NULL,
  source_trace_json JSON NOT NULL,
  requested_by_user_id INT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  reviewed_by_user_id INT NULL,
  reviewed_at DATETIME(6) NULL,
  review_note TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_supplier_promotion_queue (status, requested_at),
  KEY idx_supplier_promotion_source (supplier_offer_line_id),
  CONSTRAINT fk_supplier_promotion_offer_line FOREIGN KEY (supplier_offer_line_id) REFERENCES supplier_offer_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_promotion_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_promotion_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_supplier_promotion_type CHECK (request_type IN ('supplier_part', 'catalog_relation', 'supplier_price', 'supplier_identity')),
  CONSTRAINT chk_supplier_promotion_status CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE rfqs
  ADD COLUMN sourcing_case_id BIGINT NULL AFTER procurement_release_id,
  ADD KEY idx_rfqs_sourcing_case (sourcing_case_id),
  ADD CONSTRAINT fk_rfqs_sourcing_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO sourcing_cases
  (case_number, title, status, priority, owner_user_id, legacy_rfq_id,
   created_by_user_id, accepted_by_user_id, accepted_at, created_at, updated_at)
SELECT CONCAT('SC-LEGACY-', COALESCE(NULLIF(r.rfq_number, ''), r.id)),
       CONCAT('Legacy sourcing case ', COALESCE(NULLIF(r.rfq_number, ''), r.id)),
       CASE WHEN EXISTS (SELECT 1 FROM rfq_supplier_responses sr JOIN rfq_suppliers rs ON rs.id = sr.rfq_supplier_id WHERE rs.rfq_id = r.id)
            THEN 'offer_review' WHEN r.status = 'sent' THEN 'waiting_responses' ELSE 'in_progress' END,
       'normal', r.assigned_to_user_id, r.id, r.created_by_user_id,
       COALESCE(r.assigned_to_user_id, r.created_by_user_id), r.created_at, r.created_at, r.updated_at
FROM rfqs r
WHERE r.procurement_release_id IS NOT NULL;

UPDATE rfqs r
JOIN sourcing_cases sc ON sc.legacy_rfq_id = r.id
SET r.sourcing_case_id = sc.id
WHERE r.sourcing_case_id IS NULL;

INSERT INTO sourcing_case_release_links
  (sourcing_case_id, procurement_release_id, linked_by_user_id, linked_at)
SELECT sc.id, r.procurement_release_id, r.created_by_user_id, r.created_at
FROM sourcing_cases sc
JOIN rfqs r ON r.id = sc.legacy_rfq_id
WHERE r.procurement_release_id IS NOT NULL;

INSERT INTO sourcing_demands
  (sourcing_case_id, procurement_release_id, procurement_release_item_id,
   client_request_id, client_request_revision_id, client_request_revision_item_id,
   stable_item_key_snapshot, line_number_snapshot, catalog_position_id_snapshot,
   requested_quantity_snapshot, admitted_quantity, uom_snapshot, substitution_policy_snapshot,
   source_data_snapshot_json, identification_snapshot_json, requirements_snapshot_json,
   document_refs_snapshot_json, status, created_at, updated_at)
SELECT sc.id, pr.id, pri.id, pr.client_request_id, pr.client_request_revision_id,
       pri.client_request_revision_item_id, pri.stable_item_key_snapshot,
       pri.line_number_snapshot, pri.catalog_position_id_snapshot,
       pri.requested_quantity_snapshot, pri.requested_quantity_snapshot, pri.uom_snapshot,
       COALESCE(JSON_UNQUOTE(JSON_EXTRACT(pri.requirements_snapshot_json, '$.substitution_policy')), 'unspecified'),
       pri.source_data_snapshot_json, pri.identification_snapshot_json,
       pri.requirements_snapshot_json, pri.document_refs_snapshot_json,
       CASE WHEN EXISTS (
         SELECT 1 FROM rfq_response_lines rrl
         JOIN rfq_response_revisions rrr ON rrr.id = rrl.rfq_response_revision_id
         JOIN rfq_supplier_responses rsr ON rsr.id = rrr.rfq_supplier_response_id
         JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
         JOIN rfq_items ri ON ri.id = rrl.rfq_item_id
         WHERE rs.rfq_id = sc.legacy_rfq_id AND ri.procurement_release_item_id = pri.id
       ) THEN 'offers_available' ELSE 'sourcing_active' END,
       pri.created_at, CURRENT_TIMESTAMP(6)
FROM sourcing_cases sc
JOIN rfqs r ON r.id = sc.legacy_rfq_id
JOIN procurement_releases pr ON pr.id = r.procurement_release_id
JOIN procurement_release_items pri ON pri.procurement_release_id = pr.id;

INSERT INTO sourcing_case_events
  (sourcing_case_id, event_type, entity_type, entity_id, actor_user_id, payload_json, created_at)
SELECT sc.id, 'legacy_rfq_backfilled', 'rfq', r.id, r.created_by_user_id,
       JSON_OBJECT('rfq_number', r.rfq_number, 'procurement_release_id', r.procurement_release_id), r.created_at
FROM sourcing_cases sc JOIN rfqs r ON r.id = sc.legacy_rfq_id;

INSERT INTO supplier_inquiries
  (sourcing_case_id, supplier_id, status, language, legacy_rfq_supplier_id,
   created_by_user_id, created_at, updated_at)
SELECT sc.id, rs.supplier_id,
       CASE WHEN rs.responded_at IS NOT NULL OR rs.status = 'responded' THEN 'responded'
            WHEN rs.invited_at IS NOT NULL OR rs.status = 'sent' THEN 'sent' ELSE 'draft' END,
       COALESCE(NULLIF(rs.language, ''), 'en'), rs.id, r.created_by_user_id,
       COALESCE(rs.invited_at, r.created_at), COALESCE(rs.responded_at, rs.invited_at, r.updated_at)
FROM rfq_suppliers rs
JOIN rfqs r ON r.id = rs.rfq_id
JOIN sourcing_cases sc ON sc.legacy_rfq_id = r.id;

INSERT INTO supplier_inquiry_revisions
  (supplier_inquiry_id, revision_number, status, subject_snapshot, message_snapshot,
   contact_snapshot_json, payload_hash, legacy_rfq_revision_id,
   finalized_by_user_id, finalized_at, created_by_user_id, created_at)
SELECT si.id, 1, 'finalized', CONCAT('Legacy RFQ ', r.rfq_number), rs.note,
       JSON_OBJECT('supplier_id', rs.supplier_id, 'language', rs.language),
       NULL, r.current_rfq_revision_id, COALESCE(r.sent_by_user_id, r.created_by_user_id),
       COALESCE(r.sent_at, r.created_at), r.created_by_user_id, r.created_at
FROM supplier_inquiries si
JOIN rfq_suppliers rs ON rs.id = si.legacy_rfq_supplier_id
JOIN rfqs r ON r.id = rs.rfq_id;

INSERT INTO supplier_inquiry_revision_lines
  (supplier_inquiry_revision_id, sourcing_demand_id, requested_quantity_snapshot,
   uom_snapshot, request_snapshot_json, created_at)
SELECT sir.id, sd.id, COALESCE(sel.qty, ri.requested_qty), COALESCE(sel.uom, ri.uom, sd.uom_snapshot),
       JSON_OBJECT('legacy_rfq_item_id', ri.id, 'legacy_selection_key', sel.selection_key,
                   'line_type', COALESCE(sel.line_type, 'DEMAND'), 'line_label', sel.line_label),
       COALESCE(sel.created_at, ri.created_at)
FROM supplier_inquiry_revisions sir
JOIN supplier_inquiries si ON si.id = sir.supplier_inquiry_id
JOIN rfq_suppliers rs ON rs.id = si.legacy_rfq_supplier_id
JOIN rfq_items ri ON ri.rfq_id = rs.rfq_id
JOIN sourcing_demands sd ON sd.sourcing_case_id = si.sourcing_case_id AND sd.procurement_release_item_id = ri.procurement_release_item_id
LEFT JOIN rfq_supplier_line_selections sel ON sel.rfq_supplier_id = rs.id AND sel.rfq_item_id = ri.id
WHERE sel.id IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM rfq_supplier_line_selections sx WHERE sx.rfq_supplier_id = rs.id
);

INSERT INTO supplier_inquiry_dispatches
  (supplier_inquiry_id, supplier_inquiry_revision_id, channel, recipient_snapshot_json,
   payload_hash, document_id, legacy_dispatch_id, dispatched_by_user_id, dispatched_at, note, created_at)
SELECT si.id, sir.id, 'legacy',
       JSON_OBJECT('supplier_id', rs.supplier_id, 'legacy_dispatch_type', d.dispatch_type),
       d.payload_hash, d.document_id, d.id, d.sent_by_user_id, d.sent_at, d.note, d.sent_at
FROM rfq_supplier_dispatches d
JOIN supplier_inquiries si ON si.legacy_rfq_supplier_id = d.rfq_supplier_id
JOIN supplier_inquiry_revisions sir ON sir.supplier_inquiry_id = si.id AND sir.revision_number = 1
JOIN rfq_suppliers rs ON rs.id = d.rfq_supplier_id;

INSERT INTO supplier_offers
  (sourcing_case_id, supplier_inquiry_id, supplier_id, source_type, status,
   legacy_response_id, created_by_user_id, created_at, updated_at)
SELECT si.sourcing_case_id, si.id, rs.supplier_id, 'legacy',
       CASE WHEN sr.status IN ('rejected', 'withdrawn') THEN sr.status ELSE 'finalized' END,
       sr.id, sr.created_by_user_id, sr.created_at, sr.created_at
FROM rfq_supplier_responses sr
JOIN rfq_suppliers rs ON rs.id = sr.rfq_supplier_id
JOIN supplier_inquiries si ON si.legacy_rfq_supplier_id = rs.id;

INSERT INTO supplier_offer_revisions
  (supplier_offer_id, revision_number, status, currency, source_evidence_json,
   note, legacy_response_revision_id, finalized_by_user_id, finalized_at,
   created_by_user_id, created_at)
SELECT so.id, rr.rev_number,
       CASE WHEN rr.rev_number = mx.max_rev THEN 'finalized' ELSE 'superseded' END,
       (SELECT MIN(rl.currency) FROM rfq_response_lines rl WHERE rl.rfq_response_revision_id = rr.id),
       JSON_OBJECT('source', 'legacy_rfq_response_revision', 'legacy_response_revision_id', rr.id),
       rr.note, rr.id, rr.created_by_user_id, rr.created_at, rr.created_by_user_id, rr.created_at
FROM rfq_response_revisions rr
JOIN supplier_offers so ON so.legacy_response_id = rr.rfq_supplier_response_id
JOIN (
  SELECT rfq_supplier_response_id, MAX(rev_number) AS max_rev
  FROM rfq_response_revisions GROUP BY rfq_supplier_response_id
) mx ON mx.rfq_supplier_response_id = rr.rfq_supplier_response_id;

INSERT INTO supplier_offer_lines
  (supplier_offer_revision_id, supplier_part_id, offered_catalog_position_id,
   relationship_type, supplier_part_number_snapshot, description_snapshot,
   supplier_reply_status, offered_quantity, moq, pack_quantity, unit_price, currency,
   lead_time_days, validity_until, payment_terms, incoterms, incoterms_place,
   origin_country, evidence_json, legacy_response_line_id, created_at)
SELECT sor.id, rl.supplier_part_id, rl.catalog_position_id,
       CASE rl.offer_type WHEN 'OEM' THEN 'exact' WHEN 'ANALOG' THEN 'analog' ELSE 'unknown' END,
       sp.supplier_part_number, sp.description,
       LOWER(rl.supplier_reply_status), rl.offered_qty, rl.moq,
       CASE WHEN rl.packaging REGEXP '^[0-9]+([.][0-9]+)?$' THEN CAST(rl.packaging AS DECIMAL(15,3)) ELSE NULL END,
       rl.price, rl.currency, rl.lead_time_days,
       CASE WHEN rl.validity_days IS NOT NULL THEN DATE_ADD(DATE(rl.created_at), INTERVAL rl.validity_days DAY) ELSE NULL END,
       rl.payment_terms, rl.incoterms, rl.incoterms_place, rl.origin_country,
       JSON_OBJECT('entry_source', rl.entry_source, 'selection_key', rl.selection_key,
                   'packaging_text', rl.packaging, 'change_reason', rl.change_reason),
       rl.id, rl.created_at
FROM rfq_response_lines rl
JOIN supplier_offer_revisions sor ON sor.legacy_response_revision_id = rl.rfq_response_revision_id
LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id;

INSERT INTO supplier_offer_line_demands
  (supplier_offer_line_id, sourcing_demand_id, capable_quantity, match_basis_json, created_at)
SELECT sol.id, sd.id, rl.offered_qty,
       JSON_OBJECT('legacy_rfq_item_id', ri.id, 'selection_key', rl.selection_key,
                   'requested_catalog_position_id', ri.catalog_position_id), rl.created_at
FROM supplier_offer_lines sol
JOIN rfq_response_lines rl ON rl.id = sol.legacy_response_line_id
JOIN rfq_items ri ON ri.id = rl.rfq_item_id
JOIN supplier_offer_revisions sor ON sor.id = sol.supplier_offer_revision_id
JOIN supplier_offers so ON so.id = sor.supplier_offer_id
JOIN sourcing_demands sd ON sd.sourcing_case_id = so.sourcing_case_id AND sd.procurement_release_item_id = ri.procurement_release_item_id;

INSERT INTO sourcing_coverage_options
  (sourcing_case_id, option_code, option_type, status, title, blocker_json,
   legacy_coverage_option_id, created_by_user_id, created_at, updated_at)
SELECT sc.id, CONCAT('LEGACY-', co.id, '-', co.option_code),
       CASE co.option_kind WHEN 'WHOLE' THEN 'single' WHEN 'BOM' THEN 'split'
            WHEN 'KIT' THEN 'kit' WHEN 'MIXED' THEN 'mixed' ELSE 'manual' END,
       CASE co.coverage_status WHEN 'FULL' THEN 'valid' WHEN 'PARTIAL' THEN 'partial'
            WHEN 'BLOCKED' THEN 'blocked' WHEN 'CONFLICT' THEN 'blocked' ELSE 'draft' END,
       co.option_code, COALESCE(co.warning_json, JSON_ARRAY()), co.id,
       co.created_by_user_id, co.created_at, co.updated_at
FROM rfq_coverage_options co
JOIN sourcing_cases sc ON sc.legacy_rfq_id = co.rfq_id;

INSERT INTO sourcing_coverage_option_lines
  (sourcing_coverage_option_id, sourcing_demand_id, supplier_offer_line_id,
   supplier_id, allocated_quantity, purchase_quantity, surplus_quantity,
   uom_snapshot, validation_json, legacy_coverage_option_line_id, created_at)
SELECT sco.id, sd.id, sol.id, col.supplier_id,
       GREATEST(COALESCE(col.qty, 0.001), 0.001),
       GREATEST(COALESCE(col.qty, 0.001), 0.001), 0,
       COALESCE(NULLIF(col.uom, ''), sd.uom_snapshot),
       JSON_OBJECT('legacy_line_status', col.line_status, 'has_price', col.has_price,
                   'legacy_line_role', col.line_role), col.id, col.created_at
FROM rfq_coverage_option_lines col
JOIN sourcing_coverage_options sco ON sco.legacy_coverage_option_id = col.coverage_option_id
JOIN rfq_items ri ON ri.id = col.rfq_item_id
JOIN sourcing_demands sd ON sd.sourcing_case_id = sco.sourcing_case_id AND sd.procurement_release_item_id = ri.procurement_release_item_id
LEFT JOIN supplier_offer_lines sol ON sol.legacy_response_line_id = col.rfq_response_line_id;

INSERT INTO sourcing_case_events
  (sourcing_case_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
SELECT sc.id, 'legacy_history_linked', 'sourcing_case', sc.id, sc.created_by_user_id,
       JSON_OBJECT(
         'inquiry_count', (SELECT COUNT(*) FROM supplier_inquiries si WHERE si.sourcing_case_id = sc.id),
         'offer_count', (SELECT COUNT(*) FROM supplier_offers so WHERE so.sourcing_case_id = sc.id),
         'coverage_option_count', (SELECT COUNT(*) FROM sourcing_coverage_options co WHERE co.sourcing_case_id = sc.id)
       )
FROM sourcing_cases sc WHERE sc.legacy_rfq_id IS NOT NULL;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('sourcing.access', 'Просмотр Sourcing', 'Доступ к очереди и read model Sourcing Case', 'sourcing', 1000, 1, 0),
  ('sourcing.cases.manage', 'Управление Sourcing Case', 'Создание, принятие и архивирование кейсов закупочного поиска', 'sourcing', 1010, 1, 0),
  ('sourcing.inquiries.manage', 'Управление запросами поставщикам', 'Создание immutable-ревизий и dispatch supplier inquiry', 'sourcing', 1020, 1, 0),
  ('sourcing.offers.manage', 'Управление предложениями поставщиков', 'Транзакционный ввод и финализация Supplier Offer', 'sourcing', 1030, 1, 0),
  ('sourcing.coverage.manage', 'Управление покрытием потребности', 'Создание и валидация вариантов покрытия', 'sourcing', 1040, 1, 0),
  ('sourcing.decisions.finalize', 'Финализация Sourcing Decision', 'Фиксация трассируемого решения по покрытию', 'sourcing', 1050, 1, 0),
  ('sourcing.master_data_promotion.request', 'Запрос на продвижение мастер-данных', 'Создание проверяемого запроса без изменения Supplier master data', 'sourcing', 1060, 1, 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description), section = VALUES(section),
  sort_order = VALUES(sort_order), is_active = 1, is_legacy = 0;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key LIKE 'sourcing.%'
WHERE r.slug IN ('admin', 'nachalnik-otdela-zakupok')
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key IN (
  'sourcing.access', 'sourcing.cases.manage', 'sourcing.inquiries.manage',
  'sourcing.offers.manage', 'sourcing.coverage.manage',
  'sourcing.master_data_promotion.request'
)
WHERE r.slug = 'zakupshchik'
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key = 'sourcing.access'
WHERE r.slug IN ('prodavec', 'specialist-po-katalogam', 'nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed = 1;
