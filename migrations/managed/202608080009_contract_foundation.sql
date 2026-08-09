CREATE TABLE contract_cases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_number VARCHAR(64) NOT NULL,
  client_id INT NOT NULL,
  source_commercial_acceptance_id BIGINT NOT NULL,
  legal_form VARCHAR(40) NOT NULL,
  template_reference VARCHAR(255) NOT NULL,
  template_version VARCHAR(64) NOT NULL,
  owner_user_id INT NULL,
  current_revision_id BIGINT NULL,
  aggregate_status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  request_key VARCHAR(128) NOT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_case_number (contract_number),
  UNIQUE KEY uq_contract_case_request_key (request_key),
  KEY idx_contract_case_queue (aggregate_status, owner_user_id, updated_at),
  KEY idx_contract_case_acceptance (source_commercial_acceptance_id),
  CONSTRAINT fk_contract_case_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_case_acceptance FOREIGN KEY (source_commercial_acceptance_id) REFERENCES commercial_accepted_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_case_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_contract_case_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_contract_case_legal_form CHECK (legal_form IN ('ONE_OFF_CONTRACT','FRAMEWORK_AGREEMENT','PURCHASE_ORDER_ACCEPTANCE','SIGNED_QUOTATION','OTHER')),
  CONSTRAINT chk_contract_case_status CHECK (aggregate_status IN ('DRAFT','INTERNAL_REVIEW','EXTERNAL_REVIEW','READY_FOR_SIGNATURE','PARTIALLY_SIGNED','SIGNED','EFFECTIVE','SUPERSEDED','TERMINATED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_case_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  source_commercial_acceptance_id BIGINT NOT NULL,
  source_acceptance_hash CHAR(64) NOT NULL,
  supersedes_revision_id BIGINT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  legal_form VARCHAR(40) NOT NULL,
  template_reference VARCHAR(255) NOT NULL,
  template_version VARCHAR(64) NOT NULL,
  commercial_snapshot_json JSON NOT NULL,
  client_snapshot_json JSON NOT NULL,
  client_contact_snapshot_json JSON NOT NULL,
  billing_address_snapshot_json JSON NOT NULL,
  shipping_address_snapshot_json JSON NOT NULL,
  client_bank_snapshot_json JSON NOT NULL,
  company_legal_snapshot_json JSON NOT NULL,
  content_hash CHAR(64) NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  locked_at DATETIME(6) NULL,
  effective_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_revision_number (contract_case_id, revision_number),
  KEY idx_contract_revision_acceptance (source_commercial_acceptance_id),
  CONSTRAINT fk_contract_revision_case FOREIGN KEY (contract_case_id) REFERENCES contract_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_revision_acceptance FOREIGN KEY (source_commercial_acceptance_id) REFERENCES commercial_accepted_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_revision_parent FOREIGN KEY (supersedes_revision_id) REFERENCES contract_revisions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_contract_revision_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_contract_revision_status CHECK (status IN ('DRAFT','INTERNAL_REVIEW','EXTERNAL_REVIEW','READY_FOR_SIGNATURE','PARTIALLY_SIGNED','SIGNED','EFFECTIVE','SUPERSEDED','TERMINATED')),
  CONSTRAINT chk_contract_revision_legal_form CHECK (legal_form IN ('ONE_OFF_CONTRACT','FRAMEWORK_AGREEMENT','PURCHASE_ORDER_ACCEPTANCE','SIGNED_QUOTATION','OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE contract_cases
  ADD CONSTRAINT fk_contract_case_current_revision FOREIGN KEY (current_revision_id) REFERENCES contract_revisions (id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE contract_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  source_accepted_line_id BIGINT NOT NULL,
  line_number INT NOT NULL,
  identity_snapshot_json JSON NOT NULL,
  execution_snapshot_json JSON NOT NULL,
  client_representation_snapshot_json JSON NOT NULL,
  upstream_trace_snapshot_json JSON NOT NULL,
  quantity DECIMAL(15,3) NOT NULL,
  uom VARCHAR(24) NOT NULL,
  unit_price DECIMAL(18,4) NOT NULL,
  currency CHAR(3) NOT NULL,
  line_total DECIMAL(20,4) NOT NULL,
  delivery_commitment_days INT NULL,
  line_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_revision_accepted_line (contract_revision_id, source_accepted_line_id),
  KEY idx_contract_line_source (source_accepted_line_id),
  CONSTRAINT fk_contract_line_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_line_source FOREIGN KEY (source_accepted_line_id) REFERENCES commercial_accepted_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_contract_line_status CHECK (line_status IN ('ACTIVE','EXCLUDED')),
  CONSTRAINT chk_contract_line_values CHECK (quantity > 0 AND unit_price >= 0 AND line_total >= 0 AND (delivery_commitment_days IS NULL OR delivery_commitment_days >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_terms (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  term_type VARCHAR(48) NOT NULL,
  value_json JSON NOT NULL,
  baseline_json JSON NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_reference VARCHAR(255) NULL,
  deviation_state VARCHAR(24) NOT NULL DEFAULT 'UNCHANGED',
  approval_state VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUIRED',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_revision_term (contract_revision_id, term_type),
  CONSTRAINT fk_contract_term_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_contract_term_deviation CHECK (deviation_state IN ('UNCHANGED','CHANGED','ADDED','REMOVED')),
  CONSTRAINT chk_contract_term_approval CHECK (approval_state IN ('NOT_REQUIRED','REQUIRED','SUBMITTED','APPROVED','REJECTED','RETURNED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_clauses (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  clause_type VARCHAR(48) NOT NULL,
  title VARCHAR(255) NOT NULL,
  template_clause_reference VARCHAR(255) NULL,
  template_clause_version VARCHAR(64) NULL,
  clause_text LONGTEXT NOT NULL,
  risk_level VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
  is_material TINYINT(1) NOT NULL DEFAULT 0,
  clause_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_contract_clause_revision (contract_revision_id, sort_order),
  CONSTRAINT fk_contract_clause_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_contract_clause_risk CHECK (risk_level IN ('STANDARD','LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_contract_clause_status CHECK (clause_status IN ('ACTIVE','REMOVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_deviations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  object_type VARCHAR(24) NOT NULL,
  object_id BIGINT NULL,
  category VARCHAR(48) NOT NULL,
  baseline_json JSON NOT NULL,
  proposed_json JSON NOT NULL,
  affected_domains_json JSON NOT NULL,
  reason_codes_json JSON NOT NULL,
  required_action VARCHAR(48) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  is_blocking TINYINT(1) NOT NULL DEFAULT 1,
  approval_required TINYINT(1) NOT NULL DEFAULT 0,
  evidence_reference TEXT NULL,
  resolver_version VARCHAR(64) NOT NULL,
  created_by_user_id INT NULL,
  resolved_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  resolved_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  KEY idx_contract_deviation_queue (contract_revision_id, status, is_blocking),
  CONSTRAINT fk_contract_deviation_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_deviation_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_contract_deviation_resolver FOREIGN KEY (resolved_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_contract_deviation_status CHECK (status IN ('OPEN','SUBMITTED','APPROVED','REJECTED','RESOLVED','WITHDRAWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_approvals (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  contract_deviation_id BIGINT NULL,
  approval_type VARCHAR(40) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'SUBMITTED',
  requested_value_json JSON NOT NULL,
  baseline_value_json JSON NOT NULL,
  risk_snapshot_json JSON NOT NULL,
  reason TEXT NOT NULL,
  requester_user_id INT NOT NULL,
  approver_user_id INT NULL,
  decision_comment TEXT NULL,
  submitted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  decided_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_contract_approval_queue (status, approval_type, submitted_at),
  CONSTRAINT fk_contract_approval_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_approval_deviation FOREIGN KEY (contract_deviation_id) REFERENCES contract_deviations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_approval_requester FOREIGN KEY (requester_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_approval_approver FOREIGN KEY (approver_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_contract_approval_status CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','RETURNED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_documents (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  document_type VARCHAR(32) NOT NULL,
  generation_number INT NOT NULL,
  format VARCHAR(24) NOT NULL,
  template_reference VARCHAR(255) NULL,
  template_version VARCHAR(64) NULL,
  rendered_content LONGTEXT NULL,
  file_reference VARCHAR(1024) NULL,
  document_hash CHAR(64) NOT NULL,
  evidence_reference TEXT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  registered_by_user_id INT NULL,
  registered_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_document_idempotency (idempotency_key),
  UNIQUE KEY uq_contract_document_generation (contract_revision_id, document_type, generation_number),
  KEY idx_contract_document_revision (contract_revision_id, registered_at),
  CONSTRAINT fk_contract_document_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_document_registrar FOREIGN KEY (registered_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_contract_document_type CHECK (document_type IN ('GENERATED_DRAFT','CUSTOMER_DRAFT','SIGNED_EXECUTED','AMENDMENT','TERMINATION','OTHER')),
  CONSTRAINT chk_contract_document_format CHECK (format IN ('HTML','PDF','DOCX','CLIENT_SAFE_JSON','OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_external_sends (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  contract_document_id BIGINT NOT NULL,
  recipients_json JSON NOT NULL,
  channel VARCHAR(24) NOT NULL,
  subject_snapshot TEXT NULL,
  body_snapshot TEXT NULL,
  evidence_reference TEXT NOT NULL,
  sent_content_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  sent_by_user_id INT NULL,
  sent_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_send_idempotency (idempotency_key),
  KEY idx_contract_send_revision (contract_revision_id, sent_at),
  CONSTRAINT fk_contract_send_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_send_document FOREIGN KEY (contract_document_id) REFERENCES contract_documents (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_send_actor FOREIGN KEY (sent_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_contract_send_channel CHECK (channel IN ('EMAIL','PORTAL','MANUAL','OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_signatures (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_revision_id BIGINT NOT NULL,
  party_role VARCHAR(16) NOT NULL,
  signer_name VARCHAR(255) NOT NULL,
  signer_role VARCHAR(255) NULL,
  authority_basis TEXT NULL,
  signature_method VARCHAR(32) NOT NULL,
  signed_at DATETIME(6) NOT NULL,
  evidence_document_id BIGINT NULL,
  evidence_reference TEXT NOT NULL,
  verification_state VARCHAR(16) NOT NULL DEFAULT 'VERIFIED',
  idempotency_key VARCHAR(128) NOT NULL,
  registered_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_signature_idempotency (idempotency_key),
  UNIQUE KEY uq_contract_signature_party (contract_revision_id, party_role),
  CONSTRAINT fk_contract_signature_revision FOREIGN KEY (contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_signature_document FOREIGN KEY (evidence_document_id) REFERENCES contract_documents (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_signature_registrar FOREIGN KEY (registered_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_contract_signature_party CHECK (party_role IN ('COMPANY','CLIENT')),
  CONSTRAINT chk_contract_signature_method CHECK (signature_method IN ('WET_SIGNATURE','ELECTRONIC_SIGNATURE','MANUAL_EVIDENCE','ACKNOWLEDGED_PURCHASE_ORDER','SIGNED_QUOTATION','OTHER')),
  CONSTRAINT chk_contract_signature_state CHECK (verification_state IN ('PENDING','VERIFIED','REJECTED','REVOKED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_commitments (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_case_id BIGINT NOT NULL,
  effective_contract_revision_id BIGINT NOT NULL,
  contract_line_id BIGINT NOT NULL,
  source_accepted_line_id BIGINT NOT NULL,
  commitment_type VARCHAR(24) NOT NULL DEFAULT 'SUPPLY',
  party_snapshot_json JSON NOT NULL,
  subject_snapshot_json JSON NOT NULL,
  quantity DECIMAL(15,3) NOT NULL,
  uom VARCHAR(24) NOT NULL,
  unit_price DECIMAL(18,4) NOT NULL,
  currency CHAR(3) NOT NULL,
  line_total DECIMAL(20,4) NOT NULL,
  delivery_snapshot_json JSON NOT NULL,
  payment_snapshot_json JSON NOT NULL,
  legal_terms_snapshot_json JSON NOT NULL,
  upstream_trace_snapshot_json JSON NOT NULL,
  procurement_readiness VARCHAR(40) NOT NULL DEFAULT 'RECONFIRMATION_REQUIRED',
  readiness_reasons_json JSON NOT NULL,
  fulfillment_status VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED',
  commitment_hash CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_commitment_line (effective_contract_revision_id, contract_line_id),
  KEY idx_contract_commitment_case (contract_case_id, created_at),
  KEY idx_contract_commitment_source (source_accepted_line_id),
  CONSTRAINT fk_contract_commitment_case FOREIGN KEY (contract_case_id) REFERENCES contract_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_commitment_revision FOREIGN KEY (effective_contract_revision_id) REFERENCES contract_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_commitment_line FOREIGN KEY (contract_line_id) REFERENCES contract_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_commitment_source FOREIGN KEY (source_accepted_line_id) REFERENCES commercial_accepted_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_contract_commitment_type CHECK (commitment_type IN ('SUPPLY','SERVICE','OTHER')),
  CONSTRAINT chk_contract_procurement_readiness CHECK (procurement_readiness IN ('RECONFIRMATION_REQUIRED','READY_FOR_HANDOFF','BLOCKED')),
  CONSTRAINT chk_contract_fulfillment_status CHECK (fulfillment_status IN ('NOT_STARTED','IN_PROGRESS','FULFILLED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contract_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  contract_case_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id BIGINT NULL,
  actor_user_id INT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_contract_event_case (contract_case_id, created_at),
  CONSTRAINT fk_contract_event_case FOREIGN KEY (contract_case_id) REFERENCES contract_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_event_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('contracts.access', 'Просмотр Contract', 'Доступ к очереди и Contract Case workspace', 'contracts', 1300, 1, 0),
  ('contracts.manage', 'Управление Contract', 'Создание из immutable acceptance и редактирование draft revision', 'contracts', 1310, 1, 0),
  ('contracts.legal_review', 'Legal review Contract', 'Работа с юридическими условиями, clauses и deviations', 'contracts', 1320, 1, 0),
  ('contracts.approvals.request', 'Запрос Contract approval', 'Создание обоснованного запроса согласования', 'contracts', 1330, 1, 0),
  ('contracts.approvals.decide', 'Решение Contract approval', 'Approve, reject или return юридического отклонения', 'contracts', 1340, 1, 0),
  ('contracts.documents.manage', 'Документы Contract', 'Генерация и регистрация immutable document evidence', 'contracts', 1350, 1, 0),
  ('contracts.send_external', 'Отправка Contract', 'Фиксация внешней отправки и блокировка revision', 'contracts', 1360, 1, 0),
  ('contracts.sign', 'Подписание Contract', 'Регистрация provider-neutral signature evidence', 'contracts', 1370, 1, 0),
  ('contracts.make_effective', 'Ввод Contract в силу', 'Создание immutable Contract Commitments', 'contracts', 1380, 1, 0)
ON DUPLICATE KEY UPDATE
  name=VALUES(name), description=VALUES(description), section=VALUES(section),
  sort_order=VALUES(sort_order), is_active=VALUES(is_active), is_legacy=VALUES(is_legacy);

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key IN (
  'contracts.access','contracts.manage','contracts.legal_review','contracts.approvals.request',
  'contracts.approvals.decide','contracts.documents.manage','contracts.send_external',
  'contracts.sign','contracts.make_effective'
)
WHERE r.slug IN ('admin','nachalnik-otdela-zakupok')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key IN (
  'contracts.access','contracts.manage','contracts.legal_review','contracts.approvals.request',
  'contracts.documents.manage','contracts.send_external','contracts.sign'
)
WHERE r.slug='prodavec'
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key='contracts.access'
WHERE r.slug IN ('zakupshchik','specialist-po-katalogam','nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
