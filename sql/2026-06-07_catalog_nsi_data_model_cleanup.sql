START TRANSACTION;

CREATE TABLE IF NOT EXISTS client_parts (
  id INT NOT NULL AUTO_INCREMENT,
  client_id INT NOT NULL,
  classifier_node_id INT NULL,
  base_oem_part_id INT NULL,
  relationship_type ENUM('client_drawing','oem_variant','oem_replacement','unknown_oem') NOT NULL DEFAULT 'client_drawing',
  client_part_number VARCHAR(120) NULL,
  client_part_number_norm VARCHAR(160) NULL,
  revision_code VARCHAR(80) NULL,
  drawing_number VARCHAR(120) NULL,
  display_name VARCHAR(500) NOT NULL,
  description_ru TEXT NULL,
  difference_summary TEXT NULL,
  uom VARCHAR(16) NOT NULL DEFAULT 'шт',
  material_note VARCHAR(255) NULL,
  status ENUM('active','inactive','archived') NOT NULL DEFAULT 'active',
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_client_parts_client (client_id),
  KEY idx_client_parts_classifier (classifier_node_id),
  KEY idx_client_parts_base_oem (base_oem_part_id),
  KEY idx_client_parts_relationship (relationship_type),
  KEY idx_client_parts_number_norm (client_part_number_norm),
  KEY idx_client_parts_status (status),
  CONSTRAINT fk_client_parts_client
    FOREIGN KEY (client_id) REFERENCES clients (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_client_parts_classifier
    FOREIGN KEY (classifier_node_id) REFERENCES equipment_classifier_nodes (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_client_parts_base_oem
    FOREIGN KEY (base_oem_part_id) REFERENCES oem_parts (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS client_part_applications (
  id INT NOT NULL AUTO_INCREMENT,
  client_part_id INT NOT NULL,
  equipment_model_id INT NULL,
  client_equipment_unit_id INT NULL,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cpa_client_part (client_part_id),
  KEY idx_cpa_equipment_model (equipment_model_id),
  KEY idx_cpa_client_equipment_unit (client_equipment_unit_id),
  CONSTRAINT fk_cpa_client_part
    FOREIGN KEY (client_part_id) REFERENCES client_parts (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_cpa_equipment_model
    FOREIGN KEY (equipment_model_id) REFERENCES equipment_models (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_cpa_client_equipment_unit
    FOREIGN KEY (client_equipment_unit_id) REFERENCES client_equipment_units (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

COMMIT;

DROP PROCEDURE IF EXISTS add_column_if_missing;
DELIMITER //
CREATE PROCEDURE add_column_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_column_name VARCHAR(64),
  IN p_column_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND column_name = p_column_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD COLUMN ', p_column_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_column_if_missing(
  'oem_parts',
  'classifier_node_id',
  'classifier_node_id INT NULL AFTER manufacturer_id'
);

CALL add_column_if_missing(
  'client_request_revision_items',
  'client_part_id',
  'client_part_id INT NULL AFTER standard_part_id'
);

CALL add_column_if_missing(
  'client_request_revision_item_components',
  'client_part_id',
  'client_part_id INT NULL AFTER standard_part_id'
);

DROP PROCEDURE IF EXISTS add_column_if_missing;

DROP PROCEDURE IF EXISTS add_fk_if_missing;
DELIMITER //
CREATE PROCEDURE add_fk_if_missing(
  IN p_constraint_name VARCHAR(64),
  IN p_table_name VARCHAR(64),
  IN p_fk_sql TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND constraint_name = p_constraint_name
       AND constraint_type = 'FOREIGN KEY'
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` ADD CONSTRAINT ', p_fk_sql);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL add_fk_if_missing(
  'fk_oem_parts_classifier_node',
  'oem_parts',
  'fk_oem_parts_classifier_node FOREIGN KEY (classifier_node_id) REFERENCES equipment_classifier_nodes (id) ON DELETE SET NULL ON UPDATE CASCADE'
);

CALL add_fk_if_missing(
  'fk_crri_client_part',
  'client_request_revision_items',
  'fk_crri_client_part FOREIGN KEY (client_part_id) REFERENCES client_parts (id) ON DELETE SET NULL ON UPDATE CASCADE'
);

CALL add_fk_if_missing(
  'fk_crric_client_part',
  'client_request_revision_item_components',
  'fk_crric_client_part FOREIGN KEY (client_part_id) REFERENCES client_parts (id) ON DELETE SET NULL ON UPDATE CASCADE'
);

DROP PROCEDURE IF EXISTS add_fk_if_missing;

START TRANSACTION;

INSERT INTO equipment_classifier_nodes (parent_id, name, node_type, code, sort_order, is_active, notes)
SELECT NULL, 'Подшипники и подшипниковые узлы', 'ROOT', 'BEARINGS', 60, 1, 'Раздел создан для переноса каталожных групп, ранее ошибочно заведенных как модели оборудования'
WHERE NOT EXISTS (SELECT 1 FROM equipment_classifier_nodes WHERE code = 'BEARINGS');

SET @bearings_root := (SELECT id FROM equipment_classifier_nodes WHERE code = 'BEARINGS' LIMIT 1);

INSERT INTO equipment_classifier_nodes (parent_id, name, node_type, code, sort_order, is_active, notes)
SELECT @bearings_root, 'Подшипники', 'CATEGORY', 'BEARINGS_ROLLING', 10, 1, 'Класс подшипников для каталожных позиций производителей'
WHERE NOT EXISTS (SELECT 1 FROM equipment_classifier_nodes WHERE code = 'BEARINGS_ROLLING');

INSERT INTO equipment_classifier_nodes (parent_id, name, node_type, code, sort_order, is_active, notes)
SELECT @bearings_root, 'Корпуса подшипников', 'CATEGORY', 'BEARING_HOUSINGS', 20, 1, 'Корпусные элементы и узлы подшипников'
WHERE NOT EXISTS (SELECT 1 FROM equipment_classifier_nodes WHERE code = 'BEARING_HOUSINGS');

INSERT INTO clients (company_name, notes)
SELECT 'Михеевский ГОК', 'Создано миграцией НСИ для переноса legacy-машин клиентов из equipment_models'
WHERE NOT EXISTS (SELECT 1 FROM clients WHERE company_name = 'Михеевский ГОК');

INSERT INTO clients (company_name, notes)
SELECT 'Полюс Магадан', 'Создано миграцией НСИ для переноса legacy-машин клиентов из equipment_models'
WHERE NOT EXISTS (SELECT 1 FROM clients WHERE company_name = 'Полюс Магадан');

INSERT INTO clients (company_name, notes)
SELECT 'Амур Минералс', 'Создано миграцией НСИ для переноса legacy-машин клиентов из equipment_models'
WHERE NOT EXISTS (SELECT 1 FROM clients WHERE company_name = 'Амур Минералс');

SET @metso_id := (SELECT id FROM equipment_manufacturers WHERE name = 'Metso' LIMIT 1);
SET @tecman_id := (SELECT id FROM equipment_manufacturers WHERE name = 'Tecman' LIMIT 1);
SET @zhekuang_id := (SELECT id FROM equipment_manufacturers WHERE name = 'Zhekuang heavy industry' LIMIT 1);
SET @sandvik_id := (SELECT id FROM equipment_manufacturers WHERE name = 'SANDVIK' LIMIT 1);
SET @gyratory_node := (SELECT id FROM equipment_classifier_nodes WHERE code = 'GYRATORY' LIMIT 1);
SET @cone_node := (SELECT id FROM equipment_classifier_nodes WHERE code = 'CONE' LIMIT 1);
SET @jaw_node := (SELECT id FROM equipment_classifier_nodes WHERE name = 'Дробилки щековые' LIMIT 1);
SET @manipulator_node := (SELECT id FROM equipment_classifier_nodes WHERE name = 'Манипуляторы' LIMIT 1);
SET @hammer_node := (SELECT id FROM equipment_classifier_nodes WHERE name = 'Гидромолоты' LIMIT 1);
SET @client_drawing_node := (SELECT id FROM equipment_classifier_nodes WHERE name = 'Детали клиентов по чертежам' LIMIT 1);

UPDATE equipment_models
   SET model_name = 'CJ180',
       model_code = COALESCE(model_code, 'CJ180'),
       notes = CONCAT_WS('\n', notes, 'Очищено миграцией НСИ: из строки legacy-машины клиента выделена базовая модель.')
 WHERE id = 20
   AND model_name LIKE 'Щековая дробилка/%';

UPDATE equipment_models
   SET model_name = 'MKII 60-89',
       model_code = COALESCE(model_code, 'MKII 60-89'),
       notes = CONCAT_WS('\n', notes, 'Очищено миграцией НСИ: из строки legacy-машины клиента выделена базовая модель.')
 WHERE id = 21
   AND model_name LIKE 'Гирационная дробилка/%';

UPDATE equipment_models
   SET model_name = 'MKII 60-100',
       model_code = COALESCE(model_code, 'MKII 60-100'),
       notes = CONCAT_WS('\n', notes, 'Очищено миграцией НСИ: из строки legacy-машины клиента выделена базовая модель.')
 WHERE id = 24
   AND model_name LIKE 'Гирационная дробилка/%';

UPDATE equipment_models
   SET model_name = 'MKIII 60-100',
       model_code = COALESCE(model_code, 'MKIII 60-100'),
       notes = CONCAT_WS('\n', notes, 'Очищено миграцией НСИ: из строки legacy-машины клиента выделена базовая модель.')
 WHERE id = 25
   AND model_name LIKE 'Гирационная дробилка/%';

UPDATE equipment_models
   SET model_name = 'TMB9',
       model_code = COALESCE(model_code, 'TMB9'),
       notes = CONCAT_WS('\n', notes, 'Очищено миграцией НСИ: из строки legacy-машины без клиента выделена базовая модель; серийник сохранен в заметке исходной строки.')
 WHERE id = 27
   AND model_name LIKE 'Гидромолот/%';

SET @client_karelsky := (SELECT id FROM clients WHERE company_name = 'Карельский Окатыш' LIMIT 1);
SET @client_lebedinsky := (SELECT id FROM clients WHERE company_name = 'Лебединский ГОК' LIMIT 1);
SET @client_mikheevsky := (SELECT id FROM clients WHERE company_name = 'Михеевский ГОК' LIMIT 1);
SET @client_polyus := (SELECT id FROM clients WHERE company_name = 'Полюс Магадан' LIMIT 1);
SET @client_amur := (SELECT id FROM clients WHERE company_name = 'Амур Минералс' LIMIT 1);
SET @model_cj180 := (SELECT id FROM equipment_models WHERE manufacturer_id = @zhekuang_id AND model_name = 'CJ180' LIMIT 1);
SET @model_mkii_6089 := (SELECT id FROM equipment_models WHERE manufacturer_id = @metso_id AND model_name = 'MKII 60-89' LIMIT 1);
SET @model_mkii_60100 := (SELECT id FROM equipment_models WHERE manufacturer_id = @metso_id AND model_name = 'MKII 60-100' LIMIT 1);
SET @model_mkiii_60100 := (SELECT id FROM equipment_models WHERE manufacturer_id = @metso_id AND model_name = 'MKIII 60-100' LIMIT 1);
SET @model_hp800 := (SELECT id FROM equipment_models WHERE manufacturer_id = @metso_id AND model_name = 'HP 800' LIMIT 1);
SET @model_ua1750 := (SELECT id FROM equipment_models WHERE manufacturer_id = @tecman_id AND model_name = 'UA1750' LIMIT 1);

INSERT INTO client_equipment_units
  (client_id, equipment_model_id, serial_number, manufacture_year, internal_name, status, notes)
SELECT @client_karelsky, @model_cj180, NULL, 2026,
       'Щековая дробилка/ СJ180 /SN (Карельский Окатыш)/ г.в.2026',
       'active', 'Создано миграцией НСИ из legacy-записи equipment_models #20'
WHERE @client_karelsky IS NOT NULL
  AND @model_cj180 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_equipment_units
     WHERE client_id = @client_karelsky
       AND equipment_model_id = @model_cj180
       AND internal_name = 'Щековая дробилка/ СJ180 /SN (Карельский Окатыш)/ г.в.2026'
  );

INSERT INTO client_equipment_units
  (client_id, equipment_model_id, serial_number, manufacture_year, internal_name, status, notes)
SELECT @client_lebedinsky, @model_mkii_6089, 'SN12345', 2010,
       'Гирационная дробилка/ MKII 60-89/ SN12345(один или два) (Лебединский ГОК)/ г.в.2010',
       'active', 'Создано миграцией НСИ из legacy-записи equipment_models #21'
WHERE @client_lebedinsky IS NOT NULL
  AND @model_mkii_6089 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_equipment_units
     WHERE client_id = @client_lebedinsky
       AND equipment_model_id = @model_mkii_6089
       AND serial_number_norm = 'SN12345'
  );

INSERT INTO client_equipment_units
  (client_id, equipment_model_id, serial_number, manufacture_year, internal_name, status, notes)
SELECT @client_mikheevsky, @model_mkii_6089, 'SN54321', 2013,
       'Гирационная дробилка/ MKII 60-89/ SN54321 (Михеевский ГОК)/ г.в.2013',
       'active', 'Создано миграцией НСИ из legacy-записи equipment_models #22'
WHERE @client_mikheevsky IS NOT NULL
  AND @model_mkii_6089 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_equipment_units
     WHERE client_id = @client_mikheevsky
       AND equipment_model_id = @model_mkii_6089
       AND serial_number_norm = 'SN54321'
  );

INSERT INTO client_equipment_units
  (client_id, equipment_model_id, serial_number, manufacture_year, internal_name, status, notes)
SELECT @client_mikheevsky, @model_hp800, '223344', 2022,
       'Конусная дробилка/ HP800/ sn 223344 (Михеевский ГОК)/ гв. 2022',
       'active', 'Создано миграцией НСИ из legacy-записи equipment_models #23'
WHERE @client_mikheevsky IS NOT NULL
  AND @model_hp800 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_equipment_units
     WHERE client_id = @client_mikheevsky
       AND equipment_model_id = @model_hp800
       AND serial_number_norm = '223344'
  );

INSERT INTO client_equipment_units
  (client_id, equipment_model_id, serial_number, manufacture_year, internal_name, status, notes)
SELECT @client_polyus, @model_mkii_60100, 'SN332211', 2012,
       'Гирационная дробилка/ MKII 60-100/ SN332211 (Полюс Магадан)/ г.в.2012',
       'active', 'Создано миграцией НСИ из legacy-записи equipment_models #24'
WHERE @client_polyus IS NOT NULL
  AND @model_mkii_60100 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_equipment_units
     WHERE client_id = @client_polyus
       AND equipment_model_id = @model_mkii_60100
       AND serial_number_norm = 'SN332211'
  );

INSERT INTO client_equipment_units
  (client_id, equipment_model_id, serial_number, manufacture_year, internal_name, status, notes)
SELECT @client_amur, @model_mkiii_60100, 'SN55669', 2023,
       'Гирационная дробилка/ MKIII 60-100/ SN55669 (Амур Минералс))/ г.в.2023',
       'active', 'Создано миграцией НСИ из legacy-записи equipment_models #25'
WHERE @client_amur IS NOT NULL
  AND @model_mkiii_60100 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_equipment_units
     WHERE client_id = @client_amur
       AND equipment_model_id = @model_mkiii_60100
       AND serial_number_norm = 'SN55669'
  );

INSERT INTO client_equipment_units
  (client_id, equipment_model_id, serial_number, internal_name, status, notes)
SELECT @client_karelsky, @model_ua1750, 'sn234455677',
       'Манипулятор/ UA1750/ sn234455677 (Карельский Окатыш)',
       'active', 'Создано миграцией НСИ из legacy-записи equipment_models #26'
WHERE @client_karelsky IS NOT NULL
  AND @model_ua1750 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_equipment_units
     WHERE client_id = @client_karelsky
       AND equipment_model_id = @model_ua1750
       AND serial_number_norm = 'SN234455677'
  );

UPDATE oem_parts op
JOIN oem_part_model_fitments f ON f.oem_part_id = op.id
JOIN equipment_models em ON em.id = f.equipment_model_id
   SET op.classifier_node_id = COALESCE(op.classifier_node_id, em.classifier_node_id)
 WHERE f.equipment_model_id IN (14, 60)
   AND op.classifier_node_id IS NULL;

DELETE FROM oem_part_model_fitments
 WHERE equipment_model_id IN (14, 60);

INSERT INTO oem_parts
  (manufacturer_id, classifier_node_id, part_number, description_ru, uom, has_drawing, is_overweight, is_oversize)
SELECT @sandvik_id,
       (SELECT classifier_node_id FROM equipment_models WHERE id = 28),
       '13254654',
       'Перенесено из ошибочной legacy-модели оборудования SANDVIK / 13254654',
       'шт',
       0,
       0,
       0
WHERE @sandvik_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM equipment_models WHERE id = 28)
  AND NOT EXISTS (
    SELECT 1 FROM oem_parts
     WHERE manufacturer_id = @sandvik_id
       AND part_number_norm = '13254654'
  );

INSERT INTO client_parts
  (client_id, classifier_node_id, client_part_number, client_part_number_norm, display_name, description_ru, uom, notes)
SELECT @client_lebedinsky,
       @client_drawing_node,
       'Футеровка 5',
       'ФУТЕРОВКА5',
       'Футеровка 5',
       'Клиентская деталь по чертежу. Перенесено из ошибочной legacy-модели оборудования.',
       'шт',
       'Источник: equipment_models #74 / Лебединский ГОК / Футеровка 5'
WHERE @client_lebedinsky IS NOT NULL
  AND @client_drawing_node IS NOT NULL
  AND EXISTS (SELECT 1 FROM equipment_models WHERE id = 74)
  AND NOT EXISTS (
    SELECT 1 FROM client_parts
     WHERE client_id = @client_lebedinsky
       AND client_part_number_norm = 'ФУТЕРОВКА5'
  );

UPDATE client_request_revision_items cri
JOIN client_parts cp
  ON cp.client_part_number_norm = UPPER(REPLACE(REPLACE(REPLACE(cri.client_part_number, ' ', ''), '.', ''), '-', ''))
 SET cri.client_part_id = cp.id
WHERE cri.client_part_id IS NULL
  AND cri.client_part_number IS NOT NULL;

DELETE FROM equipment_models
 WHERE id IN (14, 22, 23, 26, 28, 60, 61, 62, 63, 64, 65, 66, 67, 69, 71, 74)
   AND NOT EXISTS (SELECT 1 FROM client_equipment_units ceu WHERE ceu.equipment_model_id = equipment_models.id)
   AND NOT EXISTS (SELECT 1 FROM client_request_revision_items cri WHERE cri.equipment_model_id = equipment_models.id)
   AND NOT EXISTS (SELECT 1 FROM oem_part_model_fitments f WHERE f.equipment_model_id = equipment_models.id)
   AND NOT EXISTS (SELECT 1 FROM oem_part_model_bom b WHERE b.equipment_model_id = equipment_models.id);

COMMIT;
