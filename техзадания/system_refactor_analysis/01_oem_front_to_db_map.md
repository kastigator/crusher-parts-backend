# OEM каталог: карта от фронтенда к БД

## 1. Что сейчас видит пользователь

Основной маршрут:

- `/original-parts`
- карточка детали: `/original-parts/:id`

Главные фронтовые файлы:

- `src/components/originalParts/OriginalPartsMain.jsx`
- `src/components/originalParts/OriginalPartsTable.jsx`
- `src/components/originalParts/DetailDock.jsx`
- `src/pages/OriginalPartDetailPage.jsx`

Важно: пользователь реально ориентируется не по таблицам БД, а по двум интерфейсам:

1. список OEM деталей;
2. карточка OEM детали.

Поэтому ниже разбор идет именно в этой последовательности.

---

## 2. Список OEM деталей

### 2.1. Экран списка

Файл:

- `src/components/originalParts/OriginalPartsMain.jsx`

Роль экрана:

- выбрать производителя и модель;
- работать либо в контексте конкретной модели, либо в режиме "весь OEM каталог";
- искать по `part number`, описаниям, техописанию, коду ТН ВЭД;
- фильтровать по логистике, материалам и BOM;
- переключать режимы просмотра:
  - дерево корней BOM;
  - только сборки;
  - только детали;
  - все;
  - вне структуры.

### 2.2. Что именно тянется с backend

Главный API списка:

- `GET /original-parts`

Поддерживаемые параметры:

- `manufacturer_id`
- `equipment_model_id`
- `group_id`
- `classifier_node_id`
- `q`
- `only_assemblies`
- `only_parts`
- `exclude_id`

Backend файл:

- `routes/originalParts.js`

### 2.3. Что реально возвращает список

Список не просто читает `oem_parts`. Он уже строит агрегированную карточку на лету:

- OEM данные из `oem_parts`
- primary model и число fitments из `oem_part_model_fitments`
- признаки сборки через `oem_part_model_bom`
- клиентское использование через `client_equipment_units`
- группу через `original_part_groups`
- ТН ВЭД через `tnved_codes`

То есть даже таблица списка уже не "просто каталог". Это агрегированная витрина.

### 2.4. Что видно в таблице списка

Файл:

- `src/components/originalParts/OriginalPartsTable.jsx`

Колонки по смыслу:

- производитель
- модель оборудования
- клиенты
- машины клиентов
- `Part number`
- описание RU
- группа
- ТН ВЭД
- вес/габариты
- признаки `has_drawing`, `is_overweight`, `is_oversize`
- признак "сборка/деталь"

Важно:

- часть колонок реально берется из базы;
- часть колонок является вычисленной агрегацией;
- вес/габариты в текущем list endpoint фактически пока отдаются как `NULL`, хотя фильтры по ним уже есть.

Это уже первый сигнал, что UI и доменная модель частично расходятся.

### 2.5. Фильтры списка

Файл:

- `src/components/originalParts/OriginalPartsFiltersDrawer.jsx`

Что умеют фильтры:

- вес и габариты;
- `has_drawing`;
- `is_overweight`;
- `is_oversize`;
- материал самой позиции;
- материал в составе BOM.

Что это означает архитектурно:

- OEM каталог уже пытается работать как инженерный и закупочный knowledge layer;
- но часть инженерных параметров хранится не в самой OEM детали, а в связях `материал -> спецификация`.

### 2.6. OEM группы

Файл:

- `src/components/originalParts/OriginalPartGroupsManager.jsx`

API:

- `GET /original-part-groups`
- `POST /original-part-groups`
- `PUT /original-part-groups/:id`
- `DELETE /original-part-groups/:id`

Таблица:

- `original_part_groups`

Что это сейчас:

- плоский словарь групп OEM деталей.

Что это не является:

- это не полноценный классификатор;
- это не дерево;
- это не тип сущности;
- это не каноническая категория справочника.

Вывод:

- группы в OEM действительно можно и нужно чистить;
- но не просто удалением;
- их надо заменить нормальным taxonomy layer в новой архитектуре.

---

## 3. Карточка OEM детали

Файлы:

- `src/pages/OriginalPartDetailPage.jsx`
- `src/components/originalParts/DetailDock.jsx`

Маршрут:

- `GET /original-parts/:id/full`

Что загружает карточка:

- основную OEM карточку;
- `application_models`;
- затем каждая вкладка отдельно тянет свои данные.

Кнопки верхнего уровня:

- `Назад к списку`
- `Удалить из модели`
- `Удалить полностью`

Это важно:

