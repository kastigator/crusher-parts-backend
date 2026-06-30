UPDATE equipment_model_bom_items item
JOIN equipment_models em ON em.id = item.equipment_model_id
JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
SET
  item.manufacturer_part_name = 'Main Frame',
  item.manufacturer_part_name_en = 'Main Frame',
  item.manufacturer_part_name_ru = NULL,
  item.title = NULL
WHERE item.equipment_model_id = 1
  AND item.manufacturer_part_number = 'MM0200329'
  AND mf.name = 'Metso'
  AND em.model_name = 'HP 800';

UPDATE catalog_positions cp
JOIN equipment_model_bom_items item ON item.catalog_position_id = cp.id
JOIN equipment_models em ON em.id = item.equipment_model_id
JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
SET
  cp.display_name = 'Main Frame',
  cp.display_name_en = 'Main Frame',
  cp.display_name_ru = NULL,
  cp.manufacturer_part_number = 'MM0200329',
  cp.updated_at = CURRENT_TIMESTAMP
WHERE item.equipment_model_id = 1
  AND item.manufacturer_part_number = 'MM0200329'
  AND mf.name = 'Metso'
  AND em.model_name = 'HP 800'
  AND cp.source_kind = 'model_bom';
