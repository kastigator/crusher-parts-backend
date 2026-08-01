-- Assign only unambiguous empty leaf sections. Intermediate folders remain `auto`.

UPDATE equipment_classifier_nodes n
JOIN equipment_classifier_nodes parent ON parent.id = n.parent_id
LEFT JOIN equipment_classifier_nodes child ON child.parent_id = n.id AND child.is_active = 1
SET n.card_kind = 'catalog_position'
WHERE n.card_kind = 'auto'
  AND n.is_active = 1
  AND parent.name = 'Крепёж'
  AND child.id IS NULL;

UPDATE equipment_classifier_nodes n
JOIN equipment_classifier_nodes parent ON parent.id = n.parent_id
LEFT JOIN equipment_classifier_nodes child ON child.parent_id = n.id AND child.is_active = 1
SET n.card_kind = 'material'
WHERE n.card_kind = 'auto'
  AND n.is_active = 1
  AND parent.name IN ('Горюче-смазочные материалы и жидкости', 'Металлопрокат и заготовки')
  AND child.id IS NULL;

UPDATE equipment_classifier_nodes n
JOIN equipment_classifier_nodes parent ON parent.id = n.parent_id
LEFT JOIN equipment_classifier_nodes child ON child.parent_id = n.id AND child.is_active = 1
SET n.card_kind = 'service'
WHERE n.card_kind = 'auto'
  AND n.is_active = 1
  AND parent.name = 'Услуги/ работы'
  AND child.id IS NULL;
