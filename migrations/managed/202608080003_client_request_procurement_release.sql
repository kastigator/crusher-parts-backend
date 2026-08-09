ALTER TABLE client_requests
  ADD COLUMN client_contact_id INT NULL AFTER client_id,
  ADD COLUMN client_installation_id INT NULL AFTER client_contact_id,
  ADD COLUMN lifecycle_stage VARCHAR(32) NOT NULL DEFAULT 'intake' AFTER status,
  ADD COLUMN row_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER lifecycle_stage,
  ADD KEY idx_client_requests_lifecycle (lifecycle_stage, assigned_to_user_id, processing_deadline),
  ADD KEY idx_client_requests_contact (client_contact_id),
  ADD KEY idx_client_requests_installation (client_installation_id),
  ADD CONSTRAINT fk_client_requests_contact
    FOREIGN KEY (client_contact_id) REFERENCES client_contacts (id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_client_requests_installation
    FOREIGN KEY (client_installation_id) REFERENCES client_equipment_units (id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE client_request_revisions
  ADD COLUMN status VARCHAR(24) NOT NULL DEFAULT 'draft' AFTER rev_number,
  ADD COLUMN revision_reason VARCHAR(32) NOT NULL DEFAULT 'initial' AFTER status,
  ADD COLUMN created_from_revision_id INT NULL AFTER revision_reason,
  ADD COLUMN finalized_at DATETIME(6) NULL AFTER note,
  ADD COLUMN finalized_by_user_id INT NULL AFTER finalized_at,
  ADD COLUMN row_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER finalized_by_user_id,
  ADD KEY idx_cr_revisions_status (client_request_id, status, rev_number),
  ADD KEY idx_cr_revisions_created_from (created_from_revision_id),
  ADD KEY idx_cr_revisions_finalized_by (finalized_by_user_id),
  ADD CONSTRAINT fk_cr_revisions_created_from
    FOREIGN KEY (created_from_revision_id) REFERENCES client_request_revisions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_cr_revisions_finalized_by
    FOREIGN KEY (finalized_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE client_request_revision_items
  ADD COLUMN stable_item_key CHAR(36) NULL AFTER client_request_revision_id,
  ADD COLUMN item_status VARCHAR(24) NOT NULL DEFAULT 'active' AFTER line_number,
  ADD COLUMN client_manufacturer_text VARCHAR(255) NULL AFTER equipment_model_id,
  ADD COLUMN client_equipment_model_text VARCHAR(255) NULL AFTER client_manufacturer_text,
  ADD COLUMN client_catalog_number VARCHAR(150) NULL AFTER client_equipment_model_text,
  ADD COLUMN source_payload_json JSON NULL AFTER internal_comment,
  ADD COLUMN updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6) AFTER created_at,
  ADD KEY idx_cr_items_status (client_request_revision_id, item_status, line_number);

ALTER TABLE client_request_events
  ADD COLUMN revision_id INT NULL AFTER client_request_id,
  ADD COLUMN item_id INT NULL AFTER revision_id,
  ADD COLUMN entity_type VARCHAR(60) NULL AFTER event_type,
  ADD COLUMN entity_id INT NULL AFTER entity_type,
  ADD COLUMN old_values_json JSON NULL AFTER actor_user_id,
  ADD COLUMN new_values_json JSON NULL AFTER old_values_json,
  ADD KEY idx_cr_events_revision (revision_id, created_at),
  ADD KEY idx_cr_events_item (item_id, created_at),
  ADD KEY idx_cr_events_entity (entity_type, entity_id, created_at);

CREATE TABLE client_request_item_identifications (
  id INT NOT NULL AUTO_INCREMENT,
  client_request_revision_item_id INT NOT NULL,
  catalog_position_id INT NULL,
  identification_status VARCHAR(32) NOT NULL DEFAULT 'unprocessed',
  match_method VARCHAR(32) NULL,
  confidence DECIMAL(5,2) NULL,
  basis_note TEXT NULL,
  confirmed_by_user_id INT NULL,
  confirmed_at DATETIME(6) NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cr_identification_item (client_request_revision_item_id),
  KEY idx_cr_identification_status (identification_status, catalog_position_id),
  KEY idx_cr_identification_catalog_position (catalog_position_id),
  KEY idx_cr_identification_confirmed_by (confirmed_by_user_id),
  CONSTRAINT fk_cr_identification_item
    FOREIGN KEY (client_request_revision_item_id) REFERENCES client_request_revision_items (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_cr_identification_catalog_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_cr_identification_confirmed_by
    FOREIGN KEY (confirmed_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_cr_identification_status CHECK (identification_status IN (
    'unprocessed', 'suggested', 'needs_review', 'confirmed',
    'needs_client_clarification', 'technical_task_open', 'not_required'
  )),
  CONSTRAINT chk_cr_identification_confidence CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 100)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_request_item_requirements (
  id INT NOT NULL AUTO_INCREMENT,
  client_request_revision_item_id INT NOT NULL,
  substitution_policy VARCHAR(40) NOT NULL DEFAULT 'unspecified',
  required_manufacturer_id INT NULL,
  required_brand_text VARCHAR(150) NULL,
  manufacture_to_drawing_allowed TINYINT(1) NOT NULL DEFAULT 0,
  kit_allowed TINYINT(1) NOT NULL DEFAULT 0,
  partial_supply_allowed TINYINT(1) NOT NULL DEFAULT 0,
  required_documents_json JSON NULL,
  technical_requirements TEXT NULL,
  procurement_note TEXT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cr_requirements_item (client_request_revision_item_id),
  KEY idx_cr_requirements_manufacturer (required_manufacturer_id),
  CONSTRAINT fk_cr_requirements_item
    FOREIGN KEY (client_request_revision_item_id) REFERENCES client_request_revision_items (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_cr_requirements_manufacturer
    FOREIGN KEY (required_manufacturer_id) REFERENCES equipment_manufacturers (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_cr_requirements_policy CHECK (substitution_policy IN (
    'exact_only', 'equivalent_requires_approval', 'equivalent_allowed',
    'open_to_proposals', 'unspecified'
  )),
  CONSTRAINT chk_cr_requirements_flags CHECK (
    manufacture_to_drawing_allowed IN (0, 1)
    AND kit_allowed IN (0, 1)
    AND partial_supply_allowed IN (0, 1)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_releases (
  id INT NOT NULL AUTO_INCREMENT,
  release_key VARCHAR(120) NOT NULL,
  client_request_id INT NOT NULL,
  client_request_revision_id INT NOT NULL,
  release_number INT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'released',
  title VARCHAR(255) NULL,
  note TEXT NULL,
  requested_procurement_owner_id INT NULL,
  released_by_user_id INT NULL,
  released_at DATETIME(6) NOT NULL,
  cancelled_by_user_id INT NULL,
  cancelled_at DATETIME(6) NULL,
  cancel_reason TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_release_key (release_key),
  UNIQUE KEY uq_procurement_release_number (client_request_id, release_number),
  KEY idx_procurement_release_revision (client_request_revision_id, status),
  KEY idx_procurement_release_owner (requested_procurement_owner_id, status, released_at),
  CONSTRAINT fk_procurement_release_request
    FOREIGN KEY (client_request_id) REFERENCES client_requests (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_release_revision
    FOREIGN KEY (client_request_revision_id) REFERENCES client_request_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_release_owner
    FOREIGN KEY (requested_procurement_owner_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_release_released_by
    FOREIGN KEY (released_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_release_cancelled_by
    FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_release_status CHECK (status IN ('released', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE procurement_release_items (
  id INT NOT NULL AUTO_INCREMENT,
  procurement_release_id INT NOT NULL,
  client_request_revision_item_id INT NOT NULL,
  stable_item_key_snapshot CHAR(36) NOT NULL,
  line_number_snapshot INT NOT NULL,
  catalog_position_id_snapshot INT NULL,
  requested_quantity_snapshot DECIMAL(15,3) NOT NULL,
  uom_snapshot VARCHAR(16) NOT NULL,
  source_data_snapshot_json JSON NOT NULL,
  identification_snapshot_json JSON NOT NULL,
  requirements_snapshot_json JSON NOT NULL,
  document_refs_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_release_item (procurement_release_id, client_request_revision_item_id),
  KEY idx_procurement_release_item_source (client_request_revision_item_id),
  KEY idx_procurement_release_item_catalog (catalog_position_id_snapshot),
  CONSTRAINT fk_procurement_release_item_release
    FOREIGN KEY (procurement_release_id) REFERENCES procurement_releases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_release_item_source
    FOREIGN KEY (client_request_revision_item_id) REFERENCES client_request_revision_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_procurement_release_item_catalog
    FOREIGN KEY (catalog_position_id_snapshot) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_procurement_release_item_qty CHECK (requested_quantity_snapshot > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE rfqs
  ADD COLUMN procurement_release_id INT NULL AFTER client_request_revision_id,
  ADD KEY idx_rfqs_procurement_release (procurement_release_id),
  ADD CONSTRAINT fk_rfqs_procurement_release
    FOREIGN KEY (procurement_release_id) REFERENCES procurement_releases (id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE rfq_items
  ADD COLUMN procurement_release_item_id INT NULL AFTER client_request_revision_item_id,
  ADD KEY idx_rfq_items_procurement_release_item (procurement_release_item_id),
  ADD CONSTRAINT fk_rfq_items_procurement_release_item
    FOREIGN KEY (procurement_release_item_id) REFERENCES procurement_release_items (id) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO client_request_revisions
  (client_request_id, rev_number, status, revision_reason, created_by_user_id, note, created_at)
SELECT cr.id, 1, 'draft', 'initial', cr.created_by_user_id,
       'Migration-created revision 1 for a legacy request without revisions', cr.created_at
FROM client_requests cr
WHERE NOT EXISTS (
  SELECT 1 FROM client_request_revisions r WHERE r.client_request_id = cr.id
);

UPDATE client_requests cr
SET current_revision_id = (
  SELECT MAX(r.id) FROM client_request_revisions r WHERE r.client_request_id = cr.id
)
WHERE cr.current_revision_id IS NULL;

UPDATE client_requests cr
LEFT JOIN client_contacts cc
  ON cc.id = (
    SELECT MIN(cc2.id)
    FROM client_contacts cc2
    WHERE cc2.client_id = cr.client_id
      AND cr.contact_name IS NOT NULL
      AND LOWER(TRIM(cc2.name)) = LOWER(TRIM(cr.contact_name))
  )
SET cr.client_contact_id = cc.id
WHERE cr.client_contact_id IS NULL AND cc.id IS NOT NULL;

UPDATE client_requests cr
SET cr.lifecycle_stage = CASE
  WHEN cr.status = 'archived' THEN 'archived'
  WHEN cr.released_to_procurement_at IS NOT NULL THEN 'released'
  WHEN EXISTS (
    SELECT 1 FROM client_request_revision_items i
    WHERE i.client_request_revision_id = cr.current_revision_id
  ) THEN 'identification'
  ELSE 'intake'
END;

UPDATE client_request_revisions r
JOIN client_requests cr ON cr.id = r.client_request_id
SET r.status = CASE
      WHEN r.id <> cr.current_revision_id THEN 'finalized'
      WHEN cr.released_to_procurement_at IS NOT NULL THEN 'finalized'
      ELSE 'draft'
    END,
    r.revision_reason = CASE WHEN r.rev_number = 1 THEN 'initial' ELSE 'client_update' END,
    r.finalized_at = CASE
      WHEN r.id <> cr.current_revision_id OR cr.released_to_procurement_at IS NOT NULL
      THEN COALESCE(cr.released_to_procurement_at, r.created_at)
      ELSE NULL
    END,
    r.finalized_by_user_id = CASE
      WHEN r.id <> cr.current_revision_id OR cr.released_to_procurement_at IS NOT NULL
      THEN COALESCE(cr.released_to_procurement_by_user_id, r.created_by_user_id)
      ELSE NULL
    END;

UPDATE client_request_revision_items
SET stable_item_key = UUID()
WHERE stable_item_key IS NULL;

ALTER TABLE client_request_revision_items
  MODIFY COLUMN stable_item_key CHAR(36) NOT NULL,
  ADD UNIQUE KEY uq_cr_items_stable_key_per_revision (client_request_revision_id, stable_item_key);

INSERT INTO client_request_item_identifications
  (client_request_revision_item_id, catalog_position_id, identification_status,
   match_method, basis_note, confirmed_at)
SELECT i.id,
       COALESCE(i.catalog_position_id, i.oem_part_id),
       CASE WHEN COALESCE(i.catalog_position_id, i.oem_part_id) IS NULL
            THEN 'unprocessed' ELSE 'confirmed' END,
       CASE WHEN COALESCE(i.catalog_position_id, i.oem_part_id) IS NULL
            THEN NULL ELSE 'legacy_link' END,
       CASE WHEN COALESCE(i.catalog_position_id, i.oem_part_id) IS NULL
            THEN NULL ELSE 'Backfilled from the validated legacy catalog link' END,
       CASE WHEN COALESCE(i.catalog_position_id, i.oem_part_id) IS NULL
            THEN NULL ELSE i.created_at END
FROM client_request_revision_items i;

INSERT INTO client_request_item_requirements
  (client_request_revision_item_id, substitution_policy, manufacture_to_drawing_allowed,
   kit_allowed, partial_supply_allowed, procurement_note)
SELECT i.id,
       CASE WHEN i.oem_only = 1 THEN 'exact_only' ELSE 'unspecified' END,
       0, 0, 0, i.internal_comment
FROM client_request_revision_items i;

INSERT INTO procurement_releases
  (release_key, client_request_id, client_request_revision_id, release_number,
   status, title, note, released_by_user_id, released_at, created_at)
SELECT CONCAT('legacy-request-', cr.id, '-release-1'),
       cr.id, cr.current_revision_id, 1, 'released',
       CONCAT('Legacy release for ', cr.internal_number),
       'Immutable snapshot backfilled from released_to_procurement_at during Wave 2',
       cr.released_to_procurement_by_user_id,
       cr.released_to_procurement_at,
       cr.released_to_procurement_at
FROM client_requests cr
WHERE cr.released_to_procurement_at IS NOT NULL
  AND cr.current_revision_id IS NOT NULL;

INSERT INTO procurement_release_items
  (procurement_release_id, client_request_revision_item_id, stable_item_key_snapshot,
   line_number_snapshot, catalog_position_id_snapshot, requested_quantity_snapshot,
   uom_snapshot, source_data_snapshot_json, identification_snapshot_json,
   requirements_snapshot_json, document_refs_snapshot_json, created_at)
SELECT pr.id, i.id, i.stable_item_key, i.line_number,
       COALESCE(i.catalog_position_id, i.oem_part_id), i.requested_qty,
       COALESCE(NULLIF(TRIM(i.uom), ''), 'шт'),
       JSON_OBJECT(
         'client_part_number', i.client_part_number,
         'client_description', i.client_description,
         'client_line_text', i.client_line_text,
         'required_date', i.required_date,
         'priority', i.priority,
         'client_comment', i.client_comment
       ),
       JSON_OBJECT(
         'catalog_position_id', ident.catalog_position_id,
         'status', ident.identification_status,
         'match_method', ident.match_method,
         'basis_note', ident.basis_note
       ),
       JSON_OBJECT(
         'substitution_policy', reqs.substitution_policy,
         'required_manufacturer_id', reqs.required_manufacturer_id,
         'required_brand_text', reqs.required_brand_text,
         'manufacture_to_drawing_allowed', reqs.manufacture_to_drawing_allowed,
         'kit_allowed', reqs.kit_allowed,
         'partial_supply_allowed', reqs.partial_supply_allowed,
         'required_documents', reqs.required_documents_json,
         'technical_requirements', reqs.technical_requirements,
         'procurement_note', reqs.procurement_note
       ),
       JSON_ARRAY(), pr.released_at
FROM procurement_releases pr
JOIN client_request_revision_items i
  ON i.client_request_revision_id = pr.client_request_revision_id
LEFT JOIN client_request_item_identifications ident
  ON ident.client_request_revision_item_id = i.id
LEFT JOIN client_request_item_requirements reqs
  ON reqs.client_request_revision_item_id = i.id
WHERE pr.release_key LIKE 'legacy-request-%-release-1';

UPDATE rfqs r
JOIN procurement_releases pr
  ON pr.client_request_id = r.client_request_id
 AND pr.release_number = 1
SET r.procurement_release_id = pr.id
WHERE r.procurement_release_id IS NULL;

UPDATE rfq_items ri
JOIN procurement_release_items pri
  ON pri.client_request_revision_item_id = ri.client_request_revision_item_id
JOIN rfqs r
  ON r.id = ri.rfq_id AND r.procurement_release_id = pri.procurement_release_id
SET ri.procurement_release_item_id = pri.id
WHERE ri.procurement_release_item_id IS NULL;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('client_requests.access', 'Просмотр заявок клиентов', 'Открытие реестра и read models Client Request', 'client_requests', 900, 1, 0),
  ('client_requests.create', 'Создание заявок клиентов', 'Создание заявки вместе с первой ревизией', 'client_requests', 910, 1, 0),
  ('client_requests.edit_header', 'Изменение реквизитов заявки', 'Изменение ответственного, сроков и рабочих реквизитов', 'client_requests', 920, 1, 0),
  ('client_requests.manage_revisions', 'Управление ревизиями заявки', 'Создание, импорт, изменение состава и финализация ревизий', 'client_requests', 930, 1, 0),
  ('client_requests.identify_items', 'Идентификация позиций заявки', 'Связь строк заявки с подтвержденной Catalog Position', 'client_requests', 940, 1, 0),
  ('client_requests.manage_requirements', 'Управление требованиями заявки', 'Ведение request-specific закупочных и технических требований', 'client_requests', 950, 1, 0),
  ('client_requests.release_to_procurement', 'Выпуск потребности в закупку', 'Создание immutable Procurement Release по готовым строкам', 'client_requests', 960, 1, 0),
  ('client_requests.archive', 'Архивирование заявок клиентов', 'Перевод заявки в архив без удаления истории', 'client_requests', 970, 1, 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description), section = VALUES(section),
  sort_order = VALUES(sort_order), is_active = 1, is_legacy = 0;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c
  ON c.capability_key IN (
    'client_requests.access', 'client_requests.create', 'client_requests.edit_header',
    'client_requests.manage_revisions', 'client_requests.identify_items',
    'client_requests.manage_requirements', 'client_requests.release_to_procurement',
    'client_requests.archive'
  )
WHERE r.slug IN ('admin', 'prodavec', 'nachalnik-otdela-zakupok')
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key = 'client_requests.access'
WHERE r.slug IN ('zakupshchik', 'specialist-po-katalogam', 'nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1
FROM roles r
JOIN capabilities c ON c.capability_key = 'client_requests.identify_items'
WHERE r.slug = 'specialist-po-katalogam'
ON DUPLICATE KEY UPDATE is_allowed = 1;
