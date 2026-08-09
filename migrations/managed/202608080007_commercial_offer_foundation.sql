CREATE TABLE commercial_offers (
  id BIGINT NOT NULL AUTO_INCREMENT,
  offer_number VARCHAR(64) NOT NULL,
  source_pricing_decision_id BIGINT NOT NULL,
  pricing_case_id BIGINT NOT NULL,
  client_request_id INT NOT NULL,
  client_id INT NOT NULL,
  owner_user_id INT NULL,
  aggregate_status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  current_revision_id BIGINT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  closed_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_offer_number (offer_number),
  UNIQUE KEY uq_commercial_offer_pricing_decision (source_pricing_decision_id),
  KEY idx_commercial_offer_queue (aggregate_status, owner_user_id, updated_at),
  CONSTRAINT fk_commercial_offer_pricing_decision FOREIGN KEY (source_pricing_decision_id) REFERENCES pricing_decisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_pricing_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_client_request FOREIGN KEY (client_request_id) REFERENCES client_requests (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_offer_status CHECK (aggregate_status IN ('DRAFT','INTERNAL_REVIEW','READY_TO_SEND','AWAITING_CLIENT','CHANGE_REQUESTED','NEGOTIATION_IN_PROGRESS','PARTIALLY_ACCEPTED','ACCEPTED','REJECTED','CLOSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_offer_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  source_pricing_decision_id BIGINT NOT NULL,
  source_pricing_decision_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  currency CHAR(3) NOT NULL,
  validity_until DATE NULL,
  payment_terms TEXT NULL,
  incoterms VARCHAR(32) NULL,
  destination TEXT NULL,
  client_delivery_commitment_days INT NULL,
  warranty_terms TEXT NULL,
  packaging_terms TEXT NULL,
  partial_delivery_terms TEXT NULL,
  general_text TEXT NULL,
  client_snapshot_json JSON NOT NULL,
  client_contact_snapshot_json JSON NOT NULL,
  billing_address_snapshot_json JSON NOT NULL,
  shipping_address_snapshot_json JSON NOT NULL,
  company_legal_snapshot_json JSON NOT NULL,
  content_hash CHAR(64) NULL,
  supersedes_revision_id BIGINT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  issued_by_user_id INT NULL,
  issued_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_offer_revision (commercial_offer_id, revision_number),
  KEY idx_commercial_offer_revision_source (source_pricing_decision_id),
  CONSTRAINT fk_commercial_offer_revision_offer FOREIGN KEY (commercial_offer_id) REFERENCES commercial_offers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_revision_pricing FOREIGN KEY (source_pricing_decision_id) REFERENCES pricing_decisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_revision_supersedes FOREIGN KEY (supersedes_revision_id) REFERENCES commercial_offer_revisions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_revision_issued_by FOREIGN KEY (issued_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_revision_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_offer_revision_status CHECK (status IN ('DRAFT','INTERNAL_REVIEW','READY_TO_SEND','ISSUED','SUPERSEDED','ACCEPTED','REJECTED')),
  CONSTRAINT chk_commercial_offer_revision_delivery CHECK (client_delivery_commitment_days IS NULL OR client_delivery_commitment_days >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE commercial_offers
  ADD CONSTRAINT fk_commercial_offer_current_revision FOREIGN KEY (current_revision_id) REFERENCES commercial_offer_revisions (id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE commercial_offer_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_revision_id BIGINT NOT NULL,
  source_pricing_decision_line_id BIGINT NOT NULL,
  source_pricing_input_line_id BIGINT NOT NULL,
  stable_item_key_snapshot CHAR(36) NOT NULL,
  line_number INT NOT NULL,
  requested_identity_snapshot_json JSON NOT NULL,
  offered_execution_snapshot_json JSON NOT NULL,
  pricing_client_projection_snapshot_json JSON NOT NULL,
  source_trace_snapshot_json JSON NOT NULL,
  fulfillment_type VARCHAR(40) NOT NULL,
  disclosure_policy VARCHAR(48) NOT NULL,
  client_display_part_number VARCHAR(255) NULL,
  client_display_description TEXT NOT NULL,
  offered_quantity DECIMAL(15,3) NOT NULL,
  uom VARCHAR(24) NOT NULL,
  recommended_unit_price_snapshot DECIMAL(18,4) NOT NULL,
  delegated_floor_snapshot DECIMAL(18,4) NULL,
  absolute_floor_snapshot DECIMAL(18,4) NULL,
  offered_unit_price DECIMAL(18,4) NOT NULL,
  calculated_lead_time_days_snapshot INT NULL,
  client_delivery_commitment_days INT NULL,
  line_status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  override_reason TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_offer_revision_pricing_line (commercial_offer_revision_id, source_pricing_decision_line_id),
  KEY idx_commercial_offer_line_stable_key (stable_item_key_snapshot),
  CONSTRAINT fk_commercial_offer_line_revision FOREIGN KEY (commercial_offer_revision_id) REFERENCES commercial_offer_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_line_pricing_line FOREIGN KEY (source_pricing_decision_line_id) REFERENCES pricing_decision_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_line_pricing_input FOREIGN KEY (source_pricing_input_line_id) REFERENCES pricing_input_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_offer_line_fulfillment CHECK (fulfillment_type IN ('EXACT_REQUESTED_ITEM','APPROVED_EQUIVALENT','PROPOSED_EQUIVALENT','KIT_COVERAGE','MANUFACTURED_TO_DRAWING')),
  CONSTRAINT chk_commercial_offer_line_disclosure CHECK (disclosure_policy IN ('SHOW_EXACT_EXECUTION','SHOW_REQUESTED_AND_OFFERED','SHOW_EQUIVALENT_WITHOUT_SOURCE','CUSTOM_APPROVED_PRESENTATION')),
  CONSTRAINT chk_commercial_offer_line_status CHECK (line_status IN ('ACTIVE','EXCLUDED')),
  CONSTRAINT chk_commercial_offer_line_values CHECK (offered_quantity > 0 AND recommended_unit_price_snapshot >= 0 AND offered_unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_approval_requests (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_revision_id BIGINT NOT NULL,
  commercial_offer_line_id BIGINT NULL,
  approval_type VARCHAR(24) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'SUBMITTED',
  requested_value_json JSON NOT NULL,
  baseline_value_json JSON NOT NULL,
  threshold_value_json JSON NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  requester_user_id INT NOT NULL,
  approver_user_id INT NULL,
  decision_comment TEXT NULL,
  submitted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  decided_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_commercial_approval_queue (status, approval_type, submitted_at),
  CONSTRAINT fk_commercial_approval_revision FOREIGN KEY (commercial_offer_revision_id) REFERENCES commercial_offer_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_approval_line FOREIGN KEY (commercial_offer_line_id) REFERENCES commercial_offer_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_approval_requester FOREIGN KEY (requester_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_approval_approver FOREIGN KEY (approver_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_approval_type CHECK (approval_type IN ('PRICE','LEAD_TIME','TERMS','DISCLOSURE')),
  CONSTRAINT chk_commercial_approval_status CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','RETURNED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_offer_document_generations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_revision_id BIGINT NOT NULL,
  template_version VARCHAR(64) NOT NULL,
  format VARCHAR(24) NOT NULL,
  client_payload_json JSON NOT NULL,
  rendered_content LONGTEXT NULL,
  file_reference VARCHAR(1024) NULL,
  document_hash CHAR(64) NOT NULL,
  generated_by_user_id INT NULL,
  generated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_commercial_document_revision (commercial_offer_revision_id, generated_at),
  CONSTRAINT fk_commercial_document_revision FOREIGN KEY (commercial_offer_revision_id) REFERENCES commercial_offer_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_document_generated_by FOREIGN KEY (generated_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_document_format CHECK (format IN ('HTML','PDF','DOCX','XLSX','CLIENT_SAFE_JSON'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_sent_offer_snapshots (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_revision_id BIGINT NOT NULL,
  document_generation_id BIGINT NULL,
  snapshot_payload_json JSON NOT NULL,
  recipients_json JSON NOT NULL,
  subject_snapshot TEXT NULL,
  body_snapshot TEXT NULL,
  channel VARCHAR(24) NOT NULL,
  snapshot_hash CHAR(64) NOT NULL,
  sent_by_user_id INT NULL,
  sent_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_commercial_sent_revision (commercial_offer_revision_id, sent_at),
  CONSTRAINT fk_commercial_sent_revision FOREIGN KEY (commercial_offer_revision_id) REFERENCES commercial_offer_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_sent_document FOREIGN KEY (document_generation_id) REFERENCES commercial_offer_document_generations (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_sent_by FOREIGN KEY (sent_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_sent_channel CHECK (channel IN ('EMAIL','PORTAL','MANUAL','OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_client_feedback (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_id BIGINT NOT NULL,
  sent_offer_snapshot_id BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'REGISTERED',
  received_at DATETIME(6) NOT NULL,
  channel VARCHAR(24) NOT NULL,
  evidence_reference TEXT NOT NULL,
  overall_note TEXT NULL,
  registered_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_feedback_snapshot (sent_offer_snapshot_id),
  CONSTRAINT fk_commercial_feedback_offer FOREIGN KEY (commercial_offer_id) REFERENCES commercial_offers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_feedback_snapshot FOREIGN KEY (sent_offer_snapshot_id) REFERENCES commercial_sent_offer_snapshots (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_feedback_registered_by FOREIGN KEY (registered_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_feedback_status CHECK (status IN ('REGISTERED','ASSESSED','CLOSED')),
  CONSTRAINT chk_commercial_feedback_channel CHECK (channel IN ('EMAIL','PORTAL','LETTER','MEETING','PHONE','OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_client_feedback_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  client_feedback_id BIGINT NOT NULL,
  commercial_offer_line_id BIGINT NOT NULL,
  result VARCHAR(32) NOT NULL,
  requested_quantity DECIMAL(15,3) NULL,
  requested_unit_price DECIMAL(18,4) NULL,
  requested_execution_text TEXT NULL,
  requested_delivery_days INT NULL,
  comment TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_feedback_line (client_feedback_id, commercial_offer_line_id),
  CONSTRAINT fk_commercial_feedback_line_feedback FOREIGN KEY (client_feedback_id) REFERENCES commercial_client_feedback (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_feedback_line_offer_line FOREIGN KEY (commercial_offer_line_id) REFERENCES commercial_offer_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_feedback_line_result CHECK (result IN ('ACCEPTED_AS_OFFERED','CHANGE_REQUESTED','REJECTED','NOT_REQUIRED','CLARIFICATION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_change_impact_assessments (
  id BIGINT NOT NULL AUTO_INCREMENT,
  client_feedback_id BIGINT NOT NULL,
  client_feedback_line_id BIGINT NULL,
  affected_domains_json JSON NOT NULL,
  reason_codes_json JSON NOT NULL,
  required_action VARCHAR(48) NOT NULL,
  resolver_version VARCHAR(64) NOT NULL,
  input_change_snapshot_json JSON NOT NULL,
  assessed_by_user_id INT NULL,
  assessed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_impact_feedback_line (client_feedback_id, client_feedback_line_id),
  CONSTRAINT fk_commercial_impact_feedback FOREIGN KEY (client_feedback_id) REFERENCES commercial_client_feedback (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_impact_feedback_line FOREIGN KEY (client_feedback_line_id) REFERENCES commercial_client_feedback_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_impact_assessed_by FOREIGN KEY (assessed_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_accepted_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_id BIGINT NOT NULL,
  accepted_offer_revision_id BIGINT NOT NULL,
  accepted_sent_snapshot_id BIGINT NOT NULL,
  client_feedback_id BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'FIXED',
  acceptance_evidence_reference TEXT NOT NULL,
  accepted_at DATETIME(6) NOT NULL,
  accepted_by_external_text VARCHAR(255) NULL,
  aggregate_total DECIMAL(20,4) NOT NULL,
  currency CHAR(3) NOT NULL,
  terms_snapshot_json JSON NOT NULL,
  acceptance_hash CHAR(64) NOT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_accepted_snapshot (accepted_sent_snapshot_id),
  KEY idx_commercial_accepted_offer (commercial_offer_id, accepted_at),
  CONSTRAINT fk_commercial_accepted_offer FOREIGN KEY (commercial_offer_id) REFERENCES commercial_offers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_accepted_revision FOREIGN KEY (accepted_offer_revision_id) REFERENCES commercial_offer_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_accepted_sent FOREIGN KEY (accepted_sent_snapshot_id) REFERENCES commercial_sent_offer_snapshots (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_accepted_feedback FOREIGN KEY (client_feedback_id) REFERENCES commercial_client_feedback (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_accepted_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_accepted_status CHECK (status IN ('FIXED','WITHDRAWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_accepted_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  accepted_commercial_revision_id BIGINT NOT NULL,
  source_offer_line_id BIGINT NOT NULL,
  source_pricing_decision_line_id BIGINT NOT NULL,
  accepted_quantity DECIMAL(15,3) NOT NULL,
  accepted_unit_price DECIMAL(18,4) NOT NULL,
  currency CHAR(3) NOT NULL,
  accepted_execution_snapshot_json JSON NOT NULL,
  client_representation_snapshot_json JSON NOT NULL,
  fulfillment_type VARCHAR(40) NOT NULL,
  delivery_commitment_days INT NULL,
  line_total DECIMAL(20,4) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACCEPTED',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commercial_accepted_line (accepted_commercial_revision_id, source_offer_line_id),
  CONSTRAINT fk_commercial_accepted_line_revision FOREIGN KEY (accepted_commercial_revision_id) REFERENCES commercial_accepted_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_accepted_line_source FOREIGN KEY (source_offer_line_id) REFERENCES commercial_offer_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_accepted_line_pricing FOREIGN KEY (source_pricing_decision_line_id) REFERENCES pricing_decision_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_commercial_accepted_line_status CHECK (status IN ('ACCEPTED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commercial_offer_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  commercial_offer_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id BIGINT NULL,
  actor_user_id INT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_commercial_offer_event (commercial_offer_id, created_at),
  CONSTRAINT fk_commercial_offer_event_offer FOREIGN KEY (commercial_offer_id) REFERENCES commercial_offers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_commercial_offer_event_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('commercial_offers.access', 'Просмотр Commercial Offer', 'Доступ к очереди и seller-safe проекциям предложений', 'commercial_offers', 1200, 1, 0),
  ('commercial_offers.manage', 'Управление Commercial Offer', 'Создание предложения из fixed Pricing Decision и редактирование draft revision', 'commercial_offers', 1210, 1, 0),
  ('commercial_offers.approvals.request', 'Запрос Commercial approval', 'Создание обоснованного запроса исключения', 'commercial_offers', 1220, 1, 0),
  ('commercial_offers.approvals.decide', 'Решение Commercial approval', 'Approve/reject/return коммерческого исключения', 'commercial_offers', 1230, 1, 0),
  ('commercial_offers.issue', 'Выпуск Commercial Offer', 'Readiness, rendering и immutable send snapshot', 'commercial_offers', 1240, 1, 0),
  ('commercial_offers.feedback.manage', 'Регистрация ответа клиента', 'Structured feedback и Change Impact Assessment', 'commercial_offers', 1250, 1, 0),
  ('commercial_offers.accept', 'Фиксация принятого предложения', 'Создание immutable Accepted Commercial Revision', 'commercial_offers', 1260, 1, 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description), section = VALUES(section),
  sort_order = VALUES(sort_order), is_active = 1, is_legacy = 0;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key LIKE 'commercial_offers.%'
WHERE r.slug IN ('admin', 'nachalnik-otdela-zakupok')
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key IN
  ('commercial_offers.access','commercial_offers.manage','commercial_offers.approvals.request',
   'commercial_offers.issue','commercial_offers.feedback.manage','commercial_offers.accept')
WHERE r.slug = 'prodavec'
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key = 'commercial_offers.access'
WHERE r.slug IN ('zakupshchik', 'specialist-po-katalogam', 'nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed = 1;
