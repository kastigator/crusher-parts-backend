CREATE TABLE IF NOT EXISTS sales_quote_calculations (
  id INT NOT NULL AUTO_INCREMENT,
  sales_quote_revision_id INT NOT NULL,
  calculation_status VARCHAR(32) NOT NULL DEFAULT 'applied',
  currency CHAR(3) NULL,
  globals_json JSON NULL,
  line_defaults_json JSON NULL,
  totals_json JSON NULL,
  warnings_json JSON NULL,
  source_payload_json JSON NULL,
  created_by_user_id INT NULL,
  applied_by_user_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_sqc_revision (sales_quote_revision_id, created_at),
  KEY idx_sqc_status (calculation_status, created_at),
  CONSTRAINT fk_sqc_revision
    FOREIGN KEY (sales_quote_revision_id)
    REFERENCES sales_quote_revisions (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS sales_quote_calculation_lines (
  id INT NOT NULL AUTO_INCREMENT,
  sales_quote_calculation_id INT NOT NULL,
  sales_quote_line_id INT NULL,
  client_request_revision_item_id INT NULL,
  catalog_position_id INT NULL,
  display_part_number_snapshot VARCHAR(255) NULL,
  display_description_snapshot TEXT NULL,
  quantity DECIMAL(15,3) NULL,
  purchase_price DECIMAL(14,4) NULL,
  sell_price_without_vat DECIMAL(14,4) NULL,
  sell_price_with_vat DECIMAL(14,4) NULL,
  line_total_without_vat DECIMAL(18,4) NULL,
  line_total_with_vat DECIMAL(18,4) NULL,
  markup_pct DECIMAL(8,2) NULL,
  gross_margin_pct DECIMAL(8,2) NULL,
  breakdown_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sqcl_calculation (sales_quote_calculation_id),
  KEY idx_sqcl_quote_line (sales_quote_line_id),
  KEY idx_sqcl_catalog_position (catalog_position_id),
  CONSTRAINT fk_sqcl_calculation
    FOREIGN KEY (sales_quote_calculation_id)
    REFERENCES sales_quote_calculations (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_sqcl_quote_line
    FOREIGN KEY (sales_quote_line_id)
    REFERENCES sales_quote_lines (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,
  CONSTRAINT fk_sqcl_catalog_position
    FOREIGN KEY (catalog_position_id)
    REFERENCES catalog_positions (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
