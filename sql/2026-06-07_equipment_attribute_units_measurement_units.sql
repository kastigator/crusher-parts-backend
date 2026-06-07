INSERT INTO measurement_units
  (code, name_ru, name_en, symbol, dimension_type, factor_to_base, is_active, is_system, note)
VALUES
  ('т/ч', 'Тонн в час', 'Tonnes per hour', 'т/ч', 'custom', NULL, 1, 1, 'Производительность оборудования'),
  ('град', 'Градус', 'Degree', 'град', 'custom', NULL, 1, 1, 'Угол в градусах')
ON DUPLICATE KEY UPDATE
  name_ru = VALUES(name_ru),
  name_en = VALUES(name_en),
  symbol = VALUES(symbol),
  dimension_type = VALUES(dimension_type),
  is_system = 1,
  is_active = 1,
  note = VALUES(note);

UPDATE equipment_classifier_node_attributes a
JOIN measurement_units mu
  ON LOWER(mu.code) = LOWER(a.unit)
  OR LOWER(mu.symbol) = LOWER(a.unit)
SET a.unit = mu.code
WHERE a.unit IS NOT NULL
  AND TRIM(a.unit) <> '';
