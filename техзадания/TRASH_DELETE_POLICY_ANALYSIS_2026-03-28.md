# Концепция корзины и политика удаления сущностей

Дата: 2026-03-28

Статус: аналитический документ, без изменений в коде и БД

Цель документа:

- зафиксировать, как должна строиться корзина в системе
- разделить сценарии `удалить`, `архивировать`, `удалить связь`, `запретить удаление`
- не упустить сценарии, где сущность участвует в незавершенном бизнес-процессе
- подготовить основу для дальнейшего backend/frontend refactor и DB design

---

## 1. Ключевой вывод

В проекте нельзя делать одну универсальную корзину для всех сущностей.

По текущему коду и БД есть минимум 4 класса удаления:

1. простое удаление карточки или справочной записи
2. удаление агрегата с дочерними сущностями
3. удаление связи между сущностями
4. удаление, которое должно быть запрещено, если объект участвует в активном процессе

Следовательно, на уровне продукта должны существовать 4 разных режима:

- `trash` — удаление в корзину с возможностью восстановления
- `archive_only` — скрытие из активной работы без физического удаления
- `relation_delete` — удаление только связи, а не объекта
- `forbidden` — удаление запрещено, пока не завершены определенные действия

---

## 2. Что есть сейчас

Сейчас в проекте есть аудит удаления, но нет полноценной корзины:

- delete-операции пишут записи в `activity_logs`
- frontend показывает удаленные записи через историю, а не через real trash storage
- `activity_logs` в большинстве случаев не содержит полноценного snapshot удаляемой сущности

Это значит:

- текущая история удаления пригодна для аудита
- текущая история удаления непригодна как источник восстановления

Следовательно, будущая корзина не должна строиться поверх `activity_logs`.

---

## 3. Базовые пользовательские режимы

### 3.1. Удалить в корзину

Поведение:

- объект исчезает из обычных списков
- объект может быть восстановлен
- связанные зависимые данные могут быть скрыты вместе с ним

Когда применять:

- карточки клиентов и поставщиков при отсутствии активных процессов
- контакты, адреса, реквизиты
- единицы оборудования
- локальные справочники и части каталога

### 3.2. Архивировать

Поведение:

- объект больше не участвует в активной работе
- объект остается в системе, в истории и отчетности
- на него продолжают ссылаться завершенные процессы

Когда применять:

- активные или исторически значимые процессные сущности
- поставщики и клиенты с завершенной или частично активной историей
- каталожные сущности, которые больше не должны использоваться в новых операциях

### 3.3. Удалить связь

Поведение:

- объект не удаляется
- удаляется только связь объекта с другой сущностью
- восстановление возвращает именно связь

Когда применять:

- OEM деталь -> модель
- supplier part -> OEM
- supplier part -> standard part
- строки BOM
- альтернативы
- links внутри bundle

### 3.4. Удаление запрещено

Поведение:

- пользователь получает объяснение, почему удаление невозможно
- система предлагает допустимую альтернативу

Когда применять:

- объект участвует в незавершенном бизнес-процессе
- по объекту уже есть документооборот или зафиксированная история
- объект является структурной системной сущностью

---

## 4. Обязательный pre-delete preview

Перед подтверждением удаления система должна строить preview и показывать пользователю:

1. что именно удаляется
2. какие дочерние данные будут затронуты
3. какие связи будут затронуты
4. есть ли блокирующие активные процессы
5. что будет доступно после проверки:
   - удалить в корзину
   - архивировать
   - удалить только связь
   - удалить нельзя
6. можно ли будет восстановить объект

Preview должен быть бизнес-ориентированным, а не SQL-ориентированным.

Пользователь должен видеть:

- названия сущностей
- счетчики зависимостей
- понятные причины блокировки
- ожидаемый результат действия

---

## 5. Карта сущностей и политика удаления

## 5.1. Семейство клиентов

Сущности:

- `clients`
- `client_contacts`
- `client_billing_addresses`
- `client_shipping_addresses`
- `client_bank_details`
- `client_equipment_units`

