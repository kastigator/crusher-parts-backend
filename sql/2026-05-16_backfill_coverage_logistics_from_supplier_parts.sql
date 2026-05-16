UPDATE rfq_coverage_option_lines col
JOIN rfq_response_lines rl ON rl.id = col.rfq_response_line_id
JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
SET
  col.weight_kg = COALESCE(
    col.weight_kg,
    CASE
      WHEN sp.weight_kg IS NULL THEN NULL
      ELSE sp.weight_kg * COALESCE(NULLIF(col.qty, 0), 1)
    END
  ),
  col.volume_cbm = COALESCE(
    col.volume_cbm,
    CASE
      WHEN sp.length_cm IS NULL OR sp.width_cm IS NULL OR sp.height_cm IS NULL THEN NULL
      ELSE (sp.length_cm * sp.width_cm * sp.height_cm * COALESCE(NULLIF(col.qty, 0), 1)) / 1000000
    END
  )
WHERE col.rfq_response_line_id IS NOT NULL
  AND (col.weight_kg IS NULL OR col.volume_cbm IS NULL)
  AND (
    sp.weight_kg IS NOT NULL
    OR (sp.length_cm IS NOT NULL AND sp.width_cm IS NOT NULL AND sp.height_cm IS NOT NULL)
  );
