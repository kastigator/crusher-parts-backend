# Поэтапный план внедрения: backend, frontend, миграции, переключение UI

## 1. Цель плана

Этот документ нужен не для архитектурной красоты, а для внедрения без хаоса.

Здесь фиксируется:

- что делаем в каком порядке;
- что не трогаем до нужного этапа;
- какие API появляются;
- какие экраны меняются первыми;
- где нужен dual-read;
- где нужен dual-write;
- в какой момент можно чистить legacy OEM слои.

---

## 2. Базовые правила внедрения

### 2.1. Что запрещено

Нельзя:

- сразу переписать OEM карточку на новую модель;
- сразу убрать `oem_parts` из процессов;
- сразу переводить RFQ/responses на новые ids;
- сразу удалять `original_part_groups`;
- сразу переносить equipment models в новые сущности физически.

### 2.2. Что обязательно

Нужно:

- сначала построить новый reference layer рядом;
- оставить backward compatibility для текущих OEM API;
- вводить новую модель через enrichments, а не через big-bang replacement;
- начинать с read-path, а не с write-path;
- чистить legacy только после того, как UI уже работает на новой модели.

---

## 3. Общая дорожная карта

Я бы делил внедрение на 7 фаз.

1. `Foundation`
2. `Reference Core`
3. `Taxonomy`
4. `OEM Canonical Bridge`
5. `Frontend Canonical UX`
6. `Supplier Intelligence`
7. `Legacy Cleanup`

---

## 4. Phase 1: Foundation

### Цель

Подготовить основу, ничего не ломая.

### Backend

Что сделать:

- создать новые таблицы из документа `05_sql_draft_and_field_migration_matrix.md`;
- создать migration tables;
- добавить feature flags на уровне backend config:
  - `REFERENCE_CORE_ENABLED`
  - `REFERENCE_CANONICAL_LINKS_ENABLED`
  - `REFERENCE_SUPPLIER_INTELLIGENCE_ENABLED`

### Frontend

На этом этапе ничего визуально не меняем.

### Результат

- новая схема существует;
- старая система работает как раньше;
- можно начинать миграцию данных без переключения UI.

---

## 5. Phase 2: Reference Core

### Цель

Поднять generalized core на базе `standard_parts`.

### Backend

Создать сервисы и API:

- `GET /reference-entity-types`
- `POST /reference-entity-types`
- `PUT /reference-entity-types/:id`
- `GET /reference-entity-types/:id/fields`
- `POST /reference-entity-types/:id/fields`
- `PUT /reference-entity-type-fields/:id`
- `GET /reference-entities`
- `POST /reference-entities`
- `GET /reference-entities/:id`
- `PUT /reference-entities/:id`
- `GET /reference-entities/:id/values`
- `PUT /reference-entities/:id/values`

Что еще сделать:

- написать migration script:
  - `standard_part_classes -> reference_entity_types`
  - `standard_part_class_fields -> reference_entity_type_fields`
  - `standard_part_field_options -> reference_entity_type_field_options`
  - `standard_parts -> reference_entities`
  - `standard_part_values -> reference_entity_values`

### Frontend

Пока не переписывать весь UI.

Сделать только одно:

- hidden/internal admin page для проверки новых `reference entities`.

### Dual strategy

- old write: `standard_parts`
- new write: пока только migration/import/admin
- old read: `standard_parts`
- new read: только internal validation UI

### Результат

- generalized entity engine уже существует и работает;
- OEM пока не затронут.

---

## 6. Phase 3: Taxonomy

### Цель

Отделить классификацию от сущностей.

### Backend

API:

- `GET /reference-taxonomies`
- `POST /reference-taxonomies`
- `GET /reference-taxonomies/:id/nodes`
- `POST /reference-taxonomies/:id/nodes`
- `PUT /reference-taxonomy-nodes/:id`
- `GET /reference-entities/:id/taxonomies`
- `PUT /reference-entities/:id/taxonomies`

Что мигрировать:

- `equipment_classifier_nodes -> reference_taxonomy_nodes`
- `original_part_groups -> legacy_oem_groups taxonomy`

Что не трогать:

- `equipment_models.classifier_node_id`
- `oem_parts.group_id`

Почему:

- старый UI продолжает жить на старых полях;
- новая taxonomy пока нужна как новый слой, а не как replacement.

### Frontend

Добавить internal screens:

- просмотр taxonomy trees;
- привязка reference entity к taxonomy node.

### Результат

- taxonomy layer уже существует;
- старые OEM groups можно перестать развивать.

---

## 7. Phase 4: OEM Canonical Bridge

### Цель

Сделать новый мост `OEM -> canonical entity`, не ломая OEM процессы.

### Backend

API:

- `GET /oem-parts/:id/reference-link`
- `PUT /oem-parts/:id/reference-link`
- `POST /oem-parts/:id/create-reference-entity`
- `GET /reference-entities/:id/oem-links`

Что сделать:

- создать `reference_entity_oem_links`;
- автоматом перенести `oem_part_standard_parts`;
- для OEM без standard link включить workflow:
  - создать draft reference entity;
  - указать entity type;
  - связать с OEM.

Что еще нужно:

- background report:
  - OEM without canonical entity
  - OEM linked to multiple canonical entities
  - canonical entities without supplier links

### Frontend

Первая новая зона в OEM карточке:

- блок `Каноническая сущность`

В нем:

- текущая linked reference entity;
- статус сущности;
- тип сущности;
- кнопка:
  - создать сущность
  - привязать к существующей
  - открыть карточку reference entity

На этом этапе вкладка `Стандартные детали` может остаться, но уже как legacy-read block.

### Dual strategy

- old read: `oem_part_standard_parts`
- new read: `reference_entity_oem_links`
- old write: пока доступен только через standard parts
- new write: через canonical block

### Результат

- у OEM карточки появляется новый центр тяжести;
- но текущая карточка и процессы не ломаются.

---

## 8. Phase 5: Frontend Canonical UX

### Цель

Сделать новый пользовательский путь через reference entities.

### Новый frontend контур

Нужны новые страницы:

- `Reference Entities`
- `Reference Entity Types`
- `Reference Taxonomies`
- `Reference Entity Detail`

### Reference Entity Detail

Карточка новой сущности должна иметь вкладки:

1. `Основное`
2. `Поля`
3. `Таксономии`
4. `OEM представления`
5. `Поставщики`
6. `Связи`
7. `Материалы`
8. `Применяемость`

### OEM карточка после этого этапа

Ее надо переделать так:

#### Оставить

- `BOM`
- `Где используется`
- `Альтернативные оригиналы`
- `Материалы`
- `По машинам клиентов`
- `Комплекты поставщика`
- `Документы`

#### Переделать

- `Номера и видимость`
  Оставить как OEM/presentation/process block, но явно назвать:
  - `OEM представление для RFQ`

- `Стандартные детали`
  Убрать как отдельную старую идею.
  Заменить на:
  - `Каноническая сущность`

#### Добавить

- summary block сверху:
  - linked canonical entity
  - entity type
  - canonical status
  - требует уточнения / готово к закупке

### Почему это важно

Пользователь начнет видеть:

- OEM деталь как representation;
- а не как единственный смысловой центр.

---

## 9. Phase 6: Supplier Intelligence

### Цель

Дать закупщикам пользу еще до полного перевода всей системы.

### Backend

API:

- `GET /suppliers/:id/capabilities`
- `PUT /suppliers/:id/capabilities`
- `GET /reference-entities/:id/supplier-recommendations`

Логика рекомендаций:

1. exact links из `reference_entity_supplier_links`
2. exact OEM links через `supplier_part_oem_parts`
3. supplier specialization by taxonomy
4. supplier capability by entity type

### Frontend

В карточке reference entity:

- блок `Рекомендуемые поставщики`

В карточке OEM:

- показывать supplier recommendations на основе linked canonical entity

### Результат

- даже если exact OEM link еще не создан, закупщик видит вероятных поставщиков.

---

## 10. Phase 7: Legacy Cleanup

### Цель

Начать удалять слабые старые слои только после того, как новая модель реально используется.

### Что можно чистить первым

1. `original_part_groups`

Условия:

- OEM UI уже читает taxonomy summary;
- новые категории заводятся только в `reference_taxonomies`.

Что делать:

- перевести `group_id` в read-only legacy mode;
- убрать создание/редактирование новых OEM groups;
- позже скрыть group manager из UI.

2. `oem_part_standard_parts`

Условия:

- canonical block в OEM карточке стабильно работает;
- reference entity -> OEM links уже являются основным источником правды.

Что делать:

- перевести old bridge в compatibility read-only;
- затем убрать из UI;
- позже архивировать.

3. часть логики `oem_part_presentation_profiles`

Условия:

- если часть полей переедет в generic representations;
- но process-specific RFQ flags, вероятно, еще долго останутся в OEM слое.

### Что нельзя чистить рано

- `oem_parts`
- `oem_part_model_fitments`
- `oem_part_model_bom`
- `oem_part_unit_overrides`
- `supplier_part_oem_parts`
- `supplier_bundles`

Это operational core.

---

## 11. Backend roadmap по задачам

### Backend Sprint A

- создать новые таблицы
- сделать migration tables
- сделать CRUD для entity types / entities
- мигрировать `standard_parts`

### Backend Sprint B

- taxonomy CRUD
- migration `equipment_classifier_nodes`
- migration `original_part_groups` в legacy taxonomy

### Backend Sprint C

- `reference_entity_oem_links`
- OEM canonical link API
- reports по coverage canonicalization

### Backend Sprint D

- relation layer
- supplier capability layer
- recommendations API

### Backend Sprint E

- compatibility cleanup
- old bridges read-only
- admin reports and integrity checks

---

## 12. Frontend roadmap по задачам

### Frontend Sprint A

- internal pages для new entity types / entities
- базовый просмотр new reference data

### Frontend Sprint B

- taxonomy admin UI
- taxonomy links UI

### Frontend Sprint C

- canonical block в OEM карточке
- ability create/link reference entity from OEM

### Frontend Sprint D

- полноценная карточка reference entity
- переходы OEM <-> canonical entity

### Frontend Sprint E

- supplier recommendations UI
- cleanup old standard tab
- hide legacy OEM groups UI

---

## 13. Где нужен dual-read и dual-write

### Dual-read обязателен

1. OEM canonical links

Читать:

- старый `oem_part_standard_parts`
- новый `reference_entity_oem_links`

Пока не завершена миграция.

2. Классификация OEM

Читать:

- `original_part_groups`
- taxonomy summary

Пока старый UI не выключен.

### Dual-write желательно

На первом этапе dual-write нужен минимально.

Лучше так:

- старые формы продолжают писать в старые таблицы;
- новые формы пишут в новые таблицы;
- migration jobs синхронизируют то, что нужно.

Почему не делать везде dual-write:

- резко возрастает риск расхождения;
- сильно усложняется отладка.

Исключение:

- canonical link from OEM
  Тут можно писать и в новый link, и при необходимости временно поддерживать old bridge.

---

## 14. Как не запутать пользователя

Пользователь сейчас мыслит фронтом.
Значит порядок UX должен быть таким.

### Сначала

Показать в OEM карточке:

- "У этой детали есть каноническая сущность"
- "У этой детали пока нет канонической сущности"

### Потом

Дать открыть canonical карточку.

### Потом

Сделать возможным старт навигации не только от OEM, но и от unified reference.

### И только потом

Убирать legacy элементы.

---

## 15. Самый безопасный practical MVP

Если выбирать самый безопасный и полезный минимальный набор работ, то я бы делал именно так:

1. generalized reference core на базе `standard_parts`
2. taxonomy layer
3. canonical block в OEM карточке
4. OEM -> canonical links
5. supplier recommendations based on canonical entity

Этого уже хватит, чтобы:

- начать типизировать оборудование;
- начать канонизировать OEM;
- убрать рост хаоса в OEM groups;
- помочь закупщикам без полного большого переписывания.

---

## 16. Что делать прямо следующим техническим шагом

Если идти уже в реализацию, то следующий порядок я считаю оптимальным:

1. сделать DDL и migration scripts для `reference_*`
2. мигрировать `standard_parts`
3. поднять CRUD для `reference entities`
4. встроить canonical block в OEM карточку
5. после этого переходить к taxonomy и supplier intelligence

Потому что именно canonical block в OEM карточке даст пользователю первый реальный, видимый смысл новой архитектуры.
