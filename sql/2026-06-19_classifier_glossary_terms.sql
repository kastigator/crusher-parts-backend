CREATE TABLE IF NOT EXISTS classifier_glossary_terms (
  id INT NOT NULL AUTO_INCREMENT,
  term VARCHAR(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  aliases_json TEXT COLLATE utf8mb4_unicode_ci NULL,
  definition TEXT COLLATE utf8mb4_unicode_ci NOT NULL,
  canonical_entity VARCHAR(80) COLLATE utf8mb4_unicode_ci NULL,
  scope VARCHAR(120) COLLATE utf8mb4_unicode_ci NULL,
  notes TEXT COLLATE utf8mb4_unicode_ci NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_classifier_glossary_term (term),
  KEY idx_classifier_glossary_active (is_active),
  KEY idx_classifier_glossary_entity (canonical_entity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO classifier_glossary_terms
  (term, aliases_json, definition, canonical_entity, scope, notes, is_active)
VALUES
  ('Классификатор', JSON_ARRAY('НСИ'), 'Иерархический справочник разделов, по которому раскладываются оборудование, товарные карточки, детали производителей и клиентские обозначения.', 'classifier_node', 'Классификатор', 'Не является карточкой товара сам по себе.', 1),
  ('Вид номенклатуры', JSON_ARRAY('тип позиции'), 'Группа правил и полей для сущности в классификаторе: оборудование, стандартное изделие, материал, услуга, клиентская деталь и другие типы.', 'card_kind', 'Карточки', 'Пока тип карточки определяется кодом интерфейса, позже можно вынести в настройки.', 1),
  ('Карточка товара', JSON_ARRAY('Номенклатурная позиция', 'catalog position'), 'Переиспользуемая позиция классификатора с названием, кодом, единицей измерения и характеристиками. Может входить в BOM разных моделей.', 'catalog_position', 'Классификатор/BOM', 'Например болт DIN 931 или типовое стандартное изделие.', 1),
  ('Производитель', JSON_ARRAY('Изготовитель'), 'Организация или бренд, выпускающий оборудование или оригинальные детали.', 'manufacturer', 'Модели/OEM', NULL, 1),
  ('Артикул', JSON_ARRAY('Обозначение', 'номер детали', 'part number'), 'Номер или обозначение детали у производителя, поставщика или клиента. Контекст обязателен, потому что одинаковые номера могут относиться к разным источникам.', 'part_number', 'Каталоги деталей', NULL, 1),
  ('BOM', JSON_ARRAY('Спецификация', 'ВОМ', 'parts book'), 'Структура состава модели оборудования: узлы, сборки, детали производителя и позиции классификатора с количеством и местом применения.', 'equipment_model_bom', 'Модель оборудования', NULL, 1),
  ('Основной аналог', JSON_ARRAY('Заменяемость'), 'Связь между позициями или деталями, показывающая, что одна может заменить другую в заданном контексте.', 'substitution', 'Детали/BOM', NULL, 1),
  ('Стандартизированное изделие', JSON_ARRAY('Стандартное изделие'), 'Изделие, описываемое стандартом, размером и характеристиками, а не только номером конкретного производителя.', 'catalog_position', 'Классификатор', 'Часто лучше вести как карточку товара.', 1),
  ('Материал', JSON_ARRAY('Группа материалов'), 'Описание материала или группы материалов для товара, детали или услуги.', 'material', 'Каталоги', NULL, 1),
  ('Товар', JSON_ARRAY('Материальный актив'), 'Материальная номенклатурная позиция, которую можно купить, хранить, поставить или использовать в BOM.', 'catalog_position', 'Каталоги', NULL, 1),
  ('Услуга', JSON_ARRAY('Нематериальный актив'), 'Нематериальная позиция закупки или продажи: ремонт, обработка, доставка, диагностика и т.п.', 'service', 'Каталоги', NULL, 1),
  ('Индивидуальное обозначение клиента', JSON_ARRAY('Товар по чертежу', 'деталь клиента'), 'Клиентское название, номер или чертеж детали, которые могут отличаться от OEM или не иметь известного OEM-аналога.', 'client_part', 'Клиенты', NULL, 1),
  ('Карточка товара поставщика', JSON_ARRAY('Справочник цен', 'supplier part'), 'Предложение или позиция поставщика с ценой, сроками, брендом и условиями, связанная с товаром, OEM-деталью или клиентской потребностью.', 'supplier_part', 'Поставщики/RFQ', NULL, 1)
ON DUPLICATE KEY UPDATE
  aliases_json = VALUES(aliases_json),
  definition = VALUES(definition),
  canonical_entity = VALUES(canonical_entity),
  scope = VALUES(scope),
  notes = VALUES(notes),
  is_active = VALUES(is_active);
