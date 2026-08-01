-- Complete classifier setup: explicit leaf purposes, practical filter/import
-- passports by product family, and scopes for every configured attribute.
-- Does not create catalog positions, equipment models, BOM rows, or stock data.

START TRANSACTION;

-- Heavy, independently maintained machines: model -> manufacturer BOM -> positions.
UPDATE equipment_classifier_nodes
SET card_kind = 'equipment_model'
WHERE card_kind = 'auto'
  AND id IN (5, 23, 25, 27, 38, 40, 44, 95, 105, 167, 171, 172, 173, 174, 175);

-- Slewing rings/drives are purchasable bearing units, not standalone machines
-- with a manufacturer BOM. A previously started model in this leaf was already
-- deleted, so only its polymorphic orphan value is cleaned below.
UPDATE equipment_classifier_nodes
SET card_kind = 'catalog_position'
WHERE id = 177;

-- Every other unresolved leaf is a purchasable catalog position. Existing
-- explicit equipment/material/service decisions are intentionally preserved.
UPDATE equipment_classifier_nodes n
LEFT JOIN (
  SELECT parent_id
  FROM equipment_classifier_nodes
  WHERE is_active = 1 AND parent_id IS NOT NULL
  GROUP BY parent_id
) active_children ON active_children.parent_id = n.id
SET n.card_kind = 'catalog_position'
WHERE n.card_kind = 'auto'
  AND active_children.parent_id IS NULL;

-- Repair obvious legacy metadata errors only where there are no stored values
-- depending on the old type.
UPDATE equipment_classifier_node_attributes
SET value_type = 'text', semantic_key = 'configuration_type'
WHERE classifier_node_id = 16 AND code = 'tip_komplektacii'
  AND NOT EXISTS (SELECT 1 FROM equipment_attribute_values v WHERE v.attribute_id = equipment_classifier_node_attributes.id);

UPDATE equipment_classifier_node_attributes
SET value_type = 'text', semantic_key = 'belt_size'
WHERE classifier_node_id = 144 AND code = 'tiporazmer_remnya'
  AND NOT EXISTS (SELECT 1 FROM equipment_attribute_values v WHERE v.attribute_id = equipment_classifier_node_attributes.id);

UPDATE equipment_classifier_node_attributes
SET value_type = 'text', semantic_key = 'protection_ip'
WHERE classifier_node_id = 170 AND code = 'stepen_zaschity_ip'
  AND NOT EXISTS (SELECT 1 FROM equipment_attribute_values v WHERE v.attribute_id = equipment_classifier_node_attributes.id);

UPDATE equipment_classifier_node_attributes
SET value_type = 'text', semantic_key = 'shaft_configuration'
WHERE classifier_node_id = 170 AND code = 'ispolnenie_vala'
  AND NOT EXISTS (SELECT 1 FROM equipment_attribute_values v WHERE v.attribute_id = equipment_classifier_node_attributes.id);

UPDATE equipment_classifier_node_attributes
SET value_type = 'text', label = 'Размер ячейки / отверстия', unit = 'мм', semantic_key = 'aperture_size'
WHERE classifier_node_id = 179 AND code = 'razmer_yacheyki'
  AND NOT EXISTS (SELECT 1 FROM equipment_attribute_values v WHERE v.attribute_id = equipment_classifier_node_attributes.id);

UPDATE equipment_classifier_node_attributes SET label = 'Диаметр вала под подшипник', semantic_key = 'bearing_seat_diameter_mm'
WHERE classifier_node_id = 176 AND code = 'diametr_vara_pod_podshipnik';

UPDATE equipment_classifier_node_attributes SET unit = 'кВт'
WHERE unit IN ('квт', 'КВТ');

UPDATE equipment_classifier_node_attributes
SET unit = '°C'
WHERE classifier_node_id = 113 AND code IN ('range_min','range_max');

UPDATE equipment_classifier_node_attributes
SET unit = CASE code
  WHEN 'kolichestvo_zubev_shesterni' THEN 'шт'
  WHEN 'modul_zuba' THEN 'мм'
  ELSE unit
END
WHERE classifier_node_id = 177
  AND code IN ('kolichestvo_zubev_shesterni','modul_zuba');

-- A single unitless "working load" cannot distinguish axial, radial and
-- moment capacities. Keep the legacy definition for audit, but do not offer it
-- for new input until those engineering fields are defined separately.
UPDATE equipment_classifier_node_attributes
SET is_active = 0, is_filterable = 0, is_importable = 0
WHERE classifier_node_id = 177 AND code = 'rabochaya_nagruzka'
  AND NOT EXISTS (SELECT 1 FROM equipment_attribute_values v WHERE v.attribute_id = equipment_classifier_node_attributes.id);

-- Stable semantics for useful legacy characteristics.
UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'motor_power_kw' THEN 'motor_power_kw'
  WHEN 'mass_equipment_t' THEN 'mass_t'
  WHEN 'capacity_min_tph' THEN 'capacity_min_tph'
  WHEN 'capacity_max_tph' THEN 'capacity_max_tph'
  ELSE semantic_key
END
WHERE classifier_node_id = 7;

UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'rezba' THEN 'thread_diameter_mm'
  WHEN 'shag_rezby' THEN 'thread_pitch_mm'
  WHEN 'dlina' THEN 'length_mm'
  WHEN 'razmer_pod_klyuch' THEN 'wrench_size_mm'
  WHEN 'standart' THEN 'standard'
  WHEN 'klass_prochnosti' THEN 'strength_class'
  WHEN 'pokrytie' THEN 'coating'
  ELSE semantic_key
END,
is_identity = CASE WHEN code IN ('rezba','shag_rezby','dlina','standart') THEN 1 ELSE is_identity END
WHERE classifier_node_id = 120;

UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'proizvoditelnost' THEN 'capacity_tph'
  WHEN 'shirina_lenty' THEN 'belt_width_mm'
  WHEN 'dlina' THEN 'conveyor_length_m'
  WHEN 'ugol_naklona' THEN 'inclination_deg'
  WHEN 'moschnost_privoda' THEN 'motor_power_kw'
  WHEN 'tip_komplektacii' THEN 'configuration_type'
  ELSE semantic_key
END
WHERE classifier_node_id IN (16, 25);

UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'tip_remnya' THEN 'belt_type'
  WHEN 'tiporazmer_remnya' THEN 'belt_size'
  ELSE semantic_key
END
WHERE classifier_node_id = 144;

UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'peredatochnoe_chislo' THEN 'gear_ratio'
  WHEN 'moschnost_privoda' THEN 'motor_power_kw'
  WHEN 'stepen_zaschity_ip' THEN 'protection_ip'
  WHEN 'skorost_privoda' THEN 'input_speed_rpm'
  WHEN 'chastota_toka' THEN 'frequency_hz'
  WHEN 'skorost_vyhodnogo_vala' THEN 'output_speed_rpm'
  WHEN 'tip_ustanovki' THEN 'mounting_type'
  WHEN 'ispolnenie_vala' THEN 'shaft_configuration'
  WHEN 'diametr_vyhodnogo_vala' THEN 'output_shaft_diameter_mm'
  WHEN 'servis_faktor' THEN 'service_factor'
  ELSE semantic_key
END
WHERE classifier_node_id = 170;

UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'shirina_lenty' THEN 'belt_width_mm'
  WHEN 'dlina_obechayki_barabana' THEN 'shell_length_mm'
  WHEN 'diametr_obechayki_barabana' THEN 'shell_diameter_mm'
  WHEN 'tip_barabana' THEN 'drum_type'
  WHEN 'tolschina_obechayki_barabana' THEN 'shell_thickness_mm'
  ELSE semantic_key
END
WHERE classifier_node_id = 176;

UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'tip_sita' THEN 'screen_media_type'
  WHEN 'dlina' THEN 'length_mm'
  WHEN 'shirina' THEN 'width_mm'
  WHEN 'razmer_yacheyki' THEN 'aperture_size'
  ELSE semantic_key
END
WHERE classifier_node_id = 179;

UPDATE equipment_classifier_node_attributes
SET semantic_key = CASE code
  WHEN 'tip_zacepleniya' THEN 'gearing_type'
  WHEN 'diametr_delitelnyy_po_zubchatomu_zacepleniyu' THEN 'pitch_diameter_mm'
  WHEN 'gabaritnyy_razmer_kolca' THEN 'ring_size_mm'
  WHEN 'rabochaya_nagruzka' THEN 'working_load'
  WHEN 'kolichestvo_zubev_shesterni' THEN 'gear_teeth_count'
  WHEN 'modul_zuba' THEN 'gear_module'
  WHEN 'weight_kg' THEN 'weight_kg'
  ELSE semantic_key
END,
is_identity = CASE
  WHEN code IN ('tip_zacepleniya','diametr_delitelnyy_po_zubchatomu_zacepleniyu',
                'gabaritnyy_razmer_kolca','kolichestvo_zubev_shesterni','modul_zuba') THEN 1
  ELSE is_identity
END
WHERE classifier_node_id = 177;

DROP TEMPORARY TABLE IF EXISTS tmp_classifier_attribute_templates;
CREATE TEMPORARY TABLE tmp_classifier_attribute_templates (
  template_key VARCHAR(80) NOT NULL,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  value_type VARCHAR(20) NOT NULL,
  unit VARCHAR(50) NULL,
  sort_order INT NOT NULL,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  is_filterable TINYINT(1) NOT NULL DEFAULT 1,
  is_importable TINYINT(1) NOT NULL DEFAULT 1,
  is_identity TINYINT(1) NOT NULL DEFAULT 0,
  semantic_key VARCHAR(100) NULL,
  help_text VARCHAR(500) NULL,
  PRIMARY KEY (template_key, code)
) ENGINE=InnoDB;

INSERT INTO tmp_classifier_attribute_templates
  (template_key, code, label, value_type, unit, sort_order, is_required, is_filterable, is_importable, is_identity, semantic_key, help_text)
