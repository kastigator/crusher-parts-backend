-- Real classifier passport for DIN 985-style low prevailing torque nuts.
-- The standard is an attribute, not a classifier level.

SET @nuts_parent_id = (
  SELECT id FROM equipment_classifier_nodes
  WHERE name = 'Гайки' AND is_active = 1
  ORDER BY id LIMIT 1
);

UPDATE equipment_classifier_nodes
SET card_kind = 'auto'
WHERE id = @nuts_parent_id;

INSERT INTO equipment_classifier_nodes
  (parent_id, name, node_type, card_kind, code, sort_order, is_active, notes)
SELECT
  @nuts_parent_id,
  'Самоконтрящиеся гайки с неметаллическим вкладышем',
  'SUBCATEGORY',
  'catalog_position',
  'self_locking_nuts_nonmetallic_insert',
  10,
  1,
  'Низкие и стандартные самоконтрящиеся гайки с неметаллическим вкладышем. Стандарт задаётся характеристикой.'
WHERE @nuts_parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM equipment_classifier_nodes
    WHERE parent_id = @nuts_parent_id
      AND code = 'self_locking_nuts_nonmetallic_insert'
  );

SET @nut_leaf_id = (
  SELECT id FROM equipment_classifier_nodes
  WHERE parent_id = @nuts_parent_id
    AND code = 'self_locking_nuts_nonmetallic_insert'
  ORDER BY id LIMIT 1
);

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required,
   is_filterable, is_importable, is_identity, semantic_key, help_text)
VALUES
  (@nut_leaf_id, 'standard', 'Стандарт', 'select', NULL, 10, 1, 1, 1, 1, 'standard', 'Например DIN 985.'),
  (@nut_leaf_id, 'nominal_thread_diameter_mm', 'Номинальный диаметр резьбы', 'number', 'мм', 20, 1, 1, 1, 1, 'thread_diameter_mm', 'Число без буквы M.'),
  (@nut_leaf_id, 'thread_pitch_mm', 'Шаг резьбы', 'number', 'мм', 30, 1, 1, 1, 1, 'thread_pitch_mm', 'Для основной или мелкой резьбы.'),
  (@nut_leaf_id, 'thread_series', 'Серия резьбы', 'select', NULL, 40, 0, 1, 1, 0, 'thread_series', 'Основной или мелкий шаг.'),
  (@nut_leaf_id, 'strength_class', 'Класс прочности', 'text', NULL, 50, 0, 1, 1, 1, 'strength_class', NULL),
  (@nut_leaf_id, 'material', 'Материал', 'text', NULL, 60, 0, 1, 1, 1, 'material', NULL),
  (@nut_leaf_id, 'coating', 'Покрытие', 'text', NULL, 70, 0, 1, 1, 1, 'coating', NULL),
  (@nut_leaf_id, 'wrench_size_mm', 'Размер под ключ', 'number', 'мм', 80, 0, 1, 1, 0, 'wrench_size_mm', NULL),
  (@nut_leaf_id, 'nut_height_mm', 'Высота гайки', 'number', 'мм', 90, 0, 0, 1, 0, 'height_mm', NULL),
  (@nut_leaf_id, 'width_across_corners_min_mm', 'Минимальный размер по углам', 'number', 'мм', 100, 0, 0, 1, 0, 'width_across_corners_min_mm', NULL),
  (@nut_leaf_id, 'bearing_surface_diameter_min_mm', 'Минимальный диаметр опорной поверхности', 'number', 'мм', 110, 0, 0, 1, 0, 'bearing_surface_diameter_min_mm', NULL),
  (@nut_leaf_id, 'hole_diameter_max_mm', 'Максимальный диаметр отверстия', 'number', 'мм', 120, 0, 0, 1, 0, 'hole_diameter_max_mm', NULL),
  (@nut_leaf_id, 'weight_per_1000_kg', 'Масса 1000 шт', 'number', 'кг', 130, 0, 0, 1, 0, 'weight_per_1000_kg', 'Справочная масса из таблицы стандарта.'),
  (@nut_leaf_id, 'unit_weight_kg', 'Масса 1 шт', 'number', 'кг', 140, 0, 1, 1, 0, 'weight_kg', 'Масса одной гайки для склада и логистики.');

INSERT IGNORE INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order, is_active)
SELECT id, 'din_985', 'DIN 985', 10, 1
FROM equipment_classifier_node_attributes
WHERE classifier_node_id = @nut_leaf_id AND code = 'standard';

INSERT IGNORE INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order, is_active)
SELECT id, 'coarse', 'Основная', 10, 1
FROM equipment_classifier_node_attributes
WHERE classifier_node_id = @nut_leaf_id AND code = 'thread_series';

INSERT IGNORE INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order, is_active)
SELECT id, 'fine', 'Мелкая', 20, 1
FROM equipment_classifier_node_attributes
WHERE classifier_node_id = @nut_leaf_id AND code = 'thread_series';

INSERT IGNORE INTO equipment_classifier_attribute_scopes (attribute_id, entity_type)
SELECT id, 'catalog_position'
FROM equipment_classifier_node_attributes
WHERE classifier_node_id = @nut_leaf_id;
