CREATE TABLE completion_policies (
  id BIGINT NOT NULL AUTO_INCREMENT,
  policy_code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  case_type VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  current_revision_id BIGINT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_completion_policy_code (policy_code),
  CONSTRAINT fk_completion_policy_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_completion_policy_status CHECK (status IN ('ACTIVE','RETIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE completion_policy_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  completion_policy_id BIGINT NOT NULL,
  revision_number INT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  policy_snapshot_json JSON NOT NULL,
  policy_hash CHAR(64) NOT NULL,
  effective_at DATETIME(6) NOT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_completion_policy_revision (completion_policy_id,revision_number),
  UNIQUE KEY uq_completion_policy_hash (completion_policy_id,policy_hash),
  CONSTRAINT fk_completion_policy_revision_policy FOREIGN KEY (completion_policy_id) REFERENCES completion_policies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_policy_revision_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_completion_policy_revision_status CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE completion_policies ADD CONSTRAINT fk_completion_policy_current_revision
  FOREIGN KEY (current_revision_id) REFERENCES completion_policy_revisions(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE completion_policy_rules (
  id BIGINT NOT NULL AUTO_INCREMENT,
  completion_policy_revision_id BIGINT NOT NULL,
  gate_code VARCHAR(64) NOT NULL,
  gate_requirement VARCHAR(24) NOT NULL,
  configuration_json JSON NOT NULL,
  sort_order INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_completion_policy_gate (completion_policy_revision_id,gate_code),
  CONSTRAINT fk_completion_policy_rule_revision FOREIGN KEY (completion_policy_revision_id) REFERENCES completion_policy_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_completion_policy_gate_requirement CHECK (gate_requirement IN ('REQUIRED','OPTIONAL','NOT_APPLICABLE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE completion_cases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  case_number VARCHAR(80) NOT NULL,
  contract_case_id BIGINT NOT NULL,
  completion_policy_revision_id BIGINT NOT NULL,
  lifecycle_state VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  lifecycle_revision_number INT UNSIGNED NOT NULL DEFAULT 1,
  last_evaluation_id BIGINT NULL,
  latest_snapshot_id BIGINT NULL,
  closed_at DATETIME(6) NULL,
  closed_by_user_id INT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_completion_case_number (case_number),
  UNIQUE KEY uq_completion_contract_case (contract_case_id),
  KEY idx_completion_active_queue (lifecycle_state,updated_at),
  CONSTRAINT fk_completion_case_contract FOREIGN KEY (contract_case_id) REFERENCES contract_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_case_policy_revision FOREIGN KEY (completion_policy_revision_id) REFERENCES completion_policy_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_case_closer FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_completion_case_state CHECK (lifecycle_state IN ('ACTIVE','READY_TO_CLOSE','CLOSED','REOPENED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE completion_evaluations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  completion_case_id BIGINT NOT NULL,
  lifecycle_revision_number INT UNSIGNED NOT NULL,
  readiness_state VARCHAR(24) NOT NULL,
  completion_policy_revision_id BIGINT NOT NULL,
  policy_snapshot_json JSON NOT NULL,
  policy_hash CHAR(64) NOT NULL,
  source_snapshot_json JSON NOT NULL,
  blockers_json JSON NOT NULL,
  warnings_json JSON NOT NULL,
  evaluation_hash CHAR(64) NOT NULL,
  evaluated_by_user_id INT NULL,
  evaluated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_completion_evaluation_case (completion_case_id,evaluated_at,id),
  CONSTRAINT fk_completion_evaluation_case FOREIGN KEY (completion_case_id) REFERENCES completion_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_evaluation_policy FOREIGN KEY (completion_policy_revision_id) REFERENCES completion_policy_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_evaluation_actor FOREIGN KEY (evaluated_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_completion_evaluation_state CHECK (readiness_state IN ('NOT_READY','READY_TO_CLOSE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE completion_snapshots (
  id BIGINT NOT NULL AUTO_INCREMENT,
  completion_case_id BIGINT NOT NULL,
  closure_sequence INT UNSIGNED NOT NULL,
  lifecycle_revision_number INT UNSIGNED NOT NULL,
  completion_evaluation_id BIGINT NOT NULL,
  completion_policy_revision_id BIGINT NOT NULL,
  policy_snapshot_json JSON NOT NULL,
  policy_hash CHAR(64) NOT NULL,
  completion_snapshot_json JSON NOT NULL,
  traceability_snapshot_json JSON NOT NULL,
  snapshot_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  closed_by_user_id INT NULL,
  closed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_completion_snapshot_sequence (completion_case_id,closure_sequence),
  UNIQUE KEY uq_completion_snapshot_idempotency (idempotency_key),
  KEY idx_completion_snapshot_history (completion_case_id,closed_at,id),
  CONSTRAINT fk_completion_snapshot_case FOREIGN KEY (completion_case_id) REFERENCES completion_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_snapshot_evaluation FOREIGN KEY (completion_evaluation_id) REFERENCES completion_evaluations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_snapshot_policy FOREIGN KEY (completion_policy_revision_id) REFERENCES completion_policy_revisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_snapshot_actor FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE completion_cases
  ADD CONSTRAINT fk_completion_case_last_evaluation FOREIGN KEY (last_evaluation_id) REFERENCES completion_evaluations(id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_completion_case_latest_snapshot FOREIGN KEY (latest_snapshot_id) REFERENCES completion_snapshots(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE completion_lifecycle_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  completion_case_id BIGINT NOT NULL,
  lifecycle_revision_number INT UNSIGNED NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  completion_snapshot_id BIGINT NULL,
  reason_code VARCHAR(80) NULL,
  explanation TEXT NULL,
  evidence_reference VARCHAR(1000) NULL,
  actor_user_id INT NULL,
  payload_json JSON NOT NULL,
  event_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_completion_event_idempotency (idempotency_key),
  KEY idx_completion_event_case (completion_case_id,occurred_at,id),
  CONSTRAINT fk_completion_event_case FOREIGN KEY (completion_case_id) REFERENCES completion_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_event_snapshot FOREIGN KEY (completion_snapshot_id) REFERENCES completion_snapshots(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_completion_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO completion_policies(policy_code,name,case_type,status)
VALUES('STANDARD_SALES_V1','Standard sales closure policy','STANDARD_SALES','ACTIVE');

INSERT INTO completion_policy_revisions(completion_policy_id,revision_number,status,policy_snapshot_json,policy_hash,effective_at)
SELECT id,1,'ACTIVE',
  JSON_OBJECT('case_type','STANDARD_SALES','policy_code','STANDARD_SALES_V1','rules',JSON_ARRAY(
    JSON_OBJECT('gate_code','CONTRACT_LEGAL','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','FULFILLMENT','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','PROCUREMENT','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','WAREHOUSE','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','DISPATCH','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','AP','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','AR','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','CLAIMS_COMPLIANCE','requirement','REQUIRED'),
    JSON_OBJECT('gate_code','REQUIRED_DOCUMENTS','requirement','OPTIONAL')
  ),'version',1),
  'af2c673c7c410232dd062a862378e8ec9fc5917def2914ff9fbf488a2bb87ffb',CURRENT_TIMESTAMP(6)
FROM completion_policies WHERE policy_code='STANDARD_SALES_V1';

UPDATE completion_policies p JOIN completion_policy_revisions r ON r.completion_policy_id=p.id AND r.revision_number=1
SET p.current_revision_id=r.id WHERE p.policy_code='STANDARD_SALES_V1';

INSERT INTO completion_policy_rules(completion_policy_revision_id,gate_code,gate_requirement,configuration_json,sort_order)
SELECT r.id,g.gate_code,g.gate_requirement,JSON_OBJECT(),g.sort_order
FROM completion_policy_revisions r
JOIN completion_policies p ON p.id=r.completion_policy_id AND p.policy_code='STANDARD_SALES_V1'
JOIN (
  SELECT 'CONTRACT_LEGAL' gate_code,'REQUIRED' gate_requirement,10 sort_order UNION ALL
  SELECT 'FULFILLMENT','REQUIRED',20 UNION ALL SELECT 'PROCUREMENT','REQUIRED',30 UNION ALL
  SELECT 'WAREHOUSE','REQUIRED',40 UNION ALL SELECT 'DISPATCH','REQUIRED',50 UNION ALL
  SELECT 'AP','REQUIRED',60 UNION ALL SELECT 'AR','REQUIRED',70 UNION ALL
  SELECT 'CLAIMS_COMPLIANCE','REQUIRED',80 UNION ALL SELECT 'REQUIRED_DOCUMENTS','OPTIONAL',90
) g;

INSERT INTO completion_cases(case_number,contract_case_id,completion_policy_revision_id,lifecycle_state)
SELECT CONCAT('COMP-',LPAD(c.id,8,'0')),c.id,r.id,'ACTIVE'
FROM contract_cases c
JOIN completion_policies p ON p.policy_code='STANDARD_SALES_V1'
JOIN completion_policy_revisions r ON r.id=p.current_revision_id
WHERE c.aggregate_status='EFFECTIVE';

INSERT INTO capabilities(capability_key,name,description,section,sort_order,is_active,is_legacy) VALUES
 ('completion.access','Просмотр Completion & Lifecycle','Active, ready, closed and historical completion cases','completion',1820,1,0),
 ('completion.readiness.evaluate','Оценка closure readiness','Persist deterministic policy-based readiness evaluation','completion',1830,1,0),
 ('completion.close','Закрытие case','Explicit atomic close with immutable completion snapshot','completion',1840,1,0),
 ('completion.reopen','Исключительное reopen','Audited exceptional reopen without snapshot mutation','completion',1850,1,0),
 ('completion.history.view','История Completion','Snapshots, policy evidence and lifecycle revisions','completion',1860,1,0)
ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),section=VALUES(section),sort_order=VALUES(sort_order),is_active=1,is_legacy=0;

INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.section='completion'
WHERE r.slug IN ('admin','nachalnik-otdela-zakupok') ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN ('completion.access','completion.readiness.evaluate','completion.close','completion.history.view')
WHERE r.slug='prodavec' ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);

INSERT INTO role_capabilities(role_id,capability_id,is_allowed)
SELECT r.id,c.id,1 FROM roles r JOIN capabilities c ON c.capability_key IN ('completion.access','completion.history.view')
WHERE r.slug IN ('zakupshchik','finansist','kladovshchik','logist','nablyudatel') ON DUPLICATE KEY UPDATE is_allowed=VALUES(is_allowed);
