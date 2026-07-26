-- Commercial/RFQ compatibility layer for the classifier-first model.
-- catalog_position is the requested/internal position anchor.
-- supplier_part is the concrete supplier item.
-- Old oem/original column names may remain temporarily as aliases only.

DROP PROCEDURE IF EXISTS add_column_if_missing;
DELIMITER //
CREATE PROCEDURE add_column_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_column_name VARCHAR(64),
  IN p_column_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND column_name = p_column_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD COLUMN ', p_column_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

DROP PROCEDURE IF EXISTS add_index_if_missing;
DELIMITER //
CREATE PROCEDURE add_index_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_index_name VARCHAR(64),
  IN p_index_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND index_name = p_index_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD ', p_index_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

DROP PROCEDURE IF EXISTS add_fk_if_missing;
DELIMITER //
CREATE PROCEDURE add_fk_if_missing(
  IN p_constraint_name VARCHAR(64),
  IN p_table_name VARCHAR(64),
  IN p_fk_sql TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND constraint_name = p_constraint_name
       AND constraint_type = 'FOREIGN KEY'
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD CONSTRAINT ', p_fk_sql);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_column_if_missing('client_request_revision_items', 'catalog_position_id', 'catalog_position_id INT NULL');
CALL add_column_if_missing('client_request_revision_item_components', 'catalog_position_id', 'catalog_position_id INT NULL');
CALL add_column_if_missing('rfq_items', 'catalog_position_id', 'catalog_position_id INT NULL');
CALL add_column_if_missing('rfq_item_components', 'catalog_position_id', 'catalog_position_id INT NULL');
CALL add_column_if_missing('rfq_response_lines', 'catalog_position_id', 'catalog_position_id INT NULL');
CALL add_column_if_missing('rfq_coverage_option_lines', 'catalog_position_id', 'catalog_position_id INT NULL');

CALL add_index_if_missing('client_request_revision_items', 'idx_crri_catalog_position', 'KEY idx_crri_catalog_position (catalog_position_id)');
CALL add_index_if_missing('client_request_revision_item_components', 'idx_crric_catalog_position', 'KEY idx_crric_catalog_position (catalog_position_id)');
CALL add_index_if_missing('rfq_items', 'idx_rfq_items_catalog_position', 'KEY idx_rfq_items_catalog_position (catalog_position_id)');
CALL add_index_if_missing('rfq_item_components', 'idx_rfq_ic_catalog_position', 'KEY idx_rfq_ic_catalog_position (catalog_position_id)');
CALL add_index_if_missing('rfq_response_lines', 'idx_rrl_catalog_position', 'KEY idx_rrl_catalog_position (catalog_position_id)');
CALL add_index_if_missing('rfq_coverage_option_lines', 'idx_rcol_catalog_position', 'KEY idx_rcol_catalog_position (catalog_position_id)');

UPDATE client_request_revision_items cri
JOIN catalog_positions cp ON cp.id = cri.oem_part_id
   SET cri.catalog_position_id = cp.id
 WHERE cri.catalog_position_id IS NULL
   AND cri.oem_part_id IS NOT NULL;

UPDATE client_request_revision_items cri
JOIN (
  SELECT code, MIN(id) AS catalog_position_id
  FROM (
    SELECT TRIM(manufacturer_part_number) AS code, id
      FROM catalog_positions
     WHERE manufacturer_part_number IS NOT NULL
       AND TRIM(manufacturer_part_number) <> ''
    UNION ALL
    SELECT TRIM(position_code) AS code, id
      FROM catalog_positions
     WHERE position_code IS NOT NULL
       AND TRIM(position_code) <> ''
  ) candidate_codes
  GROUP BY code
  HAVING COUNT(DISTINCT id) = 1
) cp_match
  ON cp_match.code = TRIM(cri.client_part_number)
   SET cri.catalog_position_id = cp_match.catalog_position_id,
       cri.oem_part_id = COALESCE(cri.oem_part_id, cp_match.catalog_position_id)
 WHERE cri.catalog_position_id IS NULL
   AND cri.client_part_number IS NOT NULL
   AND TRIM(cri.client_part_number) <> ''
   AND cri.client_part_number NOT REGEXP '[\r\n]';

UPDATE client_request_revision_item_components c
JOIN catalog_positions cp ON cp.id = c.oem_part_id
   SET c.catalog_position_id = cp.id
 WHERE c.catalog_position_id IS NULL
   AND c.oem_part_id IS NOT NULL;

UPDATE rfq_items ri
JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
LEFT JOIN catalog_positions cp
  ON cp.id = COALESCE(cri.catalog_position_id, cri.oem_part_id)
   SET ri.catalog_position_id = cp.id
 WHERE ri.catalog_position_id IS NULL
   AND cp.id IS NOT NULL;

UPDATE rfq_item_components c
JOIN catalog_positions cp ON cp.id = c.oem_part_id
   SET c.catalog_position_id = cp.id
 WHERE c.catalog_position_id IS NULL
   AND c.oem_part_id IS NOT NULL;

UPDATE rfq_response_lines rl
LEFT JOIN rfq_item_components ric ON ric.id = rl.rfq_item_component_id
LEFT JOIN rfq_items ri ON ri.id = rl.rfq_item_id
LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
LEFT JOIN catalog_positions cp
  ON cp.id = COALESCE(
    rl.requested_oem_part_id,
    ric.catalog_position_id,
    ric.oem_part_id,
    ri.catalog_position_id,
    cri.catalog_position_id,
    cri.oem_part_id,
    rl.oem_part_id
  )
   SET rl.catalog_position_id = cp.id
 WHERE rl.catalog_position_id IS NULL
   AND cp.id IS NOT NULL;

UPDATE rfq_coverage_option_lines l
LEFT JOIN rfq_response_lines rl ON rl.id = l.rfq_response_line_id
LEFT JOIN rfq_item_components ric ON ric.id = rl.rfq_item_component_id
LEFT JOIN rfq_items ri ON ri.id = l.rfq_item_id
LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
LEFT JOIN catalog_positions cp
  ON cp.id = COALESCE(
    rl.catalog_position_id,
    rl.requested_oem_part_id,
    ric.catalog_position_id,
    ric.oem_part_id,
    ri.catalog_position_id,
    cri.catalog_position_id,
    cri.oem_part_id,
    l.oem_part_id,
    rl.oem_part_id
  )
   SET l.catalog_position_id = cp.id
 WHERE l.catalog_position_id IS NULL
   AND cp.id IS NOT NULL;

CALL add_fk_if_missing(
  'fk_crri_catalog_position',
  'client_request_revision_items',
  'fk_crri_catalog_position FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE'
);
CALL add_fk_if_missing(
  'fk_crric_catalog_position',
  'client_request_revision_item_components',
  'fk_crric_catalog_position FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE'
);
CALL add_fk_if_missing(
  'fk_rfq_items_catalog_position',
  'rfq_items',
  'fk_rfq_items_catalog_position FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE'
);
CALL add_fk_if_missing(
  'fk_rfq_ic_catalog_position',
  'rfq_item_components',
  'fk_rfq_ic_catalog_position FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE'
);
CALL add_fk_if_missing(
  'fk_rrl_catalog_position',
  'rfq_response_lines',
  'fk_rrl_catalog_position FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE'
);
CALL add_fk_if_missing(
  'fk_rcol_catalog_position',
  'rfq_coverage_option_lines',
  'fk_rcol_catalog_position FOREIGN KEY (catalog_position_id) REFERENCES catalog_positions (id) ON DELETE SET NULL ON UPDATE CASCADE'
);

DROP PROCEDURE IF EXISTS add_fk_if_missing;
DROP PROCEDURE IF EXISTS add_index_if_missing;
DROP PROCEDURE IF EXISTS add_column_if_missing;
