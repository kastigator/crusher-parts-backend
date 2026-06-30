UPDATE equipment_model_bom_items item
JOIN catalog_positions cp ON cp.id = item.catalog_position_id
SET
  item.manufacturer_part_number = COALESCE(NULLIF(TRIM(item.manufacturer_part_number), ''), cp.manufacturer_part_number),
  item.manufacturer_part_name_en = COALESCE(
    NULLIF(TRIM(item.manufacturer_part_name_en), ''),
    NULLIF(TRIM(cp.display_name_en), ''),
    CASE
      WHEN cp.display_name_ru IS NULL OR cp.display_name <> cp.display_name_ru THEN NULLIF(TRIM(cp.display_name), '')
      ELSE NULL
    END
  ),
  item.manufacturer_part_name_ru = COALESCE(
    NULLIF(TRIM(item.manufacturer_part_name_ru), ''),
    CASE
      WHEN item.title REGEXP '[А-Яа-яЁё]' THEN NULLIF(TRIM(item.title), '')
      ELSE NULL
    END,
    NULLIF(TRIM(cp.display_name_ru), '')
  ),
  item.manufacturer_part_name = COALESCE(
    NULLIF(TRIM(item.manufacturer_part_name), ''),
    NULLIF(TRIM(cp.display_name_en), ''),
    NULLIF(TRIM(cp.display_name_ru), ''),
    NULLIF(TRIM(cp.display_name), '')
  )
WHERE cp.source_kind = 'model_bom'
  AND (
    JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) IS NULL
    OR CAST(JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS UNSIGNED) = item.id
  );

UPDATE catalog_positions cp
JOIN equipment_model_bom_items item ON item.catalog_position_id = cp.id
SET
  cp.display_name_en = COALESCE(NULLIF(TRIM(cp.display_name_en), ''), NULLIF(TRIM(item.manufacturer_part_name_en), '')),
  cp.display_name_ru = COALESCE(NULLIF(TRIM(cp.display_name_ru), ''), NULLIF(TRIM(item.manufacturer_part_name_ru), '')),
  cp.display_name = COALESCE(
    NULLIF(TRIM(cp.display_name), ''),
    NULLIF(TRIM(item.manufacturer_part_name_en), ''),
    NULLIF(TRIM(item.manufacturer_part_name_ru), ''),
    NULLIF(TRIM(item.manufacturer_part_name), ''),
    NULLIF(TRIM(item.manufacturer_part_number), '')
  )
WHERE cp.source_kind = 'model_bom'
  AND (
    JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) IS NULL
    OR CAST(JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS UNSIGNED) = item.id
  );

UPDATE equipment_model_bom_items item
JOIN catalog_positions cp ON cp.id = item.catalog_position_id
SET
  item.manufacturer_part_name_en = COALESCE(
    NULLIF(TRIM(item.manufacturer_part_name_en), ''),
    CASE
      WHEN cp.display_name REGEXP '[А-Яа-яЁё]' THEN NULL
      ELSE NULLIF(TRIM(COALESCE(cp.display_name_en, cp.display_name)), '')
    END
  ),
  item.manufacturer_part_name_ru = COALESCE(
    NULLIF(TRIM(item.manufacturer_part_name_ru), ''),
    CASE
      WHEN cp.display_name REGEXP '[А-Яа-яЁё]' THEN NULLIF(TRIM(cp.display_name), '')
      ELSE NULL
    END,
    NULLIF(TRIM(cp.display_name_ru), '')
  ),
  item.manufacturer_part_name = COALESCE(
    NULLIF(TRIM(item.manufacturer_part_name), ''),
    NULLIF(TRIM(cp.display_name_en), ''),
    NULLIF(TRIM(cp.display_name_ru), ''),
    NULLIF(TRIM(cp.display_name), '')
  )
WHERE item.catalog_position_id IS NOT NULL
  AND NULLIF(TRIM(COALESCE(item.manufacturer_part_name_en, item.manufacturer_part_name_ru, item.manufacturer_part_name, '')), '') IS NULL;

UPDATE equipment_model_bom_items item
JOIN catalog_positions cp ON cp.id = item.catalog_position_id
SET item.title = NULL
WHERE cp.source_kind = 'model_bom'
  AND (
    JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) IS NULL
    OR CAST(JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS UNSIGNED) = item.id
  )
  AND NULLIF(TRIM(item.title), '') IS NOT NULL
  AND (
    LOWER(TRIM(item.title)) IN (
      LOWER(TRIM(COALESCE(item.manufacturer_part_name_en, ''))),
      LOWER(TRIM(COALESCE(item.manufacturer_part_name_ru, ''))),
      LOWER(TRIM(COALESCE(item.manufacturer_part_name, ''))),
      LOWER(TRIM(COALESCE(cp.display_name, ''))),
      LOWER(TRIM(COALESCE(cp.display_name_en, ''))),
      LOWER(TRIM(COALESCE(cp.display_name_ru, '')))
    )
    OR item.title REGEXP '[А-Яа-яЁё]'
  );