VALUES
-- Equipment models
('equipment_crusher','motor_power_kw','Мощность двигателя','number','кВт',10,0,1,1,0,'motor_power_kw',NULL),
('equipment_crusher','capacity_min_tph','Производительность от','number','т/ч',20,0,1,1,0,'capacity_min_tph',NULL),
('equipment_crusher','capacity_max_tph','Производительность до','number','т/ч',30,0,1,1,0,'capacity_max_tph',NULL),
('equipment_crusher','max_feed_size_mm','Максимальный размер питания','number','мм',40,0,1,1,0,'max_feed_size_mm',NULL),
('equipment_crusher','output_size_min_mm','Размер продукта от','number','мм',50,0,1,1,0,'output_size_min_mm',NULL),
('equipment_crusher','output_size_max_mm','Размер продукта до','number','мм',60,0,1,1,0,'output_size_max_mm',NULL),
('rock_breaker','impact_energy_j','Энергия удара','number','Дж',10,0,1,1,0,'impact_energy_j',NULL),
('rock_breaker','blows_per_min','Частота ударов','number','уд/мин',20,0,1,1,0,'blows_per_min',NULL),
('rock_breaker','carrier_weight_min_t','Масса носителя от','number','т',30,0,1,1,0,'carrier_weight_min_t',NULL),
('rock_breaker','carrier_weight_max_t','Масса носителя до','number','т',40,0,1,1,0,'carrier_weight_max_t',NULL),
('rock_breaker','working_pressure_bar','Рабочее давление','number','бар',50,0,1,1,0,'working_pressure_bar',NULL),
('rock_breaker','oil_flow_l_min','Расход масла','number','л/мин',60,0,1,1,0,'oil_flow_l_min',NULL),
('boom_manipulator','max_reach_m','Максимальный вылет','number','м',10,0,1,1,0,'max_reach_m',NULL),
('boom_manipulator','lifting_capacity_kg','Грузоподъёмность','number','кг',20,0,1,1,0,'lifting_capacity_kg',NULL),
('boom_manipulator','working_pressure_bar','Рабочее давление','number','бар',30,0,1,1,0,'working_pressure_bar',NULL),
('boom_manipulator','oil_flow_l_min','Расход масла','number','л/мин',40,0,1,1,0,'oil_flow_l_min',NULL),
('mill','mill_type','Тип мельницы','text',NULL,10,0,1,1,0,'mill_type',NULL),
('mill','drum_diameter_mm','Диаметр барабана','number','мм',20,0,1,1,0,'drum_diameter_mm',NULL),
('mill','drum_length_mm','Длина барабана','number','мм',30,0,1,1,0,'drum_length_mm',NULL),
('mill','capacity_tph','Производительность','number','т/ч',40,0,1,1,0,'capacity_tph',NULL),
('mill','motor_power_kw','Мощность двигателя','number','кВт',50,0,1,1,0,'motor_power_kw',NULL),
('feeder','capacity_tph','Производительность','number','т/ч',10,0,1,1,0,'capacity_tph',NULL),
('feeder','pan_width_mm','Ширина полотна / лотка','number','мм',20,0,1,1,0,'pan_width_mm',NULL),
('feeder','pan_length_mm','Длина полотна / лотка','number','мм',30,0,1,1,0,'pan_length_mm',NULL),
('feeder','feed_speed_m_min','Скорость подачи','number','м/мин',40,0,1,1,0,'feed_speed_m_min',NULL),
('feeder','motor_power_kw','Мощность привода','number','кВт',50,0,1,1,0,'motor_power_kw',NULL),
('hydrocyclone','capacity_m3_h','Производительность','number','м³/ч',10,0,1,1,0,'capacity_m3_h',NULL),
('hydrocyclone','inlet_pressure_kpa','Давление на входе','number','кПа',20,0,1,1,0,'inlet_pressure_kpa',NULL),
('hydrocyclone','feed_diameter_mm','Диаметр питающего патрубка','number','мм',30,0,1,1,0,'feed_diameter_mm',NULL),
('hydrocyclone','overflow_diameter_mm','Диаметр сливного патрубка','number','мм',40,0,1,1,0,'overflow_diameter_mm',NULL),
('hydrocyclone','underflow_diameter_mm','Диаметр пескового патрубка','number','мм',50,0,1,1,0,'underflow_diameter_mm',NULL),
('classifier_equipment','classifier_type','Тип классификатора','text',NULL,10,0,1,1,0,'classifier_type',NULL),
('classifier_equipment','capacity_tph','Производительность','number','т/ч',20,0,1,1,0,'capacity_tph',NULL),
('classifier_equipment','separation_size_mm','Граница разделения','number','мм',30,0,1,1,0,'separation_size_mm',NULL),
('classifier_equipment','motor_power_kw','Мощность привода','number','кВт',40,0,1,1,0,'motor_power_kw',NULL),
('mobile_conveyor','capacity_tph','Производительность','number','т/ч',10,0,1,1,0,'capacity_tph',NULL),
('mobile_conveyor','belt_width_mm','Ширина ленты','number','мм',20,0,1,1,0,'belt_width_mm',NULL),
('mobile_conveyor','conveyor_length_m','Длина конвейера','number','м',30,0,1,1,0,'conveyor_length_m',NULL),
('mobile_conveyor','motor_power_kw','Мощность привода','number','кВт',40,0,1,1,0,'motor_power_kw',NULL),
('mobile_conveyor','mobility_type','Исполнение / мобильность','text',NULL,50,0,1,1,0,'mobility_type',NULL),
('filter_press','filtration_area_m2','Площадь фильтрации','number','м²',10,0,1,1,0,'filtration_area_m2',NULL),
('filter_press','plate_count','Количество плит','number','шт',20,0,1,1,0,'plate_count',NULL),
('filter_press','plate_size_mm','Размер плит','text','мм',30,0,1,1,0,'plate_size_mm','Например 1500 × 1500.'),
('filter_press','chamber_volume_l','Объём камер','number','л',40,0,1,1,0,'chamber_volume_l',NULL),
('filter_press','working_pressure_bar','Рабочее давление','number','бар',50,0,1,1,0,'working_pressure_bar',NULL),
('thickener','tank_diameter_m','Диаметр сгустителя','number','м',10,0,1,1,0,'tank_diameter_m',NULL),
('thickener','capacity_tph','Производительность','number','т/ч',20,0,1,1,0,'capacity_tph',NULL),
('thickener','drive_power_kw','Мощность привода','number','кВт',30,0,1,1,0,'drive_power_kw',NULL),
('thickener','rake_torque_knm','Крутящий момент граблин','number','кН·м',40,0,1,1,0,'rake_torque_knm',NULL),
('flotation','cell_volume_m3','Объём камеры','number','м³',10,0,1,1,0,'cell_volume_m3',NULL),
('flotation','cell_count','Количество камер','number','шт',20,0,1,1,0,'cell_count',NULL),
('flotation','capacity_tph','Производительность','number','т/ч',30,0,1,1,0,'capacity_tph',NULL),
('flotation','motor_power_kw','Мощность двигателя','number','кВт',40,0,1,1,0,'motor_power_kw',NULL),
('pump_equipment','pump_type','Тип насоса','text',NULL,10,0,1,1,0,'pump_type',NULL),
('pump_equipment','flow_m3_h','Подача','number','м³/ч',20,0,1,1,0,'flow_m3_h',NULL),
('pump_equipment','head_m','Напор','number','м',30,0,1,1,0,'head_m',NULL),
('pump_equipment','inlet_diameter_mm','Диаметр входа','number','мм',40,0,1,1,0,'inlet_diameter_mm',NULL),
('pump_equipment','outlet_diameter_mm','Диаметр выхода','number','мм',50,0,1,1,0,'outlet_diameter_mm',NULL),
('pump_equipment','motor_power_kw','Мощность двигателя','number','кВт',60,0,1,1,0,'motor_power_kw',NULL),
('vehicle','vehicle_type','Тип транспорта','text',NULL,10,0,1,1,0,'vehicle_type',NULL),
('vehicle','payload_t','Грузоподъёмность','number','т',20,0,1,1,0,'payload_t',NULL),
('vehicle','gross_weight_t','Полная масса','number','т',30,0,1,1,0,'gross_weight_t',NULL),
('vehicle','engine_power_kw','Мощность двигателя','number','кВт',40,0,1,1,0,'engine_power_kw',NULL),
('vehicle','axle_configuration','Колёсная формула','text',NULL,50,0,1,1,0,'axle_configuration',NULL),
('compressor','compressor_type','Тип компрессора','text',NULL,10,0,1,1,0,'compressor_type',NULL),
('compressor','working_pressure_bar','Рабочее давление','number','бар',20,0,1,1,0,'working_pressure_bar',NULL),
('compressor','capacity_m3_min','Производительность','number','м³/мин',30,0,1,1,0,'capacity_m3_min',NULL),
('compressor','motor_power_kw','Мощность двигателя','number','кВт',40,0,1,1,0,'motor_power_kw',NULL),
('compressor','receiver_volume_l','Объём ресивера','number','л',50,0,1,1,0,'receiver_volume_l',NULL),
('excavator','operating_weight_t','Эксплуатационная масса','number','т',10,0,1,1,0,'operating_weight_t',NULL),
('excavator','engine_power_kw','Мощность двигателя','number','кВт',20,0,1,1,0,'engine_power_kw',NULL),
('excavator','bucket_volume_m3','Объём ковша','number','м³',30,0,1,1,0,'bucket_volume_m3',NULL),
('excavator','max_digging_depth_mm','Максимальная глубина копания','number','мм',40,0,1,1,0,'max_digging_depth_mm',NULL),
('thermal_equipment','equipment_type','Тип оборудования','text',NULL,10,0,1,1,0,'equipment_type',NULL),
('thermal_equipment','thermal_power_kw','Тепловая мощность','number','кВт',20,0,1,1,0,'thermal_power_kw',NULL),
('thermal_equipment','working_temperature_c','Рабочая температура','number','°C',30,0,1,1,0,'working_temperature_c',NULL),
('thermal_equipment','working_medium','Рабочая среда','text',NULL,40,0,1,1,0,'working_medium',NULL),
('thermal_equipment','voltage_v','Напряжение','number','В',50,0,1,1,0,'voltage_v',NULL),
('generic_equipment','equipment_type','Тип оборудования','text',NULL,10,0,1,1,0,'equipment_type',NULL),
('generic_equipment','capacity_tph','Производительность','number','т/ч',20,0,1,1,0,'capacity_tph',NULL),
('generic_equipment','motor_power_kw','Мощность привода','number','кВт',30,0,1,1,0,'motor_power_kw',NULL),

