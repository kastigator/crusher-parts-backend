CREATE TABLE IF NOT EXISTS measurement_units (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL,
  name_ru VARCHAR(100) NOT NULL,
  name_en VARCHAR(100) NULL,
  symbol VARCHAR(32) NULL,
  dimension_type ENUM('quantity','mass','length','area','volume','time','currency','custom') NOT NULL DEFAULT 'custom',
  base_unit_id INT NULL,
  factor_to_base DECIMAL(20,8) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_measurement_units_code (code),
  KEY idx_measurement_units_dimension (dimension_type),
  KEY idx_measurement_units_active (is_active),
  CONSTRAINT fk_measurement_units_base
    FOREIGN KEY (base_unit_id) REFERENCES measurement_units(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO measurement_units
  (code, name_ru, name_en, symbol, dimension_type, factor_to_base, is_active, is_system, note)
VALUES
  ('pcs', 'Штука', 'Piece', 'шт', 'quantity', 1, 1, 1, 'Базовая единица количества'),
  ('set', 'Комплект', 'Set', 'компл.', 'quantity', 1, 1, 1, 'Комплект или набор'),
  ('kg', 'Килограмм', 'Kilogram', 'кг', 'mass', 1, 1, 1, 'Базовая единица массы'),
  ('g', 'Грамм', 'Gram', 'г', 'mass', 0.001, 1, 1, '1 г = 0.001 кг'),
  ('t', 'Тонна', 'Tonne', 'т', 'mass', 1000, 1, 1, '1 т = 1000 кг'),
  ('m', 'Метр', 'Metre', 'м', 'length', 1, 1, 1, 'Базовая единица длины'),
  ('cm', 'Сантиметр', 'Centimetre', 'см', 'length', 0.01, 1, 1, '1 см = 0.01 м'),
  ('mm', 'Миллиметр', 'Millimetre', 'мм', 'length', 0.001, 1, 1, '1 мм = 0.001 м'),
  ('m2', 'Квадратный метр', 'Square metre', 'м²', 'area', 1, 1, 1, 'Базовая единица площади'),
  ('m3', 'Кубический метр', 'Cubic metre', 'м³', 'volume', 1, 1, 1, 'Базовая единица объема'),
  ('l', 'Литр', 'Litre', 'л', 'volume', 0.001, 1, 1, '1 л = 0.001 м³'),
  ('day', 'День', 'Day', 'дн.', 'time', 1, 1, 1, 'Срок в днях')
ON DUPLICATE KEY UPDATE
  name_ru = VALUES(name_ru),
  name_en = VALUES(name_en),
  symbol = VALUES(symbol),
  dimension_type = VALUES(dimension_type),
  factor_to_base = VALUES(factor_to_base),
  is_system = 1,
  is_active = 1,
  note = VALUES(note);

UPDATE measurement_units child
JOIN measurement_units base ON base.code = 'kg'
SET child.base_unit_id = base.id
WHERE child.code IN ('g', 't');

UPDATE measurement_units child
JOIN measurement_units base ON base.code = 'm'
SET child.base_unit_id = base.id
WHERE child.code IN ('cm', 'mm');

UPDATE measurement_units child
JOIN measurement_units base ON base.code = 'm3'
SET child.base_unit_id = base.id
WHERE child.code = 'l';

INSERT INTO tabs (name, tab_name, path, icon, tooltip, is_active, sort_order)
SELECT 'Единицы измерения', 'measurement_units', '/measurement-units', 'default', 'Единицы измерения', 1,
       COALESCE((SELECT MAX(t.sort_order) + 1 FROM tabs t), 100)
WHERE NOT EXISTS (
  SELECT 1 FROM tabs WHERE path = '/measurement-units' OR tab_name = 'measurement_units'
);
