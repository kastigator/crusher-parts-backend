const db = require('./db')

const MODE = {
  TRASH: 'trash',
  ARCHIVE_ONLY: 'archive_only',
  RELATION_DELETE: 'relation_delete',
  FORBIDDEN: 'forbidden',
}

const ENTITY_ALIAS = {
  suppliers: 'part_suppliers',
  clients: 'clients',
  client_contacts: 'client_contacts',
  client_billing_addresses: 'client_billing_addresses',
  client_shipping_addresses: 'client_shipping_addresses',
  client_bank_details: 'client_bank_details',
  client_equipment_units: 'client_equipment_units',
  client_request_revision_items: 'client_request_revision_items',
  client_request_revision_item_components: 'client_request_revision_item_components',
  supplier_contacts: 'supplier_contacts',
  supplier_addresses: 'supplier_addresses',
  supplier_bank_details: 'supplier_bank_details',
  supplier_parts: 'supplier_parts',
  supplier_part_materials: 'supplier_part_materials',
  supplier_part_prices: 'supplier_part_prices',
  supplier_price_lists: 'supplier_price_lists',
  supplier_part_catalog_positions: 'supplier_part_catalog_positions',
  client_requests: 'client_requests',
  rfq_item_components: 'rfq_item_components',
  rfq_scenarios: 'rfq_scenarios',
  rfqs: 'rfqs',
  procurement_kpi_targets: 'procurement_kpi_targets',
  sales_kpi_targets: 'sales_kpi_targets',
  equipment_manufacturers: 'equipment_manufacturers',
  equipment_models: 'equipment_models',
  equipment_classifier_nodes: 'equipment_classifier_nodes',
  users: 'users',
  roles: 'roles',
  tabs: 'tabs',
}

const LABELS = {
  clients: 'Клиент',
  client_contacts: 'Контакт клиента',
  client_billing_addresses: 'Юридический адрес клиента',
  client_shipping_addresses: 'Адрес доставки клиента',
  client_bank_details: 'Банковские реквизиты клиента',
  client_equipment_units: 'Единица оборудования клиента',
  client_request_revision_items: 'Позиция заявки',
  client_request_revision_item_components: 'Компонент позиции заявки',
  part_suppliers: 'Поставщик',
  supplier_contacts: 'Контакт поставщика',
  supplier_addresses: 'Адрес поставщика',
  supplier_bank_details: 'Банковские реквизиты поставщика',
  supplier_parts: 'Деталь поставщика',
  supplier_part_materials: 'Материал детали поставщика',
  supplier_part_prices: 'Запись цены детали поставщика',
  supplier_price_lists: 'Прайс-лист поставщика',
  supplier_part_catalog_positions: 'Связь детали поставщика с позицией каталога',
  client_requests: 'Заявка клиента',
  rfq_item_components: 'Компонент RFQ',
  rfq_scenarios: 'Сценарий экономики RFQ',
  rfqs: 'RFQ',
  procurement_kpi_targets: 'Цель закупочного KPI',
  sales_kpi_targets: 'Цель sales KPI',
  equipment_manufacturers: 'Производитель оборудования',
  equipment_models: 'Модель оборудования',
  equipment_model_bom_items: 'Строка BOM модели',
  equipment_model_bom_child_items: 'Дочерняя строка BOM модели',
  equipment_model_bom_descendants: 'Вложенная строка BOM модели',
  equipment_classifier_nodes: 'Узел классификатора оборудования',
  users: 'Пользователь',
  roles: 'Роль',
  tabs: 'Вкладка',
}

const REMOVED_LEGACY_ENTITY_TYPES = new Set([
  'oem_parts',
  'original_part_groups',
  'oem_part_materials',
  'oem_part_material_specs',
  'oem_part_model_bom',
  'oem_part_model_fitments',
  'oem_part_alt_groups',
  'oem_part_alt_items',
  'oem_part_documents',
  'oem_part_presentation_profiles',
  'oem_part_unit_overrides',
  'oem_part_unit_material_overrides',
  'oem_part_unit_material_specs',
  'supplier_bundles',
  'supplier_bundle_items',
  'supplier_bundle_item_links',
])