Рекомендуемый режим:

- `client_contacts`: `trash`
- `client_billing_addresses`: `trash`
- `client_shipping_addresses`: `trash`
- `client_bank_details`: `trash`
- `client_equipment_units`: `trash`
- `clients`: `trash_with_checks`, а при активных процессах `archive_only`

Что считать зависимостями клиента:

- контакты
- адреса
- банковские реквизиты
- единицы оборудования
- заявки клиента
- RFQ, созданные из заявок клиента
- downstream-коммерческие и закупочные данные

Когда удаление клиента запрещать:

- есть активные `client_requests`
- есть активные `rfqs`
- есть незавершенные коммерческие или закупочные документы

Когда разрешать клиенту корзину:

- у клиента нет активных процессов
- клиент является master-data карточкой без живой процессной нагрузки

Когда переводить в архив вместо корзины:

- клиент уже используется в исторических процессах
- клиент нужен для сохранения понятной истории и ссылочной целостности

Что показывать в preview для клиента:

- количество контактов
- количество адресов
- количество банковских записей
- количество единиц оборудования
- количество заявок
- количество активных RFQ
- итоговый режим: `trash`, `archive_only`, `forbidden`

Восстановление:

- при корзине клиент восстанавливается вместе с простыми дочерними сущностями, удаленными в составе того же действия
- при архиве используется операция `снять архив`, а не restore from trash

---

## 5.2. Семейство поставщиков

Сущности:

- `part_suppliers`
- `supplier_contacts`
- `supplier_addresses`
- `supplier_bank_details`
- `supplier_parts`
- `supplier_price_lists`

Рекомендуемый режим:

- `supplier_contacts`: `trash`
- `supplier_addresses`: `trash`
- `supplier_bank_details`: `trash`
- `supplier_parts`: `trash_with_checks`
- `supplier_price_lists`: `trash_with_checks`
- `part_suppliers`: по умолчанию `archive_only`, корзина только при отсутствии активного процесса

Что считать зависимостями поставщика:

- контакты
- адреса
- реквизиты
- supplier parts
- прайс-листы
- участие в RFQ
- supplier responses
- supplier purchase orders
- supplier quality events

Когда удаление поставщика запрещать:

- поставщик участвует в активном RFQ
- есть supplier responses
- есть supplier purchase orders
- есть quality events

Когда разрешать корзину:

- поставщик является справочной карточкой и не участвует в живом процессе

Когда архивировать вместо корзины:

- поставщик имеет историческую бизнес-нагрузку
- на поставщика продолжают ссылаться завершенные документы

Preview:

- количество supplier parts
- количество прайс-листов
- наличие активных RFQ
- наличие активных PO
- наличие quality events
- итоговый режим: `trash`, `archive_only`, `forbidden`

Восстановление:

- из корзины поставщик восстанавливается вместе с простыми дочерними карточками
- supplier parts и price lists восстанавливаются, если были частью того же snapshot

---

## 5.3. Единицы оборудования клиента

Сущности:

- `client_equipment_units`
- machine-specific overrides и material overrides, если они существуют как следствие unit-уровня

Рекомендуемый режим:

- `client_equipment_units`: `trash`

Что считать зависимостями:

- unit-specific overrides
- machine-specific material data

Когда запрещать:

- если текущий незавершенный процесс прямо зависит от этой единицы оборудования и удаление нарушает workflow

Preview:

- какая единица оборудования будет скрыта
- сколько локальных overrides будет затронуто

Восстановление:

- единица оборудования восстанавливается вместе с локальными зависимостями, если они удалялись одним действием

---

## 5.4. OEM каталог

Сущности:

- `oem_parts`
- `oem_part_model_fitments`
- `oem_part_model_bom`
- `oem_part_materials`
- `oem_part_material_specs`
- `oem_part_documents`
- `oem_part_alt_groups`
- `oem_part_alt_items`
- `oem_part_standard_parts`
- unit overrides, связанные с OEM

Рекомендуемый режим:

