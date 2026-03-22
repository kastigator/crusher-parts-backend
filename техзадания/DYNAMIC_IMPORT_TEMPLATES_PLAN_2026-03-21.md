# Dynamic Import Templates Plan

Дата: 2026-03-21  
Актуальный дамп БД: `/Users/aleksandrlubimov/project/Cloud_SQL_Export_2026-03-21 (16_18_31).sql`

## Цель

Убрать зависимость импортных шаблонов Excel от статических файлов на bucket и перейти на генерацию шаблонов на лету из актуальной схемы системы.

Правильная модель:

- `template = generated`
- `artifact = stored`

То есть:

- шаблоны для импорта генерируются backend-ом на лету;
- реальные рабочие Excel-файлы процесса по-прежнему можно и нужно хранить в bucket как артефакты.

## Почему это нужно

Проблема текущей схемы:

- логика импорта меняется в коде;
- статический шаблон на bucket забывают обновить;
- пользователь скачивает старый файл;
- импорт ломается или начинает вести себя неочевидно.

Генерация на лету снимает этот класс ошибок.

## Текущее состояние на 2026-03-21

### Уже было до начала блока

- RFQ Excel для поставщиков генерируется динамически и сохраняется как артефакт процесса.
- Шаблон прайс-листа поставщика уже генерируется через backend route:
  - `/supplier-price-lists/template`

### Что оставалось статическим

Через `templateUrl` из bucket были завязаны:

- `suppliers`
- `supplier_parts`
- `original_parts`
- `tnved_codes`
- `client request` import template

## Выполненные блоки

### Блок 1. Универсальные schema-driven шаблоны импорта

Статус: выполнено  
Дата выполнения: 2026-03-21

Что сделано:

- В `routes/import.js` добавлен:
  - `GET /import/template/:type`
- Шаблон теперь строится из актуальной схемы импорта:
  - `headerMap`
  - `requiredFields`
  - `templateExampleRows`
  - `templateReadme`
- В `utils/entitySchemas.js` для сущностей добавлены метаданные генерации:
  - `templateFileName`
  - `templateSheetName`
  - `templateReadme`
  - `templateExampleRows`
- `ImportModal.jsx` теперь скачивает шаблон через API:
  - основной путь: `/import/template/:type`
  - fallback: старый `templateUrl`, если API временно не сработал

Какие импорты покрыты этим блоком:

- `suppliers`
- `supplier_parts`
- `original_parts`
- `tnved_codes`

Итог:

- универсальные import templates больше не зависят от статического файла на bucket как от источника истины;
- текущая схема импорта и шаблон теперь синхронизированы через backend.

## Следующие блоки

### Блок 2. Client Request import template

Статус: выполнено  
Дата выполнения: 2026-03-21

Почему это был отдельный блок:

- `ClientRequestsPage` использует не универсальный `ImportModal`, а свой кастомный `ImportExcelModal`;
- там другой flow:
  - загрузка,
  - staging,
  - preview,
  - create missing,
  - commit into request

Что сделано:

- В `routes/clientRequests.js` добавлен:
  - `GET /client-requests/import-template/items`
- Шаблон заявки клиента теперь генерируется backend-ом на лету.
- В `ImportExcelModal.jsx` добаван API-скачиватель шаблона с fallback на legacy URL.
- `ClientRequestsPage.jsx` переведен на новый route:
  - `/client-requests/import-template/items`

Итог:

- основной клиентский Excel-шаблон больше не зависит от bucket как от источника истины;
- отдельный import flow заявок клиента сохранен и не ломался.

### Блок 3. Очистка legacy templateUrl

Статус: выполнено  
Дата выполнения: 2026-03-21

Что сделано:

- Из экранов убраны прямые bucket URL как основной путь скачивания шаблонов:
  - `SuppliersMain`
  - `SupplierPartsMain`
  - `OriginalPartsMain`
  - `TnvedCodesMain`
  - `ClientRequestsPage`
- Рабочий путь скачивания теперь везде backend-driven.
- На уровне модалок fallback на `templateUrl` пока оставлен как защитный переходный слой, но UI уже не опирается на него как на нормальный сценарий.

Итог:

- пользовательский интерфейс больше не зависит от статических template-файлов на bucket;
- bucket перестал быть operational source of truth для import templates.

## Замечания

- Реальные импортированные или экспортированные Excel-документы процесса продолжать хранить в bucket нормально и правильно.
- Генерируем только шаблоны, а не переписываем всю документную модель.