const assertNotRemovedLegacyEntity = (entityType) => {
  if (!REMOVED_LEGACY_ENTITY_TYPES.has(entityType)) return
  const err = new Error(
    `Старый OEM-контур "${entityType}" удален. Рабочий путь теперь: классификатор → модель → BOM → позиция каталога.`
  )
  err.status = 410
  throw err
}

const ACTIVE_RFQ_STATUSES = new Set(['draft', 'structured', 'sent', 'invited', 'responded'])
const ACTIVE_PURCHASE_ORDER_STATUSES = new Set(['draft', 'sent', 'confirmed'])
const ACTIVE_QUALITY_EVENT_STATUSES = new Set(['open'])
const ACTIVE_CLIENT_REQUEST_STATUSES = new Set([
  'draft',
  'in_progress',
  'released_to_procurement',
  'rfq_created',
  'rfq_sent',
  'responses_received',
  'selection_done',
  'quote_prepared',
])

const toId = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

const countByStatus = (rows, allowed) =>
  rows.reduce((acc, row) => {
    const status = String(row?.status || '').trim().toLowerCase()
    return allowed.has(status) ? acc + Number(row?.cnt || 0) : acc
  }, 0)

const makeResponse = ({
  entityType,
  entityId,
  entityTitle,
  mode,
  title,
  message,
  affectedCounts = {},
  affectedRelations = [],
  activeProcesses = {},
  blockingReasons = [],
  allowedActions = [],
  restoreScope = null,
}) => ({
  entity_type: entityType,
  entity_id: entityId,
  entity_title: entityTitle,
  mode,
  summary: { title, message },
  affected_counts: affectedCounts,
  affected_relations: affectedRelations,
  active_processes: activeProcesses,
  blocking_reasons: blockingReasons,
  allowed_actions: allowedActions,
  restore_scope:
    restoreScope || {
      supported: mode === MODE.TRASH || mode === MODE.RELATION_DELETE,
      mode: mode === MODE.ARCHIVE_ONLY ? 'archive_toggle' : mode,
      message:
        mode === MODE.ARCHIVE_ONLY
          ? 'Используется архивирование, а не корзина'
          : mode === MODE.FORBIDDEN
            ? 'Восстановление не применяется, так как удаление недоступно'
            : 'Восстановление должно поддерживаться через корзину',
    },
})

