# Стратегия пересоздания системы: от OEM-центра к единому справочнику

## 1. Что нельзя делать

Нельзя делать такой рефакторинг:

- удалить OEM слой;
- засунуть все в один общий каталог;
- превратить `equipment_classifier_nodes` в главный центр всей системы;
- перенести бизнес-процессы сразу на новую модель.

Почему:

- на OEM слое уже сидят RFQ, supplier matching, BOM, fitments, machine overrides;
- если пересобирать систему "в лоб", получится много мусора и поломка рабочего контура.

---

## 2. Что надо сделать на самом деле

Нужна не замена OEM, а расслоение системы на уровни.

Правильная целевая архитектура:

1. `Taxonomy layer`
2. `Canonical reference layer`
3. `Representation layer`
4. `Operational/process layer`

---

## 3. Как должны выглядеть уровни

### 3.1. Taxonomy layer

Назначение:

- классификация;
- навигация;
- фильтрация;
- дерево категорий.

Сюда должны войти:

- нынешний `equipment_classifier_nodes`;
- будущие категории standard items;
- технологические категории вроде:
  - крепеж;
  - гидравлика;
  - валы;
  - футеровки;
  - электродвигатели.

Важный принцип:

- taxonomy не должна хранить свойства сущности;
- она должна только классифицировать.

### 3.2. Canonical reference layer

Назначение:

- хранить сущности как объекты знания;
- хранить их типы и настраиваемые поля;
- хранить связи между сущностями.

Это должен быть generalized version текущего `standard_parts`.

Типы сущностей:

- `equipment_family`
- `equipment_model`
- `assembly`
- `unique_part`
- `standard_item`
- `material`
- `supplier_specialization`

Поля типов задаются из интерфейса.

Примеры:

- для `конусная дробилка`:
  - мощность;
  - производительность;
  - размер питания.
- для `болт`:
  - стандарт;
  - резьба;
  - длина;
  - класс прочности;
  - покрытие.
- для `вал`:
  - длина;
  - диаметр;
  - материал;
  - термообработка.

### 3.3. Representation layer

Назначение:

- хранить внешние и внутренние представления канонической сущности.

Сюда относятся:

- OEM number;
- supplier part number;
- internal code;
- client code;
- drawing code.

Вот сюда и должен перейти смысл `oem_parts`, но без уничтожения самого operational OEM слоя.

### 3.4. Operational/process layer

Назначение:

- RFQ;
- supplier responses;
- request workspace;
- coverage;
- order-time workflows.

Этот слой сначала должен продолжать жить на текущих id и таблицах.

---

## 4. Что должно стать новым центром

Новый центр должен быть не `oem_parts`.

Новый центр должен быть:

- `reference entity`

У reference entity есть:

- тип;
- поля;
- значения полей;
- связи;
- таксономии;
- representations.

Тогда:

- стандартные детали становятся одним из типов сущностей;
- оборудование тоже становится типом сущностей;
- OEM-деталь становится representation/operational anchor;
- supplier part тоже становится representation.

---

## 5. Как это выглядит на живом примере

### Пример 1. Оборудование

Сущность:

- `Metso HP800`

Тип:

- `equipment_model`

Поля:

- мощность;
- производительность;
- тип дробилки.

Таксономии:

- `Горное оборудование -> Дробилки -> Конусные`

### Пример 2. Уникальная деталь

Сущность:

- `Вал эксцентрика HP800`

Тип:

- `unique_part`

Связи:

- `part_of -> Эксцентриковый узел HP800`
- `used_in -> Metso HP800`

Representations:

- OEM number Metso `12345678`
- supplier numbers
- internal code

### Пример 3. Стандартное изделие

Сущность:

- `Болт M10x30 10.9 ISO4017`

Тип:

- `standard_item`

Связи:

- `used_in -> Валы`
- `used_in -> Гидроцилиндры`

Representations:

- OEM number A
- OEM number B
- supplier numbers

Вот здесь и решается главная задача: не плодить один и тот же болт по разным OEM каталогам как разные сущности.

---

## 6. Что сохраняется из текущего OEM

### Сохраняем как есть по смыслу

- `oem_parts` как OEM identity;
- `oem_part_model_fitments`;
- `oem_part_model_bom`;
- `oem_part_unit_overrides`;
- `oem_part_unit_material_overrides`;
- `oem_part_unit_material_specs`;
- `supplier_part_oem_parts`;
- `supplier_bundles` и дочерние таблицы.

### Сохраняем, но переосмысляем

- `oem_part_presentation_profiles`
  Это будущий слой representations.

- `oem_part_standard_parts`
  Это мост в canonical layer.

- `oem_part_alt_groups` / `oem_part_alt_items`
  Это будущие relation types.

### Кандидаты на очистку/вынос

- `original_part_groups`
  Нужно заменить taxonomy layer.

- `has_drawing` как флаг
  Нужен пересмотр относительно document types.

