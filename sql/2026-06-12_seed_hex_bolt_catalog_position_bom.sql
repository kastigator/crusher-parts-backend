SET @hex_bolts_node := (
  SELECT id
  FROM equipment_classifier_nodes
  WHERE name = 'Болты с шестигранной головой'
  LIMIT 1
);

UPDATE equipment_classifier_node_attributes
SET label = 'Диаметр резьбы',
    value_type = 'number',
    unit = 'мм',
    sort_order = 10,
    is_filterable = 1,
    is_active = 1
WHERE classifier_node_id = @hex_bolts_node
  AND code = 'rezba';

UPDATE equipment_classifier_node_attributes
SET label = 'Шаг резьбы',
    value_type = 'number',
    unit = 'мм',
    sort_order = 20,
    is_filterable = 1,
    is_active = 1
WHERE classifier_node_id = @hex_bolts_node
  AND code = 'shag_rezby';

UPDATE equipment_classifier_node_attributes
SET label = 'Длина',
    value_type = 'number',
    unit = 'мм',
    sort_order = 30,
    is_filterable = 1,
    is_active = 1
WHERE classifier_node_id = @hex_bolts_node
  AND code = 'dlina';

UPDATE equipment_classifier_node_attributes
SET label = 'Размер под ключ',
    value_type = 'number',
    unit = 'мм',
    sort_order = 40,
    is_filterable = 1,
    is_active = 1
WHERE classifier_node_id = @hex_bolts_node
  AND code = 'razmer_pod_klyuch';

UPDATE equipment_classifier_node_attributes
SET label = 'Стандарт',
    value_type = 'text',
    unit = NULL,
    sort_order = 50,
    is_filterable = 1,
    is_active = 1
WHERE classifier_node_id = @hex_bolts_node
  AND code = 'standart';

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
VALUES
  (@hex_bolts_node, 'klass_prochnosti', 'Класс прочности', 'text', NULL, 60, 0, 1, NULL, 'Например 8.8, 10.9 или 12.9'),
  (@hex_bolts_node, 'pokrytie', 'Покрытие', 'text', NULL, 70, 0, 1, NULL, 'Например без покрытия, цинк, горячий цинк');

INSERT INTO catalog_positions
  (classifier_node_id, display_name, position_code, description, uom)
VALUES
  (
    @hex_bolts_node,
    'Болт шестигранный M20x80 10.9 DIN 931',
    'HEX-BOLT-M20X80-10.9-DIN931',
    'Переиспользуемая позиция классификатора для BOM оборудования',
    'шт'
  )
ON DUPLICATE KEY UPDATE
  classifier_node_id = VALUES(classifier_node_id),
  display_name = VALUES(display_name),
  description = VALUES(description),
  uom = VALUES(uom),
  is_active = 1;

SET @bolt_position := (
  SELECT id
  FROM catalog_positions
  WHERE position_code = 'HEX-BOLT-M20X80-10.9-DIN931'
  LIMIT 1
);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number, value_text)
SELECT id, 'catalog_position', @bolt_position,
       CASE code
         WHEN 'rezba' THEN 20
         WHEN 'shag_rezby' THEN 2.5
         WHEN 'dlina' THEN 80
         WHEN 'razmer_pod_klyuch' THEN 30
         ELSE NULL
       END,
       CASE code
         WHEN 'standart' THEN 'DIN 931'
         WHEN 'klass_prochnosti' THEN '10.9'
         WHEN 'pokrytie' THEN 'Без покрытия'
         ELSE NULL
       END
FROM equipment_classifier_node_attributes
WHERE classifier_node_id = @hex_bolts_node
  AND code IN ('rezba', 'shag_rezby', 'dlina', 'razmer_pod_klyuch', 'standart', 'klass_prochnosti', 'pokrytie')
ON DUPLICATE KEY UPDATE
  value_number = VALUES(value_number),
  value_text = VALUES(value_text);

SET @mk60110_model := (
  SELECT em.id
  FROM equipment_models em
  JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
  WHERE m.name = 'Metso'
    AND em.model_name = 'MK60-110'
  LIMIT 1
);

DELETE FROM equipment_model_bom_items
WHERE equipment_model_id = @mk60110_model
  AND title IN ('Крепеж броней вала-шестерни', 'Крепеж защитных кожухов');

INSERT INTO equipment_model_bom_items
  (equipment_model_id, parent_item_id, title, quantity, sort_order, notes)
VALUES
  (@mk60110_model, NULL, 'Крепеж броней вала-шестерни', 1, 50, 'Пример сборки с позицией из классификатора'),
  (@mk60110_model, NULL, 'Крепеж защитных кожухов', 1, 60, 'Тот же болт повторно используется в другой сборке');

SET @fastener_group_1 := (
  SELECT id
  FROM equipment_model_bom_items
  WHERE equipment_model_id = @mk60110_model
    AND title = 'Крепеж броней вала-шестерни'
  LIMIT 1
);

SET @fastener_group_2 := (
  SELECT id
  FROM equipment_model_bom_items
  WHERE equipment_model_id = @mk60110_model
    AND title = 'Крепеж защитных кожухов'
  LIMIT 1
);

INSERT INTO equipment_model_bom_items
  (equipment_model_id, parent_item_id, catalog_position_id, quantity, sort_order, notes)
VALUES
  (@mk60110_model, @fastener_group_1, @bolt_position, 12, 10, 'Пример ссылки BOM на позицию классификатора'),
  (@mk60110_model, @fastener_group_2, @bolt_position, 8, 10, 'Та же позиция классификатора переиспользована во второй сборке');
