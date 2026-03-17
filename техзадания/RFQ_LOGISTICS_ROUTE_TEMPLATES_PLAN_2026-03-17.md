# RFQ Logistics Route Templates Plan

Дата: 2026-03-17

## 1. Цель документа

Этот файл фиксирует текущее понимание логистического слоя по результатам анализа:

- актуального дампа `Cloud_SQL_Export_2026-03-17 (09_45_32).sql`;
- backend / frontend логики RFQ;
- существующего каталога `Логистические коридоры`;
- текущей рабочей вкладки `Логистика` внутри RFQ.

Документ нужен как рабочее техзадание и handoff-файл, который можно дополнять по мере продвижения решения.

## 1.1. Статус продвижения

Уже применено в реальной БД:

- SQL-пакет 1: создана таблица `rfq_shipment_group_routes`

Подтверждение:

- новый дамп `Cloud_SQL_Export_2026-03-17 (10_23_19).sql` уже содержит `rfq_shipment_group_routes`

Следующий шаг:

- SQL-пакет 2 должен закрепить:
  - правило `не более одного selected route на shipment group`;
  - трассировку выбранного маршрута в downstream-слой (`selection_lines`);
  - более точную аналитику через `logistics_route_usage_events`.

## 2. Короткий вывод

Сейчас в системе одновременно существуют:

1. `Новый рабочий RFQ-контур`
   - `rfq_coverage_options`
   - `rfq_scenarios`
   - `rfq_shipment_groups`
   - `rfq_shipment_group_lines`
   - `selection_lines`

2. `Каталожный логистический контур`
   - `logistics_corridors`
   - `logistics_route_templates`
   - `logistics_route_usage_events`

3. `Старый / переходный контур`
   - legacy-таблица `shipment_groups`
   - в ней есть `logistics_corridor_id` и `logistics_route_id`

Главный вывод:

- текущая рабочая логистика RFQ уже живет в `rfq_shipment_groups`;
- каталог коридоров не является мусором, а выглядит как заготовка под следующий слой зрелости;
- старая таблица `shipment_groups` выглядит как остаток предыдущей модели и не является актуальным ядром RFQ-потока;
- в коде уже есть задел на связку `shipment group -> route template / adhoc route`, но этот слой пока не доведен до рабочего UI.

## 3. Что сейчас реально работает

### 3.1. Рабочий бизнес-поток на сегодня

Текущий рабочий поток:

`RFQ -> Покрытие -> Сценарии -> Логистика -> Экономика -> Selection`

Где:

- `Покрытие` формирует `rfq_coverage_options` и `rfq_coverage_option_lines`;
- `Сценарии` выбирают coverage option на строку RFQ;
- `Логистика` собирает выбранные coverage lines в `rfq_shipment_groups`;
- `Экономика` считает freight / duty / landed cost на базе сценария и групп;
- `Selection` снапшотит execution baseline.

### 3.2. Что делает RFQ-вкладка `Логистика`

Текущая вкладка `Логистика`:

- работает через `routes/economics.js`;
- использует сценарий как обязательную отправную точку;
- умеет:
  - автосоздавать shipment groups;
  - создавать ручные группы;
  - редактировать header группы;
  - назначать в группу coverage option lines;
  - хранить freight / ETA / Incoterms на уровне группы.

Текущее поведение автогруппировки:

- группирует по:
  - `supplier_id`
  - `origin_country`
  - `incoterms`
  - `incoterms_place`

Важно:

- на этом шаге группа еще не опирается на catalog route template;
- логистическая группа сейчас самодостаточна и хранит свои поля вручную.

## 4. Что уже есть в БД

### 4.1. Актуальные таблицы нового RFQ-контура

В дампе подтверждены:

- `rfq_coverage_options`
- `rfq_coverage_option_lines`
- `rfq_scenarios`
- `rfq_scenario_lines`
- `rfq_shipment_groups`
- `rfq_shipment_group_lines`

Особенно важно:

- `rfq_shipment_groups` не содержит ссылки на `logistics_corridors` или `logistics_route_templates`;
- там хранятся:
  - `route_type`
  - `incoterms`
  - `incoterms_place`
  - `freight_input_mode`
  - `freight_total`
  - `freight_currency`
  - `freight_rate_per_kg`
  - `eta_min_days`
  - `eta_max_days`

