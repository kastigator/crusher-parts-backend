# Спецификация: implementation backlog и карта файлов

Дата: `2026-03-29`

Связанные документы:

- `/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/INTERFACE_ERGONOMICS_REDESIGN_2026-03-29/INTERFACE_ERGONOMICS_AUDIT_AND_REDESIGN_PLAN_2026-03-29.md`
- `/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/INTERFACE_ERGONOMICS_REDESIGN_2026-03-29/PHASE_1_PRIORITY_SCREENS_AND_COMPONENTS_SPEC_2026-03-29.md`

## 1. Назначение документа

Этот документ переводит UX-спецификацию в инженерный backlog.

Здесь фиксируется:

- что именно нужно реализовать;
- какие frontend-файлы затронуты;
- в какой последовательности лучше внедрять изменения;
- что можно сделать безопасно и изолированно;
- где потребуется более глубокий рефакторинг;
- какие риски у каждого пакета работ.

## 2. Общий принцип реализации

Реализация должна идти в таком порядке:

1. Сначала foundation-компоненты.
2. Потом новые стили и правила layout.
3. Потом по одному крупному workflow-экрану.
4. После каждого крупного модуля обязательна ручная проверка чтения, ширин, действий и скролла.

Нельзя идти сразу в хаотичный page-level patching, потому что:

- это закрепит старые паттерны;
- появятся новые локальные исключения;
- будет трудно повторно использовать решения;
- визуальная несогласованность останется.

## 3. Пакеты работ верхнего уровня

## Пакет A. Foundation-компоненты

Содержимое:

- новый page header;
- новый workspace shell;
- новая схема row actions;
- новый form grid;
- новый table pattern;
- новый summary/help pattern.

Статус зависимости:

- блокирует качественную переработку workflow-экранов;
- должен быть реализован до основного page refactor.

## Пакет B. Base styles и layout tokens

Содержимое:

- размеры отступов;
- вертикальные интервалы;
- размеры контролов;
- правила поведения длинного текста;
- правила grid для форм и страниц;
- правила table density.

Статус зависимости:

- идёт сразу после foundation;
- частично может делаться параллельно.

## Пакет C. `Client Requests`

Содержимое:

- новая композиция страницы;
- новый shell списка и workspace;
- пересборка верхней панели заявки;
- пересборка вкладки позиций;
- унификация действий по ревизиям и импорту.

## Пакет D. `RFQ Workspace`

Содержимое:

- новый shell;
- новая структура header и process strip;
- выравнивание ключевых вкладок;
- переработка списков и действий внутри RFQ flow.

## Пакет E. `Contracts`

Содержимое:

- новая форма создания;
- новая таблица контрактов;
- новая модель действий по статусу и документам.

## Пакет F. `Purchase Orders`

Содержимое:

- новая форма создания;
- новая таблица заказов;
- выравнивание качества, документов и статусов.

## 3.1. Статус выполнения

Уже реализовано в коде frontend:

- Пакет A:
  - добавлен `AppPageHeader`;
  - добавлен `WorkspaceShell`;
  - добавлен `EntityHeader`;
  - добавлен `FormGrid`;
  - обновлён `PageWrapper`;
- Пакет B:
  - добавлены базовые layout- и shell-стили в `global.css`;
- Пакет C:
  - `Client Requests` переведён на stacked shell;
  - создание заявки вынесено в `Drawer`;
  - список заявок переработан в compact selector-panel;
  - рабочая зона получила новый header и очищенную верхнюю панель;
- Пакет D:
  - `RFQ Workspace` переведён на stacked shell;
  - список RFQ переработан в compact selector-panel;
  - добавлен header активного RFQ;
  - дублирующий process strip убран, оставлен один уровень навигации через вкладки.

В работе:

- более строгая модель `RowActions`;
- следующий проход по workflow-таблицам.

Дополнительно уже реализовано:

- Пакет E:
  - `Contracts` переведён на новый page header;
  - форма переведена на `FormGrid`;
  - таблица списка контрактов упрощена и упорядочена;
- Пакет F:
  - `Purchase Orders` переведён на новый page header;
  - обзор заказа очищен от ложного edit-workspace сценария;
  - таблица списка заказов упрощена и упорядочена;

Дополнительно реализовано по каталогам:

- `Clients`:
  - верхняя служебная полоса действий убрана;
  - toolbar собран в единый контур поиска и действий;
  - основная колонка стала информативнее;
  - дефолтный набор колонок для первого открытия упрощён до контакта, телефона и e-mail;
- `Suppliers`:
  - верхняя служебная полоса действий убрана;
  - toolbar собран в единый контур поиска, быстрых фильтров и действий;
  - основная колонка стала информативнее;
  - панель быстрых фильтров упрощена до одной строки;
  - дефолтный набор колонок для первого открытия упрощён до каналов связи, capability и риска.
- `Original Parts`:
  - верхняя панель поиска и view controls собрана в один рабочий ряд;
  - ширина колонки действий уменьшена;
  - дефолтный набор колонок для первого открытия сокращён до номера, описания, группы, ТН ВЭД, веса, единицы измерения и признака сборки.
- `Materials`:
  - дерево категорий ограничено по высоте и переведено в режим selector/filter;
  - выбранная категория теперь явно показана над списком материалов;
  - правая зона со списком получила приоритет по ширине;
  - таблица материалов переведена на более свободное распределение ширины без лишнего сжатия action-колонки.