- `oem_parts`: `trash_with_checks` или `archive_only`
- `oem_part_model_fitments`: `relation_delete`
- BOM строки: `relation_delete`
- OEM alt / links: `relation_delete` или `trash_light`
- документы OEM: `trash`

Ключевой UX-принцип:

- `Удалить OEM деталь целиком`
- `Убрать OEM деталь из модели`

Это должны быть разные действия.

Что считать зависимостями OEM детали:

- fitments по моделям
- BOM родитель/ребенок
- документы
- материалы
- alternative groups/items
- standard links
- supplier links
- участие в client request / RFQ / selection / response / quality flow

Когда запрещать полное удаление:

- есть активное использование в незавершенных RFQ
- есть участие в selection / response line / downstream quality flow
- есть активные связанные процессы, где деталь является частью рабочего графа

Когда разрешать только relation delete:

- пользователь хочет убрать деталь только из одной модели
- сама OEM деталь должна остаться в каталоге

Когда архивировать:

- деталь больше не должна использоваться в новых операциях
- но нужна для исторических ссылок и сохранения каталожной истории

Preview для полного удаления:

- количество моделей
- количество BOM связей
- количество документов
- количество альтернатив
- количество standard links
- количество supplier links
- наличие активных процессов
- итоговый режим

Preview для relation delete:

- будет удалена только связь OEM -> модель
- сама OEM деталь останется
- будут удалены только model-specific overrides, связанные с этой моделью

Восстановление:

- для relation delete возвращается fitment и его локальные зависимости
- для trash возвращается вся OEM сущность и snapshot-зависимости, попавшие в корзину

---

## 5.5. Standard parts

Сущности:

- `standard_parts`
- `standard_part_values`
- `standard_part_classes`
- `standard_part_class_fields`
- `standard_part_field_options`

Рекомендуемый режим:

- `standard_parts`: `trash_with_checks` или `archive_only`
- `standard_part_classes`: не корзина, а `deactivate/hide`
- поля и опции классификатора: не пользовательская корзина, а controlled admin changes

Что считать зависимостями standard part:

- catalog values
- supplier links
- OEM links
- участие в request/RFQ/selection/response

Когда запрещать удаление standard part:

- есть активное использование в незавершенном процессе

Когда архивировать:

- part больше не нужна для новых операций, но должна сохраниться в истории

Почему не делать обычную корзину для классов:

- это структурные элементы классификатора
- удаление класса или поля меняет поведение каталога целиком

Preview:

- где используется standard part
- сколько значений и ссылок есть
- есть ли активный процесс
- можно ли только деактивировать

---

## 5.6. Supplier parts и supplier links

Сущности:

- `supplier_parts`
- `supplier_part_oem_parts`
- `supplier_part_standard_parts`
- `supplier_part_materials`
- `supplier_part_prices`

Рекомендуемый режим:

- `supplier_parts`: `trash_with_checks`
- `supplier_part_oem_parts`: `relation_delete`
- `supplier_part_standard_parts`: `relation_delete`
- `supplier_part_materials`: `relation_delete` или `trash_light`
- `supplier_part_prices`: локальное удаление записи истории, не root-trash

Что считать зависимостями:

- OEM links
- standard links
- prices
- участие в active RFQ responses
- участие в selections

Когда запрещать:

- supplier part участвует в активном RFQ / response / selection

Preview:

- сколько OEM links
- сколько standard links
- сколько price records
- где есть активное использование

Восстановление:

- links восстанавливаются как связи
- supplier part восстанавливается как карточка плюс snapshot связанных данных, если они удалялись вместе

---

## 5.7. BOM, alternatives, bundles

Сущности:

- `oem_part_model_bom`
- `oem_part_alt_groups`
- `oem_part_alt_items`
- `supplier_bundles`
- `supplier_bundle_items`
- `supplier_bundle_item_links`

Рекомендуемый режим:

- BOM row: `relation_delete`
- alt item / alt group: `relation_delete` или `trash_light`
- bundle: `trash_with_checks`
- bundle item: `relation_delete`
- bundle item link: `relation_delete`