То есть текущая группа описывает логистику сама, без справочного слоя маршрутов.

### 4.2. Каталожный слой логистики

В дампе подтверждены:

- `logistics_corridors`
- `logistics_route_templates`
- `logistics_route_usage_events`

`logistics_corridors` уже используются как справочник направления:

- origin country
- destination country
- transport mode
- risk level
- ETA range

`logistics_route_templates` уже выглядят как правильная сущность для переиспользуемого маршрута:

- `corridor_id`
- `name`
- `code`
- `version_no`
- `pricing_model`
- `currency`
- `fixed_cost`
- `rate_per_kg`
- `rate_per_cbm`
- `min_cost`
- `markup_pct`
- `markup_fixed`
- `eta_min_days`
- `eta_max_days`
- `incoterms_baseline`
- ограничения по oversize / overweight / dangerous goods

`logistics_route_usage_events` уже выглядят как правильная база для аналитики:

- `used_in_scenario`
- `selected_in_final`
- `po_created`
- `shipment_completed`
- `shipment_failed`

### 4.3. Legacy-след старой модели

В дампе есть legacy-таблица:

- `shipment_groups`

В ней уже есть:

- `logistics_corridor_id`
- `logistics_route_id`

Это сильный признак того, что раньше была попытка связывать отгрузки и логистические маршруты напрямую в другом контуре.

На текущий момент эта таблица не выглядит как ядро действующего RFQ-потока.

## 5. Что есть в коде

### 5.1. Что реально подключено

Рабочий UI:

- `src/components/rfqWorkspace/LogisticsTabContent.jsx`

Он работает только с shipment groups сценария и не показывает route templates / corridors.

Backend рабочей логистики:

- `routes/economics.js`

### 5.2. Что уже написано как задел

Во frontend уже есть компоненты:

- `src/components/rfqWorkspace/economics/GroupRoutesPanel.jsx`
- `src/components/rfqWorkspace/economics/AdhocRouteModal.jsx`

Из них видно, что задуман следующий слой:

- у группы может быть назначен template route;
- у группы может быть adhoc route;
- adhoc route выбирает `corridor_id`;
- для группы предполагается:
  - `route_source_type`
  - `route_template_id`
  - `route_payload_json`
  - `selected_for_scenario`
  - расчет `logistics_amount_calc`
  - расчет `eta_min_days_calc` / `eta_max_days_calc`

Но по текущему поиску эти компоненты не импортируются в активный рабочий экран. Значит это подготовленный, но не доведенный слой.

## 6. Бизнес-понимание правильной модели

### 6.1. Что такое `коридор`

`Коридор` должен быть не маршрутом расчета, а верхнеуровневым справочником направления.

Пример:

- `CN -> RU SEA`
- `CN -> RU ROAD`

Коридор отвечает на вопрос:

- из какой страны в какую страну;
- каким типом транспорта;
- с каким базовым risk / ETA.

### 6.2. Что такое `шаблон маршрута`

`Шаблон маршрута` должен быть основной переиспользуемой единицей.

Пример:

- `CN -> RU SEA / FOB Shanghai / FCL / Forwarder X`
- `CN -> RU ROAD / FCA Qingdao / Truck consolidated`

Шаблон маршрута отвечает на вопрос:

- как именно считать freight;
- в какой валюте;
- какой ETA брать;
- какие ограничения применимы;
- под какие Incoterms / условия шаблон подходит.

### 6.3. Что такое `маршрут группы`

Для конкретной shipment group в RFQ нужен не просто `corridor_id`, а `назначенный маршрут`.

Он должен поддерживать 2 режима:

- `template`
- `adhoc`

И обязательно хранить snapshot полей на момент выбора, чтобы дальнейшие изменения в шаблоне не ломали исторический RFQ.

## 7. Рекомендуемая целевая модель

### 7.1. Рекомендуемый пользовательский поток

Целевой поток:

1. Пользователь создает `shipment groups` в RFQ.
2. Для каждой группы система предлагает подходящие route templates.
3. Пользователь:
   - либо выбирает типовой template;
   - либо создает adhoc route вручную.
4. Если adhoc route удачный и повторяемый, пользователь может:
   - сохранить его как новый template.
