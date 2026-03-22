CREATE TABLE IF NOT EXISTS procurement_kpi_targets (
  id INT NOT NULL AUTO_INCREMENT,
  buyer_user_id INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  target_rfqs INT DEFAULT NULL,
  target_invites INT DEFAULT NULL,
  target_selections INT DEFAULT NULL,
  target_purchase_orders INT DEFAULT NULL,
  target_landed_amount DECIMAL(14,4) DEFAULT NULL,
  target_currency CHAR(3) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_kpi_targets_buyer_period (buyer_user_id, period_start, period_end),
  KEY idx_procurement_kpi_targets_period (period_start, period_end),
  CONSTRAINT fk_procurement_kpi_targets_buyer
    FOREIGN KEY (buyer_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