-- Catalog positions
('hydraulic_fitting','connection_type','Тип присоединения','text',NULL,10,0,1,1,0,'connection_type',NULL),
('hydraulic_fitting','nominal_size_mm','Условный проход','number','мм',20,0,1,1,1,'nominal_size_mm',NULL),
('hydraulic_fitting','thread_standard','Резьба / стандарт присоединения','text',NULL,30,0,1,1,1,'thread_standard',NULL),
('hydraulic_fitting','working_pressure_bar','Рабочее давление','number','бар',40,0,1,1,0,'working_pressure_bar',NULL),
('hydraulic_fitting','material','Материал','text',NULL,50,0,1,1,0,'material',NULL),
('hydraulic_nut','thread_designation','Обозначение резьбы','text',NULL,10,0,1,1,1,'thread_designation',NULL),
('hydraulic_nut','working_pressure_bar','Рабочее давление','number','бар',20,0,1,1,0,'working_pressure_bar',NULL),
('hydraulic_nut','stroke_mm','Рабочий ход','number','мм',30,0,1,1,0,'stroke_mm',NULL),
('hydraulic_nut','outer_diameter_mm','Наружный диаметр','number','мм',40,0,1,1,0,'outer_diameter_mm',NULL),
('hydraulic_valve','valve_type','Тип клапана / распределителя','text',NULL,10,0,1,1,0,'valve_type',NULL),
('hydraulic_valve','nominal_size_mm','Условный проход','number','мм',20,0,1,1,0,'nominal_size_mm',NULL),
('hydraulic_valve','max_flow_l_min','Максимальный расход','number','л/мин',30,0,1,1,0,'max_flow_l_min',NULL),
('hydraulic_valve','max_pressure_bar','Максимальное давление','number','бар',40,0,1,1,0,'max_pressure_bar',NULL),
('hydraulic_valve','control_type','Тип управления','text',NULL,50,0,1,1,0,'control_type',NULL),
('compensator','nominal_diameter_mm','Условный диаметр','number','мм',10,0,1,1,1,'nominal_diameter_mm',NULL),
('compensator','length_mm','Монтажная длина','number','мм',20,0,1,1,0,'length_mm',NULL),
('compensator','working_pressure_bar','Рабочее давление','number','бар',30,0,1,1,0,'working_pressure_bar',NULL),
('compensator','working_temperature_c','Рабочая температура','number','°C',40,0,1,1,0,'working_temperature_c',NULL),
('compensator','material','Материал','text',NULL,50,0,1,1,0,'material',NULL),
('pressure_gauge','pressure_min_bar','Диапазон давления от','number','бар',10,0,1,1,0,'pressure_min_bar',NULL),
('pressure_gauge','pressure_max_bar','Диапазон давления до','number','бар',20,0,1,1,0,'pressure_max_bar',NULL),
('pressure_gauge','dial_diameter_mm','Диаметр корпуса','number','мм',30,0,1,1,0,'dial_diameter_mm',NULL),
('pressure_gauge','accuracy_class','Класс точности','text',NULL,40,0,1,1,0,'accuracy_class',NULL),
('pressure_gauge','connection_type','Присоединение','text',NULL,50,0,1,1,0,'connection_type',NULL),
('hydraulic_pump','pump_type','Тип насоса','text',NULL,10,0,1,1,0,'pump_type',NULL),
('hydraulic_pump','displacement_cm3_rev','Рабочий объём','number','см³/об',20,0,1,1,0,'displacement_cm3_rev',NULL),
('hydraulic_pump','max_pressure_bar','Максимальное давление','number','бар',30,0,1,1,0,'max_pressure_bar',NULL),
('hydraulic_pump','max_flow_l_min','Максимальная подача','number','л/мин',40,0,1,1,0,'max_flow_l_min',NULL),
('hydraulic_pump','rotation_direction','Направление вращения','text',NULL,50,0,1,1,0,'rotation_direction',NULL),
('hydraulic_hose','inner_diameter_mm','Внутренний диаметр','number','мм',10,0,1,1,1,'inner_diameter_mm',NULL),
('hydraulic_hose','length_mm','Длина','number','мм',20,0,1,1,1,'length_mm',NULL),
('hydraulic_hose','working_pressure_bar','Рабочее давление','number','бар',30,0,1,1,0,'working_pressure_bar',NULL),
('hydraulic_hose','burst_pressure_bar','Разрывное давление','number','бар',40,0,1,1,0,'burst_pressure_bar',NULL),
('hydraulic_hose','fitting_type','Исполнение фитингов','text',NULL,50,0,1,1,0,'fitting_type',NULL),
('hydraulic_filter','filter_type','Тип фильтра','text',NULL,10,0,1,1,0,'filter_type',NULL),
('hydraulic_filter','filtration_micron','Тонкость фильтрации','number','мкм',20,0,1,1,0,'filtration_micron',NULL),
('hydraulic_filter','max_flow_l_min','Максимальный расход','number','л/мин',30,0,1,1,0,'max_flow_l_min',NULL),
('hydraulic_filter','max_pressure_bar','Максимальное давление','number','бар',40,0,1,1,0,'max_pressure_bar',NULL),
('hydraulic_filter','connection_type','Присоединение','text',NULL,50,0,1,1,0,'connection_type',NULL),
('pneumatic_cylinder','bore_diameter_mm','Диаметр поршня','number','мм',10,0,1,1,1,'bore_diameter_mm',NULL),
('pneumatic_cylinder','stroke_mm','Ход штока','number','мм',20,0,1,1,1,'stroke_mm',NULL),
('pneumatic_cylinder','rod_diameter_mm','Диаметр штока','number','мм',30,0,1,1,0,'rod_diameter_mm',NULL),
('pneumatic_cylinder','working_pressure_bar','Рабочее давление','number','бар',40,0,1,1,0,'working_pressure_bar',NULL),
('pneumatic_cylinder','mounting_type','Тип крепления','text',NULL,50,0,1,1,0,'mounting_type',NULL),
('fastener_screw','standard','Стандарт','text',NULL,10,0,1,1,1,'standard',NULL),
('fastener_screw','thread_diameter_mm','Диаметр резьбы','number','мм',20,0,1,1,1,'thread_diameter_mm',NULL),
('fastener_screw','thread_pitch_mm','Шаг резьбы','number','мм',30,0,1,1,1,'thread_pitch_mm',NULL),
('fastener_screw','length_mm','Длина','number','мм',40,0,1,1,1,'length_mm',NULL),
('fastener_screw','head_type','Тип головки','text',NULL,50,0,1,1,0,'head_type',NULL),
('fastener_screw','drive_type','Тип шлица','text',NULL,60,0,1,1,0,'drive_type',NULL),
('fastener_screw','strength_class','Класс прочности','text',NULL,70,0,1,1,0,'strength_class',NULL),
('fastener_common','standard','Стандарт','text',NULL,10,0,1,1,1,'standard',NULL),
('fastener_common','nominal_diameter_mm','Номинальный диаметр','number','мм',20,0,1,1,1,'nominal_diameter_mm',NULL),
('fastener_common','length_mm','Длина','number','мм',30,0,1,1,1,'length_mm',NULL),
('fastener_common','material','Материал','text',NULL,40,0,1,1,0,'material',NULL),
('fastener_common','coating','Покрытие','text',NULL,50,0,1,1,0,'coating',NULL),
('washer','standard','Стандарт','text',NULL,10,0,1,1,1,'standard',NULL),
('washer','inner_diameter_mm','Внутренний диаметр','number','мм',20,0,1,1,1,'inner_diameter_mm',NULL),
('washer','outer_diameter_mm','Наружный диаметр','number','мм',30,0,1,1,1,'outer_diameter_mm',NULL),
('washer','thickness_mm','Толщина','number','мм',40,0,1,1,1,'thickness_mm',NULL),
('washer','material','Материал','text',NULL,50,0,1,1,0,'material',NULL),
('washer','coating','Покрытие','text',NULL,60,0,1,1,0,'coating',NULL),
('bearing','bearing_type','Тип подшипника','text',NULL,10,0,1,1,0,'bearing_type',NULL),
('bearing','designation','Обозначение','text',NULL,20,0,1,1,1,'designation',NULL),
('bearing','inner_diameter_mm','Внутренний диаметр','number','мм',30,0,1,1,0,'inner_diameter_mm',NULL),
('bearing','outer_diameter_mm','Наружный диаметр','number','мм',40,0,1,1,0,'outer_diameter_mm',NULL),
('bearing','width_mm','Ширина','number','мм',50,0,1,1,0,'width_mm',NULL),
('bearing','seal_type','Исполнение уплотнения','text',NULL,60,0,1,1,0,'seal_type',NULL),
('bearing','clearance_class','Класс радиального зазора','text',NULL,70,0,1,1,0,'clearance_class',NULL),
('bearing_housing','housing_type','Тип корпуса','text',NULL,10,0,1,1,0,'housing_type',NULL),
('bearing_housing','bearing_designation','Обозначение подшипника','text',NULL,20,0,1,1,1,'bearing_designation',NULL),
('bearing_housing','shaft_diameter_mm','Диаметр вала','number','мм',30,0,1,1,0,'shaft_diameter_mm',NULL),
('bearing_housing','mounting_type','Тип крепления','text',NULL,40,0,1,1,0,'mounting_type',NULL),
('lubrication_system','system_type','Тип системы','text',NULL,10,0,1,1,0,'system_type',NULL),
('lubrication_system','reservoir_volume_l','Объём резервуара','number','л',20,0,1,1,0,'reservoir_volume_l',NULL),
('lubrication_system','max_pressure_bar','Максимальное давление','number','бар',30,0,1,1,0,'max_pressure_bar',NULL),
('lubrication_system','outlet_count','Количество точек смазки','number','шт',40,0,1,1,0,'outlet_count',NULL),
('gearbox','gearbox_type','Тип редуктора','text',NULL,10,0,1,1,0,'gearbox_type',NULL),
('gearbox','gear_ratio','Передаточное число','number',NULL,20,0,1,1,0,'gear_ratio',NULL),
('gearbox','rated_torque_nm','Номинальный момент','number','Н·м',30,0,1,1,0,'rated_torque_nm',NULL),
('gearbox','input_speed_rpm','Входная скорость','number','об/мин',40,0,1,1,0,'input_speed_rpm',NULL),
('gearbox','output_speed_rpm','Выходная скорость','number','об/мин',50,0,1,1,0,'output_speed_rpm',NULL),
('gearbox','mounting_type','Монтажное исполнение','text',NULL,60,0,1,1,0,'mounting_type',NULL),
('coupling','coupling_type','Тип муфты','text',NULL,10,0,1,1,0,'coupling_type',NULL),
('coupling','bore_diameter_mm','Диаметр отверстия','number','мм',20,0,1,1,0,'bore_diameter_mm',NULL),
('coupling','rated_torque_nm','Номинальный момент','number','Н·м',30,0,1,1,0,'rated_torque_nm',NULL),
('coupling','max_speed_rpm','Максимальная скорость','number','об/мин',40,0,1,1,0,'max_speed_rpm',NULL),
('chain','chain_pitch_mm','Шаг цепи','number','мм',10,0,1,1,1,'chain_pitch_mm',NULL),
('chain','row_count','Количество рядов','number','шт',20,0,1,1,1,'row_count',NULL),
('chain','roller_diameter_mm','Диаметр ролика','number','мм',30,0,1,1,0,'roller_diameter_mm',NULL),
('chain','inner_width_mm','Внутренняя ширина','number','мм',40,0,1,1,0,'inner_width_mm',NULL),
('chain','link_count','Количество звеньев','number','шт',50,0,1,1,0,'link_count',NULL),
('pulley','pulley_type','Тип шкива','text',NULL,10,0,1,1,0,'pulley_type',NULL),
('pulley','outer_diameter_mm','Наружный диаметр','number','мм',20,0,1,1,0,'outer_diameter_mm',NULL),
('pulley','bore_diameter_mm','Диаметр отверстия','number','мм',30,0,1,1,0,'bore_diameter_mm',NULL),
('pulley','groove_count','Количество ручьёв','number','шт',40,0,1,1,0,'groove_count',NULL),
('pulley','belt_profile','Профиль ремня','text',NULL,50,0,1,1,0,'belt_profile',NULL),
('seal','seal_profile','Профиль / тип уплотнения','text',NULL,10,0,1,1,0,'seal_profile',NULL),
('seal','inner_diameter_mm','Внутренний диаметр','number','мм',20,0,1,1,1,'inner_diameter_mm',NULL),
('seal','outer_diameter_mm','Наружный диаметр','number','мм',30,0,1,1,1,'outer_diameter_mm',NULL),
('seal','width_mm','Ширина / высота','number','мм',40,0,1,1,1,'width_mm',NULL),
('seal','material','Материал','text',NULL,50,0,1,1,0,'material',NULL),
('seal','hardness_shore_a','Твёрдость','number','Shore A',60,0,1,1,0,'hardness_shore_a',NULL),
('electrical','rated_voltage_v','Номинальное напряжение','number','В',10,0,1,1,0,'rated_voltage_v',NULL),
('electrical','rated_current_a','Номинальный ток','number','А',20,0,1,1,0,'rated_current_a',NULL),
('electrical','pole_count','Количество полюсов','number','шт',30,0,1,1,0,'pole_count',NULL),
('electrical','protection_ip','Степень защиты IP','text',NULL,40,0,1,1,0,'protection_ip',NULL),
('electrical','mounting_type','Монтажное исполнение','text',NULL,50,0,1,1,0,'mounting_type',NULL),
('cable','conductor_count','Количество жил','number','шт',10,0,1,1,1,'conductor_count',NULL),
('cable','conductor_section_mm2','Сечение жилы','number','мм²',20,0,1,1,1,'conductor_section_mm2',NULL),
('cable','rated_voltage_v','Номинальное напряжение','number','В',30,0,1,1,0,'rated_voltage_v',NULL),
('cable','insulation_material','Материал изоляции','text',NULL,40,0,1,1,0,'insulation_material',NULL),
('cable','length_m','Длина','number','м',50,0,1,1,0,'length_m',NULL),
('sensor','sensor_type','Тип датчика','text',NULL,10,0,1,1,0,'sensor_type',NULL),
('sensor','range_min','Диапазон измерения от','number',NULL,20,0,1,1,0,'range_min',NULL),
('sensor','range_max','Диапазон измерения до','number',NULL,30,0,1,1,0,'range_max',NULL),
('sensor','output_signal','Выходной сигнал','text',NULL,40,0,1,1,0,'output_signal',NULL),
('sensor','supply_voltage_v','Напряжение питания','number','В',50,0,1,1,0,'supply_voltage_v',NULL),
('controller','controller_type','Тип устройства','text',NULL,10,0,1,1,0,'controller_type',NULL),
('controller','supply_voltage_v','Напряжение питания','number','В',20,0,1,1,0,'supply_voltage_v',NULL),
('controller','input_count','Количество входов','number','шт',30,0,1,1,0,'input_count',NULL),
('controller','output_count','Количество выходов','number','шт',40,0,1,1,0,'output_count',NULL),
('controller','communication_interfaces','Интерфейсы связи','text',NULL,50,0,1,1,0,'communication_interfaces',NULL),
('rigging','working_load_t','Рабочая грузоподъёмность','number','т',10,0,1,1,0,'working_load_t',NULL),
('rigging','standard','Стандарт','text',NULL,20,0,1,1,0,'standard',NULL),
('rigging','material','Материал','text',NULL,30,0,1,1,0,'material',NULL),
('rigging','length_m','Длина','number','м',40,0,1,1,0,'length_m',NULL),
('rigging','diameter_mm','Диаметр / калибр','number','мм',50,0,1,1,0,'diameter_mm',NULL),
('ppe','ppe_type','Тип СИЗ','text',NULL,10,0,1,1,0,'ppe_type',NULL),
('ppe','protection_class','Класс защиты','text',NULL,20,0,1,1,0,'protection_class',NULL),
('ppe','standard','Стандарт','text',NULL,30,0,1,1,0,'standard',NULL),
('ppe','size','Размер','text',NULL,40,0,1,1,0,'size',NULL),
('ppe','material','Материал','text',NULL,50,0,1,1,0,'material',NULL),
('physical_item','material','Материал','text',NULL,10,0,1,1,0,'material',NULL),
('physical_item','length_mm','Длина','number','мм',20,0,1,1,0,'length_mm',NULL),
('physical_item','width_mm','Ширина','number','мм',30,0,1,1,0,'width_mm',NULL),
('physical_item','height_mm','Высота','number','мм',40,0,1,1,0,'height_mm',NULL),
('physical_item','weight_kg','Масса','number','кг',50,0,1,1,0,'weight_kg',NULL),
('tool','tool_type','Тип инструмента','text',NULL,10,0,1,1,0,'tool_type',NULL),
('tool','size_designation','Размер / исполнение','text',NULL,20,0,1,1,0,'size_designation',NULL),
('tool','working_range','Рабочий диапазон','text',NULL,30,0,1,1,0,'working_range',NULL),
('tool','accuracy_class','Класс точности','text',NULL,40,0,1,1,0,'accuracy_class',NULL),
('power_tool','tool_type','Тип инструмента','text',NULL,10,0,1,1,0,'tool_type',NULL),
('power_tool','power_w','Мощность','number','Вт',20,0,1,1,0,'power_w',NULL),
('power_tool','voltage_v','Напряжение','number','В',30,0,1,1,0,'voltage_v',NULL),
('power_tool','speed_rpm','Частота вращения','number','об/мин',40,0,1,1,0,'speed_rpm',NULL),
('power_tool','tool_mount','Тип оснастки / патрона','text',NULL,50,0,1,1,0,'tool_mount',NULL),
('welding_machine','welding_process','Процесс сварки','text',NULL,10,0,1,1,0,'welding_process',NULL),
('welding_machine','welding_current_a','Сварочный ток','number','А',20,0,1,1,0,'welding_current_a',NULL),
('welding_machine','supply_voltage_v','Напряжение питания','number','В',30,0,1,1,0,'supply_voltage_v',NULL),
('welding_machine','power_kw','Потребляемая мощность','number','кВт',40,0,1,1,0,'power_kw',NULL),
('welding_machine','duty_cycle_percent','Продолжительность включения','number','%',50,0,1,1,0,'duty_cycle_percent',NULL),
('welding_consumable','consumable_type','Тип расходного материала','text',NULL,10,0,1,1,0,'consumable_type',NULL),
('welding_consumable','standard','Стандарт / марка','text',NULL,20,0,1,1,1,'standard',NULL),
('welding_consumable','diameter_mm','Диаметр','number','мм',30,0,1,1,0,'diameter_mm',NULL),
('welding_consumable','length_mm','Длина','number','мм',40,0,1,1,0,'length_mm',NULL),
('welding_consumable','material','Материал','text',NULL,50,0,1,1,0,'material',NULL),
('attachment','attachment_type','Тип навесного оборудования','text',NULL,10,0,1,1,0,'attachment_type',NULL),
('attachment','carrier_class','Класс базовой машины','text',NULL,20,0,1,1,0,'carrier_class',NULL),
('attachment','working_width_mm','Рабочая ширина','number','мм',30,0,1,1,0,'working_width_mm',NULL),
('attachment','weight_kg','Масса','number','кг',40,0,1,1,0,'weight_kg',NULL),
('attachment','mounting_interface','Интерфейс крепления','text',NULL,50,0,1,1,0,'mounting_interface',NULL),
('office_equipment','device_type','Тип устройства','text',NULL,10,0,1,1,0,'device_type',NULL),
('office_equipment','print_format','Поддерживаемый формат','text',NULL,20,0,1,1,0,'print_format',NULL),
('office_equipment','power_w','Потребляемая мощность','number','Вт',30,0,1,1,0,'power_w',NULL),
('office_equipment','network_interfaces','Сетевые интерфейсы','text',NULL,40,0,1,1,0,'network_interfaces',NULL),
('packaging','packaging_type','Тип упаковки','text',NULL,10,0,1,1,0,'packaging_type',NULL),
('packaging','inner_volume_l','Полезный объём','number','л',20,0,1,1,0,'inner_volume_l',NULL),
('packaging','max_load_kg','Допустимая нагрузка','number','кг',30,0,1,1,0,'max_load_kg',NULL),
('packaging','material','Материал','text',NULL,40,0,1,1,0,'material',NULL),
('spring','spring_type','Тип пружины','text',NULL,10,0,1,1,0,'spring_type',NULL),
('spring','wire_diameter_mm','Диаметр проволоки','number','мм',20,0,1,1,0,'wire_diameter_mm',NULL),
('spring','outer_diameter_mm','Наружный диаметр','number','мм',30,0,1,1,0,'outer_diameter_mm',NULL),
('spring','free_length_mm','Свободная длина','number','мм',40,0,1,1,0,'free_length_mm',NULL),
('spring','spring_rate_n_mm','Жёсткость','number','Н/мм',50,0,1,1,0,'spring_rate_n_mm',NULL),

