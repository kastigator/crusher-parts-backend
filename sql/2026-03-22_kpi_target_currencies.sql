SET @sales_has_target_currency := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sales_kpi_targets'
    AND COLUMN_NAME = 'target_currency'
);
SET @sales_sql := IF(
  @sales_has_target_currency = 0,
  'ALTER TABLE sales_kpi_targets ADD COLUMN target_currency CHAR(3) NULL AFTER target_signed_amount',
  'SELECT 1'
);
PREPARE sales_stmt FROM @sales_sql;
EXECUTE sales_stmt;
DEALLOCATE PREPARE sales_stmt;

UPDATE sales_kpi_targets
SET target_currency = COALESCE(NULLIF(target_currency, ''), 'RUB')
WHERE target_currency IS NULL OR target_currency = '';

SET @procurement_has_target_currency := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'procurement_kpi_targets'
    AND COLUMN_NAME = 'target_currency'
);
SET @procurement_sql := IF(
  @procurement_has_target_currency = 0,
  'ALTER TABLE procurement_kpi_targets ADD COLUMN target_currency CHAR(3) NULL AFTER target_landed_amount',
  'SELECT 1'
);
PREPARE procurement_stmt FROM @procurement_sql;
EXECUTE procurement_stmt;
DEALLOCATE PREPARE procurement_stmt;

UPDATE procurement_kpi_targets
SET target_currency = COALESCE(NULLIF(target_currency, ''), 'RUB')
WHERE target_currency IS NULL OR target_currency = '';
