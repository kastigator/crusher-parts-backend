INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT DISTINCT em.classifier_node_id, 'storage_uom', 'Единица хранения', 'text', NULL, 900, 0, 0, 'storage_uom', 'Перенесено из базового поля модели'
FROM equipment_models em
WHERE em.classifier_node_id IS NOT NULL
  AND em.storage_uom IS NOT NULL
  AND em.storage_uom <> '';

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT DISTINCT em.classifier_node_id, 'weight_kg', 'Вес', 'number', 'кг', 910, 0, 1, 'weight_kg', 'Перенесено из базового поля модели'
FROM equipment_models em
WHERE em.classifier_node_id IS NOT NULL
  AND em.weight_kg IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT DISTINCT em.classifier_node_id, 'length_mm', 'Длина', 'number', 'мм', 920, 0, 1, 'length_mm', 'Перенесено из базового поля модели'
FROM equipment_models em
WHERE em.classifier_node_id IS NOT NULL
  AND em.length_mm IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT DISTINCT em.classifier_node_id, 'width_mm', 'Ширина', 'number', 'мм', 930, 0, 1, 'width_mm', 'Перенесено из базового поля модели'
FROM equipment_models em
WHERE em.classifier_node_id IS NOT NULL
  AND em.width_mm IS NOT NULL;

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
SELECT DISTINCT em.classifier_node_id, 'height_mm', 'Высота', 'number', 'мм', 940, 0, 1, 'height_mm', 'Перенесено из базового поля модели'
FROM equipment_models em
WHERE em.classifier_node_id IS NOT NULL
  AND em.height_mm IS NOT NULL;

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_text)
SELECT a.id, 'equipment_model', em.id, em.storage_uom
FROM equipment_models em
JOIN equipment_classifier_node_attributes a
  ON a.classifier_node_id = em.classifier_node_id
 AND a.code = 'storage_uom'
WHERE em.storage_uom IS NOT NULL
  AND em.storage_uom <> ''
ON DUPLICATE KEY UPDATE
  value_text = VALUES(value_text);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number)
SELECT a.id, 'equipment_model', em.id, em.weight_kg
FROM equipment_models em
JOIN equipment_classifier_node_attributes a
  ON a.classifier_node_id = em.classifier_node_id
 AND a.code = 'weight_kg'
WHERE em.weight_kg IS NOT NULL
ON DUPLICATE KEY UPDATE
  value_number = VALUES(value_number);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number)
SELECT a.id, 'equipment_model', em.id, em.length_mm
FROM equipment_models em
JOIN equipment_classifier_node_attributes a
  ON a.classifier_node_id = em.classifier_node_id
 AND a.code = 'length_mm'
WHERE em.length_mm IS NOT NULL
ON DUPLICATE KEY UPDATE
  value_number = VALUES(value_number);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number)
SELECT a.id, 'equipment_model', em.id, em.width_mm
FROM equipment_models em
JOIN equipment_classifier_node_attributes a
  ON a.classifier_node_id = em.classifier_node_id
 AND a.code = 'width_mm'
WHERE em.width_mm IS NOT NULL
ON DUPLICATE KEY UPDATE
  value_number = VALUES(value_number);

INSERT INTO equipment_attribute_values (attribute_id, entity_type, entity_id, value_number)
SELECT a.id, 'equipment_model', em.id, em.height_mm
FROM equipment_models em
JOIN equipment_classifier_node_attributes a
  ON a.classifier_node_id = em.classifier_node_id
 AND a.code = 'height_mm'
WHERE em.height_mm IS NOT NULL
ON DUPLICATE KEY UPDATE
  value_number = VALUES(value_number);
