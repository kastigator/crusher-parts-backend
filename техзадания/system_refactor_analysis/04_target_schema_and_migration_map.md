# Целевая схема единого справочника и mapping текущих таблиц

## 1. Задача

Нужно не "переписать OEM каталог", а построить над текущей системой новый центр:

- единый справочник сущностей;
- настраиваемые типы и поля;
- классификаторы и таксономии;
- канонические сущности;
- OEM и supplier representations;
- связи между сущностями;
- сохранение текущего operational OEM слоя.

Иными словами:

- текущий `OEM` остается рабочим контуром;
- текущий `standard_parts` становится прототипом нового ядра;
- текущий `equipment_classifier_nodes` становится одной из таксономий;
- новый центр системы появляется как `reference layer`.

---

## 2. Целевая модель по слоям

### 2.1. Layer 1: Taxonomy

Назначение:

- деревья классификации;
- навигация;
- фильтрация;
- grouping без хранения самих свойств сущности.

Новые таблицы:

- `reference_taxonomies`
- `reference_taxonomy_nodes`
- `reference_entity_taxonomy_links`

Примеры taxonomies:

- `equipment_domain`
- `product_categories`
- `supplier_specializations`
- `industry_segments`

Пример узлов:

- `Горное оборудование -> Дробилки -> Конусные`
- `Изделия -> Стандартные изделия -> Крепеж -> Болты`
- `Изделия -> Уникальные детали -> Валы`
- `Поставщики -> Специализация -> Гидравлика`

Ключевой принцип:

- одна сущность может быть привязана к нескольким taxonomy nodes.

---

### 2.2. Layer 2: Entity Type Engine

Назначение:

- описать типы сущностей;
- задавать поля этих типов;
- настраивать поведение полей в UI, поиске и фильтрах.

Новые таблицы:

- `reference_entity_types`
- `reference_entity_type_fields`
- `reference_entity_type_field_options`

Это прямое развитие текущих:

- `standard_part_classes`
- `standard_part_class_fields`
- `standard_part_field_options`

Типы сущностей:

- `equipment_family`
- `equipment_model`
- `assembly`
- `unique_part`
- `standard_item`
- `material`
- `supplier_specialization`
- `manufacturer_reference`

Примеры полей:

- для `equipment_model`:
  - `power_kw`
  - `capacity_tph`
  - `feed_size_mm`
- для `standard_item: bolt`:
  - `thread`
  - `length_mm`
  - `strength_class`
  - `coating`
  - `standard`
- для `unique_part`:
  - `drawing_code`
  - `material_base`
  - `revision`

---

### 2.3. Layer 3: Canonical Entities

Назначение:

- хранить сами сущности;
- хранить их тип;
- хранить значения полей;
- хранить статус проработки сущности.

Новые таблицы:

- `reference_entities`
- `reference_entity_values`

Минимальная форма `reference_entities`:

- `id`
- `entity_type_id`
- `canonical_name`
- `canonical_name_norm`
- `designation`
- `status`
- `description_ru`
- `description_en`
- `notes`
- `search_text`
- `is_active`
- `created_at`
- `updated_at`

Рекомендуемые `status`:

- `draft`
- `partially_classified`
- `canonicalized`
- `supplier_ready`
- `archived`

Зачем статус:

- чтобы OEM запись `болт` могла сначала жить как неуточненная сущность;
- потом быть дообогащена;
- потом стать полноценной канонической сущностью.

---

### 2.4. Layer 4: Relations

Назначение:

- связи между каноническими сущностями.

Новые таблицы:

- `reference_relation_types`
- `reference_entity_relations`

Relation types:

- `part_of`
- `contains`
- `used_in`
- `alternative_to`
- `substitute_for`
- `made_of`
- `compatible_with`
- `supplier_can_supply`
- `supplier_specializes_in`
- `manufacturer_of`

Важно:

- именно сюда в будущем надо переносить смысл части OEM side tables;
- но не через удаление OEM, а через постепенную нормализацию.

---

### 2.5. Layer 5: Representations

Назначение:

- внешние и внутренние представления канонической сущности.

Новые таблицы:

- `reference_entity_oem_links`
- `reference_entity_supplier_links`
- `reference_entity_internal_codes`
- `reference_entity_client_codes`

#### `reference_entity_oem_links`

Минимальные поля:

- `reference_entity_id`
- `oem_part_id`
- `representation_role`
- `is_primary`
- `note`

`representation_role`:

- `exact_oem`
- `oem_variant`
- `oem_legacy`

#### `reference_entity_supplier_links`

Минимальные поля:

- `reference_entity_id`
- `supplier_part_id`
- `link_type`
- `is_preferred`
- `note`

`link_type`:

- `exact_supplier_representation`
- `possible_match`
- `preferred_source`

---

### 2.6. Layer 6: Equipment Context

Здесь не нужно сразу ломать текущие equipment таблицы.