5. В сценарий попадает выбранный маршрут группы.
6. Экономика считается уже по назначенным маршрутам.
7. После финализации и исполнения накапливаются usage events.

### 7.2. Почему это лучше текущего состояния

Эта модель дает:

- сохранение реальных практик доставки;
- повторное использование удачных схем;
- аналитику по частоте использования;
- аналитику по успешности маршрутов;
- контролируемый переход от ручной логистики к накоплению знаний.

## 8. Рекомендуемая техническая реализация

### 8.1. Базовый принцип

Не привязывать `rfq_shipment_groups` напрямую только к `corridor_id`.

Правильнее:

- оставить `corridor` как справочник;
- route template сделать основной reuse-объект;
- для RFQ-группы хранить отдельную сущность назначения маршрута.

### 8.2. Предпочтительный вариант структуры

Рекомендуемый вариант:

ввести отдельную таблицу вида:

- `rfq_shipment_group_routes`

Примерный смысл полей:

- `id`
- `shipment_group_id`
- `route_source_type` = `template | adhoc`
- `route_template_id`
- `corridor_id`
- `route_name_snapshot`
- `pricing_model_snapshot`
- `currency_snapshot`
- `fixed_cost_snapshot`
- `rate_per_kg_snapshot`
- `rate_per_cbm_snapshot`
- `min_cost_snapshot`
- `markup_pct_snapshot`
- `markup_fixed_snapshot`
- `eta_min_days_snapshot`
- `eta_max_days_snapshot`
- `incoterms_baseline_snapshot`
- `route_payload_json`
- `selected_for_scenario`
- `calc_status`
- `logistics_amount_calc`
- `warning_json`
- `created_by_user_id`
- `updated_by_user_id`
- `created_at`
- `updated_at`

### 8.3. Почему лучше отдельная таблица, а не новые поля в `rfq_shipment_groups`

Потому что отдельная таблица позволяет:

- держать несколько candidate routes на одну группу;
- сравнивать template vs adhoc;
- явно помечать выбранный вариант;
- строить аналитику без перегрузки `rfq_shipment_groups`;
- сохранить уже задуманный `GroupRoutesPanel` почти без смены концепции.

### 8.4. Как сохранить adhoc как шаблон

Нужен отдельный action:

- `Сохранить как шаблон`

Он должен:

1. взять adhoc route;
2. проверить наличие `corridor_id`;
3. создать запись в `logistics_route_templates`;
4. сохранить автора и note;
5. при желании сразу перепривязать группу на этот newly created template или оставить adhoc.

## 9. Бизнес-аналитика, которую надо поддержать

### 9.1. Что именно хочется анализировать

Нужны ответы на вопросы:

- какими route templates пользуемся чаще всего;
- какие коридоры используются чаще;
- для каких стран / транспортов / Incoterms какой шаблон типовой;
- какие adhoc routes постоянно повторяются и уже должны стать шаблоном;
- какие шаблоны чаще попадают в финальный выбор;
- какие шаблоны чаще дают задержки или сбои;
- какие шаблоны чаще приводят к успешному исполнению.

### 9.2. Что для этого уже есть

Под такую аналитику уже подходит:

- `logistics_route_usage_events`

Его нужно не выкидывать, а начать реально заполнять.

## 10. Рекомендуемый план реализации

### Этап 1. Зафиксировать целевую модель данных

Нужно:

- признать `rfq_shipment_groups` текущим рабочим ядром;
- признать `shipment_groups` legacy-слоем;
- ввести новую связующую таблицу для маршрутов групп;
- не ломать действующую логику логистики RFQ.

### Этап 2. Довести backend для group routes

Нужно:

- CRUD для маршрутов группы;
- assign template route;
- create adhoc route;
- save adhoc as template;
- mark selected route for scenario;
- recalc logistics cost by selected route;
- логирование usage events.

### Этап 3. Подключить UI поверх текущей логистики

Вариант внедрения:

1. оставить текущую вкладку `Логистика` как экран группировки;
2. добавить следующий блок:
   - `Маршруты группы`
3. внутри него:
   - рекомендованные шаблоны;
   - все шаблоны;
   - adhoc route;
   - `сохранить как шаблон`;
   - `в сценарий`.

