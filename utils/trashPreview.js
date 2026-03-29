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
  supplier_part_standard_parts: 'supplier_part_standard_parts',
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
  oem_part_standard_parts: 'oem_part_standard_parts',
  standard_parts: 'standard_parts',
  original_part_groups: 'original_part_groups',
  procurement_kpi_targets: 'procurement_kpi_targets',
  sales_kpi_targets: 'sales_kpi_targets',
  equipment_manufacturers: 'equipment_manufacturers',
  equipment_models: 'equipment_models',
  equipment_classifier_nodes: 'equipment_classifier_nodes',
  standard_part_classes: 'standard_part_classes',
  standard_part_class_fields: 'standard_part_class_fields',
  standard_part_field_options: 'standard_part_field_options',
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
  supplier_part_standard_parts: 'Связь детали поставщика со standard part',
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
  oem_part_standard_parts: 'Связь OEM со standard part',
  standard_parts: 'Standard part',
  original_part_groups: 'Группа OEM деталей',
  procurement_kpi_targets: 'Цель закупочного KPI',
  sales_kpi_targets: 'Цель sales KPI',
  equipment_manufacturers: 'Производитель оборудования',
  equipment_models: 'Модель оборудования',
  equipment_classifier_nodes: 'Узел классификатора оборудования',
  standard_part_classes: 'Класс standard parts',
  standard_part_class_fields: 'Поле класса standard parts',
  standard_part_field_options: 'Опция поля standard parts',
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

async function previewStandardPartClass(id) {
  const [[row]] = await db.execute('SELECT * FROM standard_part_classes WHERE id = ?', [id])
  if (!row) return null

  const [[children]] = await db.execute('SELECT COUNT(*) AS cnt FROM standard_part_classes WHERE parent_id = ?', [id])
  const [[parts]] = await db.execute('SELECT COUNT(*) AS cnt FROM standard_parts WHERE class_id = ?', [id])
  const [[fields]] = await db.execute('SELECT COUNT(*) AS cnt FROM standard_part_class_fields WHERE class_id = ?', [id])

  const childCount = Number(children?.cnt || 0)
  const partCount = Number(parts?.cnt || 0)
  const fieldCount = Number(fields?.cnt || 0)
  if (childCount > 0 || partCount > 0 || fieldCount > 0) {
    return makeResponse({
      entityType: 'standard_part_classes',
      entityId: id,
      entityTitle: row.name || row.code || `Класс #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Класс standard parts используется',
      message: 'Сначала уберите дочерние классы, детали и поля класса.',
      affectedCounts: {
        standard_part_classes: childCount,
        standard_parts: partCount,
        standard_part_class_fields: fieldCount,
      },
      blockingReasons: [
        ...(childCount > 0 ? [{ code: 'CHILD_CLASSES_EXIST', message: 'Есть дочерние классы' }] : []),
        ...(partCount > 0 ? [{ code: 'STANDARD_PARTS_EXIST', message: 'Есть связанные standard parts' }] : []),
        ...(fieldCount > 0 ? [{ code: 'FIELDS_EXIST', message: 'Есть поля класса' }] : []),
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'standard_part_classes',
    entityId: id,
    entityTitle: row.name || row.code || `Класс #${id}`,
    mode: MODE.TRASH,
    title: 'Класс standard parts может быть перемещён в корзину',
    message: 'Пустой класс можно восстановить из корзины.',
    allowedActions: ['trash'],
  })
}

async function previewStandardPartClassField(id) {
  const [[row]] = await db.execute(
    `
    SELECT f.*, c.name AS class_name, c.code AS class_code
      FROM standard_part_class_fields f
      JOIN standard_part_classes c ON c.id = f.class_id
     WHERE f.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [[options]] = await db.execute('SELECT COUNT(*) AS cnt FROM standard_part_field_options WHERE field_id = ?', [id])
  const [[values]] = await db.execute('SELECT COUNT(*) AS cnt FROM standard_part_values WHERE field_id = ?', [id])

  const optionCount = Number(options?.cnt || 0)
  const valueCount = Number(values?.cnt || 0)
  if (optionCount > 0 || valueCount > 0) {
    return makeResponse({
      entityType: 'standard_part_class_fields',
      entityId: id,
      entityTitle: `${row.class_name || row.class_code || `Класс #${row.class_id}`} / ${row.label || row.code}`,
      mode: MODE.FORBIDDEN,
      title: 'Поле класса используется',
      message: 'Сначала уберите опции поля и значения у standard parts.',
      affectedCounts: {
        standard_part_field_options: optionCount,
        standard_part_values: valueCount,
      },
      blockingReasons: [
        ...(optionCount > 0 ? [{ code: 'OPTIONS_EXIST', message: 'Есть опции поля' }] : []),
        ...(valueCount > 0 ? [{ code: 'VALUES_EXIST', message: 'Есть значения поля у standard parts' }] : []),
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'standard_part_class_fields',
    entityId: id,
    entityTitle: `${row.class_name || row.class_code || `Класс #${row.class_id}`} / ${row.label || row.code}`,
    mode: MODE.TRASH,
    title: 'Поле класса может быть перемещено в корзину',
    message: 'Пустое поле без значений и опций можно восстановить из корзины.',
    allowedActions: ['trash'],
  })
}

async function previewStandardPartFieldOption(id) {
  const [[row]] = await db.execute(
    `
    SELECT o.*, f.label AS field_label, f.code AS field_code
      FROM standard_part_field_options o
      JOIN standard_part_class_fields f ON f.id = o.field_id
     WHERE o.id = ?
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'standard_part_field_options',
    entityId: id,
    entityTitle: `${row.field_label || row.field_code || `Поле #${row.field_id}`} / ${row.value_label || row.value_code}`,
    mode: MODE.TRASH,
    title: 'Опция поля может быть перемещена в корзину',
    message: 'Опция будет скрыта из конфигурации класса и сможет быть восстановлена.',
    allowedActions: ['trash'],
  })
}