- `Supplier Parts`:
  - верхняя панель поиска, быстрых переключателей и настроек колонок собрана в один рабочий ряд;
  - дефолтный набор колонок для первого открытия сокращён до номера, описания, типа, цены, срока поставки, MOQ и привязок;
  - служебная action-колонка сужена;
  - таблица переведена на более свободное распределение ширины без избыточного сжатия.
  - запущен пилот пользовательской регулировки ширины колонок с сохранением настроек по view;
  - для ширины колонок введены управляемые ограничения `min/max`, чтобы пользователь не мог ужать колонку до нечитабельного состояния;
  - длинный источник цены больше не раздувает строку по высоте: значение режется через `ellipsis`, а полный текст остаётся в `tooltip`.
- `Tnved Codes`:
  - служебные действия `Импорт` и `Корзина` встроены в общий toolbar вместо отдельной верхней полосы;
  - дефолтный набор колонок для первого открытия сокращён до описания и пошлины, без второстепенного примечания;
  - action-колонка сужена;
  - таблица переведена на более свободное распределение ширины без жёсткого fixed-layout.
- `Standard Parts`:
  - стоимость открытия карточки снижена: строку можно открыть прямым кликом по таблице, а не только через кнопку;
  - action-колонка сужена и занимает меньше полезной ширины;
  - таблица переведена на более свободное распределение ширины без жёсткого fixed-layout.

## 4. Компоненты foundation: backlog

## 4.0. Дополнительное системное правило после контрольного прохода

Для тяжёлых таблиц зафиксировано новое правило:

- пользователь может управлять порядком колонок и их шириной;
- ширина колонки не должна быть полностью свободной, только в допустимом диапазоне;
- по умолчанию должны использоваться:
  - `minWidth` для защиты от "один символ в строке";
  - `maxWidth` для защиты от бессмысленного растягивания служебных колонок;
  - `ellipsis + tooltip` для длинных вторичных значений;
  - горизонтальный скролл, если данных физически больше, чем помещается в экран.

Недопустимое поведение:

- посимвольное разламывание длинных кодов и идентификаторов;
- резкое увеличение высоты строки из-за того, что длинная техстрока попала в узкую колонку;
- прибитая в середине техническая колонка `Действия`.

## 4.1. `PageWrapper` refactor или `AppPageHeader` + облегчённый wrapper

Текущие файлы:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/PageWrapper.jsx`

Проблема:

- wrapper совмещает page padding и header, но header слишком примитивный;
- заголовок в `nowrap`;
- нет нормального разделения основного и вторичного action area.

Решение:

- либо расширить `PageWrapper`, либо вынести отдельный `AppPageHeader`;
- разрешить перенос длинного заголовка;
- добавить structured props:
  - `title`;
  - `subtitle`;
  - `status`;
  - `primaryActions`;
  - `secondaryActions`;
  - `helpSummary`.

Техническая рекомендация:

- лучше ввести новый компонент `AppPageHeader`, а `PageWrapper` оставить как контейнер с padding и шириной.

## 4.2. `WorkspaceShell`

Новые файлы:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/WorkspaceShell.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/WorkspaceShell.css` или расширение existing styles

Назначение:

- общий shell для процессных экранов.

Корректировка после пилота от 2026-03-29:

- компонент не должен навязывать только боковой split;
- для тяжёлых workflow-экранов обязательна поддержка stacked-layout;
- целевая схема для `Client Requests` и `RFQ Workspace`: список сверху, workspace ниже.
- верхний список реализуется как compact selector-panel с ограниченной высотой, а не как полноценная длинная таблица управления.

Базовые пропсы:

- `listPane`
- `detailPane`
- `listWidth`
- `stickyDetailHeader`
- `emptyState`
- `mobileMode`

## 4.3. `EntityHeader`

Новые файлы:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/EntityHeader.jsx`

Назначение:

- заголовок выбранной сущности внутри workspace.

Базовые пропсы:

- `title`
- `status`
- `meta`
- `primaryActions`
- `secondaryActions`
- `progress`

## 4.4. `RowActions`

Вариант реализации:

- либо расширить существующий:
  - `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/ActionButtons.jsx`
- либо создать новый:
  - `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/RowActions.jsx`

Рекомендация:

- не ломать старый `ActionButtons` сразу;
- создать `RowActions` как новый стандартизованный компонент;
- потом постепенно мигрировать экраны на него.

Что поддержать:

- `primaryAction`
- `secondaryAction`
- `moreActions`
- `dangerActions`
- иконки только для системных действий

## 4.5. `FormGrid`

Новые файлы:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/FormGrid.jsx`

Назначение:

- предсказуемое размещение полей.

Что поддержать:

- секции;
- адаптивный layout: split только там, где detail-pane короткая; stacked для тяжёлых рабочих экранов;
- одноколоночный fallback;
- стандартные ширины semantic size:
  - `sm`
  - `md`
  - `lg`
  - `full`

## 4.6. `DataTableV2` или расширение `DraggableColumnsTable`

Текущие файлы:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/DraggableColumnsTable.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/styles/tableStyles.css`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/styles/global.css`

Рекомендация:

- не переписывать весь table layer сразу;
- ввести новый higher-level table wrapper поверх `Table` / `DraggableColumnsTable`;
- правила поведения вынести в единый API.

Новый файл:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/DataTableV2.jsx`

Что поддержать:

- typed columns;
- row density;
- controlled `ellipsis`;
- secondary text;
- limited row actions;
- stable horizontal scroll strategy.

## 4.7. `InfoSummary` / `ContextBanner`

Новые файлы:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/InfoSummary.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/common/ContextBanner.jsx`

