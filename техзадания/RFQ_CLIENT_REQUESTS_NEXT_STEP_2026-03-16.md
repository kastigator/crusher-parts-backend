# Техническое задание: следующий шаг по RFQ Workspace и Client Requests

## Зачем этот файл
Контекст по системе уже большой, поэтому этот документ нужен как handoff в новый чат:
- что уже построено
- что уже проверено
- что надо пройти дальше
- где сейчас основные риски по регрессам

## Что уже есть в системе

### OEM / Standard / Client Equipment слой
Уже работает:
- OEM каталог
- Standard parts каталог
- Client equipment units
- Classifier workspace
- Supplier part linking через OEM и Standard

### Ключевая логика уже подтверждена
Проверенный сценарий:
1. Создаётся машина клиента на модели.
2. OEM деталь создаётся в контексте этой модели.
3. У OEM детали появляется `Модель применения`.
4. Во вкладке `По машинам клиентов` появляется конкретная машина клиента.
5. Для машины можно задать machine-specific настройку.

Это уже работает на живом кейсе `HP 800 / серийный номер 13`.

### Что ещё уже поправлено
- OEM глобальный каталог показывает `Клиенты` и `Машины клиентов`
- `Машины клиентов` теперь показываются как `Клиент / серийный номер`, а не просто число
- режим `Сборки` и колонка `Сборка` выровнены
- supplier part OEM-links теперь не дублируются строками, а показываются как одна привязка с несколькими контекстами
- активные mounted backend routes больше не ходят напрямую в удалённые `original_*` таблицы

## Общая цель следующего шага
Не строить новый слой, а пройти:
1. `RFQ Workspace`
2. потом `Client Requests`

И поймать:
- реальные runtime-регрессы
- UI-несостыковки
- скрытые legacy alias/path проблемы
- расхождения между OEM-моделью и тем, как это видит пользователь

## Блок 1. RFQ Workspace

### Цель
Подтвердить, что RFQ-поток реально живёт на новой OEM-схеме и не тащит старые `original_part_*` поля как рабочую зависимость.

### Что пройти руками

#### 1. Открытие RFQ
Проверить:
- список RFQ
- открытие конкретного RFQ
- workspace грузится без backend errors

Смотреть в логах:
- `original_part_id`
- `original_parts`
- `supplier_part_originals`
- `dispatch-summary`

#### 2. Структура RFQ
Проверить:
- items
- components
- structure rebuild
- suggested suppliers / supplier hints

Смотреть:
- корректно ли показываются OEM данные
- нет ли падений в helper-роутах

#### 3. Dispatch summary
Это уже ломалось раньше.
Проверить:
- страница summary открывается
- нет ошибок по `client_request_revision_items.original_part_id`

#### 4. Supplier responses / selection
Проверить:
- supplier line selections
- response lines
- accepted existing price path
- импорт supplier responses, если есть доступный сценарий

Смысл:
- убедиться, что связка supplier -> OEM/standard не ломает RFQ

#### 5. Coverage / Selection / Economics
Проверить открытие downstream-экранов из RFQ:
- coverage
- selection
- economics

Смысл:
- они уже мигрировались частично/полностью
- нужно подтвердить, что там нет скрытых runtime-хвостов

## Блок 2. Client Requests

### Цель
Проверить, что client request flow действительно соответствует новой логике:
- клиент
- машина клиента
- OEM / Standard / free text

### Что пройти руками

#### 1. Создание заявки из машины клиента
Сценарий:
- открыть клиента
- вкладка `Оборудование`
- `Создать заявку`

Проверить:
- клиент выбран
- машина клиента предвыбрана
- модель и equipment context не теряются

#### 2. Добавление OEM позиции
Проверить:
- OEM picker открывается
- фильтруется в контексте машины
- деталь создаётся/добавляется корректно

#### 3. Проверка строки заявки
Проверить:
- сохраняется quantity
- сохраняется UOM
- сохраняется OEM/standard/free text смысл строки

#### 4. Standard part path
Если в Client Requests уже есть выбор standard part:
- пройти и этот сценарий отдельно
- проверить, что строка заявки сохраняется корректно

#### 5. Free text path
Проверить:
- можно ли создать строку без OEM/standard master object
- не ломается ли downstream

### Что особенно смотреть в Client Requests
- UOM consistency
- equipment context inheritance
- поиск OEM именно по выбранной машине/модели
- отсутствие старых runtime-ошибок по `original_part_id`

## Приоритетные риски

### 1. Hidden legacy helper paths
Даже если основной экран работает, где-то внутри может остаться редкий backend helper path на старую схему.

### 2. UOM inconsistency
Это отдельный большой риск.
Для этого создан отдельный файл:
- [UOM_HANDOFF_2026-03-16.md](/Users/aleksandrlubimov/project/UOM_HANDOFF_2026-03-16.md)

### 3. Equipment context loss
Нужно смотреть, не теряется ли машина клиента:
- при переходах
- при создании строки
- при downstream в RFQ

### 4. Compatibility aliases
Часть API ещё отдаёт `original_part_id` как compatibility alias.
Это нормально, пока фронт не переведён везде.
Но нужно ловить места, где alias становится рабочей зависимостью, а не только мостом.

## Что фиксировать при тестировании
Если что-то ломается, сразу фиксировать:
- URL
- экран
- действие пользователя
- текст ошибки из backend log
- если есть, payload или query params

Пример:
- `RFQ Workspace -> dispatch summary -> GET /rfqs/:id/dispatch-summary -> Unknown column original_part_id`

Так проще продолжать в новом чате без потери контекста.

## Самый разумный порядок в новом чате

### Этап 1
Пройти `RFQ Workspace` сверху вниз:
- open RFQ
- structure
- dispatch summary
- supplier responses
- coverage
- selection
- economics

### Этап 2
Пройти `Client Requests`:
- create from machine
- OEM line
- standard part line
- free text line

### Этап 3
После этого отдельно разбирать только реальные найденные баги, а не делать абстрактный cleanup.

## Итог
Следующий разумный шаг действительно такой:
- сначала `RFQ Workspace`
- потом `Client Requests`

И цель уже не “переделывать архитектуру”, а:
- пройти живой рабочий сценарий
- поймать реальные регрессы
- понять, что ещё осталось несовместимым на runtime

