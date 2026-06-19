DROP PROCEDURE IF EXISTS add_column_if_missing;

DELIMITER //
CREATE PROCEDURE add_column_if_missing(
  IN table_name_in VARCHAR(64),
  IN column_name_in VARCHAR(64),
  IN column_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = table_name_in
      AND COLUMN_NAME = column_name_in
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE ', table_name_in, ' ADD COLUMN ', column_name_in, ' ', column_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_column_if_missing(
  'equipment_classifier_nodes',
  'card_kind',
  'VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT ''auto'' AFTER node_type'
);

DROP PROCEDURE IF EXISTS add_column_if_missing;

DROP PROCEDURE IF EXISTS add_index_if_missing;

DELIMITER //
CREATE PROCEDURE add_index_if_missing(
  IN table_name_in VARCHAR(64),
  IN index_name_in VARCHAR(64),
  IN index_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = table_name_in
      AND INDEX_NAME = index_name_in
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE ', table_name_in, ' ADD ', index_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_index_if_missing(
  'equipment_classifier_nodes',
  'idx_equipment_classifier_nodes_card_kind',
  'KEY idx_equipment_classifier_nodes_card_kind (card_kind)'
);

DROP PROCEDURE IF EXISTS add_index_if_missing;

UPDATE equipment_classifier_nodes n
SET n.card_kind = 'catalog_position'
WHERE EXISTS (
  SELECT 1
  FROM catalog_positions cp
  WHERE cp.classifier_node_id = n.id
    AND cp.is_active = 1
);

UPDATE equipment_classifier_nodes n
SET n.card_kind = 'equipment_model'
WHERE n.card_kind = 'auto'
  AND EXISTS (
    SELECT 1
    FROM equipment_models em
    WHERE em.classifier_node_id = n.id
  );

UPDATE equipment_classifier_nodes n
JOIN (
  SELECT DISTINCT child_parent_id AS id
  FROM (
    SELECT c.parent_id AS child_parent_id
    FROM equipment_classifier_nodes c
    JOIN equipment_models em ON em.classifier_node_id = c.id
    WHERE c.parent_id IS NOT NULL

    UNION

    SELECT c.parent_id AS child_parent_id
    FROM equipment_classifier_nodes c
    JOIN catalog_positions cp ON cp.classifier_node_id = c.id AND cp.is_active = 1
    WHERE c.parent_id IS NOT NULL
  ) filled_children
) filled_parent ON filled_parent.id = n.id
SET n.card_kind = 'mixed'
WHERE n.card_kind = 'auto';
