# OEM слой: таблицы, роли и текущая доменная логика

## 1. Главный вывод

OEM слой у тебя не является "мусором", который надо снести.

Он уже содержит рабочую доменную модель:

- OEM identity
- fitment to equipment model
- engineering BOM
- alternative OEM links
- materials and specs
- customer machine overrides
- supplier direct offers
- supplier bundles
- internal/supplier-facing representation
- document attachments

Проблема не в том, что OEM слой плохой.
Проблема в том, что он сейчас перегружен ролью "главного центра мира".

---

## 2. Таблицы OEM ядра

### 2.1. `oem_parts`

Главная таблица OEM identity.

Поля:

- `manufacturer_id`
- `part_number`
- `part_number_norm`
- `description_ru`
- `description_en`
- `tech_description`
- `uom`
- `tnved_code_id`
- `group_id`
- `has_drawing`
- `is_overweight`
- `is_oversize`

Реальный смысл:

- это конкретная OEM-позиция производителя;
- уникальность задается как `(manufacturer_id, part_number_norm)`;
- это не "каноническая деталь вообще", а представление производителя.

Что здесь спорно:

- `group_id` как плоская OEM-группа;
- `has_drawing` как отдельный флаг при наличии документационной таблицы.

Что здесь точно нужно сохранить:

- OEM number;
- связь с производителем;
- descriptions;
- базовые логистические признаки.

### 2.2. `oem_part_model_fitments`

Связь OEM детали с моделью оборудования.

Поля:

- `oem_part_id`
- `equipment_model_id`
- `description_ru`
- `description_en`
- `tech_description`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`
- `uom`

Роль:

- базовая применяемость детали по модели;
- возможный model-specific override описания и параметров.

Очень важный смысл:

- сама OEM деталь и ее применяемость не одно и то же;
- fitment уже сейчас является relation layer.

### 2.3. `oem_part_model_bom`

BOM в контексте модели.

Поля:

- `parent_oem_part_id`
- `equipment_model_id`
- `child_oem_part_id`
- `quantity`

Роль:

- структура OEM деталей;
- часть инженерной структуры оборудования.

Ключевой принцип:

- BOM привязан к модели;
- родитель и ребенок должны быть в одной модели;
- это не универсальный BOM по канонической сущности.

---

## 3. Инженерный слой вокруг OEM

### 3.1. `oem_part_materials`

Связь OEM детали с материалами.

Поля:

- `oem_part_id`
- `material_id`
- `is_default`
- `note`

Роль:

- material variants;
- default material.

### 3.2. `oem_part_material_specs`

Спецификация OEM детали в разрезе материала.

Поля:

- `oem_part_id`
- `material_id`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`

Роль:

- вес и габариты не у OEM детали "вообще", а у material-specific исполнения.

Вывод:

- это не мусор;
- это нормальная инженерная детализация;
- просто в новой архитектуре это надо перенести в более явную модель конфигурации.

### 3.3. `oem_part_documents`

Документы OEM детали.

Поля:

- `oem_part_id`
- `file_name`
- `file_type`
- `file_size`
- `file_url`
- `description`
- `uploaded_by`
- `uploaded_at`

Роль:

- чертежи;
- PDF;
- изображения;
- офисные файлы.

Замечание:

- сейчас `has_drawing` и документы живут параллельно;
- в новой модели лучше сделать `document_type` и/или вычислимый признак.

---

## 4. Representation слой, который уже зародился

### 4.1. `oem_part_presentation_profiles`

Это одна из самых важных таблиц для будущего рефакторинга.

Поля:

- `internal_part_number`
- `internal_part_name`
- `supplier_visible_part_number`
- `supplier_visible_description`
- `drawing_code`
- `use_by_default_in_supplier_rfq`
- `note`

Роль:

- внутреннее представление;
- supplier-facing представление;
- drawing-oriented представление.

Архитектурный вывод:

- система уже сама пришла к тому, что у OEM детали могут быть разные представления;
- это сильный аргумент в пользу отдельного слоя `representations`.

---

## 5. Альтернативы и граф связей

### 5.1. `oem_part_alt_groups`

Группа альтернатив OEM детали.

Поля:

- `oem_part_id`
- `name`
- `comment`

### 5.2. `oem_part_alt_items`

Состав группы альтернатив.

Поля:

- `group_id`
- `alt_oem_part_id`
- `note`