---

## 7. Что надо переделать во фронтенде карточки OEM

Карточка OEM сегодня перегружена.

Я бы в новой модели разделил ее на 4 смысловых блока.

### 7.1. Блок `OEM identity`

Оставить:

- manufacturer;
- OEM number;
- OEM descriptions;
- model fitments;
- group/taxonomy link;
- basic logistics flags.

### 7.2. Блок `Engineering`

Оставить:

- BOM;
- where used;
- materials;
- machine-specific overrides;
- documents.

### 7.3. Блок `Canonical link`

Переделать:

- вместо вкладки "Стандартные детали" сделать более общий блок:
  - каноническая сущность;
  - тип сущности;
  - reference class;
  - степень канонизации;
  - требуется уточнение / уточнено.

### 7.4. Блок `Procurement`

Оставить и постепенно усилить:

- supplier direct links;
- bundles;
- preferred suppliers;
- later: supplier specialization recommendations.

---

## 8. Что делать с OEM группами

Ответ короткий: да, OEM groups можно чистить.

Но чистить надо не вручную "удалить все", а через замену смысла.

Правильный путь:

1. перестать развивать `original_part_groups` как долгосрочную модель;
2. ввести taxonomy layer;
3. сделать migration map:
   - каждая OEM group -> taxonomy node;
4. затем отвязать UI от `original_part_groups`.

То есть OEM groups надо считать legacy-categorization.

---

## 9. Какая минимальная новая схема нужна

### 9.1. Типы и поля

- `reference_entity_types`
- `reference_entity_type_fields`
- `reference_entity_type_field_options`

### 9.2. Сущности и значения

- `reference_entities`
- `reference_entity_values`

### 9.3. Таксономии

- `reference_taxonomies`
- `reference_taxonomy_nodes`
- `reference_entity_taxonomy_links`

### 9.4. Связи

- `reference_entity_relations`

Типы relation:

- `part_of`
- `used_in`
- `alternative_to`
- `substitute_for`
- `made_of`
- `supplier_specializes_in`
- `supplier_can_supply`

### 9.5. Representations

- `reference_entity_oem_representations`
- `reference_entity_supplier_representations`
- `reference_entity_internal_codes`

На первом этапе можно даже не заменять старые таблицы, а просто добавить новые mapping tables.

---

## 10. Реальный безопасный план миграции

### Этап 1. Зафиксировать текущую модель

Что сделать:

- описать все текущие роли OEM слоя;
- перестать добавлять новые "временные" OEM groups;
- зафиксировать, что `standard_parts` становится proto-canonical layer.

### Этап 2. Построить новый meta-engine

Что сделать:

- обобщить `standard_part_classes` -> `reference_entity_types`;
- обобщить `standard_part_class_fields` -> `reference_entity_type_fields`;
- обобщить `standard_parts` -> `reference_entities`;
- обобщить `standard_part_values` -> `reference_entity_values`.

### Этап 3. Поднять taxonomy layer

Что сделать:

- сделать отдельные taxonomy tables;
- перенести туда equipment classifier;
- затем подготовить migration OEM groups -> taxonomy nodes.

### Этап 4. Связать OEM с canonical layer

Что сделать:

- для OEM детали добавить canonical link на `reference_entity`;
- не менять пока RFQ и supplier process;
- начать канонизировать OEM позиции через новый reference layer.

### Этап 5. Перенести standard parts в новый reference kernel

Что сделать:

- standard parts превратить в частный случай `reference entities`;
- UI standard parts перестроить на новый generic engine.

### Этап 6. Добавить supplier intelligence

Что сделать:

- exact links оставить;
- добавить supplier specialization по категориям;
- добавить ability to recommend suppliers by category and entity type.

### Этап 7. Переделать OEM карточку

Что сделать:

- разделить ее на `OEM`, `Engineering`, `Canonical`, `Procurement`;
- убрать из OEM identity то, что должно жить в canonical layer.

---

## 11. Что это даст бизнесу

После такого рефакторинга система сможет:

- хранить оборудование как типизируемые сущности;
- хранить стандартные изделия как типизируемые сущности;
- хранить уникальные детали как отдельные сущности;
- связывать OEM номера с каноническими сущностями;
- заранее понимать, к каким поставщикам обращаться;
- не плодить один и тот же крепеж по разным OEM каталогам;
- использовать справочник как инженерную базу знаний;
- использовать те же сущности для поиска, RFQ и supplier recommendation.

---

## 12. Итоговая позиция

Текущая система не ошибочная.
Она просто выросла из OEM-first модели в систему, которой уже нужен canonical center.

Правильная стратегия:

- не ломать OEM;
- не выкидывать зачатки, которые уже созданы;
- собрать новый единый reference layer поверх уже существующих сильных частей;
- постепенно смещать центр тяжести из `OEM catalog` в `reference knowledge system`.