async function previewClient(id) {
  const [[client]] = await db.execute('SELECT * FROM clients WHERE id = ?', [id])
  if (!client) return null

  const [
    [contacts],
    [billing],
    [shipping],
    [bank],
    [equipment],
    [requestStatuses],
    [rfqStatuses],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM client_contacts WHERE client_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM client_billing_addresses WHERE client_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM client_shipping_addresses WHERE client_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM client_bank_details WHERE client_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM client_equipment_units WHERE client_id = ?', [id]),
    db.execute('SELECT status, COUNT(*) AS cnt FROM client_requests WHERE client_id = ? GROUP BY status', [id]),
    db.execute(
      `SELECT r.status, COUNT(*) AS cnt
         FROM rfqs r
         JOIN client_requests cr ON cr.id = r.client_request_id
        WHERE cr.client_id = ?
        GROUP BY r.status`,
      [id]
    ),
  ])

  const activeClientRequests = countByStatus(requestStatuses, ACTIVE_CLIENT_REQUEST_STATUSES)
  const activeRfqs = countByStatus(rfqStatuses, ACTIVE_RFQ_STATUSES)

  const affectedCounts = {
    client_contacts: Number(contacts[0]?.cnt || 0),
    client_billing_addresses: Number(billing[0]?.cnt || 0),
    client_shipping_addresses: Number(shipping[0]?.cnt || 0),
    client_bank_details: Number(bank[0]?.cnt || 0),
    client_equipment_units: Number(equipment[0]?.cnt || 0),
  }

  if (activeClientRequests > 0 || activeRfqs > 0) {
    return makeResponse({
      entityType: 'clients',
      entityId: id,
      entityTitle: client.company_name,
      mode: MODE.ARCHIVE_ONLY,
      title: 'Клиент используется в активных процессах',
      message: 'Удаление в корзину недоступно. Можно только архивировать клиента.',
      affectedCounts,
      activeProcesses: {
        client_requests_active: activeClientRequests,
        rfqs_active: activeRfqs,
      },
      blockingReasons: [
        ...(activeClientRequests > 0
          ? [{ code: 'ACTIVE_CLIENT_REQUEST', message: 'Есть активные заявки клиента' }]
          : []),
        ...(activeRfqs > 0
          ? [{ code: 'ACTIVE_RFQ', message: 'Есть активные RFQ клиента' }]
          : []),
      ],
      allowedActions: ['archive'],
    })
  }

  return makeResponse({
    entityType: 'clients',
    entityId: id,
    entityTitle: client.company_name,
    mode: MODE.TRASH,
    title: 'Клиент может быть перемещен в корзину',
    message:
      'Клиент будет скрыт из обычных списков. Простые дочерние сущности могут быть восстановлены вместе с ним.',
    affectedCounts,
    allowedActions: ['trash'],
  })
}

async function previewClientChild(id, entityType, titleBuilder) {
  const table = entityType
  const [[row]] = await db.execute(`SELECT * FROM ${table} WHERE id = ?`, [id])
  if (!row) return null

  return makeResponse({
    entityType,
    entityId: id,
    entityTitle: titleBuilder(row),
    mode: MODE.TRASH,
    title: `${LABELS[entityType]} может быть перемещен(а) в корзину`,
    message: 'Это локальная карточка. Удаление не должно затрагивать корневые бизнес-процессы.',
    allowedActions: ['trash'],
  })
}

async function previewSimpleChild(id, entityType, titleBuilder) {
  const [[row]] = await db.execute(`SELECT * FROM ${entityType} WHERE id = ?`, [id])
  if (!row) return null

  return makeResponse({
    entityType,
    entityId: id,
    entityTitle: titleBuilder(row),
    mode: MODE.TRASH,
    title: `${LABELS[entityType]} может быть перемещен(а) в корзину`,
    message: 'Это локальная карточка. Удаление не должно затрагивать корневые бизнес-процессы.',
    allowedActions: ['trash'],
  })
}

