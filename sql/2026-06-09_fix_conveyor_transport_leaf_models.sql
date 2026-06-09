SET @conveyor_parent := (
  SELECT id
  FROM equipment_classifier_nodes
  WHERE name = 'Конвейерный транспорт'
  ORDER BY id
  LIMIT 1
);

SET @stationary_conveyor := (
  SELECT id
  FROM equipment_classifier_nodes
  WHERE parent_id = @conveyor_parent
    AND name = 'Конвейер стационарный'
  ORDER BY id
  LIMIT 1
);

UPDATE equipment_models
SET classifier_node_id = @stationary_conveyor
WHERE classifier_node_id = @conveyor_parent
  AND @stationary_conveyor IS NOT NULL;