-- Materials and services
('lubricant','product_type','Тип продукта','text',NULL,10,0,1,1,0,'product_type',NULL),
('lubricant','viscosity_grade','Класс вязкости','text',NULL,20,0,1,1,1,'viscosity_grade',NULL),
('lubricant','base_type','Тип основы','text',NULL,30,0,1,1,0,'base_type',NULL),
('lubricant','operating_temperature','Рабочий диапазон температур','text','°C',40,0,1,1,0,'operating_temperature',NULL),
('lubricant','package_volume_l','Объём упаковки','number','л',50,0,1,1,0,'package_volume_l',NULL),
('fuel','fuel_type','Тип топлива','text',NULL,10,0,1,1,1,'fuel_type',NULL),
('fuel','grade','Марка','text',NULL,20,0,1,1,1,'grade',NULL),
('fuel','sulfur_content_percent','Содержание серы','number','%',30,0,1,1,0,'sulfur_content_percent',NULL),
('fuel','package_volume_l','Объём партии / ёмкости','number','л',40,0,1,1,0,'package_volume_l',NULL),
('sheet_metal','steel_grade','Марка материала','text',NULL,10,0,1,1,1,'material_grade',NULL),
('sheet_metal','standard','Стандарт','text',NULL,20,0,1,1,1,'standard',NULL),
('sheet_metal','thickness_mm','Толщина','number','мм',30,0,1,1,1,'thickness_mm',NULL),
('sheet_metal','width_mm','Ширина','number','мм',40,0,1,1,0,'width_mm',NULL),
('sheet_metal','length_mm','Длина','number','мм',50,0,1,1,0,'length_mm',NULL),
('profile_metal','profile_type','Тип профиля','text',NULL,10,0,1,1,1,'profile_type',NULL),
('profile_metal','material_grade','Марка материала','text',NULL,20,0,1,1,1,'material_grade',NULL),
('profile_metal','standard','Стандарт','text',NULL,30,0,1,1,0,'standard',NULL),
('profile_metal','section_size','Размер сечения','text','мм',40,0,1,1,1,'section_size',NULL),
('profile_metal','length_mm','Длина','number','мм',50,0,1,1,0,'length_mm',NULL),
('bar_metal','material_grade','Марка материала','text',NULL,10,0,1,1,1,'material_grade',NULL),
('bar_metal','standard','Стандарт','text',NULL,20,0,1,1,0,'standard',NULL),
('bar_metal','diameter_mm','Диаметр','number','мм',30,0,1,1,1,'diameter_mm',NULL),
('bar_metal','length_mm','Длина','number','мм',40,0,1,1,0,'length_mm',NULL),
('concrete_product','standard','Стандарт / серия','text',NULL,10,0,1,1,1,'standard',NULL),
('concrete_product','concrete_class','Класс бетона','text',NULL,20,0,1,1,0,'concrete_class',NULL),
('concrete_product','length_mm','Длина','number','мм',30,0,1,1,0,'length_mm',NULL),
('concrete_product','width_mm','Ширина','number','мм',40,0,1,1,0,'width_mm',NULL),
('concrete_product','height_mm','Высота','number','мм',50,0,1,1,0,'height_mm',NULL),
('concrete_product','weight_kg','Масса','number','кг',60,0,1,1,0,'weight_kg',NULL),
('service','execution_location','Место выполнения','text',NULL,10,0,1,1,0,'execution_location',NULL),
('service','duration_hours','Нормативная продолжительность','number','ч',20,0,1,1,0,'duration_hours',NULL),
('service','requires_shutdown','Требует остановки оборудования','boolean',NULL,30,0,1,1,0,'requires_shutdown',NULL),
('service','qualification_requirements','Требования к квалификации','text',NULL,40,0,1,1,0,'qualification_requirements',NULL);

