# Draft модели данных корзины

Дата: 2026-03-28

Статус: draft для первой реализации foundation

Связанные документы:

- `TRASH_DELETE_POLICY_ANALYSIS_2026-03-28.md`
- `TRASH_PREVIEW_AND_RULES_SPEC_2026-03-28.md`

Цель:

- зафиксировать минимальную модель данных корзины
- определить MVP-границы внедрения
- отделить audit log, archive model и real trash storage

---

## 1. Базовый принцип

Будущая корзина должна хранить не только факт удаления, а восстановимый snapshot.

Нельзя использовать для этого:

- `activity_logs`
- бизнес-статусы `archived`
- случайные backup-таблицы

Нужен отдельный слой данных корзины.

---

## 2. Минимальная модель таблиц

## 2.1. `trash_entries`

Назначение:

- одна запись на одно действие удаления
- хранит root-сущность операции
- хранит общий контекст удаления и восстановления

Предлагаемые поля:

- `id`
- `entity_type`
- `entity_id`
- `root_entity_type`
- `root_entity_id`
- `delete_mode`
- `title`
- `subtitle`
- `snapshot_json`
- `context_json`
- `deleted_by_user_id`
- `deleted_at`
- `purge_after_at`
- `restore_status`
- `restored_at`
- `restored_by_user_id`
- `purged_at`
- `purged_by_user_id`

Смысл:

- `entity_type/entity_id` — основная сущность, которую пользователь считает удаленным объектом
- `root_entity_type/root_entity_id` — полезно для relation-delete и aggregate-delete
- `delete_mode` — `trash`, `relation_delete`, `aggregate_delete`
- `snapshot_json` — основной snapshot root-сущности
- `context_json` — понятный UI/backend контекст

---

## 2.2. `trash_entry_items`

Назначение:

- дочерние сущности и связи, попавшие в корзину в составе одного delete-действия

Предлагаемые поля:

- `id`
- `trash_entry_id`
- `item_type`
- `item_id`
- `item_role`
- `title`
- `snapshot_json`
- `sort_order`

Смысл:

- один root delete может включать много зависимых записей
- эти записи должны восстанавливаться в правильном порядке

Примеры `item_role`:

- `child_record`
- `detached_relation`
- `document`
- `override`
- `fitment`
- `bom_link`

---

## 2.3. Опционально: soft-delete поля в исходных таблицах

Для части сущностей будет полезен не только snapshot storage, но и soft-delete прямо в основной таблице.

Минимальный набор:

- `deleted_at`
- `deleted_by_user_id`

Опционально:

- `delete_reason`
- `trash_entry_id`

Этот подход подходит для:

- clients
- part_suppliers
- client_contacts
- client_billing_addresses
- client_shipping_addresses
- client_bank_details
- client_equipment_units

Но не обязан применяться ко всем сущностям в MVP.

---

## 3. Что хранить в snapshot

## 3.1. Root snapshot

В `snapshot_json` root entry хранить:

- исходную строку сущности
- каноническое отображаемое имя
- тип операции
- список затронутых дочерних типов
- краткий summary для UI

## 3.2. Item snapshots

В `trash_entry_items.snapshot_json` хранить:

- исходную строку дочерней сущности
- минимум полей, нужных для восстановления и preview

## 3.3. Что не хранить

Не надо хранить в snapshot:

- вычисляемые поля, которые можно пересчитать
- тяжелые дубли document blobs
- длинные read-model projection, которые можно собрать заново

---

## 4. MVP-границы внедрения

## 4.1. Что включить в MVP

Первый безопасный MVP:

- clients family
- supplier contacts / addresses / bank details
- client equipment units
- OEM documents
- relation-preview foundation

Причина:

- это объекты с понятной пользовательской семантикой
- здесь проще preview
- здесь меньше риск сломать process flow

## 4.2. Что не включать в первый MVP

- client_requests full trash restore
- RFQ full trash restore
- supplier responses full restore
- process documents

Причина:

- нужен отдельный archive/cancel/close domain flow

---

## 5. Preview и storage связаны, но не одинаковы

Preview может работать и без полного trash storage.

Порядок реализации:

1. сделать preview service
2. утвердить policy matrix
3. ввести trash tables
4. перевести first-wave сущности на реальное удаление в корзину
5. добавить restore

Это значит, что preview foundation можно и нужно реализовывать раньше полного restore-flow.

---

## 6. Решение по relation delete

Для relation-delete можно использовать ту же таблицу `trash_entries`.

Пример:

- `entity_type = oem_part_model_fitments`
- `entity_id = 123`
- `delete_mode = relation_delete`

В `context_json` дополнительно хранить:

- parent entity
- child entity
- human-readable label связи

---

## 7. Решение по archive model

Корзина и архив не должны смешиваться.

Архив:

- может храниться в исходной таблице через статус или `archived_at`
- не обязан создавать `trash_entries`

Trash:

- всегда должен оставлять восстановимый entry

---

## 8. Концептуальные SQL-объекты для первой реализации

Первая миграция foundation может ввести:

- `trash_entries`
- `trash_entry_items`

Без немедленного перевода всех delete-роутов.

Это позволяет:

- начать использовать preview
- постепенно переводить сущности на новую модель

---

## 9. Практическая стратегия реализации

### Шаг 1

Реализовать preview endpoint и service layer.

### Шаг 2

Добавить SQL foundation для `trash_entries` и `trash_entry_items`.

### Шаг 3

Перевести first-wave delete routes на:

- preview
- snapshot create
- soft-delete или physical detach по policy

### Шаг 4

Сделать restore only для first-wave сущностей.

---

## 10. Следующий implementation slice

После этого документа первая практическая реализация должна включать:

- SQL draft migration для trash tables
- backend `trash preview` service
- backend route `/trash/preview/:entityType/:id`
- first-wave support:
  - clients
  - part_suppliers
  - client_equipment_units
  - client child entities
  - supplier child entities
  - client_requests preview-only
  - rfqs preview-only