Назначение:

- заменить часть тяжёлых `Alert`-паттернов более управляемой моделью.

## 5. Base styles: backlog

## 5.1. Файлы, которые нужно пересмотреть

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/styles/global.css`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/styles/tableStyles.css`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/theme/antdTheme.js`

## 5.2. Что именно надо изменить

- убрать зависимость от глобальной жёсткой табличной плотности;
- пересмотреть `table-layout: fixed` как дефолт;
- ввести токены spacing и layout;
- определить правила:
  - page padding;
  - section gap;
  - card gap;
  - form gap;
  - inline controls gap;
- привести размеры шрифтов и весов к ролям, а не к случайным локальным настройкам.

## 5.3. Что пока не делать

- не устраивать глобальный theme rewrite всего Ant Design;
- не делать резкий полный visual redesign;
- не ломать все существующие таблицы одновременно.

## 6. Экран `Client Requests`: backlog по файлам

## 6.1. Основные файлы

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/ClientRequestsPage.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/clientRequests/ClientRequestWorkspaceCard.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/clientRequests/RequestsListCard.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/clientRequests/NewRequestCard.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/clientRequests/RequestQuoteTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/clientRequests/RequestContractTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/clientRequests/RequestMarginTabContent.jsx`

## 6.2. Порядок реализации

1. Перевести page-level shell.
2. Перевести список заявок в левую панель.
3. Перевести workspace header на `EntityHeader`.
4. Разделить toolbar вкладки `Позиции`.
5. Перевести таблицу позиций на новые правила.
6. Вынести создание заявки из основного полотна.

## 6.3. Что можно сделать безопасно

- новый shell без изменения бизнес-логики;
- переразметка header и toolbar;
- переразмещение блоков без изменения API;
- перевод части row actions на новый компонент.

## 6.4. Где риск

- `ClientRequestsPage.jsx` очень большой;
- высокая вероятность затронуть состояние страницы;
- возможны регрессии в режимах:
  - revision flow;
  - import flow;
  - bulk edit flow;
  - quick add flow.

Нужна постепенная изоляция блоков.

## 7. Экран `RFQ Workspace`: backlog по файлам

## 7.1. Основные файлы

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/RfqWorkspacePage.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/RfqWorkspaceMainContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/RfqOverviewTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/SuppliersTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/ResponsesTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/CoverageTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/ScenariosTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/LogisticsTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/EconomicsTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/SalesTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/ContractsTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/PurchaseOrdersTabContent.jsx`

## 7.2. Порядок реализации

1. Перевести внешний shell списка RFQ и detail area.
2. Ввести `EntityHeader` для активного RFQ.
3. Добавить process strip.
4. Перевести только самые болезненные табы первого круга:
   - `PurchaseOrdersTabContent`
   - `ContractsTabContent`
   - `SalesTabContent`
5. После этого переходить к более тяжёлым табам:
   - `Coverage`
   - `Responses`
   - `Economics`

## 7.3. Что можно сделать безопасно

- page shell;
- header;
- список RFQ;
- организация верхнего уровня вкладок.

## 7.4. Где риск

- много вложенных состояний;
- вкладки сильно завязаны на текущую композицию;
- высокая цена регрессии в логике закупочного процесса.

Вывод:

- внутри RFQ нужен строго пошаговый rollout, не massive rewrite.

## 8. Экран `Contracts`: backlog по файлам

## 8.1. Основные файлы

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/clientRequests/RequestContractTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/ContractsTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/ContractsPage.jsx`

## 8.2. Порядок реализации

1. Вынести форму на `FormGrid`.
2. Перевести info/help pattern.
3. Пересобрать таблицу строк контрактов.
4. Перевести действия статусов на `RowActions`.
5. Отдельно проверить document actions.

## 8.3. Где риск

- два похожих, но не идентичных entry point:
  - standalone page;
  - tab inside workflow.

Нужно сохранить единый visual standard без дублирования сложной логики.

## 9. Экран `Purchase Orders`: backlog по файлам

