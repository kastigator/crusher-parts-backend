-- RFQ strategy + components schema

CREATE TABLE IF NOT EXISTS rfq_item_strategies (
  id int NOT NULL AUTO_INCREMENT,
  rfq_item_id int NOT NULL,
  mode enum('SINGLE','BOM','MIXED') NOT NULL DEFAULT 'SINGLE',
  allow_oem tinyint(1) NOT NULL DEFAULT '1',
  allow_analog tinyint(1) NOT NULL DEFAULT '1',
  allow_kit tinyint(1) NOT NULL DEFAULT '1',
  allow_partial tinyint(1) NOT NULL DEFAULT '1',
  note text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rfq_item_strategy (rfq_item_id),
  KEY idx_rfq_item_strategy_item (rfq_item_id),
  CONSTRAINT fk_rfq_item_strategy_item FOREIGN KEY (rfq_item_id) REFERENCES rfq_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rfq_item_components (
  id int NOT NULL AUTO_INCREMENT,
  rfq_item_id int NOT NULL,
  original_part_id int NOT NULL,
  component_qty decimal(15,3) NOT NULL DEFAULT '1.000',
  required_qty decimal(15,3) NOT NULL DEFAULT '1.000',
  source_type enum('BOM','SELF','MANUAL') NOT NULL DEFAULT 'BOM',
  note text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rfq_item_component (rfq_item_id, original_part_id, source_type),
  KEY idx_rfq_item_component_item (rfq_item_id),
  KEY idx_rfq_item_component_part (original_part_id),
  CONSTRAINT fk_rfq_item_component_item FOREIGN KEY (rfq_item_id) REFERENCES rfq_items (id),
  CONSTRAINT fk_rfq_item_component_part FOREIGN KEY (original_part_id) REFERENCES original_parts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE rfq_response_lines
  ADD COLUMN rfq_item_component_id int DEFAULT NULL,
  ADD KEY idx_rfq_resp_line_component (rfq_item_component_id),
  ADD CONSTRAINT fk_rfq_resp_line_component FOREIGN KEY (rfq_item_component_id)
    REFERENCES rfq_item_components (id);

ALTER TABLE selection_lines
  ADD COLUMN rfq_item_component_id int DEFAULT NULL,
  ADD KEY idx_selection_lines_component (rfq_item_component_id),
  ADD CONSTRAINT fk_selection_lines_component FOREIGN KEY (rfq_item_component_id)
    REFERENCES rfq_item_components (id);
