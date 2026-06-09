CREATE TEMPORARY TABLE tmp_upper_classifier_attribute_ids AS
SELECT a.id
FROM equipment_classifier_node_attributes a
WHERE EXISTS (
  SELECT 1
  FROM equipment_classifier_nodes child
  WHERE child.parent_id = a.classifier_node_id
    AND child.is_active = 1
);

DELETE v
FROM equipment_attribute_values v
JOIN tmp_upper_classifier_attribute_ids t ON t.id = v.attribute_id;

DELETE o
FROM equipment_classifier_attribute_options o
JOIN tmp_upper_classifier_attribute_ids t ON t.id = o.attribute_id;

DELETE a
FROM equipment_classifier_node_attributes a
JOIN tmp_upper_classifier_attribute_ids t ON t.id = a.id;

DROP TEMPORARY TABLE tmp_upper_classifier_attribute_ids;