DROP TEMPORARY TABLE IF EXISTS tmp_classifier_node_templates;
CREATE TEMPORARY TABLE tmp_classifier_node_templates (
  node_id INT NOT NULL,
  template_key VARCHAR(80) NOT NULL,
  PRIMARY KEY (node_id, template_key)
) ENGINE=InnoDB;

INSERT INTO tmp_classifier_node_templates (node_id, template_key) VALUES
-- Equipment
(8,'equipment_crusher'),(37,'equipment_crusher'),(38,'equipment_crusher'),
(10,'rock_breaker'),(9,'boom_manipulator'),(11,'mill'),(14,'feeder'),(27,'feeder'),
(175,'hydrocyclone'),(44,'classifier_equipment'),(23,'mobile_conveyor'),
(173,'filter_press'),(5,'generic_equipment'),(172,'thickener'),(171,'flotation'),
(174,'pump_equipment'),(167,'vehicle'),(105,'compressor'),(40,'excavator'),(95,'thermal_equipment'),
-- Hydraulics and pneumatics
(81,'hydraulic_fitting'),(131,'hydraulic_nut'),(80,'hydraulic_valve'),(82,'hydraulic_valve'),
(149,'compensator'),(87,'pressure_gauge'),(78,'hydraulic_pump'),(79,'hydraulic_hose'),
(104,'hydraulic_filter'),(106,'pneumatic_cylinder'),
-- Fasteners
(121,'fastener_screw'),(126,'fastener_common'),(127,'fastener_common'),
(129,'fastener_common'),(124,'fastener_common'),(125,'washer'),
-- Bearings and drives
(84,'bearing'),(85,'bearing_housing'),(115,'lubrication_system'),
(169,'gearbox'),(145,'coupling'),(142,'chain'),(143,'pulley'),
-- Seals
(72,'seal'),(73,'seal'),(74,'seal'),(75,'seal'),
-- Electrical and controls
(107,'electrical'),(108,'electrical'),(109,'electrical'),(110,'electrical'),(111,'electrical'),
(112,'cable'),(113,'sensor'),(114,'controller'),
-- Tools, welding, PPE
(116,'tool'),(118,'tool'),(130,'tool'),(117,'power_tool'),
(146,'welding_machine'),(147,'welding_consumable'),(148,'ppe'),(93,'ppe'),
-- Rigging and attachments
(157,'rigging'),(158,'rigging'),(159,'rigging'),(160,'rigging'),(141,'attachment'),
-- Furniture, packaging, office and other physical goods
(133,'physical_item'),(134,'physical_item'),(135,'physical_item'),
(150,'concrete_product'),(151,'concrete_product'),
(164,'packaging'),(165,'packaging'),(163,'packaging'),(166,'office_equipment'),
(102,'physical_item'),(103,'physical_item'),(101,'spring'),
-- Materials
(152,'lubricant'),(153,'lubricant'),(154,'lubricant'),(155,'lubricant'),(168,'fuel'),
(136,'sheet_metal'),(137,'sheet_metal'),(138,'profile_metal'),(139,'bar_metal'),
-- Services
(161,'service'),(162,'service');