На первом этапе сохраняем:

- `equipment_manufacturers`
- `equipment_models`
- `client_equipment_units`

Но добавляем mapping в canonical layer:

- `reference_entity_equipment_model_links`

Либо, если идти глубже:

- `equipment_models` в будущем тоже становятся частным случаем `reference_entities`.

Но это не первый этап.

---

## 3. Рекомендуемая новая таблица supplier intelligence

Текущая система сильна в exact links, но слаба в knowledge-based supplier routing.

Нужны таблицы:

- `supplier_specialization_taxonomy_links`
- `supplier_reference_entity_capabilities`

Логика:

- поставщик может специализироваться на категории;
- поставщик может уметь поставлять конкретный класс сущностей;
- поставщик может иметь exact links к конкретным сущностям;
- система может рекомендовать поставщиков на 3 уровнях:
  - exact;
  - by entity type;
  - by taxonomy specialization.

---

## 4. Mapping: текущие таблицы -> новая роль

Ниже самое важное: что делать с каждой текущей таблицей.

### 4.1. Equipment слой

`equipment_classifier_nodes`

- новая роль: `taxonomy nodes`
- судьба: сохранить данные, мигрировать смысл в `reference_taxonomy_nodes`
- комментарий: это не entity type engine

`equipment_manufacturers`

- новая роль: operational manufacturer registry
- судьба: сохранить как есть на первом этапе
- позже: можно связать с canonical `manufacturer_reference`

`equipment_models`

- новая роль: operational equipment model registry
- судьба: сохранить как есть на первом этапе
- позже: можно частично перевести в `reference_entities` типа `equipment_model`

`client_equipment_units`

- новая роль: machine instance layer
- судьба: сохранить как есть
- комментарий: это process/asset layer, не часть общего справочника

---

### 4.2. Standard parts слой

`standard_part_classes`

- новая роль: source for `reference_entity_types` and/or type taxonomy
- судьба: мигрировать в новый meta-engine

`standard_part_class_fields`

- новая роль: source for `reference_entity_type_fields`
- судьба: мигрировать

`standard_part_field_options`

- новая роль: source for `reference_entity_type_field_options`
- судьба: мигрировать

`standard_parts`

- новая роль: source for `reference_entities`
- судьба: мигрировать в canonical layer

`standard_part_values`

- новая роль: source for `reference_entity_values`
- судьба: мигрировать

Вывод:

- текущий `standard_parts` не выбрасывается;
- он становится основой нового ядра.

---

### 4.3. OEM ядро

`oem_parts`

- новая роль: OEM operational representation
- судьба: сохранить
- дополнительно: добавить mapping в `reference_entity_oem_links`

`oem_part_model_fitments`

- новая роль: fitment relation in operational OEM layer
- судьба: сохранить
- позже: часть смысла можно дублировать в canonical relations

`oem_part_model_bom`

- новая роль: model-scoped engineering BOM
- судьба: сохранить
- позже: возможно partial mirror в canonical relation graph

`original_part_groups`

- новая роль: legacy OEM categorization
- судьба: перестать развивать, заменить taxonomy nodes

`oem_part_documents`

- новая роль: OEM attached documents
- судьба: сохранить
- позже: добавить document typing

`oem_part_materials`

- новая роль: material variants of OEM representation
- судьба: сохранить

`oem_part_material_specs`

- новая роль: material-specific engineering specs of OEM representation
- судьба: сохранить

`oem_part_presentation_profiles`

- новая роль: internal/supplier-facing/drawing representation profile
- судьба: сохранить
- дополнительно: использовать как источник будущего representation layer

`oem_part_standard_parts`

- новая роль: old OEM -> standard bridge
- судьба: постепенно заменить на `reference_entity_oem_links`

`oem_part_unit_overrides`

- новая роль: machine-specific override layer
- судьба: сохранить

`oem_part_unit_material_overrides`

- новая роль: machine-specific material overrides
- судьба: сохранить

`oem_part_unit_material_specs`

- новая роль: machine-specific material specs
- судьба: сохранить

`oem_part_alt_groups`

- новая роль: temporary OEM-specific alternative grouping
- судьба: сохранить на переходный период
- позже: перевести в generic relation model

`oem_part_alt_items`

- новая роль: OEM alternative links
- судьба: сохранить на переходный период
- позже: relation graph

---

### 4.4. Supplier слой

`supplier_part_oem_parts`

- новая роль: exact supplier -> OEM link
- судьба: сохранить
- позже: дополнить canonical supplier links

`supplier_part_standard_parts`

- новая роль: exact supplier -> canonical standard link
- судьба: сохранить и потом встроить в unified reference model

`supplier_bundles`

- новая роль: procurement bundle for OEM
- судьба: сохранить

`supplier_bundle_items`

- новая роль: bundle roles
- судьба: сохранить

