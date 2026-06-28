UPDATE equipment_model_bom_items parent
JOIN (
  SELECT DISTINCT parent_item_id
  FROM equipment_model_bom_items
  WHERE parent_item_id IS NOT NULL
) child_refs ON child_refs.parent_item_id = parent.id
SET parent.row_kind = 'assembly'
WHERE parent.row_kind <> 'assembly';

UPDATE equipment_model_bom_items
SET row_kind = 'assembly'
WHERE parent_item_id IS NULL
  AND row_kind = 'part'
  AND (
    catalog_position_id IS NULL
    OR item_type IN ('group', 'oem_part')
  );
