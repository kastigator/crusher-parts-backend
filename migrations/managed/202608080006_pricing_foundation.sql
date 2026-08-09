CREATE TABLE pricing_block_definitions (
  block_key VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (block_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO pricing_block_definitions (block_key, name, description) VALUES
  ('INITIAL_COST', 'Initial purchase cost', 'Immutable Supplier Offer price multiplied by purchase quantity'),
  ('FX_CONVERSION', 'FX conversion', 'Conversion using the calculation revision FX snapshot'),
  ('GROUP_FIXED_COST', 'Group fixed costs', 'Freight and other group costs allocated deterministically'),
  ('CUSTOMS_DUTY', 'Customs duty', 'Duty calculated from converted goods value and snapshotted rate'),
  ('TARGET_MARKUP', 'Target markup', 'Target selling price from landed unit cost and markup policy'),
  ('ROUNDING', 'Commercial rounding', 'Deterministic rounding to the configured increment'),
  ('VALIDATION_CHECKPOINT', 'Validation checkpoint', 'Required-data and reproducibility checks');

CREATE TABLE pricing_route_templates (
  id BIGINT NOT NULL AUTO_INCREMENT,
  template_code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  legacy_logistics_route_template_id INT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_route_template_code (template_code),
  UNIQUE KEY uq_pricing_route_template_legacy (legacy_logistics_route_template_id),
  CONSTRAINT fk_pricing_route_template_legacy FOREIGN KEY (legacy_logistics_route_template_id) REFERENCES logistics_route_templates (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_route_template_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_route_template_status CHECK (status IN ('DRAFT','VALIDATION_FAILED','READY_FOR_APPROVAL','PUBLISHED','RETIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_route_template_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_route_template_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(24) NOT NULL,
  definition_snapshot_json JSON NOT NULL,
  definition_hash CHAR(64) NOT NULL,
  published_by_user_id INT NULL,
  published_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_route_template_revision (pricing_route_template_id, revision_number),
  CONSTRAINT fk_pricing_route_revision_template FOREIGN KEY (pricing_route_template_id) REFERENCES pricing_route_templates (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_route_revision_published_by FOREIGN KEY (published_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_route_revision_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_route_revision_status CHECK (status IN ('DRAFT','VALIDATION_FAILED','READY_FOR_APPROVAL','PUBLISHED','RETIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_route_template_blocks (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_route_template_revision_id BIGINT NOT NULL,
  sequence_number INT NOT NULL,
  block_key VARCHAR(64) NOT NULL,
  configuration_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_route_revision_block (pricing_route_template_revision_id, sequence_number),
  CONSTRAINT fk_pricing_route_block_revision FOREIGN KEY (pricing_route_template_revision_id) REFERENCES pricing_route_template_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_route_block_definition FOREIGN KEY (block_key) REFERENCES pricing_block_definitions (block_key) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO pricing_route_templates (template_code, name, status, legacy_logistics_route_template_id)
SELECT CONCAT('LEGACY-', id), name, 'PUBLISHED', id FROM logistics_route_templates WHERE is_active = 1;

INSERT INTO pricing_route_template_revisions
  (pricing_route_template_id, revision_number, status, definition_snapshot_json, definition_hash, published_at)
SELECT pt.id, 1, 'PUBLISHED',
       JSON_OBJECT('source', 'legacy_logistics_route_template', 'legacy_template_id', lt.id,
                   'legacy_version', lt.version_no, 'pricing_model', lt.pricing_model,
                   'currency', lt.currency, 'fixed_cost', lt.fixed_cost,
                   'rate_per_kg', lt.rate_per_kg, 'rate_per_cbm', lt.rate_per_cbm,
                   'min_cost', lt.min_cost, 'markup_pct', lt.markup_pct,
                   'markup_fixed', lt.markup_fixed, 'eta_min_days', lt.eta_min_days,
                   'eta_max_days', lt.eta_max_days, 'corridor_id', lt.corridor_id),
       SHA2(CONCAT_WS('|', lt.id, lt.version_no, lt.pricing_model, lt.currency,
                      COALESCE(lt.fixed_cost, ''), COALESCE(lt.rate_per_kg, ''),
                      COALESCE(lt.rate_per_cbm, ''), COALESCE(lt.min_cost, ''),
                      lt.markup_pct, lt.markup_fixed, COALESCE(lt.eta_min_days, ''),
                      COALESCE(lt.eta_max_days, ''), lt.corridor_id), 256),
       CURRENT_TIMESTAMP(6)
FROM pricing_route_templates pt
JOIN logistics_route_templates lt ON lt.id = pt.legacy_logistics_route_template_id;

INSERT INTO pricing_route_template_blocks
  (pricing_route_template_revision_id, sequence_number, block_key, configuration_snapshot_json)
SELECT r.id, sequence_number, block_key, JSON_OBJECT('source', 'validated_legacy_pricing_pipeline')
FROM pricing_route_template_revisions r
JOIN (
  SELECT 10 sequence_number, 'INITIAL_COST' block_key UNION ALL
  SELECT 20, 'FX_CONVERSION' UNION ALL SELECT 30, 'GROUP_FIXED_COST' UNION ALL
  SELECT 40, 'CUSTOMS_DUTY' UNION ALL SELECT 50, 'TARGET_MARKUP' UNION ALL
  SELECT 60, 'ROUNDING' UNION ALL SELECT 70, 'VALIDATION_CHECKPOINT'
) blocks
WHERE r.status = 'PUBLISHED';

CREATE TABLE pricing_cases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  case_number VARCHAR(64) NOT NULL,
  sourcing_decision_id BIGINT NOT NULL,
  sourcing_case_id BIGINT NOT NULL,
  client_request_id INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'INTAKE_REVIEW',
  title VARCHAR(255) NOT NULL,
  calculation_currency CHAR(3) NOT NULL DEFAULT 'USD',
  owner_user_id INT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  fixed_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_case_number (case_number),
  UNIQUE KEY uq_pricing_case_sourcing_decision (sourcing_decision_id),
  KEY idx_pricing_case_queue (status, owner_user_id, updated_at),
  CONSTRAINT fk_pricing_case_sourcing_decision FOREIGN KEY (sourcing_decision_id) REFERENCES sourcing_decisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_case_sourcing_case FOREIGN KEY (sourcing_case_id) REFERENCES sourcing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_case_client_request FOREIGN KEY (client_request_id) REFERENCES client_requests (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_case_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_case_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_case_status CHECK (status IN ('INTAKE_REVIEW','ROUTING','PARAMETER_COLLECTION','CALCULATED','COMPARISON','APPROVAL','FIXED','BLOCKED','SUPERSEDED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_input_snapshots (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_case_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  sourcing_decision_id BIGINT NOT NULL,
  sourcing_decision_revision_number INT NOT NULL,
  snapshot_hash CHAR(64) NULL,
  fixed_by_user_id INT NULL,
  fixed_at DATETIME(6) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_input_revision (pricing_case_id, revision_number),
  KEY idx_pricing_input_source (sourcing_decision_id),
  CONSTRAINT fk_pricing_input_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_decision FOREIGN KEY (sourcing_decision_id) REFERENCES sourcing_decisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_fixed_by FOREIGN KEY (fixed_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_input_status CHECK (status IN ('DRAFT','READY','FIXED','OUTDATED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_supplier_aliases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_case_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  supplier_alias VARCHAR(80) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_supplier_alias_supplier (pricing_case_id, supplier_id),
  UNIQUE KEY uq_pricing_supplier_alias_value (pricing_case_id, supplier_alias),
  CONSTRAINT fk_pricing_supplier_alias_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_supplier_alias_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_input_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_input_snapshot_id BIGINT NOT NULL,
  sourcing_decision_line_id BIGINT NOT NULL,
  sourcing_demand_id BIGINT NOT NULL,
  procurement_release_item_id INT NOT NULL,
  client_request_revision_item_id INT NOT NULL,
  stable_item_key_snapshot CHAR(36) NOT NULL,
  line_number_snapshot INT NOT NULL,
  requested_catalog_position_id INT NULL,
  offered_catalog_position_id INT NULL,
  supplier_offer_line_id BIGINT NOT NULL,
  supplier_id INT NOT NULL,
  supplier_part_id INT NULL,
  supplier_alias VARCHAR(80) NOT NULL,
  requested_quantity DECIMAL(15,3) NOT NULL,
  client_quantity DECIMAL(15,3) NOT NULL,
  purchase_quantity DECIMAL(15,3) NOT NULL,
  uom_snapshot VARCHAR(16) NOT NULL,
  purchase_unit_price DECIMAL(18,6) NOT NULL,
  purchase_currency CHAR(3) NOT NULL,
  requested_identity_snapshot_json JSON NOT NULL,
  technical_identity_snapshot_json JSON NOT NULL,
  supply_identity_snapshot_json JSON NOT NULL,
  commercial_disclosure_snapshot_json JSON NOT NULL,
  source_trace_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_input_decision_line (pricing_input_snapshot_id, sourcing_decision_line_id),
  KEY idx_pricing_input_line_stable_key (stable_item_key_snapshot),
  CONSTRAINT fk_pricing_input_line_snapshot FOREIGN KEY (pricing_input_snapshot_id) REFERENCES pricing_input_snapshots (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_decision_line FOREIGN KEY (sourcing_decision_line_id) REFERENCES sourcing_decision_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_demand FOREIGN KEY (sourcing_demand_id) REFERENCES sourcing_demands (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_release_item FOREIGN KEY (procurement_release_item_id) REFERENCES procurement_release_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_request_item FOREIGN KEY (client_request_revision_item_id) REFERENCES client_request_revision_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_requested_catalog FOREIGN KEY (requested_catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_offered_catalog FOREIGN KEY (offered_catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_offer FOREIGN KEY (supplier_offer_line_id) REFERENCES supplier_offer_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_supplier FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_input_line_supplier_part FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_input_line_quantities CHECK (requested_quantity > 0 AND client_quantity > 0 AND purchase_quantity >= client_quantity),
  CONSTRAINT chk_pricing_input_line_price CHECK (purchase_unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_calculation_groups (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_case_id BIGINT NOT NULL,
  group_code VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  allocation_method VARCHAR(24) NOT NULL DEFAULT 'BY_VALUE',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_group_code (pricing_case_id, group_code),
  CONSTRAINT fk_pricing_group_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_group_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_group_status CHECK (status IN ('DRAFT','READY','CALCULATED','SELECTED','OUTDATED')),
  CONSTRAINT chk_pricing_group_allocation CHECK (allocation_method IN ('BY_VALUE','BY_WEIGHT','BY_QUANTITY','EQUAL','MANUAL','BY_CATEGORY'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_calculation_group_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_calculation_group_id BIGINT NOT NULL,
  pricing_input_line_id BIGINT NOT NULL,
  included_quantity DECIMAL(15,3) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_group_input_line (pricing_calculation_group_id, pricing_input_line_id),
  CONSTRAINT fk_pricing_group_line_group FOREIGN KEY (pricing_calculation_group_id) REFERENCES pricing_calculation_groups (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_group_line_input FOREIGN KEY (pricing_input_line_id) REFERENCES pricing_input_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_group_line_quantity CHECK (included_quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_route_variants (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_calculation_group_id BIGINT NOT NULL,
  pricing_route_template_revision_id BIGINT NOT NULL,
  variant_code VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  calculation_currency CHAR(3) NOT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  selected_at DATETIME(6) NULL,
  selected_by_user_id INT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_variant_code (pricing_calculation_group_id, variant_code),
  CONSTRAINT fk_pricing_variant_group FOREIGN KEY (pricing_calculation_group_id) REFERENCES pricing_calculation_groups (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_variant_template_revision FOREIGN KEY (pricing_route_template_revision_id) REFERENCES pricing_route_template_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_variant_selected_by FOREIGN KEY (selected_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_variant_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_variant_status CHECK (status IN ('DRAFT','READY','CALCULATED','SELECTED','RESERVE','REJECTED','OUTDATED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_variant_parameter_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_route_variant_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  parameter_snapshot_json JSON NOT NULL,
  parameter_hash CHAR(64) NOT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_variant_parameter_revision (pricing_route_variant_id, revision_number),
  CONSTRAINT fk_pricing_variant_parameter_variant FOREIGN KEY (pricing_route_variant_id) REFERENCES pricing_route_variants (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_variant_parameter_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_calculation_revisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_route_variant_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  pricing_input_snapshot_id BIGINT NOT NULL,
  pricing_variant_parameter_revision_id BIGINT NOT NULL,
  pricing_route_template_revision_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  result_hash CHAR(64) NOT NULL,
  fx_snapshot_json JSON NOT NULL,
  totals_snapshot_json JSON NOT NULL,
  validation_snapshot_json JSON NOT NULL,
  calculated_by_user_id INT NULL,
  calculated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  fixed_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_calculation_revision (pricing_route_variant_id, revision_number),
  KEY idx_pricing_calculation_status (pricing_route_variant_id, status),
  CONSTRAINT fk_pricing_calculation_variant FOREIGN KEY (pricing_route_variant_id) REFERENCES pricing_route_variants (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_calculation_input FOREIGN KEY (pricing_input_snapshot_id) REFERENCES pricing_input_snapshots (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_calculation_parameters FOREIGN KEY (pricing_variant_parameter_revision_id) REFERENCES pricing_variant_parameter_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_calculation_template FOREIGN KEY (pricing_route_template_revision_id) REFERENCES pricing_route_template_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_calculation_actor FOREIGN KEY (calculated_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_calculation_status CHECK (status IN ('CALCULATED','SELECTED','FIXED','OUTDATED','BLOCKED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_calculation_block_results (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_calculation_revision_id BIGINT NOT NULL,
  pricing_input_line_id BIGINT NULL,
  sequence_number INT NOT NULL,
  block_key VARCHAR(64) NOT NULL,
  input_snapshot_json JSON NOT NULL,
  output_snapshot_json JSON NOT NULL,
  raw_amount DECIMAL(24,8) NULL,
  rounded_amount DECIMAL(18,4) NULL,
  currency CHAR(3) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_pricing_block_revision (pricing_calculation_revision_id, sequence_number),
  CONSTRAINT fk_pricing_block_result_revision FOREIGN KEY (pricing_calculation_revision_id) REFERENCES pricing_calculation_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_block_result_input FOREIGN KEY (pricing_input_line_id) REFERENCES pricing_input_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_block_result_definition FOREIGN KEY (block_key) REFERENCES pricing_block_definitions (block_key) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_calculation_line_results (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_calculation_revision_id BIGINT NOT NULL,
  pricing_input_line_id BIGINT NOT NULL,
  goods_amount_raw DECIMAL(24,8) NOT NULL,
  freight_amount_raw DECIMAL(24,8) NOT NULL,
  duty_amount_raw DECIMAL(24,8) NOT NULL,
  other_amount_raw DECIMAL(24,8) NOT NULL,
  landed_amount_raw DECIMAL(24,8) NOT NULL,
  internal_unit_price_raw DECIMAL(24,8) NOT NULL,
  calculated_client_unit_price_raw DECIMAL(24,8) NOT NULL,
  rounded_client_unit_price DECIMAL(18,4) NOT NULL,
  allocation_residual DECIMAL(24,8) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL,
  trace_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_calculation_line (pricing_calculation_revision_id, pricing_input_line_id),
  CONSTRAINT fk_pricing_line_result_revision FOREIGN KEY (pricing_calculation_revision_id) REFERENCES pricing_calculation_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_line_result_input FOREIGN KEY (pricing_input_line_id) REFERENCES pricing_input_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_client_price_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_case_id BIGINT NOT NULL,
  pricing_input_line_id BIGINT NOT NULL,
  pricing_calculation_revision_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'CALCULATED',
  calculated_unit_price DECIMAL(18,4) NOT NULL,
  rounded_unit_price DECIMAL(18,4) NOT NULL,
  approved_unit_price DECIMAL(18,4) NULL,
  currency CHAR(3) NOT NULL,
  approval_evidence_json JSON NULL,
  approved_by_user_id INT NULL,
  approved_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_client_price_revision (pricing_calculation_revision_id, pricing_input_line_id),
  KEY idx_pricing_client_price_case (pricing_case_id, pricing_input_line_id, status),
  CONSTRAINT fk_pricing_client_price_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_client_price_input FOREIGN KEY (pricing_input_line_id) REFERENCES pricing_input_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_client_price_calculation FOREIGN KEY (pricing_calculation_revision_id) REFERENCES pricing_calculation_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_client_price_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_client_price_status CHECK (status IN ('CALCULATED','OVERRIDE_PENDING','APPROVED','OUTDATED','REJECTED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_price_overrides (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_client_price_line_id BIGINT NOT NULL,
  requested_unit_price DECIMAL(18,4) NOT NULL,
  previous_unit_price DECIMAL(18,4) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  requested_by_user_id INT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  reviewed_by_user_id INT NULL,
  reviewed_at DATETIME(6) NULL,
  review_note TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_pricing_override_queue (status, requested_at),
  CONSTRAINT fk_pricing_override_price FOREIGN KEY (pricing_client_price_line_id) REFERENCES pricing_client_price_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_override_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_override_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_override_status CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_decisions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_case_id BIGINT NOT NULL,
  revision_number INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  pricing_input_snapshot_id BIGINT NOT NULL,
  decision_hash CHAR(64) NULL,
  disclosure_snapshot_json JSON NOT NULL,
  finalized_by_user_id INT NULL,
  finalized_at DATETIME(6) NULL,
  supersedes_pricing_decision_id BIGINT NULL,
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_decision_revision (pricing_case_id, revision_number),
  CONSTRAINT fk_pricing_decision_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_decision_input FOREIGN KEY (pricing_input_snapshot_id) REFERENCES pricing_input_snapshots (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_decision_finalized_by FOREIGN KEY (finalized_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_decision_supersedes FOREIGN KEY (supersedes_pricing_decision_id) REFERENCES pricing_decisions (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_decision_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_decision_status CHECK (status IN ('DRAFT','FIXED','SUPERSEDED','WITHDRAWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_decision_lines (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_decision_id BIGINT NOT NULL,
  pricing_input_line_id BIGINT NOT NULL,
  pricing_calculation_revision_id BIGINT NOT NULL,
  pricing_client_price_line_id BIGINT NOT NULL,
  approved_unit_price DECIMAL(18,4) NOT NULL,
  currency CHAR(3) NOT NULL,
  seller_projection_snapshot_json JSON NOT NULL,
  client_projection_snapshot_json JSON NOT NULL,
  procurement_projection_snapshot_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_decision_line (pricing_decision_id, pricing_input_line_id),
  CONSTRAINT fk_pricing_decision_line_decision FOREIGN KEY (pricing_decision_id) REFERENCES pricing_decisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_decision_line_input FOREIGN KEY (pricing_input_line_id) REFERENCES pricing_input_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_decision_line_calculation FOREIGN KEY (pricing_calculation_revision_id) REFERENCES pricing_calculation_revisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_decision_line_price FOREIGN KEY (pricing_client_price_line_id) REFERENCES pricing_client_price_lines (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_rework_signals (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_case_id BIGINT NOT NULL,
  sourcing_decision_id BIGINT NOT NULL,
  sourcing_demand_id BIGINT NULL,
  reason_code VARCHAR(64) NOT NULL,
  details_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_by_user_id INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  resolved_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  KEY idx_pricing_rework_queue (status, created_at),
  CONSTRAINT fk_pricing_rework_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_rework_decision FOREIGN KEY (sourcing_decision_id) REFERENCES sourcing_decisions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_rework_demand FOREIGN KEY (sourcing_demand_id) REFERENCES sourcing_demands (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_rework_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_pricing_rework_status CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pricing_case_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pricing_case_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id BIGINT NULL,
  actor_user_id INT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_pricing_event_case (pricing_case_id, created_at),
  CONSTRAINT fk_pricing_event_case FOREIGN KEY (pricing_case_id) REFERENCES pricing_cases (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pricing_event_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('pricing.access', 'Просмотр Pricing', 'Доступ к очереди и проекциям Pricing Case', 'pricing', 1100, 1, 0),
  ('pricing.cases.manage', 'Управление Pricing Case', 'Прием immutable Sourcing Decision и фиксация входа', 'pricing', 1110, 1, 0),
  ('pricing.groups.manage', 'Управление расчетными группами', 'Создание Calculation Group и Route Variant', 'pricing', 1120, 1, 0),
  ('pricing.calculate', 'Выполнение расчета', 'Создание неизменяемых Calculation Revision', 'pricing', 1130, 1, 0),
  ('pricing.client_prices.manage', 'Управление ценами клиента', 'Утверждение расчетных цен и запрос override', 'pricing', 1140, 1, 0),
  ('pricing.overrides.approve', 'Согласование ценовых отклонений', 'Approve/reject обоснованных price override', 'pricing', 1150, 1, 0),
  ('pricing.decisions.finalize', 'Финализация Pricing Decision', 'Фиксация неизменяемой ревизии решения Pricing', 'pricing', 1160, 1, 0),
  ('pricing.costs.view', 'Просмотр внутренней себестоимости', 'Доступ к purchase/landed/internal cost projection', 'pricing', 1170, 1, 0),
  ('pricing.supplier_identity.reveal', 'Раскрытие поставщика в Pricing', 'Явный доступ к реальному Supplier identity с аудитом', 'pricing', 1180, 1, 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description), section = VALUES(section),
  sort_order = VALUES(sort_order), is_active = 1, is_legacy = 0;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key LIKE 'pricing.%'
WHERE r.slug IN ('admin', 'nachalnik-otdela-zakupok')
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key IN
  ('pricing.access','pricing.cases.manage','pricing.groups.manage','pricing.calculate','pricing.costs.view','pricing.supplier_identity.reveal')
WHERE r.slug = 'zakupshchik'
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key IN
  ('pricing.access','pricing.client_prices.manage','pricing.decisions.finalize')
WHERE r.slug = 'prodavec'
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key = 'pricing.access'
WHERE r.slug IN ('specialist-po-katalogam', 'nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed = 1;
