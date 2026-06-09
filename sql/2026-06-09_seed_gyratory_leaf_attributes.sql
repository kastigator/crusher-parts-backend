SET @gyratory_node := (
  SELECT id
  FROM equipment_classifier_nodes
  WHERE code = 'GYRATORY' OR name = 'Дробилки гирационные'
  ORDER BY id
  LIMIT 1
);

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'motor_power_kw', 'Мощность двигателя', 'number', 'квт', 10, 0, 1, 'motor_power_kw', 'Номинальная мощность основного электродвигателя'
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'mass_t', 'Масса оборудования', 'number', 'т', 20, 0, 1, 'mass_t', 'Ориентировочная масса базовой модели'
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'capacity_min_tph', 'Производительность от', 'number', 'т/ч', 30, 0, 1, 'capacity_min_tph', NULL
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'capacity_max_tph', 'Производительность до', 'number', 'т/ч', 40, 0, 1, 'capacity_max_tph', NULL
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'feed_opening_width_mm', 'Ширина загрузочного отверстия', 'number', 'мм', 50, 0, 1, 'feed_opening_width_mm', NULL
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'feed_opening_depth_mm', 'Глубина загрузочного отверстия', 'number', 'мм', 60, 0, 1, 'feed_opening_depth_mm', NULL
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'max_feed_size_mm', 'Макс. размер питания', 'number', 'мм', 70, 0, 1, 'max_feed_size_mm', NULL
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'css_min_mm', 'CSS минимум', 'number', 'мм', 80, 0, 1, 'css_min_mm', 'Минимальная разгрузочная щель'
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'css_max_mm', 'CSS максимум', 'number', 'мм', 90, 0, 1, 'css_max_mm', 'Максимальная разгрузочная щель'
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

INSERT INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @gyratory_node, 'chamber_type', 'Тип камеры дробления', 'select', NULL, 100, 0, 1, 'chamber_type', NULL
WHERE @gyratory_node IS NOT NULL
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  value_type = VALUES(value_type),
  unit = VALUES(unit),
  sort_order = VALUES(sort_order),
  is_required = VALUES(is_required),
  is_filterable = VALUES(is_filterable),
  semantic_key = VALUES(semantic_key),
  help_text = VALUES(help_text),
  is_active = 1;

SET @gyratory_chamber_attr := (
  SELECT id
  FROM equipment_classifier_node_attributes
  WHERE classifier_node_id = @gyratory_node AND code = 'chamber_type'
  LIMIT 1
);

INSERT INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order, is_active)
SELECT @gyratory_chamber_attr, 'standard', 'Стандартная', 10, 1
WHERE @gyratory_chamber_attr IS NOT NULL
ON DUPLICATE KEY UPDATE value_label = VALUES(value_label), sort_order = VALUES(sort_order), is_active = 1;

INSERT INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order, is_active)
SELECT @gyratory_chamber_attr, 'coarse', 'Крупного дробления', 20, 1
WHERE @gyratory_chamber_attr IS NOT NULL
ON DUPLICATE KEY UPDATE value_label = VALUES(value_label), sort_order = VALUES(sort_order), is_active = 1;

INSERT INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order, is_active)
SELECT @gyratory_chamber_attr, 'fine', 'Мелкого дробления', 30, 1
WHERE @gyratory_chamber_attr IS NOT NULL
ON DUPLICATE KEY UPDATE value_label = VALUES(value_label), sort_order = VALUES(sort_order), is_active = 1;