- удаление из модели означает удаление fitment, а не самой OEM детали;
- удаление полностью означает удаление корневой OEM сущности и ее дочерних связей.

То есть даже удаление уже различает:

- `representation in model context`
- `global OEM part`

Это очень важный архитектурный зачаток.

---

## 4. Вкладки карточки OEM детали

### 4.1. `BOM`

Файл:

- `src/components/originalParts/BomTree.jsx`

API:

- `GET /original-part-bom/tree/:id`
- `POST /original-part-bom/bulk`
- `PUT /original-part-bom`
- `DELETE /original-part-bom`

Таблица:

- `oem_part_model_bom`

Что делает вкладка:

- показывает дерево состава детали;
- позволяет добавить дочерние позиции;
- менять количество;
- удалять строку BOM;
- открывать другую OEM-деталь из узла дерева.

Ключевая бизнес-логика:

- BOM модельно-зависимая;
- backend запрещает циклы;
- backend требует, чтобы родитель и ребенок принадлежали одной модели оборудования.

Значит:

- это не универсальный product BOM;
- это engineering BOM в контексте equipment model.

### 4.2. `Где используется`

Файл:

- `src/components/originalParts/UsedInTable.jsx`

API:

- `GET /original-part-bom/used-in?child_id=:id`

Таблица:

- `oem_part_model_bom`

Смысл:

- обратная навигация по BOM;
- показывает, в каких родительских сборках участвует текущая OEM деталь.

### 4.3. `Альтернативные оригиналы`

Файлы:

- `src/components/originalParts/AltOriginalsTable.jsx`
- `src/components/originalParts/AltOriginalsPickerDrawer.jsx`

API:

- `GET /original-part-alt`
- `POST /original-part-alt`
- `PUT /original-part-alt/:id`
- `DELETE /original-part-alt/:id`
- `POST /original-part-alt/:id/items`
- `DELETE /original-part-alt/:id/items`

Таблицы:

- `oem_part_alt_groups`
- `oem_part_alt_items`

Смысл:

- у OEM детали может быть несколько групп альтернатив;
- в каждой группе можно хранить несколько альтернативных OEM позиций.

Особенность backend:

- есть авто-симметрия через группу `Симметрия (авто)`.

Это уже зачаток relation graph:

- аналог/альтернатива как отдельный тип связи.

### 4.4. `Связанные поставщики`

Файл:

- `src/components/originalParts/SuppliersLinksTab.jsx`

Что вкладка реально показывает:

1. прямые supplier links;
2. дефолтные варианты из supplier bundle.

API для прямых связей:

- `GET /original-parts/:id/options?qty=1`
- удаление через `DELETE /supplier-part-originals`

Таблица прямых связей:

- `supplier_part_oem_parts`

Дополнительные bundle API:

- `GET /supplier-bundles?original_part_id=:id`
- `GET /supplier-bundles/:id/options`

Таблицы bundle-слоя:

- `supplier_bundles`
- `supplier_bundle_items`
- `supplier_bundle_item_links`

Смысл:

- прямой exact match supplier part -> OEM part;
- плюс составной вариант поставки по ролям.

Это уже не просто "связать поставщика с деталью", а довольно зрелая procurement abstraction.

### 4.5. `Материалы`

Файл:

- `src/components/originalParts/OriginalPartMaterialsTab.jsx`

API:

- `GET /original-part-materials/:partId`
- `POST /original-part-materials`
- `DELETE /original-part-materials/:partId/:materialId`
- `PUT /original-part-material-specs`

Таблицы:

- `oem_part_materials`
- `oem_part_material_specs`

Смысл:

- у OEM детали может быть несколько материалов;
- один материал может быть default;
- по материалу можно хранить вес и габариты.

Это важный нюанс:

- в текущей архитектуре вес/габариты не принадлежат OEM детали напрямую;
- они принадлежат сочетанию `OEM деталь + материал`.

Это не мусор. Это нормальная инженерная логика.
Но в будущем это надо оформить как `material configuration` или `entity material variant`, а не оставлять как случайный side-table.

### 4.6. `Номера и видимость`

Файл:

- `src/components/originalParts/OriginalPartPresentationProfileTab.jsx`

API:

- `GET /original-parts/:id/presentation-profile`
- `PUT /original-parts/:id/presentation-profile`
- `DELETE /original-parts/:id/presentation-profile`

Таблица:

- `oem_part_presentation_profiles`

Поля:

- `internal_part_number`
- `internal_part_name`
- `supplier_visible_part_number`
- `supplier_visible_description`
- `drawing_code`
- `use_by_default_in_supplier_rfq`
- `note`

Смысл:

- это отдельное представление OEM детали для внутренней работы и RFQ;
- оно не меняет OEM identity;
- оно меняет то, как деталь будет показана поставщику.

Это очень сильный зачаток будущего слоя `representations`.

### 4.7. `Стандартные детали`

Файл:

- `src/components/originalParts/OriginalPartStandardPartsTab.jsx`

API:

- `GET /oem-part-standard-parts?oem_part_id=:id`

Таблица:

- `oem_part_standard_parts`

Смысл:

- связь OEM детали со standard part;
- связь уже read-only из OEM карточки;
- создавать ее нужно из standard parts каталога.

Это важно:

- система уже фактически признает, что канонизация должна управляться из standard layer, а не из OEM карточки.

### 4.8. `По машинам клиентов`

Файл:

- `src/components/originalParts/OriginalPartUnitOverridesTab.jsx`

Основные API:

- `GET /original-parts/:id/unit-overrides`
- `PUT /original-parts/:id/unit-overrides/:unitId`
- `DELETE /original-parts/:id/unit-overrides/:unitId`
- `GET /original-parts/:id/unit-material-overrides/:unitId`
- `POST /original-parts/:id/unit-material-overrides/:unitId`
- `DELETE /original-parts/:id/unit-material-overrides/:unitId/:materialId`
- `PUT /original-parts/:id/unit-material-specs/:unitId`

Таблицы:

- `oem_part_unit_overrides`
- `oem_part_unit_material_overrides`
- `oem_part_unit_material_specs`

Смысл:

- базовая применяемость задается по модели;
- затем на уровне конкретной машины клиента можно:
  - исключить деталь;
  - заменить другой OEM деталью;
  - зафиксировать вариант исполнения;
  - задать отдельные материалы и material specs.

Это один из самых зрелых слоев системы.
Его нельзя терять при рефакторинге.

### 4.9. `Комплекты поставщика`

Файл:

- `src/components/originalParts/bundle/BundleTab.jsx`

API:

- `GET /supplier-bundles?original_part_id=:id`
- `POST /supplier-bundles`
- `PUT /supplier-bundles/:id`
- `DELETE /supplier-bundles/:id`
- `GET /supplier-bundles/:id/items`
- `POST /supplier-bundles/items`
- `PUT /supplier-bundles/items/:id`
- `DELETE /supplier-bundles/items/:id`
- `GET /supplier-bundles/:id/options`
- `POST /supplier-bundles/links`
- `PUT /supplier-bundles/links/:id`
- `DELETE /supplier-bundles/links/:id`
- `GET /supplier-bundles/:id/totals`

Таблицы:

- `supplier_bundles`
- `supplier_bundle_items`
- `supplier_bundle_item_links`

Смысл:

- для одной OEM детали можно собирать supplier-side комплект;
- комплект состоит из ролей;
- по каждой роли можно выбрать несколько supplier parts;
- один вариант по роли может быть default.

Это уже mini-procurement-model поверх OEM.

### 4.10. `Документы`

Файл:

- `src/components/originalParts/OriginalPartDocumentsTab.jsx`

API:

- `GET /original-parts/:id/documents`
- `POST /original-parts/:id/documents`
- `PUT /original-parts/documents/:id`
- `DELETE /original-parts/documents/:id`

Таблица:

- `oem_part_documents`

Смысл:

- OEM деталь хранит документы;
- файлы лежат в GCS;
- запись о документе лежит в БД;
- загрузка документа автоматически ставит `has_drawing = 1`.

Здесь есть дублирование смысла:

- `has_drawing` как флаг;
- и реальные документы как источник факта.

В новом дизайне это лучше сделать вычисляемо или через явный document type.

---

## 5. Что уже видно из одного фронтенда

По OEM карточке уже видно, что здесь живут сразу несколько доменных слоев:

- `каталожная идентичность` — part number, manufacturer;
- `применяемость` — fitments;
- `структура изделия` — BOM;
- `инженерная конфигурация` — материалы и specs;
- `локальные отклонения` — machine-specific overrides;
- `представления` — номера и видимость;
- `закупка` — supplier links и bundles;
- `канонизация` — links to standard parts;
- `документы` — knowledge/doc layer.

То есть карточка OEM сегодня уже перегружена и семантически, и визуально.

Это не значит, что вкладки "лишние".
Это значит, что в одной карточке сейчас смешаны:

- свойства самой OEM позиции;
- связи OEM позиции с канонической сущностью;
- связи OEM позиции с оборудованием;
- связи OEM позиции с поставщиками;
- process-specific procurement UI.

Именно поэтому при рефакторинге карточку нужно будет разделять по ролям, а не просто "почистить поля".