INSERT IGNORE INTO equipment_classifier_node_attributes
  (classifier_node_id, code, label, value_type, unit, sort_order, is_required,
   is_filterable, is_importable, is_identity, semantic_key, help_text)
SELECT
  mapping.node_id, template.code, template.label, template.value_type, template.unit,
  template.sort_order, template.is_required, template.is_filterable,
  template.is_importable, template.is_identity, template.semantic_key, template.help_text
FROM tmp_classifier_node_templates mapping
JOIN tmp_classifier_attribute_templates template ON template.template_key = mapping.template_key
JOIN equipment_classifier_nodes node ON node.id = mapping.node_id AND node.is_active = 1;

-- Every active characteristic now explicitly belongs to the card type shown to
-- the user. Client-equipment passports remain opt-in and are not inferred.
DELETE s
FROM equipment_classifier_attribute_scopes s
JOIN equipment_classifier_node_attributes a ON a.id = s.attribute_id
WHERE a.classifier_node_id = 177
  AND s.entity_type = 'equipment_model';

INSERT IGNORE INTO equipment_classifier_attribute_scopes (attribute_id, entity_type)
SELECT a.id,
  CASE
    WHEN n.card_kind = 'equipment_model' THEN 'equipment_model'
    ELSE 'catalog_position'
  END