## 9.1. Основные файлы

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/components/rfqWorkspace/PurchaseOrdersTabContent.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/PurchaseOrdersPage.jsx`
- связанные превью и документные страницы при необходимости:
  - `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/PurchaseOrderPreviewPage.jsx`

## 9.2. Порядок реализации

1. Перевести форму на `FormGrid`.
2. Выделить semantic sections формы.
3. Пересобрать таблицу заказов.
4. Перевести качества и документы на новую action model.
5. Отдельно проверить длинные основания и Incoterms.

## 9.3. Где риск

- standalone page и tab-version могут начать визуально расходиться;
- строка заказа сильно зависит от бизнес-текста и длинных данных.

## 10. Пример целевой очередности merge-пакетов

## Merge 1

- `AppPageHeader`
- облегчённый `PageWrapper`
- базовые layout styles

Статус:

- выполнено

## Merge 2

- `WorkspaceShell`
- `EntityHeader`
- `InfoSummary`

Статус:

- `WorkspaceShell` и `EntityHeader` выполнены
- `WorkspaceShell` после пилота расширен `stacked-mode`, поскольку жёсткий `50/50` split ухудшил usability на реальных process screens
- `Client Requests` и `RFQ Workspace` переведены на compact selector-panel сверху с полноширинным workspace ниже
- выполнен первый проход по внутренней эргономике workspace: selector-таблицы укорочены, destructive actions вынесены из строк выбора, верхние toolbars в `Client Requests` структурированы на блоки `контекст / действия / быстрые операции`
- `ContractsPage` и `PurchaseOrdersPage` переведены в честный обзорный режим: убраны disabled-формы создания, добавлены явные переходы в основной workspace, обзорные таблицы и документные действия упрощены
- начат каталоговый пакет: `Clients` и `Suppliers` переведены на один верхний toolbar вместо двух служебных полос; action-columns в основных таблицах сужены, чтобы снизить служебный шум
- в `ClientsTable` и `SuppliersTable` начат проход по читаемости строк: primary-column стала информативнее, таблицы переведены с `fixed` на `auto` layout для более естественного распределения ширины
- `InfoSummary` пока отложен

## Merge 3

- `RowActions`
- `FormGrid`
- `DataTableV2` initial version

Статус:

- `FormGrid` выполнен
- `RowActions` и `DataTableV2` пока не реализованы

## Merge 4

- `Client Requests` shell refactor
- список + workspace composition

Статус:

- выполнено

## Merge 5

- `Client Requests` positions tab cleanup
- revision/import/bulk toolbar cleanup

Статус:

- частично выполнено через новый shell и новый header
- глубокая чистка toolbar и табличной логики ещё впереди

## Merge 6

- `RFQ Workspace` shell refactor
- RFQ header + process strip

Статус:

- выполнено

## Merge 7

- `Contracts` redesign

Статус:

- выполнено в первом базовом варианте

## Merge 8

- `Purchase Orders` redesign

Статус:

- выполнено в первом базовом варианте

## Merge 9

- добивка общих компонентов по реальным замечаниям после внедрения

## 11. Что можно внедрять без ломки существующего UI

- новые common components рядом со старым кодом;
- новые styles как additive layer;
- новый `RowActions` без удаления старого `ActionButtons`;
- новый `FormGrid` без немедленной миграции всех форм;
- новый `WorkspaceShell` только для приоритетных экранов.

Это важно, потому что:

- снижает интеграционный риск;
- позволяет выкатывать поэтапно;
- упрощает локальную проверку;
- не требует big bang rewrite.

## 12. Что потребует рефакторинга страниц

- перевод длинных workflow-страниц на master-detail;
- разделение верхней панели и рабочих секций;
- разукрупнение больших page-файлов;
- частичное выделение логических блоков в новые subcomponents.

Наиболее вероятные кандидаты на разукрупнение:

- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/ClientRequestsPage.jsx`
- `/Users/aleksandrlubimov/project/crusher-parts-frontend/src/pages/RfqWorkspacePage.jsx`

## 13. Проверки после каждого пакета

После каждого merge-пакета нужно проверить:

- читаемость таблиц;
- перенос длинных значений;
- отсутствие вылезания кнопок;
- устойчивость при узкой ширине окна;
- предсказуемость действий;
- отсутствие конфликтов между списком и рабочей зоной;
- отсутствие поломок в формах создания и редактирования.

## 14. Минимальный definition of done для реализации

Изменение считается завершённым, если:

- новый компонент действительно переиспользуем;
- он не решает проблему только одного экрана;
- он уменьшает число локальных `style={{ width: ... }}` решений;
- он уменьшает визуальную перегрузку;
- он делает следующий пользовательский шаг понятнее, чем раньше.

## 15. Рекомендуемый следующий практический шаг

После этого backlog-документа следующий рабочий шаг уже может быть инженерным:

- открыть frontend;
- начать с foundation-пакета;
- сначала реализовать:
  - `AppPageHeader`;
  - `WorkspaceShell`;
  - `RowActions`;
  - `FormGrid`;
- затем перевести `Client Requests` как первый пилотный экран.

Это лучший старт, потому что:

- `Client Requests` достаточно важен;
- на нём видны все основные UX-дефекты;
- он позволит проверить новый foundation до перехода к `RFQ Workspace`.

## 16. Контрольный проход после первой волны

После внедрения foundation, переработки workflow-shell и первой волны cleanup по каталогам подтверждены следующие остаточные зоны риска.

### 16.1. Workflow: второй приоритет

- `Client Requests`:
  - требуется отдельный проход по внутренним вкладкам `RequestQuoteTabContent` и `RequestMarginTabContent`;
  - первый локальный пакет уже выполнен для:
    - `RequestQuoteTabContent`;
    - `RequestMarginTabContent`;
  - в этом пакете:
    - ослаблены жёсткие служебные ширины в селектах и табличных action-колонках;
    - таблицы `КП` и `ревизий КП` переведены на `tableLayout="auto"` и `scroll={{ x: "max-content" }}`;
    - в `Маржа/Экономика` убрана правая fixed-колонка `Сохранить`, чтобы таблица не зажимала рабочий центр при длинных бизнес-значениях.
- `RFQ Workspace`:
  - требуется отдельный проход по:
    - `ResponsesTabContent`;
    - `CoverageTabContent`;
    - `SelectionTabContent`;
    - `SuppliersTabContent`;
    - `PurchaseOrdersTabContent`;
  - именно там остались самые дорогие по чтению бизнес-таблицы и перегруженные локальные controls.
  - первый локальный пакет уже выполнен для:
    - `ResponsesTabContent`;
    - `SuppliersTabContent`;
    - `CoverageTabContent`;
    - `SelectionTabContent`;
    - `PurchaseOrdersTabContent`;
  - в этом пакете:
    - ослаблена фиксация колонок, чтобы не возникала схема `fixed слева + fixed справа + узкая середина`;
    - уменьшены самые широкие служебные колонки;
    - для длинных значений включён честный горизонтальный `max-content` scroll вместо скрытого сжатия;
    - во вкладке `Purchase Orders` объединены близкие служебные поля, уменьшены action/document-колонки и убрано давление вспомогательных кнопок на чтение основных данных.

