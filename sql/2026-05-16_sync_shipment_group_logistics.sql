UPDATE rfq_shipment_group_lines gl
JOIN rfq_coverage_option_lines col ON col.id = gl.coverage_option_line_id
SET gl.weight_allocated_kg = COALESCE(
  gl.weight_allocated_kg,
  CASE
    WHEN col.weight_kg IS NULL THEN NULL
    WHEN gl.qty_allocated IS NOT NULL AND col.qty IS NOT NULL AND col.qty > 0
      THEN col.weight_kg * (gl.qty_allocated / col.qty)
    ELSE col.weight_kg
  END
)
WHERE gl.included = 1
  AND gl.weight_allocated_kg IS NULL
  AND col.weight_kg IS NOT NULL;

UPDATE rfq_shipment_groups g
LEFT JOIN (
  SELECT
    gl.shipment_group_id,
    NULLIF(SUM(COALESCE(gl.weight_allocated_kg, 0)), 0) AS total_weight_kg,
    NULLIF(SUM(COALESCE(
      CASE
        WHEN col.volume_cbm IS NULL THEN NULL
        WHEN gl.qty_allocated IS NOT NULL AND col.qty IS NOT NULL AND col.qty > 0
          THEN col.volume_cbm * (gl.qty_allocated / col.qty)
        ELSE col.volume_cbm
      END,
      0
    )), 0) AS total_volume_cbm
  FROM rfq_shipment_group_lines gl
  JOIN rfq_coverage_option_lines col ON col.id = gl.coverage_option_line_id
  WHERE gl.included = 1
  GROUP BY gl.shipment_group_id
) totals ON totals.shipment_group_id = g.id
SET
  g.total_weight_kg = totals.total_weight_kg,
  g.total_volume_cbm = totals.total_volume_cbm
WHERE totals.shipment_group_id IS NOT NULL;