async function previewUser(id, params = {}) {
  const [[row]] = await db.execute(
    `
    SELECT u.*, r.name AS role_name, r.slug AS role_slug
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?
    `,
    [id]
  )
  if (!row) return null

  const currentUserId = toId(params?.current_user_id)
  const [[activeSessions]] = await db.execute(
    `
    SELECT COUNT(*) AS cnt
      FROM user_sessions
     WHERE user_id = ?
       AND status = 'active'
       AND last_seen_at >= NOW() - INTERVAL 10 MINUTE
    `,
    [id]
  )

  const sessionCount = Number(activeSessions?.cnt || 0)
  if (currentUserId && currentUserId === id) {
    return makeResponse({
      entityType: 'users',
      entityId: id,
      entityTitle: row.username || `Пользователь #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Нельзя удалить текущего пользователя',
      message: 'Сначала войдите под другим пользователем с административными правами.',
      blockingReasons: [{ code: 'SELF_DELETE', message: 'Это текущая учётная запись' }],
      allowedActions: [],
    })
  }
  if (sessionCount > 0) {
    return makeResponse({
      entityType: 'users',
      entityId: id,
      entityTitle: row.username || `Пользователь #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Пользователь сейчас активен',
      message: 'Нельзя удалять пользователя с активной сессией.',
      activeProcesses: { active_sessions: sessionCount },
      blockingReasons: [{ code: 'ACTIVE_SESSION', message: 'Есть активная пользовательская сессия' }],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'users',
    entityId: id,
    entityTitle: row.username || `Пользователь #${id}`,
    mode: MODE.TRASH,
    title: 'Пользователь может быть перемещён в корзину',
    message: 'Учётная запись будет удалена из списка пользователей и сможет быть восстановлена из корзины.',
    allowedActions: ['trash'],
  })
}

async function previewRole(id) {
  const [[row]] = await db.execute('SELECT * FROM roles WHERE id = ?', [id])
  if (!row) return null

  const [[usersCount]] = await db.execute('SELECT COUNT(*) AS cnt FROM users WHERE role_id = ?', [id])
  const [[permissionCount]] = await db.execute('SELECT COUNT(*) AS cnt FROM role_permissions WHERE role_id = ?', [id])
  const [[capabilityCount]] = await db.execute('SELECT COUNT(*) AS cnt FROM role_capabilities WHERE role_id = ?', [id])

  const userCount = Number(usersCount?.cnt || 0)
  const permCount = Number(permissionCount?.cnt || 0)
  const capCount = Number(capabilityCount?.cnt || 0)
  if (String(row.slug || '').toLowerCase() === 'admin') {
    return makeResponse({
      entityType: 'roles',
      entityId: id,
      entityTitle: row.name || row.slug || `Роль #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Системную роль admin удалять нельзя',
      message: 'Роль администратора должна оставаться в системе.',
      blockingReasons: [{ code: 'ADMIN_ROLE', message: 'Это системная роль admin' }],
      allowedActions: [],
    })
  }
  if (userCount > 0) {
    return makeResponse({
      entityType: 'roles',
      entityId: id,
      entityTitle: row.name || row.slug || `Роль #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Роль используется пользователями',
      message: 'Сначала переведите пользователей на другую роль.',
      affectedCounts: { users: userCount },
      blockingReasons: [{ code: 'ROLE_IN_USE', message: 'Есть пользователи с этой ролью' }],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'roles',
    entityId: id,
    entityTitle: row.name || row.slug || `Роль #${id}`,
    mode: MODE.TRASH,
    title: 'Роль может быть перемещена в корзину',
    message: 'Роль и её права/возможности будут скрыты и смогут быть восстановлены.',
    affectedCounts: {
      role_permissions: permCount,
      role_capabilities: capCount,
    },
    allowedActions: ['trash'],
  })
}

async function previewTab(id) {
  const [[row]] = await db.execute('SELECT * FROM tabs WHERE id = ?', [id])
  if (!row) return null

  const [[permissionCount]] = await db.execute('SELECT COUNT(*) AS cnt FROM role_permissions WHERE tab_id = ?', [id])
  return makeResponse({
    entityType: 'tabs',
    entityId: id,
    entityTitle: row.name || row.tab_name || row.path || `Вкладка #${id}`,
    mode: MODE.TRASH,
    title: 'Вкладка может быть перемещена в корзину',
    message: 'Вкладка и связанные role permissions будут скрыты и смогут быть восстановлены.',
    affectedCounts: {
      role_permissions: Number(permissionCount?.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewSupplier(id) {
  const [[supplier]] = await db.execute('SELECT * FROM part_suppliers WHERE id = ?', [id])
  if (!supplier) return null

  const [
    [contacts],
    [addresses],
    [bank],
    [parts],
    [priceLists],
    [rfqStatuses],
    [poStatuses],
    [qualityStatuses],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_contacts WHERE supplier_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_addresses WHERE supplier_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_bank_details WHERE supplier_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_parts WHERE supplier_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_price_lists WHERE supplier_id = ?', [id]),
    db.execute(
      `SELECT r.status, COUNT(*) AS cnt
         FROM rfq_suppliers rs
         JOIN rfqs r ON r.id = rs.rfq_id
        WHERE rs.supplier_id = ?
        GROUP BY r.status`,
      [id]
    ),
    db.execute('SELECT status, COUNT(*) AS cnt FROM supplier_purchase_orders WHERE supplier_id = ? GROUP BY status', [id]),
    db.execute('SELECT status, COUNT(*) AS cnt FROM supplier_quality_events WHERE supplier_id = ? GROUP BY status', [id]),
  ])

  const activeRfqs = countByStatus(rfqStatuses, ACTIVE_RFQ_STATUSES)
  const activePurchaseOrders = countByStatus(poStatuses, ACTIVE_PURCHASE_ORDER_STATUSES)
  const openQualityEvents = countByStatus(qualityStatuses, ACTIVE_QUALITY_EVENT_STATUSES)

  const affectedCounts = {
    supplier_contacts: Number(contacts[0]?.cnt || 0),
    supplier_addresses: Number(addresses[0]?.cnt || 0),
    supplier_bank_details: Number(bank[0]?.cnt || 0),
    supplier_parts: Number(parts[0]?.cnt || 0),
    supplier_price_lists: Number(priceLists[0]?.cnt || 0),
  }

  if (activeRfqs > 0 || activePurchaseOrders > 0 || openQualityEvents > 0) {
    return makeResponse({
      entityType: 'part_suppliers',
      entityId: id,
      entityTitle: supplier.name,
      mode: MODE.ARCHIVE_ONLY,
      title: 'Поставщик используется в активных процессах',
      message: 'Удаление в корзину недоступно. Можно только архивировать поставщика.',
      affectedCounts,
      activeProcesses: {
        rfqs_active: activeRfqs,
        purchase_orders_active: activePurchaseOrders,
        quality_events_open: openQualityEvents,
      },
      blockingReasons: [
        ...(activeRfqs > 0 ? [{ code: 'ACTIVE_RFQ', message: 'Поставщик участвует в активных RFQ' }] : []),
        ...(activePurchaseOrders > 0
          ? [{ code: 'ACTIVE_PURCHASE_ORDER', message: 'Есть активные заказы поставщику' }]
          : []),
        ...(openQualityEvents > 0
          ? [{ code: 'OPEN_QUALITY_EVENT', message: 'Есть открытые quality events' }]
          : []),
      ],
      allowedActions: ['archive'],
    })
  }

  return makeResponse({
    entityType: 'part_suppliers',
    entityId: id,
    entityTitle: supplier.name,
    mode: MODE.TRASH,
    title: 'Поставщик может быть перемещен в корзину',
    message: 'Поставщик будет скрыт из обычных списков вместе с простыми дочерними карточками.',
    affectedCounts,
    allowedActions: ['trash'],
  })
}

async function previewSupplierPart(id) {
  const [[row]] = await db.execute(
    `
    SELECT sp.*, ps.name AS supplier_name
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
     WHERE sp.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [
    [materials],
    [oemLinks],
    [standardLinks],
    [prices],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_part_materials WHERE supplier_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_part_oem_parts WHERE supplier_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_part_standard_parts WHERE supplier_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_part_prices WHERE supplier_part_id = ?', [id]),
  ])

  return makeResponse({
    entityType: 'supplier_parts',
    entityId: id,
    entityTitle: `${row.supplier_name} / ${row.supplier_part_number || row.canonical_part_number || `#${id}`}`,
    mode: MODE.TRASH,
    title: 'Деталь поставщика может быть перемещена в корзину',
    message: 'Будут скрыты связи, материалы и история цен этой детали поставщика.',
    affectedCounts: {
      supplier_part_materials: Number(materials.cnt || 0),
      supplier_part_oem_parts: Number(oemLinks.cnt || 0),
      supplier_part_standard_parts: Number(standardLinks.cnt || 0),
      supplier_part_prices: Number(prices.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewSupplierPartPrice(id) {
  const [[row]] = await db.execute(
    `
    SELECT
      spp.*,
      sp.supplier_part_number,
      ps.name AS supplier_name,
      m.name AS material_name
    FROM supplier_part_prices spp
    JOIN supplier_parts sp ON sp.id = spp.supplier_part_id
    JOIN part_suppliers ps ON ps.id = sp.supplier_id
    LEFT JOIN materials m ON m.id = spp.material_id
    WHERE spp.id = ?
    `,
    [id]
  )
  if (!row) return null

  const priceLabel =
    row.price != null
      ? `${Number(row.price).toFixed(2)} ${String(row.currency || '').trim()}`.trim()
      : `#${id}`
  const dateLabel =
    row.date instanceof Date
      ? row.date.toISOString().slice(0, 10)
      : String(row.date || '').slice(0, 10)
  const materialSuffix = row.material_name ? ` / ${row.material_name}` : ''

  return makeResponse({
    entityType: 'supplier_part_prices',
    entityId: id,
    entityTitle: `${row.supplier_name} / ${row.supplier_part_number || `Деталь #${row.supplier_part_id}`} / ${priceLabel}${dateLabel ? ` / ${dateLabel}` : ''}${materialSuffix}`,
    mode: MODE.TRASH,
    title: 'Запись цены может быть перемещена в корзину',
    message: 'Будет скрыта только выбранная запись истории цены.',
    allowedActions: ['trash'],
  })
}

async function previewSupplierPriceList(id) {
  const [[row]] = await db.execute(
    `
    SELECT spl.*, ps.name AS supplier_name
      FROM supplier_price_lists spl
      JOIN part_suppliers ps ON ps.id = spl.supplier_id
     WHERE spl.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [
    [lines],
    [generatedPrices],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_price_list_lines WHERE supplier_price_list_id = ?', [id]),
    db.execute(
      `SELECT COUNT(*) AS cnt
         FROM supplier_part_prices spp
         JOIN supplier_price_list_lines spll ON spll.id = spp.source_id
        WHERE spll.supplier_price_list_id = ?
          AND spp.source_type = 'PRICE_LIST'`,
      [id]
    ),
  ])

  if (String(row.status || '').toLowerCase() === 'active') {
    return makeResponse({
      entityType: 'supplier_price_lists',
      entityId: id,
      entityTitle: `${row.supplier_name} / ${row.list_name || row.list_code || `#${id}`}`,
      mode: MODE.FORBIDDEN,
      title: 'Активный прайс-лист нельзя удалить',
      message: 'Сначала активируйте другой прайс-лист или переведите текущий в неактивное состояние.',
      affectedCounts: {
        supplier_price_list_lines: Number(lines.cnt || 0),
        supplier_part_prices: Number(generatedPrices.cnt || 0),
      },
      blockingReasons: [
        { code: 'ACTIVE_PRICE_LIST', message: 'Прайс-лист сейчас активен' },
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'supplier_price_lists',
    entityId: id,
    entityTitle: `${row.supplier_name} / ${row.list_name || row.list_code || `#${id}`}`,
    mode: MODE.TRASH,
    title: 'Прайс-лист может быть перемещен в корзину',
    message: 'Будут скрыты строки прайс-листа и сгенерированные из него цены.',
    affectedCounts: {
      supplier_price_list_lines: Number(lines.cnt || 0),
      supplier_part_prices: Number(generatedPrices.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewSupplierPriceListLine(id) {
  const [[row]] = await db.execute(
    `
    SELECT spll.*, spl.status AS list_status, spl.list_name, spl.list_code, ps.name AS supplier_name
      FROM supplier_price_list_lines spll
      JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
      JOIN part_suppliers ps ON ps.id = spl.supplier_id
     WHERE spll.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [[generatedPrices]] = await db.execute(
    `SELECT COUNT(*) AS cnt
       FROM supplier_part_prices
      WHERE source_type = 'PRICE_LIST'
        AND source_id = ?`,
    [id]
  )

  if (String(row.list_status || '').toLowerCase() === 'active') {
    return makeResponse({
      entityType: 'supplier_price_list_lines',
      entityId: id,
      entityTitle: `${row.supplier_name} / ${row.supplier_part_number_raw || `Строка #${id}`}`,
      mode: MODE.FORBIDDEN,
      title: 'Строку активного прайс-листа нельзя удалить',
      message: 'Сначала переведите прайс-лист в неактивное состояние, затем удаляйте отдельные строки.',
      affectedCounts: {
        supplier_part_prices: Number(generatedPrices.cnt || 0),
      },
      blockingReasons: [
        { code: 'ACTIVE_PRICE_LIST', message: 'Строка принадлежит активному прайс-листу' },
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'supplier_price_list_lines',
    entityId: id,
    entityTitle: `${row.supplier_name} / ${row.supplier_part_number_raw || `Строка #${id}`}`,
    mode: MODE.TRASH,
    title: 'Строка прайс-листа может быть перемещена в корзину',
    message: 'Будет скрыта сама строка и сгенерированные из неё цены.',
    affectedCounts: {
      supplier_part_prices: Number(generatedPrices.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewSupplierPartOemLink(supplierPartId, params = {}) {
  const oemPartId = toId(params?.oem_part_id) || toId(params?.original_part_id)
  if (!oemPartId) {
    const err = new Error('Для preview supplier_part_oem_parts нужен oem_part_id/original_part_id')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT
      spo.*,
      sp.supplier_part_number,
      op.part_number AS oem_part_number
    FROM supplier_part_oem_parts spo
    JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
    JOIN oem_parts op ON op.id = spo.oem_part_id
    WHERE spo.supplier_part_id = ?
      AND spo.oem_part_id = ?
    `,
    [supplierPartId, oemPartId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'supplier_part_oem_parts',
    entityId: supplierPartId,
    entityTitle: `${row.supplier_part_number || `Supplier part #${supplierPartId}`} -> ${row.oem_part_number || `OEM #${oemPartId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Связь supplier part -> OEM может быть удалена',
    message: 'Будет удалена только связь. Карточки supplier part и OEM детали останутся в системе.',
    allowedActions: ['relation_delete'],
  })
}

async function previewSupplierPartStandardLink(supplierPartId, params = {}) {
  const standardPartId = toId(params?.standard_part_id)
  if (!standardPartId) {
    const err = new Error('Для preview supplier_part_standard_parts нужен standard_part_id')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT
      spsp.*,
      sp.supplier_part_number,
      std.display_name,
      std.designation
    FROM supplier_part_standard_parts spsp
    JOIN supplier_parts sp ON sp.id = spsp.supplier_part_id
    JOIN standard_parts std ON std.id = spsp.standard_part_id
    WHERE spsp.supplier_part_id = ?
      AND spsp.standard_part_id = ?
    `,
    [supplierPartId, standardPartId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'supplier_part_standard_parts',
    entityId: supplierPartId,
    entityTitle: `${row.supplier_part_number || `Supplier part #${supplierPartId}`} -> ${row.display_name || row.designation || `Standard #${standardPartId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Связь supplier part -> standard part может быть удалена',
    message: 'Будет удалена только связь. Карточки supplier part и standard part останутся в системе.',
    allowedActions: ['relation_delete'],
  })
}

async function previewSupplierPartMaterialLink(supplierPartId, params = {}) {
  const materialId = toId(params.material_id)
  if (!materialId) {
    const err = new Error('material_id is required for supplier_part_materials preview')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT spm.*,
           sp.supplier_part_number,
           m.name AS material_name,
           m.code AS material_code
      FROM supplier_part_materials spm
      JOIN supplier_parts sp ON sp.id = spm.supplier_part_id
      JOIN materials m ON m.id = spm.material_id
     WHERE spm.supplier_part_id = ?
       AND spm.material_id = ?
    `,
    [supplierPartId, materialId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'supplier_part_materials',
    entityId: supplierPartId,
    entityTitle: `${row.supplier_part_number || `Supplier part #${supplierPartId}`} / ${row.material_name || row.material_code || `Материал #${materialId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Материал будет отвязан от детали поставщика',
    message: 'Будет удалена только эта связь материала с деталью поставщика.',
    allowedActions: ['relation_delete'],
  })
}

async function previewOemUnitOverride(oemPartId, params = {}) {
  const unitId = toId(params?.unit_id)
  if (!unitId) {
    const err = new Error('Для preview oem_part_unit_overrides нужен unit_id')
    err.status = 400
    throw err
  }
  const [[row]] = await db.execute(
    `
    SELECT
      opuo.*,
      op.part_number,
      c.company_name,
      em.model_name,
      ceu.serial_number
    FROM oem_part_unit_overrides opuo
    JOIN oem_parts op ON op.id = opuo.oem_part_id
    JOIN client_equipment_units ceu ON ceu.id = opuo.client_equipment_unit_id
    JOIN clients c ON c.id = ceu.client_id
    JOIN equipment_models em ON em.id = ceu.equipment_model_id
    WHERE opuo.oem_part_id = ?
      AND opuo.client_equipment_unit_id = ?
    `,
    [oemPartId, unitId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'oem_part_unit_overrides',
    entityId: oemPartId,
    entityTitle: `${row.part_number || `OEM #${oemPartId}`} / ${row.company_name || 'Клиент'} / ${row.model_name || 'Модель'}${row.serial_number ? ` / ${row.serial_number}` : ''}`,
    mode: MODE.RELATION_DELETE,
    title: 'Machine-specific override может быть удалён',
    message: 'Будет удалён только override для выбранной машины клиента. Базовая применяемость OEM детали останется.',
    allowedActions: ['relation_delete'],
  })
}

async function previewOemUnitMaterialOverride(oemPartId, params = {}) {
  const unitId = toId(params?.unit_id)
  const materialId = toId(params?.material_id)
  if (!unitId || !materialId) {
    const err = new Error('Для preview oem_part_unit_material_overrides нужны unit_id и material_id')
    err.status = 400
    throw err
  }
  const [[row]] = await db.execute(
    `
    SELECT
      opumo.*,
      op.part_number,
      c.company_name,
      em.model_name,
      ceu.serial_number,
      m.name AS material_name,
      m.code AS material_code
    FROM oem_part_unit_material_overrides opumo
    JOIN oem_parts op ON op.id = opumo.oem_part_id
    JOIN client_equipment_units ceu ON ceu.id = opumo.client_equipment_unit_id
    JOIN clients c ON c.id = ceu.client_id
    JOIN equipment_models em ON em.id = ceu.equipment_model_id
    LEFT JOIN materials m ON m.id = opumo.material_id
    WHERE opumo.oem_part_id = ?
      AND opumo.client_equipment_unit_id = ?
      AND opumo.material_id = ?
    `,
    [oemPartId, unitId, materialId]
  )
  if (!row) return null

  const [[spec]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_part_unit_material_specs WHERE oem_part_id = ? AND client_equipment_unit_id = ? AND material_id = ?',
    [oemPartId, unitId, materialId]
  )

  return makeResponse({
    entityType: 'oem_part_unit_material_overrides',
    entityId: oemPartId,
    entityTitle: `${row.part_number || `OEM #${oemPartId}`} / ${row.material_name || row.material_code || `Материал #${materialId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Machine-specific материал может быть удалён',
    message: 'Будет удалён material override для выбранной машины клиента. Связанная machine-specific спецификация тоже будет удалена.',
    affectedCounts: {
      oem_part_unit_material_specs: Number(spec.cnt || 0),
    },
    allowedActions: ['relation_delete'],
  })
}

async function previewOemDocument(docId) {
  const [[row]] = await db.execute(
    `
    SELECT d.*, op.part_number
    FROM oem_part_documents d
    JOIN oem_parts op ON op.id = d.oem_part_id
    WHERE d.id = ?
    `,
    [docId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'oem_part_documents',
    entityId: docId,
    entityTitle: `${row.part_number || `OEM #${row.oem_part_id}`} / ${row.file_name || `Документ #${docId}`}`,
    mode: MODE.TRASH,
    title: 'Документ может быть перемещён в корзину',
    message: 'Из карточки детали исчезнет только запись документа. Файл физически не удаляется на этапе корзины и может быть восстановлен.',
    allowedActions: ['trash'],
  })
}

async function previewOemPresentationProfile(id) {
  const [[row]] = await db.execute(
    `
    SELECT opp.*, op.part_number
      FROM oem_part_presentation_profiles opp
      JOIN oem_parts op ON op.id = opp.oem_part_id
     WHERE opp.oem_part_id = ?
     LIMIT 1
    `,
    [id]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'oem_part_presentation_profiles',
    entityId: id,
    entityTitle: `${row.part_number} / presentation profile`,
    mode: MODE.RELATION_DELETE,
    title: 'Профиль представления будет удалён',
    message: 'Будет удалён только профиль представления для этой OEM детали.',
    allowedActions: ['relation_delete'],
  })
}

async function previewSupplierBundle(bundleId) {
  const [[row]] = await db.execute('SELECT * FROM supplier_bundles WHERE id = ?', [bundleId])
  if (!row) return null

  const [[items]] = await db.execute('SELECT COUNT(*) AS cnt FROM supplier_bundle_items WHERE bundle_id = ?', [bundleId])
  const [[links]] = await db.execute(
    `SELECT COUNT(*) AS cnt
       FROM supplier_bundle_item_links l
       JOIN supplier_bundle_items i ON i.id = l.item_id
      WHERE i.bundle_id = ?`,
    [bundleId]
  )

  return makeResponse({
    entityType: 'supplier_bundles',
    entityId: bundleId,
    entityTitle: row.title || row.name || `Комплект #${bundleId}`,
    mode: MODE.TRASH,
    title: 'Комплект может быть перемещён в корзину',
    message: 'Будут скрыты сам комплект, его роли и варианты. Если комплект используется в процессах, удаление всё равно будет заблокировано на этапе выполнения.',
    affectedCounts: {
      supplier_bundle_items: Number(items.cnt || 0),
      supplier_bundle_item_links: Number(links.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewSupplierBundleItem(itemId) {
  const [[row]] = await db.execute(
    `
    SELECT i.*, b.title AS bundle_title
    FROM supplier_bundle_items i
    JOIN supplier_bundles b ON b.id = i.bundle_id
    WHERE i.id = ?
    `,
    [itemId]
  )
  if (!row) return null

  const [[links]] = await db.execute('SELECT COUNT(*) AS cnt FROM supplier_bundle_item_links WHERE item_id = ?', [itemId])

  return makeResponse({
    entityType: 'supplier_bundle_items',
    entityId: itemId,
    entityTitle: `${row.bundle_title || `Комплект #${row.bundle_id}`} / ${row.role_label || `Роль #${itemId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Роль комплекта может быть удалена',
    message: 'Будет удалена только выбранная роль и её варианты. Сам комплект останется.',
    affectedCounts: {
      supplier_bundle_item_links: Number(links.cnt || 0),
    },
    allowedActions: ['relation_delete'],
  })
}

async function previewSupplierBundleItemLink(linkId) {
  const [[row]] = await db.execute(
    `
    SELECT
      l.*,
      i.role_label,
      b.title AS bundle_title,
      sp.supplier_part_number
    FROM supplier_bundle_item_links l
    JOIN supplier_bundle_items i ON i.id = l.item_id
    JOIN supplier_bundles b ON b.id = i.bundle_id
    JOIN supplier_parts sp ON sp.id = l.supplier_part_id
    WHERE l.id = ?
    `,
    [linkId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'supplier_bundle_item_links',
    entityId: linkId,
    entityTitle: `${row.bundle_title || `Комплект #${row.item_id}`} / ${row.role_label || 'Роль'} / ${row.supplier_part_number || `Supplier part #${row.supplier_part_id}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Вариант роли комплекта может быть удалён',
    message: 'Будет удалён только выбранный вариант. Комплект и роль останутся.',
    allowedActions: ['relation_delete'],
  })
}

async function previewTnvedCode(id) {
  const [[row]] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [id])
  if (!row) return null

  const [[oemParts]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM oem_parts WHERE tnved_code_id = ?',
    [id]
  )

  const oemCount = Number(oemParts.cnt || 0)
  if (oemCount > 0) {
    return makeResponse({
      entityType: 'tnved_codes',
      entityId: id,
      entityTitle: `${row.code}${row.description ? ` / ${row.description}` : ''}`,
      mode: MODE.FORBIDDEN,
      title: 'Код ТН ВЭД используется в каталоге',
      message: 'Сначала снимите этот код с OEM деталей, затем удаляйте его.',
      affectedCounts: {
        oem_parts: oemCount,
      },
      blockingReasons: [
        { code: 'TNVED_IN_USE', message: 'Код ТН ВЭД привязан к OEM деталям' },
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'tnved_codes',
    entityId: id,
    entityTitle: `${row.code}${row.description ? ` / ${row.description}` : ''}`,
    mode: MODE.TRASH,
    title: 'Код ТН ВЭД может быть перемещён в корзину',
    message: 'Запись будет скрыта из справочника и её можно будет восстановить из корзины.',
    allowedActions: ['trash'],
  })
}

async function previewLogisticsRouteTemplate(id) {
  const [[row]] = await db.execute(
    `
    SELECT rt.*, c.name AS corridor_name
      FROM logistics_route_templates rt
      LEFT JOIN logistics_corridors c ON c.id = rt.corridor_id
     WHERE rt.id = ?
    `,
    [id]
  )
  if (!row) return null

  const [[supplierParts]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM supplier_parts WHERE default_logistics_route_id = ?',
    [id]
  )

  const partCount = Number(supplierParts.cnt || 0)
  if (partCount > 0) {
    return makeResponse({
      entityType: 'logistics_route_templates',
      entityId: id,
      entityTitle: row.name || row.code || `Шаблон доставки #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Шаблон доставки используется в деталях поставщика',
      message: 'Сначала отвяжите шаблон от деталей поставщика, затем удаляйте его.',
      affectedCounts: {
        supplier_parts: partCount,
      },
      blockingReasons: [
        { code: 'ROUTE_TEMPLATE_IN_USE', message: 'Шаблон используется как default route у деталей поставщика' },
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'logistics_route_templates',
    entityId: id,
    entityTitle: row.name || row.code || `Шаблон доставки #${id}`,
    mode: MODE.TRASH,
    title: 'Шаблон доставки может быть перемещён в корзину',
    message: 'Шаблон будет скрыт из справочника и его можно будет восстановить из корзины.',
    allowedActions: ['trash'],
  })
}

async function previewMaterial(id) {
  const [[row]] = await db.execute('SELECT * FROM materials WHERE id = ?', [id])
  if (!row) return null

  const [
    [properties],
    [curves],
    [aliases],
    [oemLinks],
    [supplierLinks],
    [defaultSupplierParts],
    [unitOverrides],
    [unitSpecs],
    [matchedPriceLines],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM material_properties WHERE material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM material_property_curves WHERE material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM material_aliases WHERE material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_materials WHERE material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_part_materials WHERE material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_parts WHERE default_material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_unit_material_overrides WHERE material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_unit_material_specs WHERE material_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_price_list_lines WHERE matched_material_id = ?', [id]),
  ])

  const blockingCounts = {
    oem_part_materials: Number(oemLinks.cnt || 0),
    supplier_part_materials: Number(supplierLinks.cnt || 0),
    supplier_parts: Number(defaultSupplierParts.cnt || 0),
    oem_part_unit_material_overrides: Number(unitOverrides.cnt || 0),
    oem_part_unit_material_specs: Number(unitSpecs.cnt || 0),
    supplier_price_list_lines: Number(matchedPriceLines.cnt || 0),
  }
  const totalBlocking = Object.values(blockingCounts).reduce((sum, value) => sum + Number(value || 0), 0)

  if (totalBlocking > 0) {
    return makeResponse({
      entityType: 'materials',
      entityId: id,
      entityTitle: row.name || row.code || `Материал #${id}`,
      mode: MODE.FORBIDDEN,
      title: 'Материал используется в каталоге',
      message: 'Сначала снимите материал со связанных деталей и overrides, затем удаляйте его.',
      affectedCounts: {
        material_properties: Number(properties.cnt || 0),
        material_property_curves: Number(curves.cnt || 0),
        material_aliases: Number(aliases.cnt || 0),
        ...blockingCounts,
      },
      blockingReasons: [
        { code: 'MATERIAL_IN_USE', message: 'Материал используется в OEM, supplier parts или unit overrides' },
      ],
      allowedActions: [],
    })
  }

  return makeResponse({
    entityType: 'materials',
    entityId: id,
    entityTitle: row.name || row.code || `Материал #${id}`,
    mode: MODE.TRASH,
    title: 'Материал может быть перемещён в корзину',
    message: 'Будут сохранены свойства, кривые и алиасы материала.',
    affectedCounts: {
      material_properties: Number(properties.cnt || 0),
      material_property_curves: Number(curves.cnt || 0),
      material_aliases: Number(aliases.cnt || 0),
    },
    allowedActions: ['trash'],
  })
}

async function previewClientRequest(id) {
  const [[request]] = await db.execute('SELECT * FROM client_requests WHERE id = ?', [id])
  if (!request) return null

  const [
    [revisions],
    [items],
    [rfqs],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM client_request_revisions WHERE client_request_id = ?', [id]),
    db.execute(
      `SELECT COUNT(*) AS cnt
         FROM client_request_revision_items cri
         JOIN client_request_revisions cr ON cr.id = cri.client_request_revision_id
        WHERE cr.client_request_id = ?`,
      [id]
    ),
    db.execute('SELECT COUNT(*) AS cnt FROM rfqs WHERE client_request_id = ?', [id]),
  ])

  const status = String(request.status || '').trim().toLowerCase()
  const rfqCount = Number(rfqs[0]?.cnt || 0)

  if (status === 'draft' && rfqCount === 0) {
    return makeResponse({
      entityType: 'client_requests',
      entityId: id,
      entityTitle: request.internal_number,
      mode: MODE.TRASH,
      title: 'Черновик заявки можно переместить в корзину',
      message: 'Черновая заявка еще не ушла в downstream-процесс.',
      affectedCounts: {
        client_request_revisions: Number(revisions[0]?.cnt || 0),
        client_request_revision_items: Number(items[0]?.cnt || 0),
        rfqs: rfqCount,
      },
      allowedActions: ['trash'],
    })
  }

  return makeResponse({
    entityType: 'client_requests',
    entityId: id,
    entityTitle: request.internal_number,
    mode: MODE.ARCHIVE_ONLY,
    title: 'Заявка уже участвует в бизнес-процессе',
    message: 'Удаление в корзину недоступно. Используйте закрытие, отмену или архивирование.',
    affectedCounts: {
      client_request_revisions: Number(revisions[0]?.cnt || 0),
      client_request_revision_items: Number(items[0]?.cnt || 0),
      rfqs: rfqCount,
    },
    activeProcesses: {
      client_request_status: status,
      rfqs_total: rfqCount,
    },
    blockingReasons: [
      { code: 'PROCESS_ENTITY', message: 'Заявка уже находится в process flow и не должна удаляться как обычная карточка' },
    ],
    allowedActions: ['archive', 'close', 'cancel'],
  })
}

async function previewRfq(id) {
  const [[rfq]] = await db.execute('SELECT * FROM rfqs WHERE id = ?', [id])
  if (!rfq) return null

  const [
    [items],
    [suppliers],
    [responses],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM rfq_items WHERE rfq_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM rfq_suppliers WHERE rfq_id = ?', [id]),
    db.execute(
      `SELECT COUNT(*) AS cnt
         FROM rfq_supplier_responses rsr
         JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
        WHERE rs.rfq_id = ?`,
      [id]
    ),
  ])

  const status = String(rfq.status || '').trim().toLowerCase()
  const responseCount = Number(responses[0]?.cnt || 0)

  if (status === 'draft' && responseCount === 0) {
    return makeResponse({
      entityType: 'rfqs',
      entityId: id,
      entityTitle: rfq.rfq_number || `RFQ #${id}`,
      mode: MODE.TRASH,
      title: 'Черновик RFQ можно переместить в корзину',
      message: 'RFQ еще не получил ответов и может быть удален как ранний черновик.',
      affectedCounts: {
        rfq_items: Number(items[0]?.cnt || 0),
        rfq_suppliers: Number(suppliers[0]?.cnt || 0),
        rfq_supplier_responses: responseCount,
      },
      allowedActions: ['trash'],
    })
  }

  return makeResponse({
    entityType: 'rfqs',
    entityId: id,
    entityTitle: rfq.rfq_number || `RFQ #${id}`,
    mode: MODE.ARCHIVE_ONLY,
    title: 'RFQ уже участвует в бизнес-процессе',
    message: 'Удаление в корзину недоступно. Используйте закрытие, отмену или архивирование RFQ.',
    affectedCounts: {
      rfq_items: Number(items[0]?.cnt || 0),
      rfq_suppliers: Number(suppliers[0]?.cnt || 0),
      rfq_supplier_responses: responseCount,
    },
    activeProcesses: {
      rfq_status: status,
      rfq_supplier_responses: responseCount,
    },
    blockingReasons: [
      { code: 'PROCESS_ENTITY', message: 'RFQ уже является частью process flow' },
    ],
    allowedActions: ['archive', 'close', 'cancel'],
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
    [standardLinks],
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
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_standard_parts WHERE oem_part_id = ?', [id]),
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
    oem_part_standard_parts: Number(standardLinks[0]?.cnt || 0),
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
  ])

  const affectedCounts = {
    oem_part_unit_overrides: Number(unitOverrides[0]?.cnt || 0),
    oem_part_unit_material_overrides: Number(unitMaterialOverrides[0]?.cnt || 0),
    oem_part_unit_material_specs: Number(unitMaterialSpecs[0]?.cnt || 0),
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

async function previewStandardPart(id) {
  const [[part]] = await db.execute('SELECT * FROM standard_parts WHERE id = ?', [id])
  if (!part) return null

  const [
    [values],
    [oemLinks],
    [supplierLinks],
    [activeRfqItems],
  ] = await Promise.all([
    db.execute('SELECT COUNT(*) AS cnt FROM standard_part_values WHERE standard_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM oem_part_standard_parts WHERE standard_part_id = ?', [id]),
    db.execute('SELECT COUNT(*) AS cnt FROM supplier_part_standard_parts WHERE standard_part_id = ?', [id]),
    db.execute(
      `SELECT COUNT(*) AS cnt
         FROM rfq_items ri
         JOIN rfqs r ON r.id = ri.rfq_id
        WHERE ri.standard_part_id = ?
          AND r.status IN ('draft', 'structured', 'sent')`,
      [id]
    ),
  ])

  const activeUsage = Number(activeRfqItems[0]?.cnt || 0)
  const affectedCounts = {
    standard_part_values: Number(values[0]?.cnt || 0),
    oem_part_standard_parts: Number(oemLinks[0]?.cnt || 0),
    supplier_part_standard_parts: Number(supplierLinks[0]?.cnt || 0),
  }

  if (activeUsage > 0) {
    return makeResponse({
      entityType: 'standard_parts',
      entityId: id,
      entityTitle: part.display_name,
      mode: MODE.ARCHIVE_ONLY,
      title: 'Standard part используется в активных процессах',
      message: 'Удаление в корзину недоступно. Используйте архивирование или деактивацию.',
      affectedCounts,
      activeProcesses: {
        rfq_item_usage: activeUsage,
      },
      blockingReasons: [
        { code: 'ACTIVE_PROCESS_USAGE', message: 'Standard part участвует в активных RFQ' },
      ],
      allowedActions: ['archive'],
    })
  }

  return makeResponse({
    entityType: 'standard_parts',
    entityId: id,
    entityTitle: part.display_name,
    mode: MODE.TRASH,
    title: 'Standard part может быть перемещена в корзину',
    message: 'Удаление допускается при отсутствии активного использования в процессе.',
    affectedCounts,
    allowedActions: ['trash'],
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

async function previewOemPartStandardLink(oemPartId, params = {}) {
  const standardPartId = toId(params.standard_part_id)
  if (!standardPartId) {
    const err = new Error('standard_part_id is required for oem_part_standard_parts preview')
    err.status = 400
    throw err
  }

  const [[row]] = await db.execute(
    `
    SELECT opsp.*,
           op.part_number AS oem_part_number,
           sp.display_name,
           sp.designation
      FROM oem_part_standard_parts opsp
      JOIN oem_parts op ON op.id = opsp.oem_part_id
      JOIN standard_parts sp ON sp.id = opsp.standard_part_id
     WHERE opsp.oem_part_id = ?
       AND opsp.standard_part_id = ?
    `,
    [oemPartId, standardPartId]
  )
  if (!row) return null

  return makeResponse({
    entityType: 'oem_part_standard_parts',
    entityId: oemPartId,
    entityTitle: `${row.oem_part_number} / ${row.display_name || row.designation || `Standard part #${standardPartId}`}`,
    mode: MODE.RELATION_DELETE,
    title: 'Связь OEM со standard part будет удалена',
    message: 'Будет удалена только эта связь OEM со standard part.',
    allowedActions: ['relation_delete'],
  })
}

async function previewOemPartBom(parentId, params = {}) {
  const childId = toId(params.child_part_id)
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
    ORDER BY b.equipment_model_id ASC
    LIMIT 1
    `,
    [parentId, childId]
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
    case 'supplier_part_standard_parts':
      return previewSupplierPartStandardLink(entityId, params)
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
    case 'standard_parts':
      return previewStandardPart(entityId)
    case 'oem_part_materials':
      return previewOemPartMaterial(entityId, params)
    case 'oem_part_material_specs':
      return previewOemPartMaterialSpec(entityId, params)
    case 'oem_part_standard_parts':
      return previewOemPartStandardLink(entityId, params)
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
    case 'equipment_classifier_nodes':
      return previewEquipmentClassifierNode(entityId)
    case 'standard_part_classes':
      return previewStandardPartClass(entityId)
    case 'standard_part_class_fields':
      return previewStandardPartClassField(entityId)
    case 'standard_part_field_options':
      return previewStandardPartFieldOption(entityId)
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