### 16.2. Каталоги: остаточные особенности

- `Standard Parts`:
  - это не просто каталог, а registry с тяжёлыми действиями и связанными представлениями;
  - для него приоритетом остаётся упрощение открытия карточки и дисциплина действий, а не агрессивное сокращение columns model;
- `Materials`:
  - базовая композиция улучшена, но далее нужен уже не layout-pass, а review detail drawer и карточки материала;
- `Original Parts` и `Supplier Parts`:
  - базовый first-open стал лучше;
  - следующий шаг там уже не toolbar, а контроль самых тяжёлых detail/sub-tabs и вложенных таблиц.

### 16.3. Технический остаток по таблицам

- несмотря на локальный перевод ряда экранов на `tableLayout=\"auto\"`, в проекте остаётся заметное число nested и detail tables на `table-layout: fixed`;
- это означает, что следующий пакет должен идти не по верхним страницам, а по подтаблицам и workflow-tab content.

### 16.4. Следующий практический шаг

Следующим инженерным пакетом рекомендуется:

- не брать новый верхнеуровневый экран;
- пройти внутренние workflow-вкладки `Client Requests` и `RFQ Workspace`;
- отдельно проверить самые тяжёлые nested tables на предмет:
  - фиксированного layout;
  - избыточной ширины служебных колонок;
  - дублирования действий;
  - перегруженных локальных toolbar.

## 17. Вторая волна: backlog после контрольного прохода

После локального cleanup ширин и фиксированных колонок стало ясно, что следующий слой проблем уже не табличный, а сценарный.

### 17.1. Что теперь считается главным источником неудобства

- дублирование уровней навигации и управления одним и тем же объектом;
- смешение сценариев `создать` и `контролировать` на одном визуальном уровне;
- слишком дорогая модель построчного редактирования;
- экраны, которые читаются как технический registry вместо task-oriented workspace.

### 17.2. Конкретные пакеты второй волны

#### Пакет W2-A. `SelectionTabContent`

Задача:

- сократить decision-area до одного главного блока утверждения сценария.

Статус:

- начат;
- первый локальный пакет уже выполнен;
- следующий локальный пакет уже выполнен.

Что пересобрать:

- selector сценария;
- summary текущего сценария;
- таблицу состава сценария;
- блок `Уже созданные утвержденные выборы`;
- блок `База для продавца`.

Цель:

- пользователь должен быстро ответить на вопрос:
  - этот сценарий можно утверждать или нет.

Что уже сделано в первом локальном пакете:

- отдельный блок `Уже созданные утвержденные выборы` убран как самостоятельная равноправная карточка;
- история выборов и downstream-контекст перенесены в единый вторичный блок `Утверждённый выбор для продавца`;
- decision-area наверху стала чище:
  - текущий сценарий;
  - ключевые summary-теги;
  - таблица состава сценария;
  - затем уже вторичный блок про финальный выбор.

Что уже сделано в следующем локальном пакете:

- decision-area собрана в явный блок `Решение по сценарию`;
- экран теперь прямо показывает, можно ли утверждать сценарий сейчас;
- добавлены summary-сигналы готовности: неполные строки, строки без полной цены, OEM-риски;
- главный вопрос пользователя поднят выше длинной таблицы состава.

Что уже сделано в дополнительном локальном пакете:

- проблемные строки сценария вынесены в отдельный короткий review-блок;
- полный состав сценария переведён во вторичный раскрываемый слой;
- первый экран вкладки стал меньше напоминать отчёт и сильнее сфокусирован на решении.

#### Пакет W2-B. `RequestQuoteTabContent`

Задача:

- убрать двойную навигацию по КП.

Статус:

- начат;
- первый локальный пакет уже выполнен;
- следующий локальный пакет уже выполнен.

Что пересобрать:

- `Select` выбранного КП;
- реестр КП;
- блок ревизий выбранного КП;
- статусные действия.

Цель:

- оставить один главный способ навигации по предложению и один главный detail-context для текущего КП.

Что уже сделано в первом локальном пакете:

- убран `Select` как второй параллельный способ навигации по КП;
- главным способом выбора КП сделан реестр;
- текущее выбранное КП теперь определяется кликом по строке таблицы;
- добавлена явная подсветка активной строки, чтобы detail-context читался без догадок.

Что уже сделано в следующем локальном пакете:

- статусные действия убраны из строк таблицы;
- row registry снова работает прежде всего как selector;
- actions перенесены в контекст выбранного КП в header карточки;
- навигация по предложениям и управление состоянием больше не конкурируют в одной и той же строке.

#### Пакет W2-C. `RequestMarginTabContent`

Задача:

- пересмотреть модель редактирования экономики.

Статус:

- начат;
- первый локальный пакет уже выполнен;
- следующий локальный пакет уже выполнен.

Что пересобрать:

- row-level save flow;
- способ правки цен/маржи;
- представление totals и revision context;
- роль диагностической колонки `Правило`.

Цель:

- уменьшить цену серии правок и убрать ощущение “таблички с десятком мини-форм”.

Что уже сделано в первом локальном пакете:

- добавлен явный блок `Контекст ревизии` вместо разрозненных controls;
- экран теперь показывает количество изменённых строк;
- появился batch-save для серии правок по строкам;
- построчная кнопка `Сохранить` теперь работает как точечное действие только для реально изменённой строки.

