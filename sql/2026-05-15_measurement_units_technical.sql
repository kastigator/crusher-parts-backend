INSERT INTO measurement_units
  (code, name_ru, name_en, symbol, dimension_type, factor_to_base, is_active, is_system, note)
VALUES
  ('kw', 'Киловатт', 'Kilowatt', 'кВт', 'custom', NULL, 1, 1, 'Единица мощности для технических характеристик'),
  ('v', 'Вольт', 'Volt', 'В', 'custom', NULL, 1, 1, 'Единица напряжения для технических характеристик'),
  ('hz', 'Герц', 'Hertz', 'Гц', 'custom', NULL, 1, 1, 'Единица частоты для технических характеристик'),
  ('rpm', 'Оборотов в минуту', 'Revolutions per minute', 'об/мин', 'custom', NULL, 1, 1, 'Частота вращения'),
  ('a', 'Ампер', 'Ampere', 'А', 'custom', NULL, 1, 1, 'Единица силы тока'),
  ('nm', 'Ньютон-метр', 'Newton metre', 'Н·м', 'custom', NULL, 1, 1, 'Единица крутящего момента'),
  ('bar', 'Бар', 'Bar', 'bar', 'custom', NULL, 1, 1, 'Единица давления'),
  ('mpa', 'Мегапаскаль', 'Megapascal', 'МПа', 'custom', NULL, 1, 1, 'Единица давления'),
  ('celsius', 'Градус Цельсия', 'Degree Celsius', '°C', 'custom', NULL, 1, 1, 'Единица температуры'),
  ('percent', 'Процент', 'Percent', '%', 'custom', NULL, 1, 1, 'Доля в процентах')
ON DUPLICATE KEY UPDATE
  name_ru = VALUES(name_ru),
  name_en = VALUES(name_en),
  symbol = VALUES(symbol),
  dimension_type = VALUES(dimension_type),
  is_system = 1,
  is_active = 1,
  note = VALUES(note);