Что показывать:

- это локальное удаление структуры
- родительский объект
- контекст связи
- количество зависимых link-объектов

Восстановление:

- строго локальное
- без попытки восстанавливать весь каталог

---

## 5.8. Client requests

Сущности:

- `client_requests`
- `client_request_revisions`
- `client_request_revision_items`
- `client_request_revision_item_components`
- downstream aggregate, который уходит в RFQ и дальше

Рекомендуемый режим:

- `draft client_request`: `trash`
- после перехода в рабочий процесс: `archive_only`, `cancel`, `close`

Когда удаление запрещать:

- уже существует RFQ
- есть responses, scorecards, selections
- есть коммерческие документы
- есть закупочные документы

Preview:

- если draft: сколько ревизий и позиций будет скрыто
- если не draft: удаление запрещено, доступна только бизнес-операция (`cancel`, `close`, `archive`)

Восстановление:

- только для раннего draft-сценария
- для активных и исторических заявок restore from trash не является основным режимом

---

## 5.9. RFQ

Сущности:

- `rfqs`
- `rfq_items`
- `rfq_suppliers`
- `rfq_supplier_responses`
- `rfq_response_revisions`
- `rfq_response_lines`
- `rfq_supplier_scorecards`
- `selections`
- `shipment_groups`
- `economics` и snapshot tables

Рекомендуемый режим:

- `draft RFQ`: `trash`
- отправленный или рабочий RFQ: `archive_only`, `cancel`, `close`

Когда удаление запрещать:

- RFQ был отправлен
- есть supplier responses
- есть selections
- есть scorecards
- есть downstream quotes / PO effects

Preview:

- число suppliers
- число response chains
- число selection records
- число scorecards
- число shipment/economics records
- итог: `trash`, `archive_only`, `forbidden`

Восстановление:

- только для раннего draft RFQ
- sent/responded RFQ лучше не восстанавливать через пользовательскую корзину

---

## 5.10. Supplier responses

Сущности:

- `rfq_supplier_responses`
- `rfq_response_revisions`
- `rfq_response_lines`

Рекомендуемый режим:

- не основная корзина
- использовать бизнес-статусы и архивирование

Причина:

- responses являются частью хронологии взаимодействия с поставщиком
- в UI уже есть понятие archived на workspace-уровне, но это не корзина

Рекомендуемые действия:

- `archive`
- `supersede`
- `hide from active workspace`

Удаление пользователю:

- как правило не давать

---

## 5.11. Quotes, contracts, purchase orders, quality events

Сущности:

- `sales_quotes`
- `client_contracts`
- `supplier_purchase_orders`
- `supplier_quality_events`

Рекомендуемый режим:

- не корзина
- только бизнес-операции:
  - `cancel`
  - `void`
  - `close`
  - `archive`
  - `supersede`

Почему:

- это документы процесса
- удаление ломает историю и аудит

---

## 5.12. Системные и структурные сущности

Сущности:

- `users`
- `roles`
- `tabs`
- `capabilities`
- `equipment_manufacturers`
- `equipment_models`
- `standard_part_classes`
- системные корни классификаторов

Рекомендуемый режим:

- не пользовательская корзина
- `deactivate`
- `hide from selectors`
- `admin-only controlled delete`

Почему:

- это структурные сущности системы
- их удаление меняет общую архитектуру поведения

---

## 6. Правила запрета удаления

Удаление должно быть запрещено, если выполняется хотя бы одно из условий:

1. сущность участвует в незавершенном бизнес-процессе
2. по сущности уже создан документ, который должен остаться в истории
3. удаление разрушает важную цепочку аудита
4. объект является системной структурной сущностью
5. восстановление после удаления будет неоднозначным или потенциально разрушительным

Практическое правило:

- если для безопасного восстановления нужно восстанавливать длинный процессный агрегат, такую сущность лучше не удалять в корзину, а архивировать

---

## 7. Что должен видеть пользователь