Что уже сделано в следующем локальном пакете:

- построчная кнопка `Сохранить` убрана из основной таблицы;
- диагностическая логика `Правило` перенесена в контекст самой позиции;
- строка теперь сначала показывает экономику, а уже потом вторичный диагностический сигнал;
- основная таблица стала ближе к рабочему редактору продавца, а не к service-grid.

Что уже сделано в дополнительном локальном пакете:

- вычисляемые метрики собраны в один вторичный блок `Результат`;
- строка перестала держать несколько однотипных производных колонок рядом;
- основной фокус ещё сильнее смещён на поля, которые пользователь реально правит.

#### Пакет W2-D. `SuppliersTabContent`

Задача:

- развести подбор, настройку и отправку поставщиков.

Статус:

- начат;
- первый локальный пакет уже выполнен;
- следующий локальный пакет уже выполнен.

Что пересобрать:

- supplier hints;
- add-supplier block;
- suppliers-in-rfq grid;
- dispatch summary / file history.

Цель:

- пользователь должен в каждый момент понимать один активный режим:
  - подбираю;
  - настраиваю;
  - отправляю.

Что уже сделано в первом локальном пакете:

- экран разведен на два явных режима:
  - `Подбор и состав поставщиков`;
  - `Отправка и история`;
- карточки переименованы так, чтобы их роль читалась быстрее:
  - кандидаты;
  - ручное добавление;
  - состав рассылки;
  - история отправок;
- пользовательская ментальная модель стала яснее без большого рефактора вкладки на отдельные subpages.

Что уже сделано в следующем локальном пакете:

- текущая рассылка сделана primary mode внутри режима отправки;
- история файлов переведена во вторичный раскрываемый блок;
- bulk action `Сформировать Excel` и флаг `Включать строки с уже принятой ценой` подняты в контекст текущей рассылки;
- текущая отправка и historical review теперь меньше конкурируют на одном экране.

Что уже сделано в дополнительном локальном пакете:

- summary-шапка текущей рассылки упрощена;
- ключевые показатели оставлены как быстрый operational snapshot, а вторичный контекст вынесен в короткий текст;
- блок `Новые позиции в ревизии` стал короче и более инструктивным.

#### Пакет W2-E. `CoverageTabContent`

Задача:

- уменьшить cognitive load матрицы покрытия.

Статус:

- начат;
- первый локальный пакет уже выполнен;
- следующий локальный пакет уже выполнен.

Что пересобрать:

- режим matrix diagnostics;
- сохранение mixed/manual вариантов;
- combo tables;
- focus/filter по поставщикам.

Цель:

- не просто показать матрицу, а помочь принять решение по покрытию без визуального утопления в ячейках.

Что уже сделано в первом локальном пакете:

- режимы `матрица`, `сводка поставщиков` и `комбинации` получили явные поясняющие заголовки и описания;
- action `Сохранить покрытие RFQ` переименован в более точный `Сохранить варианты покрытия`;
- матрица перестала выглядеть как единственный общий режим экрана и стала читаться как один из нескольких рабочих режимов.

Что уже сделано в следующем локальном пакете:

- добавлен мягкий focus-mode для матрицы поставщиков;
- по умолчанию матрица показывает не всех, а наиболее полезных для сравнения поставщиков;
- режим `Показать всех поставщиков` оставлен как явное обратимое действие;
- сравнение стало более управляемым без потери доступа ко всем данным.

#### Пакет W2-F. `PurchaseOrdersTabContent`

Задача:

- разделить создание нового PO и контроль уже созданных PO.

Статус:

- начат;
- первый локальный пакет уже выполнен.

Что пересобрать:

- create block;
- overview table;
- document actions;
- quality actions.

Цель:

- обзорные действия не должны визуально подчиняться create-form.

Что уже сделано в первом локальном пакете:

- обзор выпущенных заказов вынесен выше создания;
- основным режимом экрана сделан контроль уже созданных PO;
- create-form переведена во вторичный раскрываемый блок;
- экран стал лучше разделять режимы `обзор` и `создание`.

Что уже сделано в следующем локальном пакете:

- статус PO перенесён в первичный блок заказа;
- supplier reference встроен в контекст поставщика;
- quality-action и document-actions собраны в один спокойный блок `Действия`;
- строка заказа стала лучше работать как обзорная строка, а не как хвост из отдельных сервисных колонок.

### 17.3. Рекомендуемый порядок второй волны

- `SelectionTabContent`
- `RequestQuoteTabContent`
- `RequestMarginTabContent`
- `SuppliersTabContent`
- `CoverageTabContent`
- `PurchaseOrdersTabContent`

### 17.4. Правило для второй волны

Во второй волне нельзя ограничиваться только width/fixed tuning.

Каждый пакет должен проверяться по вопросам:

- что пользователь делает первым;
- что он делает чаще всего;
- что должно быть видно без лишней прокрутки;
- какие два сценария сейчас ошибочно смешаны;
- можно ли убрать один уровень навигации или один уровень действий.

### 17.5. Контрольный проход после второй локальной волны второй фазы

Что уже улучшилось:

- `SelectionTabContent` стал менее отчётным: history/downstream-блок больше не конкурирует с утверждением сценария;
- `RequestQuoteTabContent` больше не держит ни двойную навигацию, ни status-actions внутри строк;
- `RequestMarginTabContent` получил batch-save, более понятный header ревизии, меньший service-noise в таблице и собрал числовое редактирование в единый блок коммерческих параметров без изменения формул;
- `SuppliersTabContent` и `CoverageTabContent` не только лучше проговаривают режимы, но и лучше дозируют рабочий контент;
- `PurchaseOrdersTabContent` теперь лучше разделяет обзор и создание, а строка заказа стала спокойнее.

Что остаётся проблемным и требует третьей волны:

- `SelectionTabContent`:
  - decision-area всё ещё слишком длинная;
  - сценарий, summary и таблица состава читаются последовательно, но экран всё ещё больше похож на review-report, чем на decision-screen.
- `RequestQuoteTabContent`:
  - основной конфликт уже снят;
  - следующая проблема теперь в том, что header выбранного КП и таблица ревизий ещё можно сделать компактнее и яснее по hierarchy.
- `RequestMarginTabContent`:
  - batch-save уже помогает, но модель редактирования всё ещё таблично-техническая;
  - плотность строки уже снижена, но следующий шаг теперь скорее в иерархии edit vs computed state, а не в самих формулах.
- `SuppliersTabContent`:
  - главный конфликт current dispatch vs history уже снижен;
  - summary и dispatch-controls уже стали спокойнее;
  - следующий шаг теперь скорее в ещё более компактной строке поставщика, а не в верхнем summary-блоке.
- `CoverageTabContent`:
  - матрица уже получила не только общий focus, но и сценарные режимы сравнения: лучшее покрытие, лучшее покрытие с ценой, OEM/критичные;
  - следующий шаг там теперь уже не в базовом выборе колонок, а в ещё более глубоких аналитических сценариях, если они реально понадобятся пользователям.
- `PurchaseOrdersTabContent`:
  - обзорная строка уже разгружена;
  - следующая архитектурная развилка: оставлять ли create-form в collapsible card или окончательно уводить её в drawer/modal.

Что брать в третью волну:

- `SelectionTabContent`: сократить decision-area и усилить главный момент утверждения;
- `RequestMarginTabContent`: снизить плотность одновременного редактирования в строке;
- `SuppliersTabContent`: упростить summary-density в текущем составе рассылки;
- `CoverageTabContent`: сделать focus-mode умнее, чем просто top-N supplier columns;
- `PurchaseOrdersTabContent`: решить судьбу create-flow как отдельного режима.

Дополнительный контрольный проход после локальных пакетов показал:

- `SelectionTabContent` уже вышел из зоны явной боли; следующий шаг там скорее эволюционный, а не срочный.
- `RequestMarginTabContent` тоже стал рабочим; если возвращаться к нему, то уже ради более мягкого разделения editable и computed-state, а не из-за критической перегрузки.
- `SuppliersTabContent` стал заметно спокойнее в верхнем dispatch-блоке; дальше улучшение уже в деталях строки поставщика.
- `CoverageTabContent` остаётся самым сложным аналитическим экраном, но базовый focus-mode уже стал заметно умнее и ближе к реальным сценариям сравнения.

### 17.6. Уточнение после дополнительного контрольного прохода

После дополнительного контрольного прохода приоритеты третьей волны подтверждены и уточнены:

- для широких таблиц зафиксировано отдельное UX-правило:
  - горизонтальный скролл должен быть явно считываемым;
  - одного `scroll-x` недостаточно;
  - нужен паттерн `edge fade + краткая подсказка до первого сдвига`.
- первый рабочий пакет этого правила уже внедрён в `SuppliersTabContent` для:
  - текущего состава рассылки;
  - истории отправок RFQ.
- следующий рабочий пакет этого правила уже внедрён в:
  - `ResponsesTabContent`;
  - `CoverageTabContent`:
    - матрица;
    - supplier summary;
    - combinations table;
  - `PurchaseOrdersTabContent`.

- отдельно внедрено правило для `actions`-колонок в крупных draggable-реестрах:
  - `SupplierPartsTable`;
  - `ClientsTable`;
  - `SuppliersTable`;
  - `OriginalPartsTable`.
- в этих таблицах `Действия` больше не держится как lock-column и по умолчанию стоит последней.
- следующий пакет того же правила применён в:
  - `MaterialsTable`;
  - `TnvedCodesTable`;
  - `LogisticsTabContent` (`Группы отгрузки`);
  - `CoverageTabContent` (`Комбинации`).
- смысл правила зафиксирован так:
  - если таблица already draggable, `actions` не блокируется без особой причины;
  - базовое место `actions` — последний столбец;
  - техническая колонка не должна случайно оказываться в середине бизнес-таблицы из-за старого lock/nonDraggable правила;
  - даже сохранённый пользовательский порядок должен нормализовать `actions` в конец строки.

- отдельно внедрено системное правило для длинных значений в таблицах:
  - больше не используется агрессивный посимвольный перенос long-values в обычных `td`;
  - приоритет смещён в сторону естественной ширины, горизонтального скролла и `ellipsis`, а не роста высоты строки;
  - это особенно важно для supplier/reference/RFQ-кодов, длинных номеров и внутренних идентификаторов, которые раньше могли растягивать строку на полэкрана.

- `SelectionTabContent`
  - больше не выглядит хаотичным;
  - но всё ещё остаётся самым длинным decision-screen;
  - следующий эффект даст не новый layout, а уменьшение review-density под блоком утверждения.

- `RequestMarginTabContent`
  - уже вышел из зоны service-conflict;
  - но остаётся плотным как числовой редактор;
  - следующий шаг должен облегчать редактирование нескольких ключевых чисел в строке, а не добавлять новые таблицы или summary-блоки.

