# SQL draft новой схемы и матрица переноса полей

## 1. Назначение документа

Это не финальная миграция для немедленного запуска в production.

Это:

- инженерный черновик новой схемы;
- основа для обсуждения структуры таблиц;
- матрица переноса полей;
- способ заранее увидеть, где будет автоматическая миграция, а где нужен ручной или полуавтоматический reclassification.

Главный принцип:

- новые таблицы сначала создаются рядом со старыми;
- старые OEM/equipment/process tables не ломаются;
- migration идет по слоям;
- переключение UI и backend происходит постепенно.

---

## 2. SQL draft: taxonomy layer

```sql
CREATE TABLE reference_taxonomies (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reference_taxonomies_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reference_taxonomy_nodes (
  id INT NOT NULL AUTO_INCREMENT,
  taxonomy_id INT NOT NULL,
  parent_id INT NULL,
  code VARCHAR(100) NULL,
  name VARCHAR(255) NOT NULL,
  node_type VARCHAR(50) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reference_taxonomy_nodes_taxonomy (taxonomy_id, sort_order, name),
  KEY idx_reference_taxonomy_nodes_parent (parent_id),
  CONSTRAINT fk_reference_taxonomy_nodes_taxonomy
    FOREIGN KEY (taxonomy_id) REFERENCES reference_taxonomies (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reference_taxonomy_nodes_parent
    FOREIGN KEY (parent_id) REFERENCES reference_taxonomy_nodes (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reference_entity_taxonomy_links (
  reference_entity_id INT NOT NULL,
  taxonomy_node_id INT NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (reference_entity_id, taxonomy_node_id),
  KEY idx_reference_entity_taxonomy_links_node (taxonomy_node_id, reference_entity_id),
  CONSTRAINT fk_reference_entity_taxonomy_links_entity
    FOREIGN KEY (reference_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reference_entity_taxonomy_links_node
    FOREIGN KEY (taxonomy_node_id) REFERENCES reference_taxonomy_nodes (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Комментарий:

- `node_type` сохраняем, потому что в текущем equipment classifier он уже используется;
- это поможет безболезненно перенести старую логику.

---

## 3. SQL draft: entity type engine

```sql
CREATE TABLE reference_entity_types (
  id INT NOT NULL AUTO_INCREMENT,
  parent_id INT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  base_kind VARCHAR(50) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reference_entity_types_code (code),
  KEY idx_reference_entity_types_parent (parent_id),
  CONSTRAINT fk_reference_entity_types_parent
    FOREIGN KEY (parent_id) REFERENCES reference_entity_types (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reference_entity_type_fields (
  id INT NOT NULL AUTO_INCREMENT,
  entity_type_id INT NOT NULL,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  field_type VARCHAR(50) NOT NULL,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  is_in_title TINYINT(1) NOT NULL DEFAULT 0,
  is_in_list TINYINT(1) NOT NULL DEFAULT 0,
  is_in_filters TINYINT(1) NOT NULL DEFAULT 0,
  is_searchable TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  unit VARCHAR(50) NULL,
  placeholder VARCHAR(255) NULL,
  help_text TEXT NULL,
  default_value TEXT NULL,
  settings_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reference_entity_type_fields_type_code (entity_type_id, code),
  KEY idx_reference_entity_type_fields_type (entity_type_id, sort_order),
  CONSTRAINT fk_reference_entity_type_fields_type
    FOREIGN KEY (entity_type_id) REFERENCES reference_entity_types (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reference_entity_type_field_options (
  id INT NOT NULL AUTO_INCREMENT,
  field_id INT NOT NULL,
  value_code VARCHAR(100) NULL,
  value_label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_reference_entity_type_field_options_field (field_id, sort_order),
  CONSTRAINT fk_reference_entity_type_field_options_field
    FOREIGN KEY (field_id) REFERENCES reference_entity_type_fields (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Комментарий:

- `base_kind` нужен, чтобы различать семантику типа:
  - `equipment_model`
  - `assembly`
  - `part`
  - `standard_item`
  - `material`
  - `supplier_capability`

Это позволит строить разные UI-режимы без хардкода по конкретным названиям классов.

---

## 4. SQL draft: canonical entities

```sql
CREATE TABLE reference_entities (
  id INT NOT NULL AUTO_INCREMENT,
  entity_type_id INT NOT NULL,
  canonical_name VARCHAR(255) NOT NULL,
  canonical_name_norm VARCHAR(255) GENERATED ALWAYS AS (
    UPPER(REPLACE(REPLACE(REPLACE(TRIM(canonical_name), ' ', ''), '-', ''), '.', ''))
  ) STORED,
  designation VARCHAR(255) NULL,
  status ENUM(
    'draft',
    'partially_classified',
    'canonicalized',
    'supplier_ready',
    'archived'
  ) NOT NULL DEFAULT 'draft',
  description_ru TEXT NULL,
  description_en TEXT NULL,
  notes TEXT NULL,
  search_text MEDIUMTEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  source_standard_part_id INT NULL,
  source_equipment_model_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reference_entities_type (entity_type_id, is_active, canonical_name),
  KEY idx_reference_entities_status (status, is_active),
  KEY idx_reference_entities_source_standard (source_standard_part_id),
  KEY idx_reference_entities_source_equipment (source_equipment_model_id),
  CONSTRAINT fk_reference_entities_type
    FOREIGN KEY (entity_type_id) REFERENCES reference_entity_types (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reference_entity_values (
  reference_entity_id INT NOT NULL,
  field_id INT NOT NULL,
  value_text TEXT NULL,
  value_number DECIMAL(18,6) NULL,
  value_boolean TINYINT(1) NULL,
  value_date DATE NULL,
  value_json JSON NULL,
  PRIMARY KEY (reference_entity_id, field_id),
  KEY idx_reference_entity_values_field (field_id, reference_entity_id),
  CONSTRAINT fk_reference_entity_values_entity
    FOREIGN KEY (reference_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reference_entity_values_field
    FOREIGN KEY (field_id) REFERENCES reference_entity_type_fields (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Комментарий:

- `source_standard_part_id` и `source_equipment_model_id` нужны только как transitional fields;
- потом их можно убрать, когда миграция завершится.

---

## 5. SQL draft: relation layer

```sql
CREATE TABLE reference_relation_types (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  inverse_code VARCHAR(100) NULL,
  is_directed TINYINT(1) NOT NULL DEFAULT 1,
  description TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reference_relation_types_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reference_entity_relations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  left_entity_id INT NOT NULL,
  relation_type_id INT NOT NULL,
  right_entity_id INT NOT NULL,
  source_context VARCHAR(50) NULL,
  source_record_id INT NULL,
  note VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reference_entity_relations_unique (
    left_entity_id,
    relation_type_id,
    right_entity_id,
    source_context,
    source_record_id
  ),
  KEY idx_reference_entity_relations_left (left_entity_id, relation_type_id),
  KEY idx_reference_entity_relations_right (right_entity_id, relation_type_id),
  CONSTRAINT fk_reference_entity_relations_left
    FOREIGN KEY (left_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reference_entity_relations_right
    FOREIGN KEY (right_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reference_entity_relations_type
    FOREIGN KEY (relation_type_id) REFERENCES reference_relation_types (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Комментарий:

- `source_context` нужен, чтобы relation мог ссылаться на происхождение:
  - `oem_bom`
  - `oem_alt`
  - `manual`
  - `equipment_fitment`
- это позволит не терять provenance.

---

## 6. SQL draft: representation layer

### 6.1. OEM links

```sql
CREATE TABLE reference_entity_oem_links (
  reference_entity_id INT NOT NULL,
  oem_part_id INT NOT NULL,
  representation_role ENUM(
    'exact_oem',
    'oem_variant',
    'oem_legacy'
  ) NOT NULL DEFAULT 'exact_oem',
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (reference_entity_id, oem_part_id),
  KEY idx_reference_entity_oem_links_oem (oem_part_id, reference_entity_id),
  KEY idx_reference_entity_oem_links_primary (reference_entity_id, is_primary),
  CONSTRAINT fk_reference_entity_oem_links_entity
    FOREIGN KEY (reference_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reference_entity_oem_links_oem
    FOREIGN KEY (oem_part_id) REFERENCES oem_parts (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 6.2. Supplier links

```sql
CREATE TABLE reference_entity_supplier_links (
  reference_entity_id INT NOT NULL,
  supplier_part_id INT NOT NULL,
  link_type ENUM(
    'exact_supplier_representation',
    'possible_match',
    'preferred_source'
  ) NOT NULL DEFAULT 'exact_supplier_representation',
  is_preferred TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (reference_entity_id, supplier_part_id),
  KEY idx_reference_entity_supplier_links_supplier (supplier_part_id, reference_entity_id),
  KEY idx_reference_entity_supplier_links_preferred (reference_entity_id, is_preferred),
  CONSTRAINT fk_reference_entity_supplier_links_entity
    FOREIGN KEY (reference_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reference_entity_supplier_links_supplier
    FOREIGN KEY (supplier_part_id) REFERENCES supplier_parts (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 6.3. Internal codes

```sql
CREATE TABLE reference_entity_internal_codes (
  id INT NOT NULL AUTO_INCREMENT,
  reference_entity_id INT NOT NULL,
  code_type ENUM(
    'internal_part_number',
    'internal_part_name',
    'drawing_code',
    'client_code',
    'legacy_code'
  ) NOT NULL,
  code_value VARCHAR(255) NOT NULL,
  note VARCHAR(255) NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reference_entity_internal_codes_unique (reference_entity_id, code_type, code_value),
  KEY idx_reference_entity_internal_codes_entity (reference_entity_id, code_type),
  CONSTRAINT fk_reference_entity_internal_codes_entity
    FOREIGN KEY (reference_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Комментарий:

- часть данных из `oem_part_presentation_profiles` может мигрировать сюда;
- но сам `oem_part_presentation_profiles` пока сохраняется как OEM-side presentation layer.

---

## 7. SQL draft: supplier intelligence

```sql
CREATE TABLE supplier_reference_entity_capabilities (
  supplier_id INT NOT NULL,
  reference_entity_id INT NOT NULL,
  capability_type ENUM(
    'can_supply',
    'specializes_in',
    'preferred_supplier'
  ) NOT NULL DEFAULT 'can_supply',
  confidence_score DECIMAL(5,2) NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (supplier_id, reference_entity_id, capability_type),
  KEY idx_supplier_reference_entity_capabilities_entity (reference_entity_id, capability_type),
  CONSTRAINT fk_supplier_reference_entity_capabilities_entity
    FOREIGN KEY (reference_entity_id) REFERENCES reference_entities (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_supplier_reference_entity_capabilities_supplier
    FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Комментарий:

- это таблица для будущих рекомендаций поставщиков не только по exact part links.

---

## 8. Порядок физического создания таблиц

Правильный порядок создания:

1. `reference_taxonomies`
2. `reference_taxonomy_nodes`
3. `reference_entity_types`
4. `reference_entity_type_fields`
5. `reference_entity_type_field_options`
6. `reference_entities`
7. `reference_entity_values`
8. `reference_relation_types`
9. `reference_entity_relations`
10. `reference_entity_oem_links`
11. `reference_entity_supplier_links`
12. `reference_entity_internal_codes`
13. `supplier_reference_entity_capabilities`
14. `reference_entity_taxonomy_links`

Почему так:

- `reference_entity_taxonomy_links` зависит одновременно от `entities` и `taxonomy_nodes`;
- representation tables зависят от готовых `entities`;
- capabilities зависят от supplier registry и `entities`.

---

## 9. Матрица переноса: standard parts -> new core

### 9.1. `standard_part_classes -> reference_entity_types`

| Старое поле | Новое поле | Правило |
|---|---|---|
| `id` | `legacy_standard_part_class_id` | временно хранить в migration map, не как основной PK |
| `parent_id` | `parent_id` | переносится через mapping old->new ids |
| `code` | `code` | переносится как есть |
| `name` | `name` | переносится как есть |
| `description` | `description` | переносится как есть |
| `sort_order` | `sort_order` | переносится как есть |
| `is_active` | `is_active` | переносится как есть |
| — | `base_kind` | вычисляется, по умолчанию `standard_item` |

### 9.2. `standard_part_class_fields -> reference_entity_type_fields`

| Старое поле | Новое поле | Правило |
|---|---|---|
| `class_id` | `entity_type_id` | через mapping классов |
| `code` | `code` | как есть |
| `label` | `label` | как есть |
| `field_type` | `field_type` | как есть |
| `is_required` | `is_required` | как есть |
| `is_in_title` | `is_in_title` | как есть |
| `is_in_list` | `is_in_list` | как есть |
| `is_in_filters` | `is_in_filters` | как есть |
| `is_searchable` | `is_searchable` | как есть |
| `sort_order` | `sort_order` | как есть |
| `unit` | `unit` | как есть |
| `placeholder` | `placeholder` | как есть |
| `help_text` | `help_text` | как есть |
| `default_value` | `default_value` | как есть |
| `settings_json` | `settings_json` | как есть |

### 9.3. `standard_part_field_options -> reference_entity_type_field_options`

| Старое поле | Новое поле | Правило |
|---|---|---|
| `field_id` | `field_id` | через mapping полей |
| `value` / `code` | `value_code` | как есть |
| `label` | `value_label` | как есть |
| `sort_order` | `sort_order` | как есть |
| `is_active` | `is_active` | как есть |

### 9.4. `standard_parts -> reference_entities`

| Старое поле | Новое поле | Правило |
|---|---|---|
| `class_id` | `entity_type_id` | через mapping class -> entity_type |
| `display_name` | `canonical_name` | как есть |
| `designation` | `designation` | как есть |
| `description_ru` | `description_ru` | как есть |
| `description_en` | `description_en` | как есть |
| `notes` | `notes` | как есть |
| `attributes_search_text` | `search_text` | как есть |
| `is_active` | `is_active` | как есть |
| `id` | `source_standard_part_id` | как transitional source reference |
| — | `status` | по умолчанию `canonicalized` |

### 9.5. `standard_part_values -> reference_entity_values`

| Старое поле | Новое поле | Правило |
|---|---|---|
| `standard_part_id` | `reference_entity_id` | через mapping standard_part -> entity |
| `field_id` | `field_id` | через mapping class_field -> entity_type_field |
| `value_text` | `value_text` | как есть |
| `value_number` | `value_number` | как есть |
| `value_boolean` | `value_boolean` | как есть |
| `value_date` | `value_date` | как есть |
| `value_json` | `value_json` | как есть |

---

## 10. Матрица переноса: equipment classifier -> taxonomy layer

### 10.1. `equipment_classifier_nodes -> reference_taxonomy_nodes`

Сначала создать taxonomy:

- `code = 'equipment_domain'`
- `name = 'Классификатор оборудования'`

Потом переносить узлы.

| Старое поле | Новое поле | Правило |
|---|---|---|
| `id` | `legacy_equipment_classifier_node_id` | хранить во временной mapping table |
| `parent_id` | `parent_id` | через mapping старых id в новые |
| `code` | `code` | как есть |
| `name` | `name` | как есть |
| `node_type` | `node_type` | как есть |
| `sort_order` | `sort_order` | как есть |
| `is_active` | `is_active` | как есть |
| `notes` | `notes` | как есть |
| — | `taxonomy_id` | фиксированное значение taxonomy `equipment_domain` |

### 10.2. `equipment_models -> reference_entities`

Это уже не прямая миграция "таблица-в-таблицу".

Рекомендация:

- не переносить `equipment_models` физически сразу;
- сначала создать для них canonical mirrors как `reference_entities` типа `equipment_model`.

| Старое поле | Новое поле | Правило |
|---|---|---|
| `model_name` | `canonical_name` | как есть |
| `model_code` | часть `designation` или field value | зависит от выбранного типа |
| `notes` | `notes` | как есть |
| `id` | `source_equipment_model_id` | transitional link |
| `classifier_node_id` | `reference_entity_taxonomy_links` | через mapping узлов taxonomy |

---

## 11. Матрица переноса: OEM -> reference links

### 11.1. `oem_part_standard_parts -> reference_entity_oem_links`

Это самый чистый и надежный автоматический мост.

Алгоритм:

1. для каждого `standard_part` уже существует `reference_entity`;
2. берем `oem_part_standard_parts`;
3. создаем строку в `reference_entity_oem_links`.

| Старое поле | Новое поле | Правило |
|---|---|---|
| `standard_part_id` | `reference_entity_id` | через mapping standard_part -> reference_entity |
| `oem_part_id` | `oem_part_id` | как есть |
| `is_primary` | `is_primary` | как есть |
| `note` | `note` | как есть |
| — | `representation_role` | по умолчанию `exact_oem` |

### 11.2. `oem_parts` без standard link

Это уже не чистая автоматическая миграция.

Для них нужен статусный workflow:

- если OEM деталь очевидно стандартная и уже классифицирована, создаем canonical entity;
- если OEM деталь уникальная, создаем entity типа `unique_part`;
- если OEM деталь неясна (`болт`, `втулка`, `кольцо` без параметров), создаем `draft` или `partially_classified`.

Предлагаемый алгоритм:

| Ситуация | Действие |
|---|---|
| есть link в `oem_part_standard_parts` | автоматический перенос |
| описание явно уникальное и equipment/model-specific | создать `unique_part` entity |
| описание слишком общее | создать `draft` entity и пометить `requires enrichment` |
| есть drawing/internal profile | использовать как дополнительный сигнал для canonical entity |

---

## 12. Матрица переноса: OEM groups

### 12.1. `original_part_groups -> reference_taxonomy_nodes`

Создаем отдельную taxonomy:

- `code = 'legacy_oem_groups'`
- `name = 'Legacy OEM группы'`

Зачем не смешивать сразу с основной product taxonomy:

- чтобы не тащить старый мусор прямо в новый основной классификатор;
- сначала groups живут как отдельная legacy taxonomy;
- потом вручную их можно маппить в правильные target categories.

| Старое поле | Новое поле | Правило |
|---|---|---|
| `name` | `name` | как есть |
| `description` | `notes` | как есть |
| `sort_order` | `sort_order` | как есть |
| — | `taxonomy_id` | taxonomy `legacy_oem_groups` |
| — | `code` | можно сгенерировать из `name`, либо оставить null |

### 12.2. `oem_parts.group_id -> reference_entity_taxonomy_links`

Не переносить напрямую в canonical taxonomy.

Рекомендация:

- сначала навесить OEM part -> legacy taxonomy node;
- потом, после разметки, проставлять нормальные product taxonomy links на canonical entities.

---

## 13. Матрица переноса: presentation profiles

### 13.1. `oem_part_presentation_profiles`

Часть данных остается в OEM слое, часть может дублироваться в unified reference.

| Старое поле | Новое место | Правило |
|---|---|---|
| `internal_part_number` | `reference_entity_internal_codes` | `code_type = internal_part_number` |
| `internal_part_name` | `reference_entity_internal_codes` или `notes` | чаще как internal code/name pair |
| `supplier_visible_part_number` | пока оставить в `oem_part_presentation_profiles` | это OEM-side RFQ presentation |
| `supplier_visible_description` | пока оставить в `oem_part_presentation_profiles` | process-facing data |
| `drawing_code` | `reference_entity_internal_codes` | `code_type = drawing_code` |
| `use_by_default_in_supplier_rfq` | оставить в OEM слое | process flag |
| `note` | `notes` / `reference_entity_internal_codes.note` | по ситуации |

Вывод:

- `oem_part_presentation_profiles` нельзя сразу выбросить;
- это не только справочник, но и procurement behavior.

---

## 14. Матрица переноса: supplier links

### 14.1. `supplier_part_oem_parts -> reference_entity_supplier_links`

Если у OEM уже есть canonical entity:

| Старое поле | Новое поле | Правило |
|---|---|---|
| `supplier_part_id` | `supplier_part_id` | как есть |
| `oem_part_id` | `reference_entity_id` | через `reference_entity_oem_links` |
| `is_preferred` | `is_preferred` | как есть |
| `priority_rank` | `note` или будущий ranking field | пока можно сохранить в note / отдельное поле позже |
| — | `link_type` | `exact_supplier_representation` |

Если canonical entity еще нет:

- supplier link остается только на OEM until canonicalization.

### 14.2. Supplier specialization

Это уже новый слой, прямого источника в текущей БД почти нет.

Заполнять нужно:

- вручную;
- полуавтоматически по history exact links;
- потом по поведению закупщиков.

---

## 15. Что мигрировать автоматически, а что нет

### Автоматически

- `standard_part_classes -> reference_entity_types`
- `standard_part_class_fields -> reference_entity_type_fields`
- `standard_part_field_options -> reference_entity_type_field_options`
- `standard_parts -> reference_entities`
- `standard_part_values -> reference_entity_values`
- `equipment_classifier_nodes -> reference_taxonomy_nodes`
- `oem_part_standard_parts -> reference_entity_oem_links`
- `original_part_groups -> legacy taxonomy`

### Полуавтоматически

- `equipment_models -> reference_entities`
- `oem_parts without standard link -> reference_entities`
- `supplier_part_oem_parts -> reference_entity_supplier_links`

### Ручная/экспертная разметка

- переназначение legacy OEM groups в нормальные taxonomy branches;
- классификация неясных OEM деталей;
- supplier specializations;
- relation types beyond simple direct mappings.

---

## 16. Рекомендуемые transitional tables

Чтобы миграция была прозрачной, я бы добавил временные mapping tables.

```sql
CREATE TABLE migration_standard_part_to_reference_entity (
  standard_part_id INT NOT NULL PRIMARY KEY,
  reference_entity_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_migration_standard_part_to_reference_entity_entity (reference_entity_id)
);

CREATE TABLE migration_equipment_classifier_node_to_taxonomy_node (
  equipment_classifier_node_id INT NOT NULL PRIMARY KEY,
  taxonomy_node_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_migration_equipment_classifier_node_to_taxonomy_node_node (taxonomy_node_id)
);

CREATE TABLE migration_oem_part_to_reference_entity (
  oem_part_id INT NOT NULL PRIMARY KEY,
  reference_entity_id INT NOT NULL,
  migration_mode ENUM(
    'from_standard_link',
    'auto_unique_part',
    'draft_unclassified',
    'manual'
  ) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_migration_oem_part_to_reference_entity_entity (reference_entity_id)
);
```

Почему это важно:

- не придется гадать, как старая сущность превратилась в новую;
- можно безопасно делать повторные миграции;
- можно строить отладочные отчеты.

---

## 17. Минимальный SQL-план внедрения

### Phase 1

Создать:

- `reference_entity_types`
- `reference_entity_type_fields`
- `reference_entity_type_field_options`
- `reference_entities`
- `reference_entity_values`
- mapping tables

И выполнить:

- перенос `standard_parts`.

### Phase 2

Создать:

- `reference_taxonomies`
- `reference_taxonomy_nodes`
- `reference_entity_taxonomy_links`

И выполнить:

- перенос `equipment_classifier_nodes`;
- перенос `original_part_groups` в legacy taxonomy.

### Phase 3

Создать:

- `reference_entity_oem_links`
- `reference_entity_internal_codes`

И выполнить:

- автоматический перенос `oem_part_standard_parts`;
- частичный перенос `oem_part_presentation_profiles`.

### Phase 4

Создать:

- `reference_relation_types`
- `reference_entity_relations`
- `reference_entity_supplier_links`
- `supplier_reference_entity_capabilities`

И постепенно:

- canonicalize OEM;
- разворачивать supplier intelligence.

---

## 18. Практический итог

Если делать коротко, то физическая стратегия такая:

1. новый generalized core строится на базе идей `standard_parts`;
2. equipment classifier переносится как taxonomy, а не как entity model;
3. OEM остается operational layer;
4. мост `OEM -> canonical entity` становится центральным элементом миграции;
5. `original_part_groups` не лечатся, а вытесняются;
6. supplier exact links сохраняются, а сверху наращивается capability layer.

Это самый безопасный путь, при котором:

- не ломается текущий RFQ/workspace;
- не теряется OEM BOM и machine-specific logic;
- появляется новый реальный центр системы;
- и фронт можно переделывать постепенно, без резкого большого взрыва.
