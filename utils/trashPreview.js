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
  supplier_part_oem_parts: 'supplier_part_oem_parts',
  oem_part_unit_overrides: 'oem_part_unit_overrides',
  oem_part_unit_material_overrides: 'oem_part_unit_material_overrides',
  oem_part_documents: 'oem_part_documents',
  oem_part_presentation_profiles: 'oem_part_presentation_profiles',
  supplier_bundles: 'supplier_bundles',
  supplier_bundle_items: 'supplier_bundle_items',
  supplier_bundle_item_links: 'supplier_bundle_item_links',
  client_requests: 'client_requests',
  rfq_item_components: 'rfq_item_components',
  rfq_scenarios: 'rfq_scenarios',
  rfqs: 'rfqs',
  oem_parts: 'oem_parts',
  oem_part_material_specs: 'oem_part_material_specs',
  original_part_groups: 'original_part_groups',
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
  supplier_part_oem_parts: 'Связь детали поставщика с OEM',
  oem_part_unit_overrides: 'Machine-specific override OEM детали',
  oem_part_unit_material_overrides: 'Machine-specific material override',
  oem_part_documents: 'Документ OEM детали',
  oem_part_presentation_profiles: 'Профиль представления OEM детали',
  supplier_bundles: 'Комплект поставщиков',
  supplier_bundle_items: 'Роль в комплекте',
  supplier_bundle_item_links: 'Вариант роли комплекта',
  client_requests: 'Заявка клиента',
  rfq_item_components: 'Компонент RFQ',
  rfq_scenarios: 'Сценарий экономики RFQ',
  rfqs: 'RFQ',
  oem_parts: 'OEM деталь',
  oem_part_material_specs: 'Спецификация материала OEM детали',
  original_part_groups: 'Группа OEM деталей',
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

  const [[overrides]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_part_unit_overrides WHERE client_equipment_unit_id = ?',
    [id]
  )
  const [[materialOverrides]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_part_unit_material_overrides WHERE client_equipment_unit_id = ?',
    [id]
  )
  const [[materialSpecs]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_part_unit_material_specs WHERE client_equipment_unit_id = ?',
    [id]
  )

  return makeResponse({
    entityType: 'client_equipment_units',
    entityId: id,
    entityTitle: `${row.client_name} / ${row.model_name}${row.serial_number ? ` / ${row.serial_number}` : ''}`,
    mode: MODE.TRASH,
    title: 'Единица оборудования может быть перемещена в корзину',
    message: 'Единица оборудования будет скрыта вместе с локальными unit-specific настройками.',
    affectedCounts: {
      oem_part_unit_overrides: Number(overrides.cnt || 0),
      oem_part_unit_material_overrides: Number(materialOverrides.cnt || 0),
      oem_part_unit_material_specs: Number(materialSpecs.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewClientRequestRevisionItem(id) {
  const [[row]] = await db.execute(
    `
    SELECT cri.*,
           cr.client_request_id,
           req.internal_number AS request_number,
           op.part_number AS oem_part_number
      FROM client_request_revision_items cri
      JOIN client_request_revisions cr ON cr.id = cri.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
      LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
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
      row.oem_part_number ||
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
           cri.client_part_number,
           op.part_number AS oem_part_number
      FROM client_request_revision_item_components c
      JOIN client_request_revision_items cri ON cri.id = c.client_request_revision_item_id
      LEFT JOIN oem_parts op ON op.id = c.oem_part_id
     WHERE c.id = ?
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'client_request_revision_item_components',
    entityId: id,
    entityTitle: row.oem_part_number || row.client_part_number || `Компонент #${id}`,
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
           ri.rfq_id,
           op.part_number AS oem_part_number
      FROM rfq_item_components c
      JOIN rfq_items ri ON ri.id = c.rfq_item_id
      LEFT JOIN oem_parts op ON op.id = c.oem_part_id
     WHERE c.id = ?
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'rfq_item_components',
    entityId: id,
    entityTitle: row.oem_part_number || `Компонент RFQ #${id}`,
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

async function previewOriginalPartGroup(id) {
  const [[row]] = await db.execute('SELECT * FROM original_part_groups WHERE id = ?', [id])
  if (!row) return null

  const [[parts]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_parts WHERE group_id = ?',
    [id]
  )

  return makeResponse({
    entityType: 'original_part_groups',
    entityId: id,
    entityTitle: row.name || `Группа #${id}`,
    mode: MODE.TRASH,
    title: 'Группа OEM деталей может быть перемещена в корзину',
    message: 'Группа будет скрыта, а связанные OEM детали временно отвяжутся от неё. При восстановлении группа вернётся вместе с привязками.',
    affectedCounts: {
      oem_parts: Number(parts?.cnt || 0),
    },
    allowedActions: ['trash'],
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
  const [[oemParts]] = await db.execute('SELECT COUNT(*) AS cnt FROM oem_parts WHERE manufacturer_id = ?', [id])

  const modelCount = Number(models?.cnt || 0)
  const oemCount = Number(oemParts?.cnt || 0)
  if (modelCount > 0 || oemCount > 0) {
    return makeResponse({
      entityType: 'equipment_manufacturers',
      entityId: id,
      entityTitle: row.name || `Производитель #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Производитель используется в каталоге',
      message: 'Сначала уберите связанные модели и OEM детали, затем удаляйте производителя.',
      affectedCounts: {
        equipment_models: modelCount,
        oem_parts: oemCount,
      },
      blockingReasons: [
        ...(modelCount > 0 ? [{ code: 'MODELS_EXIST', message: 'Есть связанные модели оборудования' }] : []),
        ...(oemCount > 0 ? [{ code: 'OEM_PARTS_EXIST', message: 'Есть связанные OEM детали' }] : []),
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
  const [[fitments]] = await db.execute('SELECT COUNT(*) AS cnt FROM oem_part_model_fitments WHERE equipment_model_id = ?', [id])
  const [[bom]] = await db.execute('SELECT COUNT(*) AS cnt FROM oem_part_model_bom WHERE equipment_model_id = ?', [id])

  const unitCount = Number(units?.cnt || 0)
  const fitmentCount = Number(fitments?.cnt || 0)
  const bomCount = Number(bom?.cnt || 0)
  if (unitCount > 0 || fitmentCount > 0 || bomCount > 0) {
    return makeResponse({
      entityType: 'equipment_models',
      entityId: id,
      entityTitle: `${row.manufacturer_name} / ${row.model_name}`,
      mode: MODE.FORBIDDEN,
      title: 'Модель используется в рабочих данных',
      message: 'Сначала уберите привязки OEM, BOM и единицы оборудования клиента, затем удаляйте модель.',
      affectedCounts: {
        client_equipment_units: unitCount,
        oem_part_model_fitments: fitmentCount,
        oem_part_model_bom: bomCount,
      },
      blockingReasons: [
        ...(unitCount > 0 ? [{ code: 'UNITS_EXIST', message: 'Есть единицы оборудования клиентов' }] : []),
        ...(fitmentCount > 0 ? [{ code: 'FITMENTS_EXIST', message: 'Есть fitment-привязки OEM деталей' }] : []),
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

async function previewOemPart(id) {
  const [[part]] = await db.execute(
    `
    SELECT op.id, op.part_number, em.name AS manufacturer_name
      FROM oem_parts op
      JOIN equipment_manufacturers em ON em.id = op.manufacturer_id
     WHERE op.id = ?
    `,
    [id]
  )
  if (!part) return null

  const [
    [fitments],
    [bomParents],
    [bomChildren],
    [documents],
    [materials],
    [altGroups],
    [supplierLinks],
    [activeRfqItems],
    [activeResponseLines],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_model_fitments WHERE oem_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_model_bom WHERE parent_oem_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_model_bom WHERE child_oem_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_documents WHERE oem_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_materials WHERE oem_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_alt_groups WHERE oem_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_part_oem_parts WHERE oem_part_id = ?', [id]),
    db.execute(
      `SELECT COUNT(*) AS cnt
         FROM rfq_items ri
         JOIN rfqs r ON r.id = ri.rfq_id
        WHERE ri.oem_part_id = ?
          AND r.status IN ('draft', 'structured', 'sent')`,
      [id]
    ),
    db.execute(
      `SELECT COUNT(*) AS cnt
         FROM rfq_response_lines
        WHERE oem_part_id = ? OR requested_oem_part_id = ?`,
      [id, id]
    ),
  ])

  const activeUsage = Number(activeRfqItems[0]?.cnt || 0) + Number(activeResponseLines[0]?.cnt || 0)
  const affectedCounts = {
    oem_part_model_fitments: Number(fitments[0]?.cnt || 0),
    oem_part_model_bom_parent_links: Number(bomParents[0]?.cnt || 0),
    oem_part_model_bom_child_links: Number(bomChildren[0]?.cnt || 0),
    oem_part_documents: Number(documents[0]?.cnt || 0),
    oem_part_materials: Number(materials[0]?.cnt || 0),
    oem_part_alt_groups: Number(altGroups[0]?.cnt || 0),
    supplier_part_oem_parts: Number(supplierLinks[0]?.cnt || 0),
  }
  const structuralLinks =
    Number(bomParents[0]?.cnt || 0) +
    Number(bomChildren[0]?.cnt || 0) +
    Number(documents[0]?.cnt || 0) +
    Number(materials[0]?.cnt || 0) +
    Number(altGroups[0]?.cnt || 0) +
    Number(standardLinks[0]?.cnt || 0) +
    Number(supplierLinks[0]?.cnt || 0)

  if (activeUsage > 0) {
    return makeResponse({
      entityType: 'oem_parts',
      entityId: id,
      entityTitle: `${part.manufacturer_name} / ${part.part_number}`,
      mode: MODE.ARCHIVE_ONLY,
      title: 'OEM деталь используется в активных процессах',
      message: 'Полное удаление в корзину недоступно. Используйте архивирование или relation-delete в контексте модели.',
      affectedCounts,
      activeProcesses: {
        rfq_item_usage: Number(activeRfqItems[0]?.cnt || 0),
        response_line_usage: Number(activeResponseLines[0]?.cnt || 0),
      },
      blockingReasons: [
        { code: 'ACTIVE_PROCESS_USAGE', message: 'Деталь участвует в активных RFQ или response lines' },
      ],
      allowedActions: ['archive', 'relation_delete'],
    })
  }

  if (structuralLinks > 0) {
    return makeResponse({
      entityType: 'oem_parts',
      entityId: id,
      entityTitle: `${part.manufacturer_name} / ${part.part_number}`,
      mode: MODE.FORBIDDEN,
      title: 'Полное удаление OEM детали недоступно',
      message: 'Сначала удалите BOM, документы, материалы и другие связи, либо используйте удаление из конкретной модели.',
      affectedCounts,
      blockingReasons: [
        { code: 'STRUCTURAL_LINKS', message: 'У OEM детали есть структурные связи в каталоге' },
      ],
      allowedActions: ['relation_delete'],
    })
  }

  return makeResponse({
    entityType: 'oem_parts',
    entityId: id,
    entityTitle: `${part.manufacturer_name} / ${part.part_number}`,
    mode: MODE.TRASH,
    title: 'OEM деталь может быть перемещена в корзину',
    message: 'Полное удаление допускается только при отсутствии активного process usage.',
    affectedCounts,
    allowedActions: ['trash', 'relation_delete'],
  })
}

async function previewOemPartFitment(partId, params = {}) {
  const modelId = toId(params.equipment_model_id)
  if (!modelId) {
    const err = new Error('equipment_model_id обязателен для preview удаления из модели')
    err.status = 400
    throw err
  }

  const [[part]] = await db.execute(
    `
    SELECT op.id, op.part_number, em.name AS manufacturer_name
      FROM oem_parts op
      JOIN equipment_manufacturers em ON em.id = op.manufacturer_id
     WHERE op.id = ?
    `,
    [partId]
  )
  if (!part) return null

  const [fitments] = await db.execute(
    'SELECT id, equipment_model_id FROM oem_part_model_fitments WHERE oem_part_id = ? ORDER BY equipment_model_id ASC',
    [partId]
  )
  const fitment = fitments.find((row) => Number(row.equipment_model_id) === modelId)
  if (!fitment) return null

  const [
    [unitOverrides],
    [unitMaterialOverrides],
    [unitMaterialSpecs],
    [bomParentLinks],
    [bomChildLinks],
  ] = await Promise.all([
    db.execute(
      `
      SELECT COUNT(*) AS cnt
      FROM oem_part_unit_overrides opuo
      JOIN client_equipment_units cu ON cu.id = opuo.client_equipment_unit_id
      WHERE opuo.oem_part_id = ?
        AND cu.equipment_model_id = ?
      `,
      [partId, modelId]
    ),
    db.execute(
      `
      SELECT COUNT(*) AS cnt
      FROM oem_part_unit_material_overrides opumo
      JOIN client_equipment_units cu ON cu.id = opumo.client_equipment_unit_id
      WHERE opumo.oem_part_id = ?
        AND cu.equipment_model_id = ?
      `,
      [partId, modelId]
    ),
    db.execute(
      `
      SELECT COUNT(*) AS cnt
      FROM oem_part_unit_material_specs opums
      JOIN client_equipment_units cu ON cu.id = opums.client_equipment_unit_id
      WHERE opums.oem_part_id = ?
        AND cu.equipment_model_id = ?
      `,
      [partId, modelId]
    ),
    db.execute(
      `
      SELECT COUNT(*) AS cnt
      FROM oem_part_model_bom
      WHERE parent_oem_part_id = ?
        AND equipment_model_id = ?
      `,
      [partId, modelId]
    ),
    db.execute(
      `
      SELECT COUNT(*) AS cnt
      FROM oem_part_model_bom
      WHERE child_oem_part_id = ?
        AND equipment_model_id = ?
      `,
      [partId, modelId]
    ),
  ])

  const affectedCounts = {
    oem_part_unit_overrides: Number(unitOverrides[0]?.cnt || 0),
    oem_part_unit_material_overrides: Number(unitMaterialOverrides[0]?.cnt || 0),
    oem_part_unit_material_specs: Number(unitMaterialSpecs[0]?.cnt || 0),
    oem_part_model_bom_parent_links: Number(bomParentLinks[0]?.cnt || 0),
    oem_part_model_bom_child_links: Number(bomChildLinks[0]?.cnt || 0),
  }
  const bomLinksCount =
    affectedCounts.oem_part_model_bom_parent_links +
    affectedCounts.oem_part_model_bom_child_links

  if (bomLinksCount > 0) {
    return makeResponse({
      entityType: 'oem_part_model_fitments',
      entityId: fitment.id,
      entityTitle: `${part.manufacturer_name} / ${part.part_number}`,
      mode: MODE.FORBIDDEN,
      title: 'Удаление из модели недоступно',
      message: 'Сначала удалите строки BOM этой модели, где деталь является родителем или дочерней позицией.',
      affectedCounts: {
        oem_part_model_fitments: 1,
        ...affectedCounts,
      },
      blockingReasons: [
        { code: 'MODEL_BOM_LINKS', message: 'У детали есть BOM-связи в выбранной модели' },
      ],
      allowedActions: ['relation_delete'],
    })
  }

  if (fitments.length === 1) {
    return makeResponse({
      entityType: 'oem_part_model_fitments',
      entityId: fitment.id,
      entityTitle: `${part.manufacturer_name} / ${part.part_number}`,
      mode: MODE.TRASH,
      title: 'Удаление из этой модели удалит OEM деталь целиком',
      message: 'У детали осталась только одна модель применения, поэтому будет удалена вся OEM деталь.',
      affectedCounts: {
        oem_part_model_fitments: 1,
        ...affectedCounts,
      },
      allowedActions: ['trash'],
    })
  }

  return makeResponse({
    entityType: 'oem_part_model_fitments',
    entityId: fitment.id,
    entityTitle: `${part.manufacturer_name} / ${part.part_number}`,
    mode: MODE.RELATION_DELETE,
    title: 'OEM деталь будет удалена только из выбранной модели',
    message: 'Сама OEM деталь останется в каталоге. Будут удалены только fitment и model-specific unit overrides для этой модели.',
    affectedCounts: {
      oem_part_model_fitments: 1,
      ...affectedCounts,
    },
    allowedActions: ['relation_delete'],
  })
}

async function previewOemPartMaterial(partId, params = {}) {
  const materialId = toId(params.material_id)
  if (!materialId) {
    const err = new Error('material_id обязателен для preview удаления связи материала')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT
      opm.*,
      p.part_number,
      m.name AS material_name,
      m.code AS material_code
    FROM oem_part_materials opm
    JOIN oem_parts p ON p.id = opm.oem_part_id
    JOIN materials m ON m.id = opm.material_id
    WHERE opm.oem_part_id = ?
      AND opm.material_id = ?
    `,
    [partId, materialId]
  )
  if (!row) return null

  const [[specs]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_part_material_specs WHERE oem_part_id = ? AND material_id = ?',
    [partId, materialId]
  )

  return makeResponse({
    entityType: 'oem_part_materials',
    entityId: partId,
    entityTitle: `${row.part_number} / ${row.material_name || row.material_code || `Материал #${materialId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Связь OEM детали с материалом будет удалена',
    message: 'OEM деталь останется в каталоге. Будет удалена только связь с материалом и связанные material specs.',
    affectedCounts: {
      oem_part_material_specs: Number(specs.cnt || 0),
    },
    allowedActions: ['relation_delete'],
  })
}

async function previewOemPartMaterialSpec(partId, params = {}) {
  const materialId = toId(params.material_id)
  if (!materialId) {
    const err = new Error('material_id is required for oem_part_material_specs preview')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT s.*,
           p.part_number,
           m.name AS material_name,
           m.code AS material_code
      FROM oem_part_material_specs s
      JOIN oem_parts p ON p.id = s.oem_part_id
      JOIN materials m ON m.id = s.material_id
     WHERE s.oem_part_id = ?
       AND s.material_id = ?
    `,
    [partId, materialId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'oem_part_material_specs',
    entityId: partId,
    entityTitle: `${row.part_number} / ${row.material_name || row.material_code || `Материал #${materialId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Спецификация материала будет удалена',
    message: 'Будет удалена только числовая спецификация материала. Связь материала с OEM деталью останется.',
    allowedActions: ['relation_delete'],
  })
}

async function previewOemPartBom(parentId, params = {}) {
  const childId = toId(params.child_part_id)
  const modelId = toId(params.equipment_model_id)
  if (!childId) {
    const err = new Error('child_part_id обязателен для preview удаления строки BOM')
    err.status = 400
    throw err
  }

  const [rows] = await db.execute(
    `
    SELECT
      b.*,
      p.part_number AS parent_part_number,
      c.part_number AS child_part_number
    FROM oem_part_model_bom b
    JOIN oem_parts p ON p.id = b.parent_oem_part_id
    JOIN oem_parts c ON c.id = b.child_oem_part_id
    WHERE b.parent_oem_part_id = ?
      AND b.child_oem_part_id = ?
      ${modelId ? 'AND b.equipment_model_id = ?' : ''}
    ORDER BY b.equipment_model_id ASC
    LIMIT 1
    `,
    modelId ? [parentId, childId, modelId] : [parentId, childId]
  )
  const row = rows[0]
  if (!row) return null

  return makeResponse({
    entityType: 'oem_part_model_bom',
    entityId: parentId,
    entityTitle: `${row.parent_part_number} -> ${row.child_part_number}`,
    mode: MODE.RELATION_DELETE,
    title: 'Строка BOM будет удалена',
    message: 'Будет удалена только связь между родительской и дочерней OEM деталью для этой модели.',
    affectedCounts: {},
    allowedActions: ['relation_delete'],
  })
}

async function previewOemAltGroup(groupId) {
  const [[group]] = await db.execute(
    'SELECT id, oem_part_id, name, comment FROM oem_part_alt_groups WHERE id = ?',
    [groupId]
  )
  if (!group) return null

  const [[items]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_part_alt_items WHERE group_id = ?',
    [groupId]
  )

  return makeResponse({
    entityType: 'oem_part_alt_groups',
    entityId: groupId,
    entityTitle: group.name || `Группа #${groupId}`,
    mode: MODE.RELATION_DELETE,
    title: 'Группа альтернатив будет удалена',
    message: 'OEM деталь останется в каталоге. Будут удалены только эта группа и её элементы.',
    affectedCounts: {
      oem_part_alt_items: Number(items.cnt || 0),
    },
    allowedActions: ['relation_delete'],
  })
}

async function previewOemAltItem(groupId, params = {}) {
  const altPartId = toId(params.alt_part_id)
  if (!altPartId) {
    const err = new Error('alt_part_id обязателен для preview удаления альтернативы')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT
      i.group_id,
      i.alt_oem_part_id,
      i.note,
      g.name AS group_name,
      p.part_number AS alt_part_number
    FROM oem_part_alt_items i
    JOIN oem_part_alt_groups g ON g.id = i.group_id
    JOIN oem_parts p ON p.id = i.alt_oem_part_id
    WHERE i.group_id = ?
      AND i.alt_oem_part_id = ?
    `,
    [groupId, altPartId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'oem_part_alt_items',
    entityId: groupId,
    entityTitle: `${row.group_name || `Группа #${groupId}`} / ${row.alt_part_number}`,
    mode: MODE.RELATION_DELETE,
    title: 'Альтернатива будет удалена из группы',
    message: 'Будет удалена только эта связь альтернативы внутри группы.',
    allowedActions: ['relation_delete'],
  })
}

async function buildTrashPreview(rawEntityType, rawEntityId, params = {}) {
  const entityType = ENTITY_ALIAS[String(rawEntityType || '').trim()] || String(rawEntityType || '').trim()
  const entityId = toId(rawEntityId)

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
    case 'supplier_part_oem_parts':
      return previewSupplierPartOemLink(entityId, params)
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
    case 'oem_parts':
      return previewOemPart(entityId)
    case 'oem_part_materials':
      return previewOemPartMaterial(entityId, params)
    case 'oem_part_material_specs':
      return previewOemPartMaterialSpec(entityId, params)
    case 'oem_part_unit_overrides':
      return previewOemUnitOverride(entityId, params)
    case 'oem_part_unit_material_overrides':
      return previewOemUnitMaterialOverride(entityId, params)
    case 'oem_part_documents':
      return previewOemDocument(entityId)
    case 'oem_part_presentation_profiles':
      return previewOemPresentationProfile(entityId)
    case 'oem_part_model_fitments':
      return previewOemPartFitment(entityId, params)
    case 'oem_part_model_bom':
      return previewOemPartBom(entityId, params)
    case 'oem_part_alt_groups':
      return previewOemAltGroup(entityId)
    case 'oem_part_alt_items':
      return previewOemAltItem(entityId, params)
    case 'supplier_bundles':
      return previewSupplierBundle(entityId)
    case 'supplier_bundle_items':
      return previewSupplierBundleItem(entityId)
    case 'supplier_bundle_item_links':
      return previewSupplierBundleItemLink(entityId)
    case 'original_part_groups':
      return previewOriginalPartGroup(entityId)
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
