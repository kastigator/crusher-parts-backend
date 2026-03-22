CREATE TABLE IF NOT EXISTS sales_kpi_targets (
  id INT NOT NULL AUTO_INCREMENT,
  seller_user_id INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  target_requests INT NULL,
  target_quotes INT NULL,
  target_contracts INT NULL,
  target_signed_amount DECIMAL(14,4) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_kpi_targets_seller_period (seller_user_id, period_start, period_end),
  KEY idx_sales_kpi_targets_period (period_start, period_end),
  CONSTRAINT fk_sales_kpi_targets_seller
    FOREIGN KEY (seller_user_id) REFERENCES users (id)
    ON DELETE CASCADE
);
