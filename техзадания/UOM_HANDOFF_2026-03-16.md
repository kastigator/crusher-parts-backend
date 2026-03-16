# Техническое задание: UOM / единицы измерения

## Цель
Привести работу с единицами измерения (`uom`) к одной понятной модели во всей системе, чтобы:
- не появлялись мусорные значения вроде `spc`
- одинаковые сущности использовали одинаковые единицы измерения
- импорты, карточки, заявки, RFQ и downstream-процессы не расходились по смыслу
- пользователь видел нормальные русские обозначения, а не случайные технические коды

## Бизнес-проблема
Исторически в системе единицы измерения использовались неоднородно:
- где-то как свободный текст
- где-то как локальная нормализация
- где-то как backend default
- где-то как фронтовый текстовый input

Из-за этого возникал риск:
- сохранить `spc`, `pc`, `pieces`, `шт`, `штука` как разные значения
- сломать аналитику и фильтры
- получить разные UOM у одной и той же детали в разных бизнес-процессах

## Что уже сделано
Уже переведены на общий строгий helper:
- [utils/uom.js](/Users/aleksandrlubimov/project/crusher-parts-backend/utils/uom.js)
- [routes/supplierParts.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/supplierParts.js)
- [routes/standardParts.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/standardParts.js)
- [routes/oemParts.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/oemParts.js)

Во фронте free-text input уже заменён на выбор фиксированных значений в:
- [StandardPartsMain.jsx](/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/standardParts/StandardPartsMain.jsx)

Смысл уже сделанного:
- backend принимает только канонические значения
- случайные значения вроде `spc` больше не должны молча проходить
- фронт для standard parts больше не должен генерировать мусорные UOM

## Целевая модель UOM
Нужен единый канонический набор хранения в БД.

Рекомендуемый канонический набор:
- `pcs`
- `kg`
- `set`

Отображение в UI:
- `pcs` -> `шт`
- `kg` -> `кг`
- `set` -> `компл.`

Важно:
- в БД хранить только канонические коды
- в UI показывать локализованное отображение
- в API не плодить свободные текстовые варианты

## Где UOM участвует по бизнес-смыслу

### 1. OEM детали
Файл/слой:
- [routes/oemParts.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/oemParts.js)
- [routes/originalParts.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/originalParts.js)

Роль:
- мастер UOM OEM детали
- используется в карточке OEM и каталоге

Риск:
- старые записи могли иметь неканонические значения

### 2. Стандартные детали
Файл/слой:
- [routes/standardParts.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/standardParts.js)
- [StandardPartsMain.jsx](/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/standardParts/StandardPartsMain.jsx)

Роль:
- мастер UOM standard part

Риск:
- если допустить free-text, standard catalog быстро засорится

### 3. Детали поставщиков
Файл/слой:
- [routes/supplierParts.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/supplierParts.js)

Роль:
- supplier-specific UOM
- может не совпадать с OEM/standard, но должна нормально нормализоваться

Риск:
- поставщики часто дают хаотичные обозначения
- именно здесь ранее и всплывал мусор вроде `spc`

### 4. Client Requests
Файл/слой:
- [routes/clientRequests.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/clientRequests.js)
- [ClientRequestsPage.jsx](/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/ClientRequestsPage.jsx)

Роль:
- UOM строки клиентской заявки
- может приходить от OEM/standard/free text

Риск:
- здесь легко возникает смешение пользовательского ввода и мастер-данных

### 5. RFQ
Файл/слой:
- [routes/rfqs.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/rfqs.js)

Роль:
- requested qty / UOM у RFQ items, component lines, dispatch summary

Риск:
- если RFQ живёт в другой UOM, downstream-логика начинает расходиться с Client Requests

### 6. Coverage / Selection / Economics
Файл/слой:
- [routes/coverage.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/coverage.js)
- [routes/selection.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/selection.js)
- [routes/economics.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/economics.js)

Роль:
- чтение и аналитика выбранных позиций

Риск:
- в аналитике можно не заметить, что часть строк живёт в разных UOM

### 7. Sales Quotes / Purchase Orders
Файл/слой:
- [routes/salesQuotes.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/salesQuotes.js)
- [routes/purchaseOrders.js](/Users/aleksandrlubimov/project/crusher-parts-backend/routes/purchaseOrders.js)

Роль:
- downstream documents

Риск:
- если здесь остались старые текстовые UOM, документы будут неаккуратными

### 8. Импорт / экспорт / Excel
Файл/слой:
- импорты в `clientRequests`
- supplier imports
- возможные Excel-процессы downstream

Риск:
- это главный источник мусорных единиц измерения

## Правила, чтобы не запутаться

### Правило 1
У каждой мастер-сущности свой канонический UOM:
- OEM detail
- Standard part
- Supplier part

### Правило 2
В строках бизнес-процессов UOM не должен быть свободным текстом, если строка опирается на мастер-объект.

То есть:
- если выбрана OEM деталь, UOM должен наследоваться от OEM
- если выбрана standard part, UOM должен наследоваться от standard part
- если выбрана supplier part, supplier UOM можно показывать, но при необходимости нормализовать

### Правило 3
Свободный UOM допустим только для truly free-text позиций.

### Правило 4
Во всех create/edit/import путях использовать только один shared helper нормализации.

### Правило 5
Во фронте нельзя оставлять свободные input-поля там, где должен быть выбор из канона.

## Что ещё надо проверить и доработать

### A. Просканировать весь backend на использование `uom`
Нужно пройти:
- `routes/clientRequests.js`
- `routes/rfqs.js`
- `routes/coverage.js`
- `routes/selection.js`
- `routes/economics.js`
- `routes/salesQuotes.js`
- `routes/purchaseOrders.js`

Цель:
- понять, где UOM читается
- где пишется
- где может идти без нормализации

### B. Просканировать фронт на поля единиц измерения
Нужно пройти:
- OEM create/edit forms
- Standard parts forms
- Supplier parts forms
- Client Requests forms
- RFQ-related edit dialogs

Цель:
- убрать free-text там, где он не нужен
- унифицировать отображение

### C. Проверить данные в БД
Нужно сделать аудит существующих значений UOM:
- какие значения реально лежат в `oem_parts.uom`
- `standard_parts.uom`
- `supplier_parts.uom`
- строках заявок / RFQ / downstream

Цель:
- выделить неканонические значения
- подготовить backfill/cleanup SQL

### D. Определить политику отображения
Нужно решить окончательно:
- храним `pcs/kg/set`
- показываем `шт/кг/компл.`

И применять это единообразно во всех таблицах и карточках.

## Минимальный следующий технический план

### Шаг 1
Сделать runtime-аудит всех backend-маршрутов, где фигурирует `uom`.

### Шаг 2
Сделать аудит фронтовых форм на свободный ввод UOM.

### Шаг 3
Сделать SQL-аудит реальных значений UOM в БД.

### Шаг 4
Подготовить миграционный backfill неканонических значений к `pcs/kg/set`.

### Шаг 5
После этого уже фиксировать единый UI-словарь отображения.

## Самая короткая формула
- в БД только канон
- во фронте только локализованное отображение
- в create/edit/import не допускать свободный ввод без нормализации
- в бизнес-процессах наследовать UOM от мастер-сущности, а не вводить заново