async function previewClientEquipmentUnit(id) {
  const [[row]] = await db.execute(
    `
    SELECT ceu.*,
           c.company_name AS client_name,
           em.model_name
      FROM client_equipment_units ceu
      JOIN clients c ON c.id = ceu.client_id
      JOIN equipment_models em ON em.id = ceu.equipment_model_id
     WHERE ceu.id = ?
    `,
    [id]
  )
  if (!row) return null

  const overrides = { cnt: 0 }
  const materialOverrides = { cnt: 0 }
  const materialSpecs = { cnt: 0 }

  return makeResponse({
    entityType: 'client_equipment_units',
    entityId: id,
    entityTitle: `${row.client_name} / ${row.model_name}${row.serial_number ? ` / ${row.serial_number}` : ''}`,
    mode: MODE.TRASH,
    title: 'Единица оборудования может быть перемещена в корзину',
    message: 'Единица оборудования будет скрыта вместе с локальными unit-specific настройками.',
    affectedCounts: {
      client_equipment_unit_overrides: Number(overrides.cnt || 0),
      client_equipment_unit_material_overrides: Number(materialOverrides.cnt || 0),
      client_equipment_unit_material_specs: Number(materialSpecs.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewClientRequestRevisionItem(id) {
  const [[row]] = await db.execute(
    `
    SELECT cri.*,
           cr.client_request_id,
           req.internal_number AS request_number
      FROM client_request_revision_items cri
      JOIN client_request_revisions cr ON cr.id = cri.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
     WHERE cri.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [[components]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM client_request_revision_item_components WHERE client_request_revision_item_id = ?',
    [id]
  )
  const [[strategies]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM client_request_revision_item_strategies WHERE client_request_revision_item_id = ?',
    [id]
  )

  return makeResponse({
    entityType: 'client_request_revision_items',
    entityId: id,
    entityTitle:
      row.client_part_number ||
      `Позиция ${row.line_number || id}`,
    mode: MODE.TRASH,
    title: 'Позиция заявки будет перемещена в корзину',
    message: 'Позицию можно будет восстановить вместе с её стратегией и компонентами.',
    affectedCounts: {
      client_request_revision_item_components: Number(components?.cnt || 0),
      client_request_revision_item_strategies: Number(strategies?.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewClientRequestRevisionItemComponent(id) {
  const [[row]] = await db.execute(
    `
    SELECT c.*,
           cri.line_number,
           cri.client_part_number
      FROM client_request_revision_item_components c
      JOIN client_request_revision_items cri ON cri.id = c.client_request_revision_item_id
     WHERE c.id = ?
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'client_request_revision_item_components',
    entityId: id,
    entityTitle: row.client_part_number || `Компонент #${id}`,
    mode: MODE.RELATION_DELETE,
    title: 'Компонент позиции заявки будет удален',
    message: 'Будет удалён только этот компонент. Его можно будет восстановить из корзины.',
    allowedActions: ['relation_delete'],
  })
}

async function previewRfqItemComponent(id) {
  const [[row]] = await db.execute(
    `
    SELECT c.*,
           ri.rfq_id
      FROM rfq_item_components c
      JOIN rfq_items ri ON ri.id = c.rfq_item_id
     WHERE c.id = ?
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'rfq_item_components',
    entityId: id,
    entityTitle: `Компонент RFQ #${id}`,
    mode: MODE.RELATION_DELETE,
    title: 'Компонент RFQ будет удален из структуры',
    message: 'Будет удалён только этот компонент. Его можно будет восстановить из корзины.',
    allowedActions: ['relation_delete'],
  })
}

async function previewRfqScenario(id, params = {}) {
  const rfqId = toId(params?.rfq_id)
  if (!rfqId) {
    const err = new Error('Для preview rfq_scenarios нужен rfq_id')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT s.*, r.rfq_number
      FROM rfq_scenarios s
      JOIN rfqs r ON r.id = s.rfq_id
     WHERE s.id = ?
       AND s.rfq_id = ?
    `,
    [id, rfqId]
  )
  if (!row) return null

  const [[lines]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM rfq_scenario_lines WHERE scenario_id = ?',
    [id]
  )
  const [[selectionUsage]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM selections WHERE scenario_id = ?',
    [id]
  )

  const selectionCount = Number(selectionUsage?.cnt || 0)
  if (selectionCount > 0) {
    return makeResponse({
      entityType: 'rfq_scenarios',
      entityId: id,
      entityTitle: row.name || `Сценарий #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Сценарий уже используется в выборе',
      message: 'Сценарий нельзя удалять, пока он используется во вкладке «Выбор».',
      affectedCounts: {
        rfq_scenario_lines: Number(lines?.cnt || 0),
      },
      activeProcesses: {
        selections_active: selectionCount,
      },
      blockingReasons: [
        { code: 'SCENARIO_IN_SELECTION', message: 'Есть связанные selections' },
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'rfq_scenarios',
    entityId: id,
    entityTitle: row.name || `Сценарий #${id}`,
    mode: MODE.TRASH,
    title: 'Сценарий может быть перемещён в корзину',
    message: 'Сценарий и его строки будут скрыты из RFQ workspace и смогут быть восстановлены.',
    affectedCounts: {
      rfq_scenario_lines: Number(lines?.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewEquipmentModelBomItem(id) {
  const [[row]] = await db.execute(
    `
    SELECT item.*,
           em.model_name,
           man.name AS manufacturer_name,
           parent.manufacturer_part_number AS parent_part_number,
           parent.manufacturer_part_name AS parent_part_name,
           parent.manufacturer_part_name_en AS parent_part_name_en,
           parent.manufacturer_part_name_ru AS parent_part_name_ru,
           cp.name AS catalog_position_name,
           cp.code AS catalog_position_code
      FROM equipment_model_bom_items item
      JOIN equipment_models em ON em.id = item.equipment_model_id
      JOIN equipment_manufacturers man ON man.id = em.manufacturer_id
      LEFT JOIN equipment_model_bom_items parent ON parent.id = item.parent_item_id
      LEFT JOIN catalog_positions cp ON cp.id = item.catalog_position_id
     WHERE item.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [[directChildren]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM equipment_model_bom_items WHERE parent_item_id = ?',
    [id]
  )
  const [descendants] = await db.execute(
    `
    WITH RECURSIVE bom_descendants AS (
      SELECT id
        FROM equipment_model_bom_items
       WHERE parent_item_id = ?
      UNION ALL
      SELECT child.id
        FROM equipment_model_bom_items child
        JOIN bom_descendants parent ON parent.id = child.parent_item_id
    )
    SELECT COUNT(*) AS cnt FROM bom_descendants
    `,
    [id]
  )

  const title =
    row.manufacturer_part_number ||
    row.manufacturer_part_name ||
    row.manufacturer_part_name_en ||
    row.manufacturer_part_name_ru ||
    row.title ||
    row.catalog_position_name ||
    row.catalog_position_code ||
    `BOM строка #${id}`
  const modelTitle = `${row.manufacturer_name || ''} ${row.model_name || ''}`.trim()
  const descendantCount = Number(descendants?.[0]?.cnt || 0)

  return makeResponse({
    entityType: 'equipment_model_bom_items',
    entityId: id,
    entityTitle: title,
    mode: MODE.RELATION_DELETE,
    title: 'Строка будет удалена из BOM модели',
    message:
      descendantCount > 0
        ? `Будет удалено это место в BOM "${modelTitle}" и весь вложенный подузел. Карточки классификатора, детали и коммерческие связи не удаляются.`
        : `Будет удалено только это место в BOM "${modelTitle}". Карточки классификатора, детали и коммерческие связи не удаляются.`,
    affectedCounts: {
      equipment_model_bom_child_items: Number(directChildren?.cnt || 0),
      equipment_model_bom_descendants: descendantCount,
    },
    affectedRelations: [
      {
        entity_type: 'equipment_models',
        entity_id: row.equipment_model_id,
        title: modelTitle || `Модель #${row.equipment_model_id}`,
        role: 'BOM модели',
      },
      row.parent_item_id
        ? {
            entity_type: 'equipment_model_bom_items',
            entity_id: row.parent_item_id,
            title:
              row.parent_part_number ||
              row.parent_part_name ||
              row.parent_part_name_en ||
              row.parent_part_name_ru ||
              `Родительская строка #${row.parent_item_id}`,
            role: 'Родительский узел',
          }
        : null,
      row.catalog_position_id
        ? {
            entity_type: 'catalog_positions',
            entity_id: row.catalog_position_id,
            title: row.catalog_position_name || row.catalog_position_code || `Позиция #${row.catalog_position_id}`,
            role: 'Связанная позиция классификатора не удаляется',
          }
        : null,
    ].filter(Boolean),
    allowedActions: ['relation_delete'],
  })
}

async function previewSupplierPartCatalogPositionLink(id, params = {}) {
  const supplierPartId = toId(id) || toId(params.supplier_part_id)
  const catalogPositionId = toId(params.catalog_position_id)
  if (!supplierPartId || !catalogPositionId) return null

  const [[row]] = await db.execute(
    `
    SELECT
      spcp.*,
      sp.supplier_part_number,
      cp.position_code,
      cp.display_name
    FROM supplier_part_catalog_positions spcp
    JOIN supplier_parts sp ON sp.id = spcp.supplier_part_id
    JOIN catalog_positions cp ON cp.id = spcp.catalog_position_id
    WHERE spcp.supplier_part_id = ? AND spcp.catalog_position_id = ?
    `,
    [supplierPartId, catalogPositionId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'supplier_part_catalog_positions',
    entityId: supplierPartId,
    entityTitle: `${row.supplier_part_number || `Позиция поставщика #${supplierPartId}`} -> ${row.position_code || row.display_name || `Позиция каталога #${catalogPositionId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Связь с позицией каталога будет удалена',
    message: 'Удаляется только связь детали поставщика с позицией каталога. Сама деталь поставщика и карточка каталога остаются.',
    affectedCounts: {
      supplier_part_catalog_positions: 1,
    },
    allowedActions: ['delete_relation'],
  })
}

async function previewProcurementKpiTarget(id) {
  const [[row]] = await db.execute(
    `
    SELECT t.*, u.full_name, u.username
      FROM procurement_kpi_targets t
      LEFT JOIN users u ON u.id = t.buyer_user_id
     WHERE t.id = ?
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'procurement_kpi_targets',
    entityId: id,
    entityTitle: `${row.full_name || row.username || `Закупщик #${row.buyer_user_id}`}: ${row.period_start} - ${row.period_end}`,
    mode: MODE.TRASH,
    title: 'Цель закупочного KPI может быть перемещена в корзину',
    message: 'Цель исчезнет из панели KPI и сможет быть восстановлена из корзины.',
    allowedActions: ['trash'],
  })
}

async function previewSalesKpiTarget(id) {
  const [[row]] = await db.execute(
    `
    SELECT t.*, u.full_name, u.username
      FROM sales_kpi_targets t
      LEFT JOIN users u ON u.id = t.seller_user_id
     WHERE t.id = ?
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'sales_kpi_targets',
    entityId: id,
    entityTitle: `${row.full_name || row.username || `Продавец #${row.seller_user_id}`}: ${row.period_start} - ${row.period_end}`,
    mode: MODE.TRASH,
    title: 'Цель sales KPI может быть перемещена в корзину',
    message: 'Цель исчезнет из панели KPI и сможет быть восстановлена из корзины.',
    allowedActions: ['trash'],
  })
}

async function previewEquipmentManufacturer(id) {
  const [[row]] = await db.execute('SELECT * FROM equipment_manufacturers WHERE id = ?', [id])
  if (!row) return null

  const [[models]] = await db.execute('SELECT COUNT(*) AS cnt FROM equipment_models WHERE manufacturer_id = ?', [id])
  const [[catalogPositions]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM catalog_positions WHERE manufacturer_id = ?',
    [id]
  )

  const modelCount = Number(models?.cnt || 0)
  const catalogPositionCount = Number(catalogPositions?.cnt || 0)
  if (modelCount > 0 || catalogPositionCount > 0) {
    return makeResponse({
      entityType: 'equipment_manufacturers',
      entityId: id,
      entityTitle: row.name || `Производитель #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Производитель используется в каталоге',
      message: 'Сначала уберите связанные модели и позиции каталога, затем удаляйте производителя.',
      affectedCounts: {
        equipment_models: modelCount,
        catalog_positions: catalogPositionCount,
      },
      blockingReasons: [
        ...(modelCount > 0 ? [{ code: 'MODELS_EXIST', message: 'Есть связанные модели оборудования' }] : []),
        ...(catalogPositionCount > 0
          ? [{ code: 'CATALOG_POSITIONS_EXIST', message: 'Есть связанные позиции каталога' }]
          : []),
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'equipment_manufacturers',
    entityId: id,
    entityTitle: row.name || `Производитель #${id}`,
    mode: MODE.TRASH,
    title: 'Производитель может быть перемещён в корзину',
    message: 'Запись будет скрыта из справочника производителей и сможет быть восстановлена.',
    allowedActions: ['trash'],
  })
}

async function previewEquipmentModel(id) {
  const [[row]] = await db.execute(
    `
    SELECT em.*, m.name AS manufacturer_name
      FROM equipment_models em
      JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
     WHERE em.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [[units]] = await db.execute('SELECT COUNT(*) AS cnt FROM client_equipment_units WHERE equipment_model_id = ?', [id])
  const [[bom]] = await db.execute('SELECT COUNT(*) AS cnt FROM equipment_model_bom_items WHERE equipment_model_id = ?', [
    id,
  ])

  const unitCount = Number(units?.cnt || 0)
  const bomCount = Number(bom?.cnt || 0)
  if (unitCount > 0 || bomCount > 0) {
    return makeResponse({
      entityType: 'equipment_models',
      entityId: id,
      entityTitle: `${row.manufacturer_name} / ${row.model_name}`,
      mode: MODE.FORBIDDEN,
      title: 'Модель используется в рабочих данных',
      message: 'Сначала уберите BOM и единицы оборудования клиента, затем удаляйте модель.',
      affectedCounts: {
        client_equipment_units: unitCount,
        equipment_model_bom_items: bomCount,
      },
      blockingReasons: [
        ...(unitCount > 0 ? [{ code: 'UNITS_EXIST', message: 'Есть единицы оборудования клиентов' }] : []),
        ...(bomCount > 0 ? [{ code: 'BOM_EXIST', message: 'Есть строки BOM для этой модели' }] : []),
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'equipment_models',
    entityId: id,
    entityTitle: `${row.manufacturer_name} / ${row.model_name}`,
    mode: MODE.TRASH,
    title: 'Модель может быть перемещена в корзину',
    message: 'Запись будет скрыта из справочника моделей и сможет быть восстановлена.',
    allowedActions: ['trash'],
  })
}

async function previewEquipmentClassifierNode(id) {
  const [[row]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [id])
  if (!row) return null

  const [[children]] = await db.execute('SELECT COUNT(*) AS cnt FROM equipment_classifier_nodes WHERE parent_id = ?', [id])
  const [[models]] = await db.execute('SELECT COUNT(*) AS cnt FROM equipment_models WHERE classifier_node_id = ?', [id])

  const childCount = Number(children?.cnt || 0)
  const modelCount = Number(models?.cnt || 0)
  if (childCount > 0 || modelCount > 0) {
    return makeResponse({
      entityType: 'equipment_classifier_nodes',
      entityId: id,
      entityTitle: row.name || `Узел #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Узел классификатора используется',
      message: 'Удаление недоступно, пока у узла есть дочерние узлы или модели оборудования.',
      affectedCounts: {
        equipment_classifier_nodes: childCount,
        equipment_models: modelCount,
      },
      blockingReasons: [
        ...(childCount > 0 ? [{ code: 'CHILD_NODES_EXIST', message: 'Есть дочерние узлы классификатора' }] : []),
        ...(modelCount > 0 ? [{ code: 'MODELS_EXIST', message: 'Есть модели оборудования в этом узле' }] : []),
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'equipment_classifier_nodes',
    entityId: id,
    entityTitle: row.name || `Узел #${id}`,
    mode: MODE.TRASH,
    title: 'Узел классификатора может быть перемещён в корзину',
    message: 'Пустой узел классификатора можно восстановить из корзины.',
    allowedActions: ['trash'],
  })
}

async function buildTrashPreview(rawEntityType, rawEntityId, params = {}) {
  const entityType = ENTITY_ALIAS[String(rawEntityType || '').trim()] || String(rawEntityType || '').trim()
  const entityId = toId(rawEntityId)
  assertNotRemovedLegacyEntity(entityType)

  if (!entityId) {
    const err = new Error('Некорректный идентификатор сущности')
    err.status = 400
    throw err
  }

  switch (entityType) {
    case 'clients':
      return previewClient(entityId)
    case 'client_contacts':
      return previewClientChild(entityId, entityType, (row) => row.name || `Контакт #${row.id}`)
    case 'client_billing_addresses':
      return previewClientChild(entityId, entityType, (row) => row.label || row.formatted_address || `Адрес #${row.id}`)
    case 'client_shipping_addresses':
      return previewClientChild(entityId, entityType, (row) => row.formatted_address || `Адрес доставки #${row.id}`)
    case 'client_bank_details':
      return previewClientChild(entityId, entityType, (row) => row.bank_name || `Реквизиты #${row.id}`)
    case 'client_equipment_units':
      return previewClientEquipmentUnit(entityId)
    case 'client_request_revision_items':
      return previewClientRequestRevisionItem(entityId)
    case 'client_request_revision_item_components':
      return previewClientRequestRevisionItemComponent(entityId)
    case 'supplier_contacts':
      return previewSimpleChild(entityId, entityType, (row) => row.name || `Контакт поставщика #${row.id}`)
    case 'supplier_addresses':
      return previewSimpleChild(entityId, entityType, (row) => row.label || row.formatted_address || `Адрес поставщика #${row.id}`)
    case 'supplier_bank_details':
      return previewSimpleChild(entityId, entityType, (row) => row.bank_name || `Реквизиты поставщика #${row.id}`)
    case 'part_suppliers':
      return previewSupplier(entityId)
    case 'supplier_parts':
      return previewSupplierPart(entityId)
    case 'supplier_part_materials':
      return previewSupplierPartMaterialLink(entityId, params)
    case 'supplier_part_prices':
      return previewSupplierPartPrice(entityId)
    case 'supplier_part_catalog_positions':
      return previewSupplierPartCatalogPositionLink(entityId, params)
    case 'supplier_price_lists':
      return previewSupplierPriceList(entityId)
    case 'supplier_price_list_lines':
      return previewSupplierPriceListLine(entityId)
    case 'tnved_codes':
      return previewTnvedCode(entityId)
    case 'logistics_route_templates':
      return previewLogisticsRouteTemplate(entityId)
    case 'materials':
      return previewMaterial(entityId)
    case 'client_requests':
      return previewClientRequest(entityId)
    case 'rfq_item_components':
      return previewRfqItemComponent(entityId)
    case 'rfq_scenarios':
      return previewRfqScenario(entityId, params)
    case 'rfqs':
      return previewRfq(entityId)
    case 'procurement_kpi_targets':
      return previewProcurementKpiTarget(entityId)
    case 'sales_kpi_targets':
      return previewSalesKpiTarget(entityId)
    case 'equipment_manufacturers':
      return previewEquipmentManufacturer(entityId)
    case 'equipment_models':
      return previewEquipmentModel(entityId)
    case 'equipment_model_bom_items':
      return previewEquipmentModelBomItem(entityId)
    case 'equipment_classifier_nodes':
      return previewEquipmentClassifierNode(entityId)
    case 'users':
      return previewUser(entityId, params)
    case 'roles':
      return previewRole(entityId)
    case 'tabs':
      return previewTab(entityId)
    default: {
      const err = new Error(`Preview для сущности "${entityType}" пока не поддерживается`)
      err.status = 400
      throw err
    }
  }
}

module.exports = {
  MODE,
  LABELS,
  buildTrashPreview,
}
