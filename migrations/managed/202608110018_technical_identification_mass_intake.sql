CREATE TABLE technical_identification_tasks (
  id INT NOT NULL AUTO_INCREMENT,
  task_number VARCHAR(64) NOT NULL,
  source_domain VARCHAR(32) NOT NULL DEFAULT 'client_request',
  client_request_id INT NOT NULL,
  client_request_revision_id INT NOT NULL,
  client_request_revision_item_id INT NOT NULL,
  source_stable_item_key CHAR(36) NOT NULL,
  source_snapshot_json JSON NOT NULL,
  source_hash CHAR(64) NOT NULL,
  candidate_snapshot_json JSON NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  due_at DATETIME(6) NULL,
  assigned_to_user_id INT NULL,
  blocker_code VARCHAR(64) NULL,
  blocker_note TEXT NULL,
  result_catalog_position_id INT NULL,
  resolution_type VARCHAR(32) NULL,
  resolution_note TEXT NULL,
  reopened_from_task_id INT NULL,
  active_source_key VARCHAR(160) NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by_user_id INT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  started_by_user_id INT NULL,
  started_at DATETIME(6) NULL,
  resolved_by_user_id INT NULL,
  resolved_at DATETIME(6) NULL,
  closed_by_user_id INT NULL,
  closed_at DATETIME(6) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ti_task_number (task_number),
  UNIQUE KEY uq_ti_active_source (active_source_key),
  KEY idx_ti_queue (status, priority, due_at, assigned_to_user_id, id),
  KEY idx_ti_request (client_request_id, client_request_revision_id, client_request_revision_item_id),
  KEY idx_ti_result_position (result_catalog_position_id),
  KEY idx_ti_reopened_from (reopened_from_task_id),
  CONSTRAINT fk_ti_request
    FOREIGN KEY (client_request_id) REFERENCES client_requests (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_ti_revision
    FOREIGN KEY (client_request_revision_id) REFERENCES client_request_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_ti_item
    FOREIGN KEY (client_request_revision_item_id) REFERENCES client_request_revision_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_ti_assignee
    FOREIGN KEY (assigned_to_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ti_result_position
    FOREIGN KEY (result_catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ti_reopened_from
    FOREIGN KEY (reopened_from_task_id) REFERENCES technical_identification_tasks (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ti_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_ti_started_by
    FOREIGN KEY (started_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ti_resolved_by
    FOREIGN KEY (resolved_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ti_closed_by
    FOREIGN KEY (closed_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_ti_status CHECK (status IN (
    'new', 'in_progress', 'waiting_client', 'resolved', 'cancelled', 'superseded'
  )),
  CONSTRAINT chk_ti_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT chk_ti_terminal_result CHECK (
    (status = 'resolved' AND result_catalog_position_id IS NOT NULL AND resolution_type IN ('reused_existing', 'created_new'))
    OR (status <> 'resolved')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE technical_identification_task_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  task_id INT NOT NULL,
  sequence_no INT UNSIGNED NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  actor_user_id INT NOT NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  payload_json JSON NULL,
  source_hash CHAR(64) NULL,
  idempotency_key VARCHAR(160) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ti_event_sequence (task_id, sequence_no),
  UNIQUE KEY uq_ti_event_idempotency (idempotency_key),
  KEY idx_ti_event_task_time (task_id, occurred_at, id),
  KEY idx_ti_event_actor (actor_user_id, occurred_at),
  CONSTRAINT fk_ti_event_task
    FOREIGN KEY (task_id) REFERENCES technical_identification_tasks (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_ti_event_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_request_intake_commands (
  id BIGINT NOT NULL AUTO_INCREMENT,
  idempotency_key VARCHAR(160) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'committed',
  client_request_id INT NOT NULL,
  client_request_revision_id INT NOT NULL,
  result_json JSON NOT NULL,
  created_by_user_id INT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cr_intake_idempotency (idempotency_key),
  KEY idx_cr_intake_request (client_request_id, client_request_revision_id),
  CONSTRAINT fk_cr_intake_request
    FOREIGN KEY (client_request_id) REFERENCES client_requests (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_cr_intake_revision
    FOREIGN KEY (client_request_revision_id) REFERENCES client_request_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_cr_intake_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_cr_intake_status CHECK (status IN ('committed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('technical_identification.access', 'Просмотр очереди идентификации', 'Очередь и история технической идентификации', 'technical_identification', 980, 1, 0),
  ('technical_identification.manage', 'Работа с идентификацией', 'Взятие задач в работу, уточнения и возврат в очередь', 'technical_identification', 981, 1, 0),
  ('technical_identification.assign', 'Назначение идентификации', 'Исполнитель, приоритет и срок задач идентификации', 'technical_identification', 982, 1, 0),
  ('technical_identification.resolve', 'Решение идентификации', 'Транзакционное связывание задачи с Catalog Position', 'technical_identification', 983, 1, 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  section = VALUES(section),
  sort_order = VALUES(sort_order),
  is_active = VALUES(is_active);

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key IN (
  'technical_identification.access',
  'technical_identification.manage',
  'technical_identification.assign',
  'technical_identification.resolve'
)
WHERE r.slug IN ('admin', 'nachalnik-otdela-zakupok', 'specialist-po-katalogam')
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key = 'technical_identification.access'
WHERE r.slug IN ('prodavec', 'zakupshchik', 'nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed = 1;
