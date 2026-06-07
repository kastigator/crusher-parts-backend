CREATE TABLE IF NOT EXISTS equipment_classifier_node_attributes (
  id INT NOT NULL AUTO_INCREMENT,
  classifier_node_id INT NOT NULL,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  value_type ENUM('text','textarea','number','boolean','select','multiselect','date') NOT NULL DEFAULT 'number',
  unit VARCHAR(50) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  is_filterable TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  semantic_key VARCHAR(100) NULL,
  help_text TEXT NULL,
  settings_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_equipment_classifier_node_attributes_node_code (classifier_node_id, code),
  KEY idx_equipment_classifier_node_attributes_node (classifier_node_id),
  KEY idx_equipment_classifier_node_attributes_sort (classifier_node_id, sort_order, id),
  KEY idx_equipment_classifier_node_attributes_type (value_type),
  KEY idx_equipment_classifier_node_attributes_filterable (is_filterable, is_active),
  CONSTRAINT fk_equipment_classifier_node_attributes_node
    FOREIGN KEY (classifier_node_id) REFERENCES equipment_classifier_nodes (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS equipment_classifier_attribute_options (
  id INT NOT NULL AUTO_INCREMENT,
  attribute_id INT NOT NULL,
  value_code VARCHAR(100) NOT NULL,
  value_label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_equipment_classifier_attribute_options_attr_code (attribute_id, value_code),
  KEY idx_equipment_classifier_attribute_options_attr (attribute_id),
  CONSTRAINT fk_equipment_classifier_attribute_options_attr
    FOREIGN KEY (attribute_id) REFERENCES equipment_classifier_node_attributes (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS equipment_attribute_values (
  id INT NOT NULL AUTO_INCREMENT,
  attribute_id INT NOT NULL,
  entity_type ENUM('equipment_model','client_equipment_unit') NOT NULL,
  entity_id INT NOT NULL,
  value_text TEXT NULL,
  value_number DECIMAL(18,6) NULL,
  value_boolean TINYINT(1) NULL,
  value_date DATE NULL,
  value_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_equipment_attribute_values_attr_entity (attribute_id, entity_type, entity_id),
  KEY idx_equipment_attribute_values_entity (entity_type, entity_id),
  KEY idx_equipment_attribute_values_number (attribute_id, value_number),
  KEY idx_equipment_attribute_values_boolean (attribute_id, value_boolean),
  KEY idx_equipment_attribute_values_date (attribute_id, value_date),
  CONSTRAINT fk_equipment_attribute_values_attr
    FOREIGN KEY (attribute_id) REFERENCES equipment_classifier_node_attributes (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @crushing_root := (
  SELECT id FROM equipment_classifier_nodes
  WHERE code = 'CRUSHING' OR name = 'Дробильное оборудование'
  ORDER BY id
  LIMIT 1
);
SET @screens_node := (
  SELECT id FROM equipment_classifier_nodes
  WHERE code = 'SCREENS' OR name = 'Грохоты'
  ORDER BY id
  LIMIT 1
);
SET @cone_node := (
  SELECT id FROM equipment_classifier_nodes
  WHERE code = 'CONE' OR name = 'Дробилки конусные'
  ORDER BY id
  LIMIT 1
);
SET @gyratory_node := (
  SELECT id FROM equipment_classifier_nodes
  WHERE code = 'GYRATORY' OR name = 'Дробилки гирационные'
  ORDER BY id
  LIMIT 1
);

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @crushing_root, 'motor_power_kw', 'Мощность двигателя', 'number', 'квт', 10, 0, 1, 'motor_power_kw', 'Номинальная мощность основного электродвигателя'
WHERE @crushing_root IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @crushing_root, 'mass_t', 'Масса оборудования', 'number', 'т', 20, 0, 1, 'mass_t', 'Ориентировочная масса базовой модели'
WHERE @crushing_root IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @crushing_root, 'capacity_min_tph', 'Производительность от', 'number', 'т/ч', 30, 0, 1, 'capacity_min_tph', NULL
WHERE @crushing_root IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @crushing_root, 'capacity_max_tph', 'Производительность до', 'number', 'т/ч', 40, 0, 1, 'capacity_max_tph', NULL
WHERE @crushing_root IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @cone_node, 'cone_diameter_mm', 'Диаметр конуса', 'number', 'мм', 110, 0, 1, 'cone_diameter_mm', NULL
WHERE @cone_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @cone_node, 'max_feed_size_mm', 'Макс. размер питания', 'number', 'мм', 120, 0, 1, 'max_feed_size_mm', NULL
WHERE @cone_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @cone_node, 'css_min_mm', 'CSS минимум', 'number', 'мм', 130, 0, 1, 'css_min_mm', 'Минимальная разгрузочная щель'
WHERE @cone_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @cone_node, 'css_max_mm', 'CSS максимум', 'number', 'мм', 140, 0, 1, 'css_max_mm', 'Максимальная разгрузочная щель'
WHERE @cone_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @cone_node, 'chamber_type', 'Тип камеры дробления', 'select', NULL, 150, 0, 1, 'chamber_type', NULL
WHERE @cone_node IS NOT NULL;

SET @chamber_type_attr := (
  SELECT id FROM equipment_classifier_node_attributes
  WHERE classifier_node_id = @cone_node AND code = 'chamber_type'
  LIMIT 1
);

INSERT IGNORE INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order)
SELECT @chamber_type_attr, 'fine', 'Мелкая', 10
WHERE @chamber_type_attr IS NOT NULL;
INSERT IGNORE INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order)
SELECT @chamber_type_attr, 'medium', 'Средняя', 20
WHERE @chamber_type_attr IS NOT NULL;
INSERT IGNORE INTO equipment_classifier_attribute_options
  (attribute_id, value_code, value_label, sort_order)
SELECT @chamber_type_attr, 'coarse', 'Крупная', 30
WHERE @chamber_type_attr IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @screens_node, 'deck_width_mm', 'Ширина деки', 'number', 'мм', 110, 0, 1, 'deck_width_mm', NULL
WHERE @screens_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @screens_node, 'deck_length_mm', 'Длина деки', 'number', 'мм', 120, 0, 1, 'deck_length_mm', NULL
WHERE @screens_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @screens_node, 'deck_count', 'Количество дек', 'number', 'шт', 130, 0, 1, 'deck_count', NULL
WHERE @screens_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @screens_node, 'screening_area_m2', 'Площадь просеивания', 'number', 'м2', 140, 0, 1, 'screening_area_m2', NULL
WHERE @screens_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @screens_node, 'inclination_deg', 'Угол наклона', 'number', 'град', 150, 0, 1, 'inclination_deg', NULL
WHERE @screens_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @screens_node, 'amplitude_mm', 'Амплитуда', 'number', 'мм', 160, 0, 1, 'amplitude_mm', NULL
WHERE @screens_node IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT @screens_node, 'vibration_frequency_hz', 'Частота вибрации', 'number', 'Гц', 170, 0, 1, 'vibration_frequency_hz', NULL
WHERE @screens_node IS NOT NULL;

SET @model_hp800 := (
  SELECT em.id
  FROM equipment_models em
  JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
  WHERE mf.name LIKE '%Metso%' AND em.model_name LIKE '%HP 800%'
  ORDER BY em.id
  LIMIT 1
);
SET @model_hp300 := (
  SELECT em.id
  FROM equipment_models em
  JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
  WHERE mf.name LIKE '%Metso%' AND em.model_name LIKE '%HP 300%'
  ORDER BY em.id
  LIMIT 1
);
SET @model_screen := (
  SELECT em.id
  FROM equipment_models em
  JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
  WHERE mf.name LIKE '%Metso%' AND (em.model_name LIKE '%LH3073%' OR em.model_name LIKE '%3073%')
  ORDER BY em.id
  LIMIT 1
);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number)
SELECT a.id, 'equipment_model', @model_hp800,
       CASE a.code
         WHEN 'motor_power_kw' THEN 600
         WHEN 'mass_t' THEN 68
         WHEN 'capacity_min_tph' THEN 300
         WHEN 'capacity_max_tph' THEN 1200
         WHEN 'cone_diameter_mm' THEN 2134
         WHEN 'max_feed_size_mm' THEN 350
         WHEN 'css_min_mm' THEN 8
         WHEN 'css_max_mm' THEN 70
       END
FROM equipment_classifier_node_attributes a
WHERE @model_hp800 IS NOT NULL
  AND a.code IN ('motor_power_kw','mass_t','capacity_min_tph','capacity_max_tph','cone_diameter_mm','max_feed_size_mm','css_min_mm','css_max_mm')
ON DUPLICATE KEY UPDATE value_number = VALUES(value_number);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_text)
SELECT a.id, 'equipment_model', @model_hp800, 'coarse'
FROM equipment_classifier_node_attributes a
WHERE @model_hp800 IS NOT NULL
  AND a.code = 'chamber_type'
ON DUPLICATE KEY UPDATE value_text = VALUES(value_text);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number)
SELECT a.id, 'equipment_model', @model_hp300,
       CASE a.code
         WHEN 'motor_power_kw' THEN 220
         WHEN 'mass_t' THEN 18.1
         WHEN 'capacity_min_tph' THEN 115
         WHEN 'capacity_max_tph' THEN 440
         WHEN 'cone_diameter_mm' THEN 1120
         WHEN 'max_feed_size_mm' THEN 241
         WHEN 'css_min_mm' THEN 6
         WHEN 'css_max_mm' THEN 50
       END
FROM equipment_classifier_node_attributes a
WHERE @model_hp300 IS NOT NULL
  AND a.code IN ('motor_power_kw','mass_t','capacity_min_tph','capacity_max_tph','cone_diameter_mm','max_feed_size_mm','css_min_mm','css_max_mm')
ON DUPLICATE KEY UPDATE value_number = VALUES(value_number);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_text)
SELECT a.id, 'equipment_model', @model_hp300, 'medium'
FROM equipment_classifier_node_attributes a
WHERE @model_hp300 IS NOT NULL
  AND a.code = 'chamber_type'
ON DUPLICATE KEY UPDATE value_text = VALUES(value_text);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number)
SELECT a.id, 'equipment_model', @model_screen,
       CASE a.code
         WHEN 'motor_power_kw' THEN 22
         WHEN 'mass_t' THEN 16
         WHEN 'deck_width_mm' THEN 3000
         WHEN 'deck_length_mm' THEN 7300
         WHEN 'deck_count' THEN 2
         WHEN 'screening_area_m2' THEN 21.9
         WHEN 'inclination_deg' THEN 20
         WHEN 'amplitude_mm' THEN 8
         WHEN 'vibration_frequency_hz' THEN 16
       END
FROM equipment_classifier_node_attributes a
WHERE @model_screen IS NOT NULL
  AND a.code IN ('motor_power_kw','mass_t','deck_width_mm','deck_length_mm','deck_count','screening_area_m2','inclination_deg','amplitude_mm','vibration_frequency_hz')
ON DUPLICATE KEY UPDATE value_number = VALUES(value_number);