Перед подтверждением действия интерфейс должен показывать 4 блока:

### 7.1. Что будет затронуто

- дочерние записи
- связи
- документы
- локальные настройки

### 7.2. Что не будет затронуто

- процессы и документы, которые останутся в системе
- объекты, которые не затрагиваются данным действием

### 7.3. Ограничения

- активные процессы
- блокирующие причины
- альтернативное допустимое действие

### 7.4. Что будет дальше

- можно ли восстановить
- срок хранения в корзине
- кто может удалить навсегда

---

## 8. Требования к будущему backend API

Перед любым delete-действием нужен preview endpoint / сервисный метод.

Концептуально ответ preview должен содержать:

- `entity_type`
- `entity_id`
- `entity_title`
- `mode`
- `affected_counts`
- `affected_relations`
- `active_processes`
- `blocking_reasons`
- `allowed_actions`
- `restore_scope`

Пример mode:

- `trash`
- `archive_only`
- `relation_delete`
- `forbidden`

---

## 9. Требования к будущему trash storage

Корзина должна храниться отдельно от `activity_logs`.

Причины:

- `activity_logs` является аудитом, а не snapshot storage
- в большинстве delete-операций там нет полного old-state

Будущая корзина должна хранить:

- тип сущности
- идентификатор сущности
- тип удаления
- заголовок/название
- snapshot удаляемой сущности
- snapshot зависимостей, попавших в корзину в рамках этого действия
- кто удалил
- когда удалил
- когда можно purgе-ить окончательно
- статус восстановления

---

## 10. Рекомендуемая матрица режимов

### `trash`

- client contacts
- client billing addresses
- client shipping addresses
- client bank details
- supplier contacts
- supplier addresses
- supplier bank details
- client equipment units
- OEM documents

### `trash_with_checks`

- clients
- part suppliers
- supplier parts
- supplier price lists
- OEM parts
- standard parts
- bundles

### `relation_delete`

- OEM -> model fitment
- supplier part -> OEM
- supplier part -> standard part
- BOM rows
- alternative items
- bundle links
- bundle items

### `archive_only / cancel / close`

- client requests
- RFQ
- supplier responses
- sales quotes
- contracts
- purchase orders
- quality events

### `deactivate / admin-only`

- users
- roles
- tabs
- capabilities
- equipment manufacturers
- equipment models
- classifier roots

---

## 11. Порядок внедрения

Рекомендуемый этапный план:

### Этап 1. Политика и классификация

- утвердить policy matrix по сущностям
- утвердить, какие сущности являются root aggregate
- утвердить правила запрета удаления

### Этап 2. Preview API

- сделать серверную логику impact analysis
- научить backend возвращать пользователю delete preview

### Этап 3. MVP корзины для безопасных сущностей

Стартовать с:

- contacts
- addresses
- bank details
- client equipment units
- OEM documents

Потом добавить:

- clients
- part suppliers

### Этап 4. relation delete UX

- отделить удаление сущности от удаления связи
- особенно для OEM fitment и supplier links

### Этап 5. archive model для process entities

- client requests
- RFQ
- supplier responses
- quotes / contracts / PO / quality

### Этап 6. refactor delete logic

- вынести delete/preview/restore в сервисный слой
- убрать размазанную ad hoc delete-логику по роутам

---

## 12. Что нельзя делать

Не рекомендуется:

- строить корзину поверх `activity_logs`
- делать одну кнопку `Удалить` с одинаковым смыслом для всех сущностей
- разрешать пользователю удалять process entities после входа в живой workflow
- смешивать `archived` и `deleted` в одно понятие
- восстанавливать process aggregate без отдельной доменной логики

---

## 13. Следующий рабочий артефакт

Следующий полезный документ после этого анализа:

- `TRASH_PREVIEW_AND_RULES_SPEC_2026-03-28.md`

В нем можно уже зафиксировать:

- точные preview-сценарии по каждой сущности
- допустимые кнопки и тексты модалок
- будущие backend contract-ответы
- draft схемы таблиц корзины