FROM equipment_classifier_node_attributes a
JOIN equipment_classifier_nodes n ON n.id = a.classifier_node_id
WHERE a.is_active = 1
  AND n.card_kind IN ('equipment_model','catalog_position','material','service');

-- A missing value is represented by the absence of an EAV row. Remove only
-- fully empty legacy rows; false, zero, empty JSON collections and real text
-- values remain untouched.
DELETE FROM equipment_attribute_values
WHERE value_text IS NULL
  AND value_number IS NULL
  AND value_boolean IS NULL
  AND value_date IS NULL
  AND value_json IS NULL;

DELETE v
FROM equipment_attribute_values v
LEFT JOIN equipment_models model
  ON v.entity_type = 'equipment_model' AND model.id = v.entity_id
LEFT JOIN client_equipment_units unit
  ON v.entity_type = 'client_equipment_unit' AND unit.id = v.entity_id
LEFT JOIN catalog_positions position
  ON v.entity_type = 'catalog_position' AND position.id = v.entity_id
WHERE (v.entity_type = 'equipment_model' AND model.id IS NULL)
   OR (v.entity_type = 'client_equipment_unit' AND unit.id IS NULL)
   OR (v.entity_type = 'catalog_position' AND position.id IS NULL);

DROP TEMPORARY TABLE IF EXISTS tmp_classifier_node_templates;
DROP TEMPORARY TABLE IF EXISTS tmp_classifier_attribute_templates;

COMMIT;