### Этап 4. Довести экономику

Экономика должна считать freight не только из ручных полей группы, а из:

- выбранного group route;
- snapshot его pricing model;
- веса / объема группы;
- duty basis.

### Этап 5. Довести аналитику

Отдельно нужны:

- stats по corridors;
- stats по route templates;
- top used templates;
- adhoc routes worth templating;
- success / failure / ETA quality.

## 11. Предварительные SQL-изменения

Ниже не финальный migration pack, а предварительный draft SQL, который логически соответствует целевой модели.

```sql
CREATE TABLE rfq_shipment_group_routes (
  id BIGINT NOT NULL AUTO_INCREMENT,
  shipment_group_id BIGINT NOT NULL,
  route_source_type ENUM('template','adhoc') NOT NULL DEFAULT 'template',
  route_template_id INT NULL,
  corridor_id INT NULL,
  route_name_snapshot VARCHAR(255) NULL,
  pricing_model_snapshot ENUM('fixed','per_kg','per_cbm','per_kg_or_cbm_max','hybrid') NULL,
  currency_snapshot CHAR(3) NULL,
  fixed_cost_snapshot DECIMAL(18,4) NULL,
  rate_per_kg_snapshot DECIMAL(18,6) NULL,
  rate_per_cbm_snapshot DECIMAL(18,6) NULL,
  min_cost_snapshot DECIMAL(18,4) NULL,
  markup_pct_snapshot DECIMAL(9,4) NULL,
  markup_fixed_snapshot DECIMAL(18,4) NULL,
  eta_min_days_snapshot INT NULL,
  eta_max_days_snapshot INT NULL,
  incoterms_baseline_snapshot VARCHAR(16) NULL,
  route_payload_json JSON NULL,
  logistics_amount_calc DECIMAL(18,4) NULL,
  calc_status ENUM('draft','ok','warning','error') NOT NULL DEFAULT 'draft',
  warning_json JSON NULL,
  selected_for_scenario TINYINT(1) NOT NULL DEFAULT 0,
  created_by_user_id INT NULL,
  updated_by_user_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rsgr_group (shipment_group_id),
  KEY idx_rsgr_template (route_template_id),
  KEY idx_rsgr_corridor (corridor_id),
  KEY idx_rsgr_selected (selected_for_scenario),
  CONSTRAINT fk_rsgr_group FOREIGN KEY (shipment_group_id) REFERENCES rfq_shipment_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_rsgr_template FOREIGN KEY (route_template_id) REFERENCES logistics_route_templates(id) ON DELETE SET NULL,
  CONSTRAINT fk_rsgr_corridor FOREIGN KEY (corridor_id) REFERENCES logistics_corridors(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_rsgr_group_selected
  ON rfq_shipment_group_routes (shipment_group_id, selected_for_scenario);
```

Комментарий:

- этот unique index в чистом виде может потребовать отдельной техники, если MySQL-версия не позволяет удобную частичную уникальность;
- при необходимости вместо него лучше делать бизнес-проверку в backend и хранить только один `selected_for_scenario = 1` на группу.

## 12. Рекомендация по следующему шагу

Следующий разумный шаг:

1. согласовать target data model;
2. подготовить финальный SQL migration pack;
3. только после применения SQL пользователем идти в backend и frontend.

То есть сейчас правильный порядок такой:

- не чинить UI вслепую;
- сначала зафиксировать схему данных и жизненный цикл маршрута группы.

## 13. Что важно помнить дальше

### 13.1. Что не стоит ломать

Не стоит выкидывать:

- `logistics_corridors`
- `logistics_route_templates`
- `logistics_route_usage_events`

Это не мусор, а правильный фундамент для зрелой модели.

### 13.2. Что выглядит legacy

На текущий момент как legacy-кандидат выглядит:

- `shipment_groups`

Его надо не удалять сразу, а отдельно проверить на реальное использование в коде и данных.

### 13.3. Главный архитектурный принцип

`Shipment group` и `route template` — это не одно и то же.

Правильная модель:

- группа = объект консолидации строк сценария;
- маршрут = способ доставить эту группу;
- шаблон маршрута = переиспользуемый эталон;
- коридор = верхнеуровневый справочник направления.
