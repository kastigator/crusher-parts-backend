DELIMITER $$

DROP PROCEDURE IF EXISTS add_column_if_missing $$
CREATE PROCEDURE add_column_if_missing(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = p_table
       AND column_name = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

CREATE TABLE IF NOT EXISTS supplier_part_catalog_positions (
  supplier_part_id INT NOT NULL,
  catalog_position_id INT NOT NULL,
  relationship_type VARCHAR(32) NOT NULL DEFAULT 'can_supply',
  confidence DECIMAL(5,4) NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (supplier_part_id, catalog_position_id),
  KEY idx_spcp_catalog_position (catalog_position_id),
  CONSTRAINT fk_spcp_supplier_part
    FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_spcp_catalog_position
    FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CALL add_column_if_missing(
  'supplier_part_catalog_positions',
  'priority_rank',
  'priority_rank INT NULL AFTER confidence'
);
CALL add_column_if_missing(
  'supplier_part_catalog_positions',
  'is_preferred',
  'is_preferred TINYINT(1) NOT NULL DEFAULT 0 AFTER priority_rank'
);

INSERT INTO supplier_part_catalog_positions (
  supplier_part_id,
  catalog_position_id,
  relationship_type,
  confidence,
  priority_rank,
  is_preferred,
  notes
)
SELECT
  spo.supplier_part_id,
  cp.id AS catalog_position_id,
  CASE
    WHEN UPPER(COALESCE(sp.part_type, '')) = 'ANALOG' THEN 'analog'
    WHEN UPPER(COALESCE(sp.part_type, '')) = 'OEM' THEN 'exact'
    ELSE 'can_supply'
  END AS relationship_type,
  1.0000 AS confidence,
  spo.priority_rank,
  COALESCE(spo.is_preferred, 0) AS is_preferred,
  CONCAT('Автоперенос из legacy supplier_part_oem_parts: oem_part_id=', spo.oem_part_id) AS notes
FROM supplier_part_oem_parts spo
JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
JOIN catalog_positions cp
  ON JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.legacy_oem_part_id')) = CAST(spo.oem_part_id AS CHAR)
LEFT JOIN supplier_part_catalog_positions existing
  ON existing.supplier_part_id = spo.supplier_part_id
 AND existing.catalog_position_id = cp.id
WHERE existing.supplier_part_id IS NULL;

DROP PROCEDURE IF EXISTS add_column_if_missing;