- `SuppliersTabContent`
  - current dispatch уже стал главным режимом;
  - history ушла во вторичный слой;
  - остаточный UX-долг теперь в плотности summary-alert и dispatch-controls, а не в архитектуре вкладки.

- `CoverageTabContent`
  - table/fixed-проблема уже не главная;
  - главный остаточный долг теперь аналитический:
    - как быстрее переключать полезные наборы supplier-columns;
    - как не заставлять пользователя каждый раз смотреть один и тот же generic focus-set.

- `RequestQuoteTabContent`
  - переведён в устойчивое состояние;
  - дальнейшие улучшения уже не срочные.

- `PurchaseOrdersTabContent`
  - переведён в устойчивое обзорное состояние;
  - дальнейшие улучшения уже не срочные по сравнению с четырьмя экранами выше.

### 17.7. Отдельный финальный вывод по техническим названиям на фронте

Финальный проход показал отдельный риск, не связанный напрямую с layout:

- часть экранов по-прежнему допускает fallback на raw `status / basis / type / code` из API;
- это значит, что при появлении нового backend enum пользователь может увидеть не деловой текст, а внутреннее техническое значение.

Наиболее заметные зоны риска:

- `SelectionTabContent`
- `ScenariosTabContent`
- `EconomicsTabContent`
- `RequestQuoteTabContent`
- `RequestMarginTabContent`
- `SalesTabContent`
- `RequestContractTabContent`
- `ContractsTabContent`
- `PurchaseOrdersTabContent`
- `CoverageTabContent`

Особый случай:

- в `CoverageTabContent` пользовательский интерфейс по-прежнему опирается на коды `NQ / NS / Q? / Q- / Q+ / Q+P / Q+OEM / Q!`;
- сейчас они уже снабжены подсказками, но сами short-codes всё ещё скорее внутренние, чем естественные пользовательские обозначения.

Рекомендуемое системное правило:

- никакой raw enum не должен попадать на экран как основной label;
- неизвестное значение должно превращаться в безопасную бизнес-формулировку вроде `Неизвестный статус` или `Неизвестный режим`;
- словари label-ов должны быть централизованы и проверяться отдельно от layout-работ.
## Update 2026-03-29 — System Column Resize Rollout

- `DraggableColumnsTable` переведён на системный resize по сохранённой ширине колонки, а не по измеренной DOM-ширине.
- Resize раскатан на основные draggable-таблицы каталогов и рабочих экранов через `columnSizingKey`.
- Для `Supplier Parts` отдельно зафиксирована рабочая схема:
  - горизонтальный scroll живёт через штатный `scroll.x`;
  - drag-drop и resize разведены по разным зонам заголовка;
  - длинные значения режутся через `ellipsis + tooltip`, а не удерживают ширину колонки.
- Следующий контрольный слой качества:
  - точечно проходить колонки с тяжёлым кастомным render;
  - убирать лишние вторые строки из ячеек, если они снова мешают shrink;
  - выравнивать `minWidth` по типам колонок, а не по фактической длине текста.

## Update 2026-03-29 — Catalog Draggable Tables Audit Fix

- После системного rollout найден повторяющийся дефект в каталогах:
  - resize был внедрён, но отдельные таблицы всё ещё жили по старому паттерну;
  - в них одновременно оставались `fixed: "left"`, `lock: true`, `tableLayout="auto"` и rich-content ячейки без жёсткого clipping.
- Это приводило к трём симптомам:
  - колонка не сжималась, потому что ширину продолжал диктовать текст;
  - drag-and-drop работал непредсказуемо или не работал для первых колонок;
  - fixed-слои визуально конфликтовали с resize и scroll.
- Системно вычищены и приведены к одному паттерну:
  - `ClientsTable`
  - `SuppliersTable`
  - `OriginalPartsTable`
  - `MaterialsTable`
  - `TnvedCodesTable`
- Новый базовый принцип для draggable catalog tables:
  - без крайней причины не использовать `fixed: "left"` у первых колонок;
  - не использовать `lock: true` для основных бизнес-колонок;
  - `tableLayout="fixed"` + `scroll.x = "max-content"` для предсказуемого resize;
  - primary/rich ячейки обязаны жить с `ellipsis` и `overflow: hidden`, а не удерживать колонку своей фактической длиной;
  - `actions` остаётся последней технической колонкой.

## Update 2026-03-29 — Root Cause Fix For Cross-Table Resize

- После дополнительной проверки выяснилось, что основной дефект был не только в `fixed/lock`.
- В `Supplier Parts` resize работал лучше, потому что там общая ширина таблицы пересчитывалась из текущих пользовательских ширин колонок.
- В остальных draggable-таблицах менялась только ширина отдельных колонок, но не пересчитывались:
  - общая ширина inner table;
  - `scroll.x`;
  - CSS variable для resizable table width.
- Из-за этого resize формально срабатывал, но визуально таблица продолжала жить в старой геометрии и создавалось ощущение, что колонка “упирается в текст”.
- `DraggableColumnsTable` исправлен системно:
  - теперь общая ширина таблицы считается из `mergedColumns`;
  - для resizable-режима автоматически обновляется `--op-table-resizable-width`;
  - если `scroll.x` не задан числом, он автоматически заменяется на вычисленную общую ширину таблицы.
- Это устраняет расхождение между рабочим эталоном `Supplier Parts` и остальными каталоговыми draggable-таблицами.