`supplier_bundle_item_links`

- новая роль: supplier options per role
- судьба: сохранить

---

## 5. Что именно переделывать во фронтенде

### 5.1. OEM список

Что останется:

- производитель;
- модель;
- OEM number;
- fitment context;
- BOM-статус;
- supplier coverage;
- client usage.

Что надо убрать из центрального смысла:

- OEM groups как основную классификацию.

Что надо добавить:

- canonical entity;
- canonical status;
- entity type;
- степень проработки;
- supplier recommendation grade.

---

### 5.2. OEM карточка

Новая логика карточки должна быть такой.

#### Блок 1. `OEM`

Оставить:

- OEM number
- производитель
- fitments
- model context
- базовые descriptions
- TN VED

#### Блок 2. `Engineering`

Оставить:

- BOM
- where used
- materials
- machine overrides
- documents

#### Блок 3. `Canonical`

Новый обязательный блок:

- каноническая сущность
- тип сущности
- canonical status
- признаки:
  - стандартная
  - уникальная
  - требует уточнения
- переход в unified reference card

#### Блок 4. `Procurement`

Оставить:

- supplier direct links
- bundles
- preferred options

И добавить:

- recommended suppliers by specialization

---

## 6. Предлагаемая поэтапная миграция

### Этап 0. Заморозка старого хаоса

Что сделать:

- перестать развивать `original_part_groups`;
- не плодить новые категории в OEM в обход новой модели;
- договориться, что новые сущности сначала проектируются как будущие entity types.

### Этап 1. Поднять новый meta-engine

Создать новые таблицы:

- `reference_entity_types`
- `reference_entity_type_fields`
- `reference_entity_type_field_options`
- `reference_entities`
- `reference_entity_values`

И сразу мигрировать в них:

- `standard_part_*`

На этом этапе frontend standard parts можно еще не ломать.

### Этап 2. Поднять taxonomy layer

Создать:

- `reference_taxonomies`
- `reference_taxonomy_nodes`
- `reference_entity_taxonomy_links`

И мигрировать:

- `equipment_classifier_nodes`

Плюс подготовить mapping:

- `original_part_groups -> taxonomy nodes`

### Этап 3. Связать OEM с canonical entities

Создать:

- `reference_entity_oem_links`

Далее:

- для OEM карточки дать поле `reference_entity_id`;
- если OEM соответствует standard part, link создается автоматически;
- если не соответствует, создается черновая canonical сущность.

### Этап 4. Включить canonical block в OEM UI

На фронте:

- показать canonical entity в карточке OEM;
- дать переход;
- дать статус проработки.

### Этап 5. Добавить supplier intelligence

Создать:

- `supplier_reference_entity_capabilities`
- taxonomy links по специализации поставщика

Тогда даже без exact link система сможет подсказывать:

- этих поставщиков стоит запросить по этой сущности.

### Этап 6. Постепенно перевести поиск на новый центр

Сначала:

- OEM остается точкой входа;
- unified reference работает как enrichment layer.

Потом:

- можно делать поиск сверху вниз:
  - taxonomy -> canonical entity -> OEM -> supplier.

---

## 7. Какие миграции дадут максимальную пользу первыми

Если идти прагматично, то первые реальные выигрыши дадут 4 вещи.

1. Generalized `standard_parts -> reference_entities`

Это даст общий конструктор сущностей и полей.

2. `oem_parts -> reference_entity_oem_links`

Это даст канонизацию OEM позиций.

3. `original_part_groups -> taxonomy nodes`

Это уберет самый мусорный и слабый слой.

4. Supplier specialization layer

Это даст закупщикам практическую пользу даже без полного рефакторинга.

---

## 8. Минимальный MVP новой архитектуры

Если не делать сразу "идеальную систему", то MVP может быть таким:

- generalized `reference_entities` на базе `standard_parts`
- taxonomy layer для equipment и product categories
- link `OEM -> reference_entity`
- supplier specialization by taxonomy
- canonical block в OEM карточке

Уже этого хватит, чтобы:

- перестать плодить одинаковые standard items;
- начать описывать оборудование через типы и поля;
- начать рекомендовать suppliers не только по exact links;
- постепенно сместить центр из OEM в единый справочник.

---

## 9. Итоговая рекомендация

Правильная стратегия такая:

- не чистить OEM "до основания";
- чистить именно слабые временные слои вроде `original_part_groups`;
- строить новый центр как generalized version `standard_parts`;
- оставить OEM как operational representation layer;
- постепенно перевести UI и процессы на canonical-first мышление.

То есть в итоге система должна выглядеть так:

- `taxonomy` отвечает на "в каком мире это находится";
- `reference entity` отвечает на "что это такое";
- `OEM` отвечает на "как это кодируется у производителя";
- `supplier` отвечает на "кто и как это поставляет";
- `process layer` отвечает на "как это проходит через закупку".
