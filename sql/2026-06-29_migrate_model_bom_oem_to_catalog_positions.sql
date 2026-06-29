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

CALL add_column_if_missing(
  'catalog_positions',
  'manufacturer_id',
  'manufacturer_id INT NULL AFTER classifier_node_id'
);
CALL add_column_if_missing(
  'catalog_positions',
  'equipment_model_id',
  'equipment_model_id INT NULL AFTER manufacturer_id'
);
CALL add_column_if_missing(
  'catalog_positions',
  'manufacturer_part_number',
  'manufacturer_part_number VARCHAR(120) NULL AFTER position_code'
);
CALL add_column_if_missing(
  'catalog_positions',
  'display_name_en',
  'display_name_en VARCHAR(255) NULL AFTER display_name'
);
CALL add_column_if_missing(
  'catalog_positions',
  'display_name_ru',
  'display_name_ru VARCHAR(255) NULL AFTER display_name_en'
);

DROP PROCEDURE IF EXISTS add_column_if_missing;

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

CALL add_index_if_missing(
  'catalog_positions',
  'idx_catalog_positions_model',
  'KEY idx_catalog_positions_model (equipment_model_id, is_active)'
);
CALL add_index_if_missing(
  'catalog_positions',
  'idx_catalog_positions_manufacturer_part',
  'KEY idx_catalog_positions_manufacturer_part (manufacturer_id, manufacturer_part_number)'
);

DROP PROCEDURE IF EXISTS add_index_if_missing;

UPDATE catalog_positions cp
JOIN equipment_model_bom_items item ON item.catalog_position_id = cp.id
JOIN equipment_models em ON em.id = item.equipment_model_id
SET
  cp.manufacturer_id = COALESCE(cp.manufacturer_id, em.manufacturer_id),
  cp.equipment_model_id = COALESCE(cp.equipment_model_id, em.id),
  cp.manufacturer_part_number = COALESCE(cp.manufacturer_part_number, item.manufacturer_part_number),
  cp.display_name_en = COALESCE(cp.display_name_en, item.manufacturer_part_name_en, item.manufacturer_part_name, item.title),
  cp.display_name_ru = COALESCE(cp.display_name_ru, item.manufacturer_part_name_ru)
WHERE item.catalog_position_id IS NOT NULL
  AND cp.source_kind = 'model_bom';

UPDATE catalog_positions
SET equipment_model_id = NULL
WHERE source_kind <> 'model_bom'
  AND equipment_model_id IS NOT NULL;

INSERT INTO catalog_positions
  (classifier_node_id, manufacturer_id, equipment_model_id, position_kind, source_kind,
   display_name, display_name_en, display_name_ru, position_code, manufacturer_part_number,
   description, uom, is_active, status, meta_json)
SELECT
  em.classifier_node_id,
  em.manufacturer_id,
  em.id,
  CASE
    WHEN item.row_kind IN ('assembly','part','kit','document','service','material') THEN item.row_kind
    ELSE 'part'
  END AS position_kind,
  'model_bom' AS source_kind,
  LEFT(COALESCE(item.manufacturer_part_name_en, item.manufacturer_part_name_ru, item.manufacturer_part_name, item.title, item.manufacturer_part_number, op.description_en, op.description_ru, op.part_number), 255) AS display_name,
  LEFT(COALESCE(item.manufacturer_part_name_en, item.manufacturer_part_name, op.description_en, op.description_ru, item.title), 255) AS display_name_en,
  LEFT(COALESCE(item.manufacturer_part_name_ru, op.description_ru), 255) AS display_name_ru,
  LEFT(CONCAT(
    'MODEL-BOM-',
    em.id,
    '-',
    item.id,
    '-',
    UPPER(REPLACE(REPLACE(COALESCE(item.manufacturer_part_number, op.part_number, CONCAT('ROW-', item.id)), ' ', '-'), '/', '-'))
  ), 120) AS position_code,
  COALESCE(item.manufacturer_part_number, op.part_number) AS manufacturer_part_number,
  CONCAT_WS(
    '\n',
    CONCAT('Создано из BOM модели ', mf.name, ' ', em.model_name),
    IF(item.item_no IS NOT NULL, CONCAT('Позиция в BOM: ', item.item_no), NULL),
    IF(op.id IS NOT NULL, CONCAT('Источник legacy oem_parts.id=', op.id), NULL),
    item.notes
  ) AS description,
  COALESCE(op.uom, 'шт') AS uom,
  1 AS is_active,
  'active' AS status,
  JSON_OBJECT(
    'source', 'equipment_model_bom_items',
    'source_bom_item_id', item.id,
    'legacy_oem_part_id', item.oem_part_id,
    'equipment_model_id', em.id,
    'manufacturer_id', em.manufacturer_id
  ) AS meta_json
FROM equipment_model_bom_items item
JOIN equipment_models em ON em.id = item.equipment_model_id
JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
LEFT JOIN oem_parts op ON op.id = item.oem_part_id
LEFT JOIN catalog_positions existing
  ON existing.equipment_model_id = em.id
 AND existing.manufacturer_part_number <=> COALESCE(item.manufacturer_part_number, op.part_number)
 AND existing.source_kind = 'model_bom'
WHERE item.catalog_position_id IS NULL
  AND item.client_part_id IS NULL
  AND (item.oem_part_id IS NOT NULL OR item.manufacturer_part_number IS NOT NULL OR item.manufacturer_part_name IS NOT NULL OR item.manufacturer_part_name_en IS NOT NULL OR item.manufacturer_part_name_ru IS NOT NULL OR item.title IS NOT NULL)
  AND existing.id IS NULL;

UPDATE equipment_model_bom_items item
JOIN equipment_models em ON em.id = item.equipment_model_id
JOIN catalog_positions cp
  ON cp.equipment_model_id = em.id
 AND cp.source_kind = 'model_bom'
 AND cp.manufacturer_part_number <=> item.manufacturer_part_number
SET
  item.catalog_position_id = cp.id,
  item.item_type = 'catalog_position',
  item.oem_part_id = NULL
WHERE item.catalog_position_id IS NULL
  AND item.client_part_id IS NULL
  AND item.manufacturer_part_number IS NOT NULL;

UPDATE equipment_model_bom_items item
JOIN catalog_positions cp
  ON JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) = CAST(item.id AS CHAR)
SET
  item.catalog_position_id = cp.id,
  item.item_type = 'catalog_position',
  item.oem_part_id = NULL
WHERE item.catalog_position_id IS NULL
  AND item.client_part_id IS NULL;

UPDATE equipment_model_bom_items
SET item_type = 'catalog_position',
    oem_part_id = NULL
WHERE catalog_position_id IS NOT NULL
  AND oem_part_id IS NOT NULL;