Роль:

- хранение аналогов/замен/вариантов внутри OEM мира.

Что важно:

- группы альтернатив уже являются relation mechanism, а не просто списком полей;
- backend даже поддерживает авто-симметрию.

В новой архитектуре это почти наверняка должно стать общим типом relation:

- `alternative_to`
- `substitute_for`
- `cross_reference`

---

## 6. Machine-specific layer

### 6.1. `oem_part_unit_overrides`

Поля:

- `oem_part_id`
- `client_equipment_unit_id`
- `status`
- `replacement_oem_part_id`
- `note`
- `effective_from`
- `effective_to`

Роль:

- конкретная машина клиента может отличаться от базовой модели.

Статусы:

- `applies`
- `excluded`
- `replaced`
- `variant`

Это очень зрелая логика.
Это точно нельзя потерять.

### 6.2. `oem_part_unit_material_overrides`

Поля:

- `oem_part_id`
- `client_equipment_unit_id`
- `material_id`
- `is_default`
- `note`

Роль:

- у конкретной машины набор материалов может отличаться от базового.

### 6.3. `oem_part_unit_material_specs`

Поля:

- `oem_part_id`
- `client_equipment_unit_id`
- `material_id`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`

Роль:

- machine-specific engineering specs.

Вывод:

- здесь уже живет логика variant configuration;
- в новой системе это должен быть отдельный controlled layer, а не "еще одна вкладка OEM".

---

## 7. Канонизация и standard layer

### 7.1. `oem_part_standard_parts`

Поля:

- `oem_part_id`
- `standard_part_id`
- `is_primary`
- `note`

Роль:

- мост между OEM-представлением и канонической standard сущностью.

Ключевой организационный сигнал:

- ручное создание этой связи из OEM карточки уже отключено;
- управление связью перенесено в `standard_parts`.

Это означает:

- система уже фактически начала смещать "канонический центр" из OEM в standard layer.

---

## 8. Supplier слой вокруг OEM

### 8.1. `supplier_part_oem_parts`

Поля:

- `supplier_part_id`
- `oem_part_id`
- `priority_rank`
- `is_preferred`

Роль:

- exact mapping supplier part -> OEM part.

Это сегодня один из главных практических мостов для закупки.

### 8.2. `supplier_bundles`

Поля:

- `oem_part_id`
- `title`
- `note`
- legacy: `name`, `comment`

Роль:

- supplier-side комплект для OEM детали.

### 8.3. `supplier_bundle_items`

Поля:

- `bundle_id`
- `role_label`
- `qty`
- `sort_order`

Роль:

- роли внутри комплекта.

### 8.4. `supplier_bundle_item_links`

Поля:

- `item_id`
- `supplier_part_id`
- `is_default`
- `note`
- `default_one`

Роль:

- варианты supplier parts под одну роль в комплекте.

Вывод:

- bundle layer уже хранит не просто "кого спросить", а структуру поставки;
- это сильный процессный слой и его нельзя потерять.

---

## 9. `original_part_groups`: почему это можно чистить

Таблица:

- `original_part_groups`

Поля:

- `name`
- `description`
- `sort_order`

Что это сейчас:

- плоский словарь для OEM-каталога.

Почему это слабое место:

- нет иерархии;
- нет inheritance;
- нет типизации полей;
- нет связи с equipment classifier;
- нет связи с standard part classes;
- нет многомерной классификации.

Именно поэтому OEM groups сейчас и ощущаются как мусор.

Вывод:

- `original_part_groups` логично рассматривать как временный compatibility layer;
- в новой архитектуре их нужно заменить нормальными taxonomy nodes.

---

## 10. Что уже является зачатком новой системы

Внутри текущей архитектуры уже есть три зародыша будущего решения.

### 10.1. Из `standard_parts`

Уже есть:

- тип сущности;
- поля типа;
- options;
- values;
- display-name generation.

Это лучший прототип нового справочника.

### 10.2. Из `equipment classifier`

Уже есть:

- taxonomy tree оборудования;
- привязка equipment models к tree nodes.

Это зачаток taxonomy layer.

### 10.3. Из `OEM`

Уже есть:

- representations;
- fitment;
- BOM;
- alternatives;
- variants;
- supplier links;
- documents.

Это зачаток relation/process/representation layer.

То есть новая система не должна "заменить все".
Она должна собрать воедино уже существующие сильные части.
