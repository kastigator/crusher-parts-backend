const db = require('./db')

const clampLimit = (value, fallback = 8, max = 25) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.trunc(n), max)
}

const likePattern = (value) => `%${String(value || '').trim()}%`

const normalizeSearchVariants = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return []
  const compact = raw.replace(/[\s\-_.\\/]+/g, '')
  const spaced = raw.replace(/[-_.\\/]+/g, ' ')
  const variants = [raw, compact, spaced]
  return [...new Set(variants.map((item) => item.trim()).filter(Boolean))]
}

const buildLikeClause = (columns, variants, params) => {
  const parts = []
  columns.forEach((column) => {
    variants.forEach((variant) => {
      parts.push(`${column} LIKE ?`)
      params.push(likePattern(variant))
    })
  })
  return `(${parts.join(' OR ')})`
}

const STATUS_LABELS = {
  draft: 'Черновик',
  new: 'Новая',
  in_progress: 'В работе',
  sent: 'Отправлен',
  contracted: 'Законтрактовано',
  quote_prepared: 'КП подготовлено',
  responses_received: 'Получены ответы',
  rfq_created: 'RFQ создан',
  selection_done: 'Выбор закупки сделан',
  rfq_sent: 'RFQ отправлен',
  rfq_assigned: 'Назначена в закупку',
  sent_to_supplier: 'Отправлена поставщику',
  supplier_responses_received: 'Получены ответы поставщиков',
  sent_to_client: 'Отправлено клиенту',
  contract_signed: 'Контракт подписан',
  signed: 'Подписан',
  in_execution: 'В исполнении',
  completed: 'Завершен',
  closed_with_issues: 'Закрыт с замечаниями',
  cancelled: 'Отменен',
  archived: 'Архив',
}

const humanStatus = (status) => STATUS_LABELS[String(status || '').trim()] || status || '—'

const normalizeDutyRate = (value) => {
  if (value === null || value === undefined || value === '') return null
  const normalized = String(value).replace('%', '').replace(',', '.').trim()
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

const buildObjectLink = (type, id) => {
  if (!id) return null
  if (type === 'client') return 'раздел "Клиенты", карточка клиента'
  if (type === 'client_request') return 'раздел "Client Request Workspace", карточка заявки'
  if (type === 'rfq') return 'раздел "RFQ Workspace", карточка RFQ'
  if (type === 'sales_quote') return 'раздел "RFQ Workspace", блок КП клиенту'
  if (type === 'client_contract') return 'раздел "RFQ Workspace", блок контрактов'
  if (type === 'supplier_purchase_order') return 'раздел "RFQ Workspace", блок заказов поставщикам'
  if (type === 'oem_part') return 'Каталоги -> OEM детали'
  if (type === 'supplier_part') return 'Каталоги -> Детали поставщиков'
  if (type === 'standard_part') return 'Каталоги -> Стандартные детали'
  if (type === 'material') return 'Каталоги -> Материалы'
  if (type === 'tnved_code') return 'Каталоги -> Коды ТН ВЭД'
  return null
}

const MEASUREMENT_UNIT_USAGE_SOURCES = [
  { key: 'oem_parts.uom', label: 'OEM детали', table: 'oem_parts', field: 'uom' },
  { key: 'oem_part_model_fitments.uom', label: 'Применяемость OEM по моделям', table: 'oem_part_model_fitments', field: 'uom' },
  { key: 'standard_parts.uom', label: 'Стандартные детали', table: 'standard_parts', field: 'uom' },
  { key: 'supplier_parts.uom', label: 'Детали поставщиков', table: 'supplier_parts', field: 'uom' },
  { key: 'rfq_items.uom', label: 'Позиции RFQ', table: 'rfq_items', field: 'uom' },
  { key: 'rfq_supplier_line_selections.uom', label: 'Строки поставщиков в RFQ', table: 'rfq_supplier_line_selections', field: 'uom' },
  { key: 'rfq_coverage_option_lines.uom', label: 'Покрытие RFQ', table: 'rfq_coverage_option_lines', field: 'uom' },
  { key: 'client_request_revision_items.uom', label: 'Позиции заявок клиентов', table: 'client_request_revision_items', field: 'uom' },
  { key: 'material_properties.unit', label: 'Свойства материалов', table: 'material_properties', field: 'unit' },
  { key: 'standard_part_class_fields.unit', label: 'Поля классов стандартных деталей', table: 'standard_part_class_fields', field: 'unit' },
  { key: 'rfq_econ2_scenario_other_costs.unit', label: 'Прочие расходы экономики RFQ', table: 'rfq_econ2_scenario_other_costs', field: 'unit' },
  { key: 'supplier_procurement_rules.enforce_uom', label: 'Правила закупки поставщика', table: 'supplier_procurement_rules', field: 'enforce_uom' },
]

const mapBusinessObject = (row) => ({
  type: row.type,
  label: row.label,
  id: row.id,
  title: row.title,
  description: row.description || null,
  section: row.section,
  open_in_interface: buildObjectLink(row.type, row.id),
})

const getBusinessSnapshot = async () => {
  const [[counts]] = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM clients) AS clients,
      (SELECT COUNT(*) FROM part_suppliers) AS suppliers,
      (SELECT COUNT(*) FROM supplier_parts) AS supplier_parts,
      (SELECT COUNT(*) FROM oem_parts) AS oem_parts,
      (SELECT COUNT(*) FROM standard_parts) AS standard_parts,
      (SELECT COUNT(*) FROM materials) AS materials,
      (SELECT COUNT(*) FROM client_requests) AS client_requests,
      (SELECT COUNT(*) FROM rfqs) AS rfqs,
      (SELECT COUNT(*) FROM rfq_supplier_responses) AS supplier_responses,
      (SELECT COUNT(*) FROM sales_quotes) AS sales_quotes,
      (SELECT COUNT(*) FROM client_contracts) AS client_contracts,
      (SELECT COUNT(*) FROM supplier_purchase_orders) AS purchase_orders
  `)

  const [recentRequests] = await db.execute(`
    SELECT cr.id,
           cr.internal_number,
           cr.status,
           cr.created_at,
           c.company_name AS client_name
      FROM client_requests cr
      JOIN clients c ON c.id = cr.client_id
     ORDER BY cr.created_at DESC
     LIMIT 8
  `)

  const [recentRfqs] = await db.execute(`
    SELECT r.id,
           r.rfq_number,
           r.status,
           r.created_at,
           c.company_name AS client_name
      FROM rfqs r
      JOIN client_requests cr ON cr.id = r.client_request_id
      JOIN clients c ON c.id = cr.client_id
     ORDER BY r.created_at DESC
     LIMIT 8
  `)

  return {
    counts: counts || {},
    recent_client_requests: recentRequests,
    recent_rfqs: recentRfqs,
  }
}

const getCatalogHealthSummary = async () => {
  const [[counts]] = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM equipment_models WHERE classifier_node_id IS NULL) AS equipment_models_without_classifier,
      (
        SELECT COUNT(*)
          FROM oem_parts op
          LEFT JOIN oem_part_standard_parts link ON link.oem_part_id = op.id
         WHERE link.oem_part_id IS NULL
      ) AS oem_without_standard_link,
      (
        SELECT COUNT(*)
          FROM supplier_parts sp
          LEFT JOIN supplier_part_standard_parts link ON link.supplier_part_id = sp.id
         WHERE link.supplier_part_id IS NULL
      ) AS supplier_parts_without_standard_link,
      (
        SELECT COUNT(*)
          FROM oem_parts op
          LEFT JOIN (
            SELECT oem_part_id,
                   MAX(weight_kg IS NOT NULL) AS has_weight,
                   MAX(length_cm IS NOT NULL AND width_cm IS NOT NULL AND height_cm IS NOT NULL) AS has_dimensions
              FROM oem_part_model_fitments
             GROUP BY oem_part_id
          ) fit ON fit.oem_part_id = op.id
         WHERE COALESCE(fit.has_weight, 0) = 0
            OR COALESCE(fit.has_dimensions, 0) = 0
      ) AS oem_missing_logistics,
      (
        SELECT COUNT(*)
          FROM supplier_parts sp
         WHERE sp.weight_kg IS NULL
            OR sp.length_cm IS NULL
            OR sp.width_cm IS NULL
            OR sp.height_cm IS NULL
      ) AS supplier_parts_missing_logistics,
      (
        SELECT COUNT(*)
          FROM standard_part_classes c
          LEFT JOIN standard_part_class_fields f ON f.class_id = c.id
         WHERE f.id IS NULL
      ) AS standard_classes_without_fields,
      (
        SELECT COUNT(*)
          FROM standard_parts sp
          LEFT JOIN oem_part_standard_parts ol ON ol.standard_part_id = sp.id
          LEFT JOIN supplier_part_standard_parts sl ON sl.standard_part_id = sp.id
         WHERE ol.standard_part_id IS NULL
           AND sl.standard_part_id IS NULL
      ) AS standard_parts_without_links
  `)

  const [topQueues] = await db.execute(`
    SELECT 'equipment_model_without_classifier' AS type,
           em.id,
           em.model_name AS title,
           m.name AS subtitle
      FROM equipment_models em
      JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
     WHERE em.classifier_node_id IS NULL
     ORDER BY em.id DESC
     LIMIT 8
  `)

  return {
    counts: counts || {},
    examples: topQueues,
  }
}

const getOpenContracts = async ({ limit } = {}) => {
  const safeLimit = clampLimit(limit, 12, 40)

  const [[counts]] = await db.execute(`
    SELECT
      COUNT(*) AS total,
      SUM(cc.status = 'draft') AS draft,
      SUM(cc.status = 'sent_to_client') AS sent_to_client,
      SUM(cc.status = 'signed') AS signed,
      SUM(cc.status = 'in_execution') AS in_execution,
      SUM(cc.status = 'completed') AS completed,
      SUM(cc.status = 'closed_with_issues') AS closed_with_issues,
      SUM(cc.status = 'cancelled') AS cancelled
    FROM client_contracts cc
  `)

  const [rows] = await db.execute(
    `
    SELECT cc.id,
           cc.contract_number,
           cc.contract_date,
           cc.status,
           cc.amount,
           cc.currency,
           cc.created_at,
           c.company_name AS client_name,
           sq.id AS sales_quote_id,
           sq.selection_id,
           cr.client_request_id,
           (
             SELECT COUNT(*)
               FROM supplier_purchase_orders po
              WHERE po.selection_id = sq.selection_id
                AND po.status <> 'cancelled'
           ) AS purchase_orders_total,
           (
             SELECT COUNT(*)
               FROM supplier_purchase_orders po
              WHERE po.selection_id = sq.selection_id
                AND po.status = 'confirmed'
           ) AS purchase_orders_confirmed
      FROM client_contracts cc
      JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
      JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
      JOIN clients c ON c.id = req.client_id
     WHERE cc.status NOT IN ('completed', 'closed_with_issues', 'cancelled')
     ORDER BY cc.contract_date DESC, cc.id DESC
     LIMIT ${safeLimit}
    `
  )

  return {
    counts: {
      total: Number(counts?.total || 0),
      draft: Number(counts?.draft || 0),
      sent_to_client: Number(counts?.sent_to_client || 0),
      signed: Number(counts?.signed || 0),
      in_execution: Number(counts?.in_execution || 0),
      completed: Number(counts?.completed || 0),
      closed_with_issues: Number(counts?.closed_with_issues || 0),
      cancelled: Number(counts?.cancelled || 0),
    },
    open_contracts: rows.map((row) => ({
      ...row,
      status_label: humanStatus(row.status),
      open_in_interface: buildObjectLink('client_contract', row.id),
    })),
    status_labels: STATUS_LABELS,
    answer_policy:
      'Показывай пользователю status_label, а не технический status. В списке контрактов называй клиента, номер, сумму и статус по-русски.',
  }
}

const findTnvedAssignmentCandidates = async ({ tnved_code, part_numbers, query, limit } = {}) => {
  const safeLimit = clampLimit(limit, 10, 30)
  const code = String(tnved_code || '').trim()
  const partNumbers = Array.isArray(part_numbers)
    ? part_numbers.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const fallbackQuery = String(query || '').trim()

  let tnvedRows = []
  if (code) {
    const [rows] = await db.execute(
      `
      SELECT id, code, description, duty_rate
        FROM tnved_codes
       WHERE code = ? OR code LIKE ?
       ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END, LENGTH(code), code
       LIMIT 10
      `,
      [code, likePattern(code), code]
    )
    tnvedRows = rows
  }

  if (!tnvedRows.length && fallbackQuery) {
    const params = []
    const variants = normalizeSearchVariants(fallbackQuery)
    const [rows] = await db.execute(
      `
      SELECT id, code, description, duty_rate
        FROM tnved_codes
       WHERE ${buildLikeClause(['code', 'description'], variants, params)}
       ORDER BY LENGTH(code), code
       LIMIT 10
      `,
      params
    )
    tnvedRows = rows
  }

  const partVariants = partNumbers.length
    ? partNumbers.flatMap((item) => normalizeSearchVariants(item))
    : normalizeSearchVariants(fallbackQuery)

  let oemParts = []
  if (partVariants.length) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT p.id,
             p.part_number,
             p.description_ru,
             p.description_en,
             p.tnved_code_id,
             tc.code AS current_tnved_code,
             m.name AS manufacturer_name
        FROM oem_parts p
        LEFT JOIN equipment_manufacturers m ON m.id = p.manufacturer_id
        LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
       WHERE ${buildLikeClause(['p.part_number', 'p.description_ru', 'p.description_en'], partVariants, params)}
       ORDER BY p.part_number
       LIMIT ${safeLimit}
      `,
      params
    )
    oemParts = rows
  }

  return {
    requested_tnved_code: code || null,
    requested_part_numbers: partNumbers,
    tnved_candidates: tnvedRows,
    oem_part_candidates: oemParts,
    can_execute:
      tnvedRows.length === 1 &&
      oemParts.length > 0 &&
      oemParts.every((part) => Number(part.tnved_code_id || 0) !== Number(tnvedRows[0].id)),
    execution_hint:
      'Ничего не меняй без подтверждения пользователя. Покажи найденный код, детали и что будет изменено.',
  }
}

const listTnvedCodesByDutyRate = async ({ duty_rate, min_rate, max_rate, limit } = {}) => {
  const safeLimit = clampLimit(limit, 20, 100)
  const exactRate = normalizeDutyRate(duty_rate)
  const minRate = normalizeDutyRate(min_rate)
  const maxRate = normalizeDutyRate(max_rate)

  const where = []
  const params = []
  let mode = 'all'

  if (exactRate !== null) {
    where.push('ABS(COALESCE(duty_rate, -999999) - ?) < 0.0001')
    params.push(exactRate)
    mode = 'exact'
  } else {
    if (minRate !== null) {
      where.push('duty_rate >= ?')
      params.push(minRate)
      mode = 'range'
    }
    if (maxRate !== null) {
      where.push('duty_rate <= ?')
      params.push(maxRate)
      mode = 'range'
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [[summary]] = await db.execute(
    `
    SELECT COUNT(*) AS total
      FROM tnved_codes
      ${whereSql}
    `,
    params
  )

  const [rows] = await db.execute(
    `
    SELECT id,
           code,
           description,
           duty_rate,
           notes
      FROM tnved_codes
      ${whereSql}
     ORDER BY LENGTH(code), code
     LIMIT ${safeLimit}
    `,
    params
  )

  return {
    filter: {
      mode,
      duty_rate: exactRate,
      min_rate: minRate,
      max_rate: maxRate,
    },
    total: Number(summary?.total || 0),
    shown: rows.length,
    codes: rows.map((row) => ({
      label: 'Код ТН ВЭД',
      code: row.code,
      description: row.description || null,
      duty_rate_percent: row.duty_rate === null || row.duty_rate === undefined ? null : Number(row.duty_rate),
      note: row.notes || null,
      where_to_open: buildObjectLink('tnved_code', row.id),
    })),
    answer_policy:
      'Ответь как справочник ТН ВЭД. Показывай код, описание и пошлину в процентах. Не говори про техническое поле duty_rate.',
  }
}

const searchSystemRecords = async ({ query, limit } = {}) => {
  const q = String(query || '').trim()
  if (!q) return { query: q, results: [] }
  const safeLimit = clampLimit(limit, 8, 20)
  const variants = normalizeSearchVariants(q)

  const clientParams = []
  const [clients] = await db.execute(
    `
    SELECT 'client' AS type,
           id,
           company_name AS title,
           CONCAT_WS(' / ', contact_person, phone, email, tax_id, registration_number) AS subtitle
      FROM clients
     WHERE ${buildLikeClause(['company_name', 'contact_person', 'phone', 'email', 'tax_id', 'registration_number'], variants, clientParams)}
     ORDER BY company_name
     LIMIT ${safeLimit}
    `,
    clientParams
  )

  const supplierParams = []
  const [suppliers] = await db.execute(
    `
    SELECT 'supplier' AS type,
           ps.id,
           ps.name AS title,
           CONCAT_WS(' / ', ps.vat_number, ps.public_code, sa.country, sc.name, sc.email, sc.phone) AS subtitle
      FROM part_suppliers ps
      LEFT JOIN supplier_addresses sa ON sa.id = (
        SELECT sa2.id FROM supplier_addresses sa2
         WHERE sa2.supplier_id = ps.id
         ORDER BY sa2.is_primary DESC, sa2.created_at DESC, sa2.id DESC
         LIMIT 1
      )
      LEFT JOIN supplier_contacts sc ON sc.id = (
        SELECT sc2.id FROM supplier_contacts sc2
         WHERE sc2.supplier_id = ps.id
         ORDER BY sc2.is_primary DESC, sc2.created_at DESC, sc2.id DESC
         LIMIT 1
      )
     WHERE ${buildLikeClause(['ps.name', 'ps.vat_number', 'ps.public_code', 'sa.country', 'sc.name', 'sc.email', 'sc.phone'], variants, supplierParams)}
     ORDER BY ps.name
     LIMIT ${safeLimit}
    `,
    supplierParams
  )

  const oemParams = []
  const [oemParts] = await db.execute(
    `
    SELECT 'oem_part' AS type,
           p.id,
           p.part_number AS title,
           CONCAT_WS(' / ', p.description_ru, p.description_en, m.name) AS subtitle
      FROM oem_parts p
      LEFT JOIN equipment_manufacturers m ON m.id = p.manufacturer_id
     WHERE ${buildLikeClause(['p.part_number', 'p.description_ru', 'p.description_en', 'm.name'], variants, oemParams)}
     ORDER BY p.part_number
     LIMIT ${safeLimit}
    `,
    oemParams
  )

  const supplierPartParams = []
  const [supplierParts] = await db.execute(
    `
    SELECT 'supplier_part' AS type,
           sp.id,
           sp.supplier_part_number AS title,
           CONCAT_WS(' / ', sp.description_ru, sp.description_en, ps.name) AS subtitle
      FROM supplier_parts sp
      LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
     WHERE ${buildLikeClause(['sp.supplier_part_number', 'sp.description_ru', 'sp.description_en', 'ps.name'], variants, supplierPartParams)}
     ORDER BY sp.supplier_part_number
     LIMIT ${safeLimit}
    `,
    supplierPartParams
  )

  const standardPartParams = []
  const [standardParts] = await db.execute(
    `
    SELECT 'standard_part' AS type,
           sp.id,
           COALESCE(sp.display_name, sp.designation, CONCAT('Standard part #', sp.id)) AS title,
           CONCAT_WS(' / ', sp.designation, sp.description_ru, sp.description_en, c.name) AS subtitle
      FROM standard_parts sp
      LEFT JOIN standard_part_classes c ON c.id = sp.class_id
     WHERE ${buildLikeClause(['sp.display_name', 'sp.designation', 'sp.description_ru', 'sp.description_en', 'c.name'], variants, standardPartParams)}
     ORDER BY sp.id DESC
     LIMIT ${safeLimit}
    `,
    standardPartParams
  )

  const materialParams = []
  const [materials] = await db.execute(
    `
    SELECT 'material' AS type,
           m.id,
           m.name AS title,
           CONCAT_WS(' / ', m.code, m.standard, c.name) AS subtitle
      FROM materials m
      LEFT JOIN material_categories c ON c.id = m.category_id
     WHERE ${buildLikeClause(['m.name', 'm.code', 'm.standard', 'm.description', 'c.name'], variants, materialParams)}
     ORDER BY m.name
     LIMIT ${safeLimit}
    `,
    materialParams
  )

  const tnvedParams = []
  const [tnvedCodes] = await db.execute(
    `
    SELECT 'tnved_code' AS type,
           id,
           code AS title,
           description AS subtitle
      FROM tnved_codes
     WHERE ${buildLikeClause(['code', 'description'], variants, tnvedParams)}
     ORDER BY LENGTH(code), code
     LIMIT ${safeLimit}
    `,
    tnvedParams
  )

  return {
    query: q,
    results: [
      ...clients,
      ...suppliers,
      ...oemParts,
      ...supplierParts,
      ...standardParts,
      ...materials,
      ...tnvedCodes,
    ].slice(0, safeLimit * 6),
  }
}

const searchBusinessObjects = async ({ query, object_type, limit } = {}) => {
  const q = String(query || '').trim()
  if (!q) return { query: q, objects: [], note: 'Нужна строка поиска.' }

  const safeLimit = clampLimit(limit, 6, 15)
  const variants = normalizeSearchVariants(q)
  const requestedType = String(object_type || 'all').trim().toLowerCase()
  const typeAliases = {
    client: ['clients', 'customer', 'customers', 'клиент', 'клиенты'],
    supplier: ['suppliers', 'поставщик', 'поставщики'],
    oem_part: ['oem', 'oem_parts', 'original_part', 'original_parts', 'оригинальная', 'оригинальные', 'оэм'],
    supplier_part: ['supplier_parts', 'деталь_поставщика', 'детали_поставщика'],
    standard_part: ['standard_parts', 'стандартная', 'стандартные', 'крепеж', 'крепёж'],
    material: ['materials', 'материал', 'материалы'],
    tnved_code: ['tnved', 'tnved_codes', 'тнвэд', 'тн_вэд', 'таможенный_код'],
  }
  const include = (type) =>
    requestedType === 'all' ||
    requestedType === type ||
    requestedType === `${type}s` ||
    (typeAliases[type] || []).includes(requestedType)
  const objects = []

  if (include('client')) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT 'client' AS type,
             'Клиент' AS label,
             id,
             company_name AS title,
             CONCAT_WS(' / ', contact_person, phone, email, tax_id, registration_number) AS description,
             'Клиенты' AS section
        FROM clients
       WHERE ${buildLikeClause(['company_name', 'contact_person', 'phone', 'email', 'tax_id', 'registration_number'], variants, params)}
       ORDER BY company_name
       LIMIT ${safeLimit}
      `,
      params
    )
    objects.push(...rows.map(mapBusinessObject))
  }

  if (include('supplier')) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT 'supplier' AS type,
             'Поставщик' AS label,
             ps.id,
             ps.name AS title,
             CONCAT_WS(' / ', ps.vat_number, ps.public_code, sa.country, sc.name, sc.email, sc.phone) AS description,
             'Поставщики' AS section
        FROM part_suppliers ps
        LEFT JOIN supplier_addresses sa ON sa.id = (
          SELECT sa2.id FROM supplier_addresses sa2
           WHERE sa2.supplier_id = ps.id
           ORDER BY sa2.is_primary DESC, sa2.created_at DESC, sa2.id DESC
           LIMIT 1
        )
        LEFT JOIN supplier_contacts sc ON sc.id = (
          SELECT sc2.id FROM supplier_contacts sc2
           WHERE sc2.supplier_id = ps.id
           ORDER BY sc2.is_primary DESC, sc2.created_at DESC, sc2.id DESC
           LIMIT 1
        )
       WHERE ${buildLikeClause(['ps.name', 'ps.vat_number', 'ps.public_code', 'sa.country', 'sc.name', 'sc.email', 'sc.phone'], variants, params)}
       ORDER BY ps.name
       LIMIT ${safeLimit}
      `,
      params
    )
    objects.push(...rows.map(mapBusinessObject))
  }

  if (include('oem_part')) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT 'oem_part' AS type,
             'OEM деталь' AS label,
             p.id,
             p.part_number AS title,
             CONCAT_WS(' / ', p.description_ru, p.description_en, m.name) AS description,
             'OEM детали' AS section
        FROM oem_parts p
        LEFT JOIN equipment_manufacturers m ON m.id = p.manufacturer_id
       WHERE ${buildLikeClause(['p.part_number', 'p.description_ru', 'p.description_en', 'm.name'], variants, params)}
       ORDER BY p.part_number
       LIMIT ${safeLimit}
      `,
      params
    )
    objects.push(...rows.map(mapBusinessObject))
  }

  if (include('supplier_part')) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT 'supplier_part' AS type,
             'Деталь поставщика' AS label,
             sp.id,
             sp.supplier_part_number AS title,
             CONCAT_WS(' / ', sp.description_ru, sp.description_en, ps.name) AS description,
             'Детали поставщиков' AS section
        FROM supplier_parts sp
        LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
       WHERE ${buildLikeClause(['sp.supplier_part_number', 'sp.description_ru', 'sp.description_en', 'ps.name'], variants, params)}
       ORDER BY sp.supplier_part_number
       LIMIT ${safeLimit}
      `,
      params
    )
    objects.push(...rows.map(mapBusinessObject))
  }

  if (include('standard_part')) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT 'standard_part' AS type,
             'Стандартная деталь' AS label,
             sp.id,
             COALESCE(sp.display_name, sp.designation, CONCAT('Standard part #', sp.id)) AS title,
             CONCAT_WS(' / ', sp.designation, sp.description_ru, sp.description_en, c.name) AS description,
             'Стандартные детали' AS section
        FROM standard_parts sp
        LEFT JOIN standard_part_classes c ON c.id = sp.class_id
       WHERE ${buildLikeClause(['sp.display_name', 'sp.designation', 'sp.description_ru', 'sp.description_en', 'c.name'], variants, params)}
       ORDER BY COALESCE(sp.display_name, sp.designation, CONCAT('Standard part #', sp.id))
       LIMIT ${safeLimit}
      `,
      params
    )
    objects.push(...rows.map(mapBusinessObject))
  }

  if (include('material')) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT 'material' AS type,
             'Материал' AS label,
             m.id,
             m.name AS title,
             CONCAT_WS(' / ', m.code, m.standard, c.name) AS description,
             'Материалы' AS section
        FROM materials m
        LEFT JOIN material_categories c ON c.id = m.category_id
       WHERE ${buildLikeClause(['m.name', 'm.code', 'm.standard', 'm.description', 'c.name'], variants, params)}
       ORDER BY m.name
       LIMIT ${safeLimit}
      `,
      params
    )
    objects.push(...rows.map(mapBusinessObject))
  }

  if (include('tnved_code')) {
    const params = []
    const [rows] = await db.execute(
      `
      SELECT 'tnved_code' AS type,
             'Код ТН ВЭД' AS label,
             id,
             code AS title,
             description,
             'Коды ТН ВЭД' AS section
        FROM tnved_codes
       WHERE ${buildLikeClause(['code', 'description'], variants, params)}
       ORDER BY LENGTH(code), code
       LIMIT ${safeLimit}
      `,
      params
    )
    objects.push(...rows.map(mapBusinessObject))
  }

  return {
    query: q,
    objects: objects.slice(0, safeLimit * 7),
    answer_policy:
      'Отвечай пользователю названиями label/title/section/open_in_interface. Не показывай type как технический идентификатор.',
  }
}

const getClientBusinessTimeline = async ({ client_id, query, limit } = {}) => {
  const safeLimit = clampLimit(limit, 10, 25)
  let clientId = Number(client_id) || null
  let clients = []

  if (!clientId && query) {
    const params = []
    const variants = normalizeSearchVariants(query)
    const [rows] = await db.execute(
      `
      SELECT id,
             company_name,
             contact_person,
             phone,
             email,
             tax_id,
             registration_number
        FROM clients
       WHERE ${buildLikeClause(['company_name', 'contact_person', 'phone', 'email', 'tax_id', 'registration_number'], variants, params)}
       ORDER BY
         CASE WHEN LOWER(company_name) = LOWER(?) THEN 0 ELSE 1 END,
         company_name
       LIMIT 5
      `,
      [...params, String(query || '').trim()]
    )
    clients = rows
    if (rows.length === 1) clientId = rows[0].id
  }

  if (!clientId) {
    return {
      object: 'Клиент',
      query: query || null,
      candidates: clients.map((row) => ({
        id: row.id,
        name: row.company_name,
        contacts: [row.contact_person, row.phone, row.email].filter(Boolean).join(' / ') || null,
        open_in_interface: buildObjectLink('client', row.id),
      })),
      needs_clarification: clients.length !== 1,
      answer_policy:
        clients.length
          ? 'Если найдено несколько клиентов, попроси пользователя выбрать одного по названию.'
          : 'Клиент не найден. Ответь простым языком и предложи поискать по другому написанию.',
    }
  }

  const [[client]] = await db.execute(
    `
    SELECT id,
           company_name,
           contact_person,
           phone,
           email,
           tax_id,
           registration_number,
           created_at
      FROM clients
     WHERE id = ?
    `,
    [clientId]
  )

  if (!client) {
    return { object: 'Клиент', client_id: clientId, found: false, answer_policy: 'Клиент не найден.' }
  }

  const [requests] = await db.execute(
    `
    SELECT cr.id,
           cr.internal_number,
           cr.client_reference,
           cr.status,
           cr.received_at,
           cr.processing_deadline,
           cr.created_at,
           (
             SELECT COUNT(*)
               FROM client_request_revision_items cri
               JOIN client_request_revisions rev ON rev.id = cri.client_request_revision_id
              WHERE rev.client_request_id = cr.id
           ) AS positions_count
      FROM client_requests cr
     WHERE cr.client_id = ?
     ORDER BY COALESCE(cr.received_at, cr.created_at) DESC, cr.id DESC
     LIMIT ${safeLimit}
    `,
    [clientId]
  )

  const [rfqs] = await db.execute(
    `
    SELECT r.id,
           r.rfq_number,
           r.status,
           r.created_at,
           cr.client_request_id,
           req.internal_number AS request_number
      FROM rfqs r
      JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
     WHERE req.client_id = ?
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ${safeLimit}
    `,
    [clientId]
  )

  const [quotes] = await db.execute(
    `
    SELECT sq.id,
           sq.status,
           sq.currency,
           sq.created_at,
           cr.client_request_id,
           req.internal_number AS request_number,
           r.rfq_number
      FROM sales_quotes sq
      JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
      LEFT JOIN selections s ON s.id = sq.selection_id
      LEFT JOIN rfqs r ON r.id = s.rfq_id
     WHERE req.client_id = ?
     ORDER BY sq.created_at DESC, sq.id DESC
     LIMIT ${safeLimit}
    `,
    [clientId]
  )

  const [contracts] = await db.execute(
    `
    SELECT cc.id,
           cc.contract_number,
           cc.contract_date,
           cc.status,
           cc.amount,
           cc.currency,
           cr.client_request_id,
           req.internal_number AS request_number
      FROM client_contracts cc
      JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
      JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
     WHERE req.client_id = ?
     ORDER BY COALESCE(cc.contract_date, cc.created_at) DESC, cc.id DESC
     LIMIT ${safeLimit}
    `,
    [clientId]
  )

  const [purchaseOrders] = await db.execute(
    `
    SELECT po.id,
           po.status,
           po.supplier_reference,
           po.currency,
           po.created_at,
           ps.name AS supplier_name,
           req.internal_number AS request_number
      FROM supplier_purchase_orders po
      JOIN part_suppliers ps ON ps.id = po.supplier_id
      JOIN sales_quotes sq ON sq.selection_id = po.selection_id
      JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
     WHERE req.client_id = ?
     ORDER BY po.created_at DESC, po.id DESC
     LIMIT ${safeLimit}
    `,
    [clientId]
  )

  return {
    object: 'Клиент',
    client: {
      id: client.id,
      name: client.company_name,
      contact: [client.contact_person, client.phone, client.email].filter(Boolean).join(' / ') || null,
      identifiers: [client.tax_id, client.registration_number].filter(Boolean).join(' / ') || null,
      open_in_interface: buildObjectLink('client', client.id),
    },
    summary: {
      client_requests: requests.length,
      rfqs: rfqs.length,
      sales_quotes: quotes.length,
      contracts: contracts.length,
      supplier_purchase_orders: purchaseOrders.length,
      has_orders_or_requests:
        requests.length > 0 ||
        rfqs.length > 0 ||
        quotes.length > 0 ||
        contracts.length > 0 ||
        purchaseOrders.length > 0,
    },
    client_requests: requests.map((row) => ({
      label: 'Заявка клиента',
      id: row.id,
      number: row.internal_number,
      client_reference: row.client_reference,
      status: humanStatus(row.status),
      received_at: row.received_at,
      created_at: row.created_at,
      positions_count: Number(row.positions_count || 0),
      open_in_interface: buildObjectLink('client_request', row.id),
    })),
    rfqs: rfqs.map((row) => ({
      label: 'RFQ',
      id: row.id,
      number: row.rfq_number,
      request_number: row.request_number,
      status: humanStatus(row.status),
      created_at: row.created_at,
      open_in_interface: buildObjectLink('rfq', row.id),
    })),
    sales_quotes: quotes.map((row) => ({
      label: 'КП клиенту',
      id: row.id,
      request_number: row.request_number,
      rfq_number: row.rfq_number,
      status: humanStatus(row.status),
      currency: row.currency,
      created_at: row.created_at,
      open_in_interface: buildObjectLink('sales_quote', row.id),
    })),
    contracts: contracts.map((row) => ({
      label: 'Контракт',
      id: row.id,
      number: row.contract_number,
      request_number: row.request_number,
      status: humanStatus(row.status),
      amount: row.amount,
      currency: row.currency,
      date: row.contract_date,
      open_in_interface: buildObjectLink('client_contract', row.id),
    })),
    supplier_purchase_orders: purchaseOrders.map((row) => ({
      label: 'Заказ поставщику',
      id: row.id,
      supplier: row.supplier_name,
      supplier_reference: row.supplier_reference,
      request_number: row.request_number,
      status: humanStatus(row.status),
      currency: row.currency,
      created_at: row.created_at,
      open_in_interface: buildObjectLink('supplier_purchase_order', row.id),
    })),
    answer_policy:
      'Ответь как консультант интерфейса. Не показывай технические имена полей. Если summary.has_orders_or_requests=true, скажи, что клиент уже фигурировал в работе, и перечисли последние заявки/RFQ/контракты.',
  }
}

const getBusinessObjectTimeline = async ({ object_type, object_id, query, limit } = {}) => {
  const type = String(object_type || '').trim().toLowerCase()
  if (!type || type === 'client' || type === 'customer' || type === 'клиент') {
    return getClientBusinessTimeline({ client_id: object_id, query, limit })
  }

  return {
    object_type: object_type || null,
    supported: ['client'],
    note: 'Пока универсальная история реализована для клиента. Для других сущностей используй search_business_objects и специализированные инструменты.',
  }
}

const getRfqTimeline = async ({ rfq_id, query, limit } = {}) => {
  const safeLimit = clampLimit(limit, 10, 30)
  let rfqId = Number(rfq_id) || null
  let candidates = []

  if (!rfqId && query) {
    const params = []
    const variants = normalizeSearchVariants(query)
    const [rows] = await db.execute(
      `
      SELECT r.id,
             r.rfq_number,
             r.status,
             c.company_name AS client_name,
             req.internal_number AS request_number
        FROM rfqs r
        JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
        JOIN client_requests req ON req.id = cr.client_request_id
        JOIN clients c ON c.id = req.client_id
       WHERE ${buildLikeClause(['r.rfq_number', 'req.internal_number', 'c.company_name'], variants, params)}
       ORDER BY
         CASE WHEN LOWER(r.rfq_number) = LOWER(?) THEN 0 ELSE 1 END,
         r.id DESC
       LIMIT 5
      `,
      [...params, String(query || '').trim()]
    )
    candidates = rows
    const exact = rows.find((row) => String(row.rfq_number || '').toLowerCase() === String(query || '').trim().toLowerCase())
    if (exact) rfqId = exact.id
    else if (rows.length === 1) rfqId = rows[0].id
  }

  if (!rfqId) {
    return {
      object: 'RFQ',
      query: query || null,
      candidates: candidates.map((row) => ({
        id: row.id,
        number: row.rfq_number,
        client: row.client_name,
        request_number: row.request_number,
        status: humanStatus(row.status),
        open_in_interface: buildObjectLink('rfq', row.id),
      })),
      needs_clarification: candidates.length !== 1,
      answer_policy:
        candidates.length
          ? 'Если найдено несколько RFQ, попроси пользователя выбрать RFQ по номеру.'
          : 'RFQ не найден. Предложи поискать по номеру RFQ, номеру заявки или клиенту.',
    }
  }

  const [[rfq]] = await db.execute(
    `
    SELECT r.id,
           r.rfq_number,
           r.status,
           r.created_at,
           r.assigned_to_user_id,
           u.full_name AS assigned_user_name,
           req.id AS client_request_id,
           req.internal_number AS request_number,
           req.status AS request_status,
           req.received_at,
           req.processing_deadline,
           c.id AS client_id,
           c.company_name AS client_name
      FROM rfqs r
      JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
      JOIN client_requests req ON req.id = cr.client_request_id
      JOIN clients c ON c.id = req.client_id
      LEFT JOIN users u ON u.id = r.assigned_to_user_id
     WHERE r.id = ?
     LIMIT 1
    `,
    [rfqId]
  )

  if (!rfq) {
    return { object: 'RFQ', rfq_id: rfqId, found: false, answer_policy: 'RFQ не найден.' }
  }

  const [items] = await db.execute(
    `
    SELECT ri.id,
           ri.line_number,
           cri.client_part_number,
           cri.client_description,
           cri.requested_qty,
           cri.uom,
           op.part_number AS oem_part_number,
           op.description_ru AS oem_description,
           sp.display_name AS standard_part_name,
           sp.designation AS standard_part_designation
      FROM rfq_items ri
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
      LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
      LEFT JOIN standard_parts sp ON sp.id = cri.standard_part_id
     WHERE ri.rfq_id = ?
     ORDER BY ri.line_number ASC, ri.id ASC
     LIMIT ${safeLimit}
    `,
    [rfqId]
  )

  const [suppliers] = await db.execute(
    `
    SELECT rs.id AS rfq_supplier_id,
           rs.supplier_id,
           ps.name AS supplier_name,
           ps.public_code,
           rs.status,
           rs.invited_at,
           rs.responded_at,
           COUNT(DISTINCT rsr.id) AS responses_count,
           COUNT(DISTINCT rl.id) AS response_lines_count,
           MIN(rl.price) AS min_price,
           MAX(rl.currency) AS currency
      FROM rfq_suppliers rs
      JOIN part_suppliers ps ON ps.id = rs.supplier_id
      LEFT JOIN rfq_supplier_responses rsr ON rsr.rfq_supplier_id = rs.id
      LEFT JOIN rfq_response_revisions rr ON rr.rfq_supplier_response_id = rsr.id
      LEFT JOIN rfq_response_lines rl ON rl.rfq_response_revision_id = rr.id
     WHERE rs.rfq_id = ?
     GROUP BY rs.id, rs.supplier_id, ps.name, ps.public_code, rs.status, rs.invited_at, rs.responded_at
     ORDER BY ps.name
     LIMIT ${safeLimit}
    `,
    [rfqId]
  )

  const [selections] = await db.execute(
    `
    SELECT s.id,
           s.status,
           s.note,
           s.created_at,
           COUNT(sl.id) AS lines_count,
           COUNT(DISTINCT sl.supplier_id) AS suppliers_count,
           SUM(COALESCE(sl.landed_amount, sl.goods_amount, 0)) AS total_amount,
           MAX(sl.currency) AS currency
      FROM selections s
      LEFT JOIN selection_lines sl ON sl.selection_id = s.id
     WHERE s.rfq_id = ?
     GROUP BY s.id, s.status, s.note, s.created_at
     ORDER BY s.id DESC
     LIMIT ${safeLimit}
    `,
    [rfqId]
  )

  const [quotes] = await db.execute(
    `
    SELECT sq.id,
           sq.status,
           sq.currency,
           sq.created_at,
           sq.selection_id,
           COUNT(sqln.id) AS lines_count,
           SUM(COALESCE(sqln.sell_price, 0) * COALESCE(sqln.qty, 0)) AS sell_total
      FROM sales_quotes sq
      LEFT JOIN sales_quote_revisions sqr ON sqr.sales_quote_id = sq.id
      LEFT JOIN sales_quote_lines sqln ON sqln.sales_quote_revision_id = sqr.id
     WHERE sq.selection_id IN (SELECT id FROM selections WHERE rfq_id = ?)
     GROUP BY sq.id, sq.status, sq.currency, sq.created_at, sq.selection_id
     ORDER BY sq.id DESC
     LIMIT ${safeLimit}
    `,
    [rfqId]
  )

  const [contracts] = await db.execute(
    `
    SELECT cc.id,
           cc.contract_number,
           cc.contract_date,
           cc.status,
           cc.amount,
           cc.currency,
           sq.selection_id
      FROM client_contracts cc
      JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
     WHERE sq.selection_id IN (SELECT id FROM selections WHERE rfq_id = ?)
     ORDER BY COALESCE(cc.contract_date, cc.created_at) DESC, cc.id DESC
     LIMIT ${safeLimit}
    `,
    [rfqId]
  )

  const [purchaseOrders] = await db.execute(
    `
    SELECT po.id,
           po.status,
           po.supplier_reference,
           po.currency,
           po.created_at,
           ps.name AS supplier_name,
           COUNT(pol.id) AS lines_count
      FROM supplier_purchase_orders po
      JOIN selections s ON s.id = po.selection_id
      JOIN part_suppliers ps ON ps.id = po.supplier_id
      LEFT JOIN supplier_purchase_order_lines pol ON pol.supplier_purchase_order_id = po.id
     WHERE s.rfq_id = ?
     GROUP BY po.id, po.status, po.supplier_reference, po.currency, po.created_at, ps.name
     ORDER BY po.id DESC
     LIMIT ${safeLimit}
    `,
    [rfqId]
  )

  return {
    object: 'RFQ',
    rfq: {
      id: rfq.id,
      number: rfq.rfq_number,
      status: humanStatus(rfq.status),
      created_at: rfq.created_at,
      assigned_to: rfq.assigned_user_name || null,
      client: rfq.client_name,
      client_request_number: rfq.request_number,
      client_request_status: humanStatus(rfq.request_status),
      open_in_interface: buildObjectLink('rfq', rfq.id),
    },
    summary: {
      items: items.length,
      suppliers: suppliers.length,
      suppliers_with_responses: suppliers.filter((row) => Number(row.responses_count || 0) > 0).length,
      selections: selections.length,
      sales_quotes: quotes.length,
      contracts: contracts.length,
      supplier_purchase_orders: purchaseOrders.length,
    },
    items: items.map((row) => ({
      label: 'Позиция RFQ',
      line_number: row.line_number,
      client_part_number: row.client_part_number,
      description: row.client_description || row.oem_description || null,
      qty: row.requested_qty,
      unit: row.uom,
      oem_part_number: row.oem_part_number || null,
      standard_part: row.standard_part_name || row.standard_part_designation || null,
    })),
    suppliers: suppliers.map((row) => ({
      label: 'Поставщик RFQ',
      supplier: row.supplier_name,
      public_code: row.public_code,
      status: humanStatus(row.status),
      invited_at: row.invited_at,
      responded_at: row.responded_at,
      responses_count: Number(row.responses_count || 0),
      response_lines_count: Number(row.response_lines_count || 0),
      min_price: row.min_price,
      currency: row.currency,
    })),
    selections: selections.map((row) => ({
      label: 'Выбор закупки',
      id: row.id,
      status: humanStatus(row.status),
      lines_count: Number(row.lines_count || 0),
      suppliers_count: Number(row.suppliers_count || 0),
      total_amount: row.total_amount,
      currency: row.currency,
      created_at: row.created_at,
    })),
    sales_quotes: quotes.map((row) => ({
      label: 'КП клиенту',
      id: row.id,
      status: humanStatus(row.status),
      lines_count: Number(row.lines_count || 0),
      sell_total: row.sell_total,
      currency: row.currency,
      created_at: row.created_at,
      open_in_interface: buildObjectLink('sales_quote', row.id),
    })),
    contracts: contracts.map((row) => ({
      label: 'Контракт',
      id: row.id,
      number: row.contract_number,
      status: humanStatus(row.status),
      amount: row.amount,
      currency: row.currency,
      date: row.contract_date,
      open_in_interface: buildObjectLink('client_contract', row.id),
    })),
    supplier_purchase_orders: purchaseOrders.map((row) => ({
      label: 'Заказ поставщику',
      id: row.id,
      supplier: row.supplier_name,
      supplier_reference: row.supplier_reference,
      status: humanStatus(row.status),
      lines_count: Number(row.lines_count || 0),
      currency: row.currency,
      created_at: row.created_at,
      open_in_interface: buildObjectLink('supplier_purchase_order', row.id),
    })),
    answer_policy:
      'Ответь как менеджер процесса RFQ: клиент, статус, поставщики/ответы, выбор, КП, контракты и PO. Не показывай названия таблиц и SQL-поля.',
  }
}

const getCatalogQualityQueue = async ({ queue, limit } = {}) => {
  const safeLimit = clampLimit(limit, 12, 50)
  const normalizedQueue = String(queue || 'summary').trim().toLowerCase()
  const queues = {
    equipment_models_without_classifier: {
      label: 'Модели оборудования без узла классификатора',
      sql: `
        SELECT em.id,
               em.model_name AS title,
               m.name AS subtitle,
               COUNT(DISTINCT f.oem_part_id) AS related_oem_parts,
               COUNT(DISTINCT ceu.id) AS client_units
          FROM equipment_models em
          JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
          LEFT JOIN oem_part_model_fitments f ON f.equipment_model_id = em.id
          LEFT JOIN client_equipment_units ceu ON ceu.equipment_model_id = em.id
         WHERE em.classifier_node_id IS NULL
         GROUP BY em.id, em.model_name, m.name
         ORDER BY related_oem_parts DESC, client_units DESC, m.name, em.model_name
         LIMIT ${safeLimit}
      `,
    },
    oem_without_standard_link: {
      label: 'OEM детали без связи со стандартной деталью',
      sql: `
        SELECT op.id,
               op.part_number AS title,
               CONCAT_WS(' / ', op.description_ru, op.description_en, m.name) AS subtitle,
               COUNT(DISTINCT f.equipment_model_id) AS fitments,
               COUNT(DISTINCT spl.supplier_part_id) AS supplier_links
          FROM oem_parts op
          LEFT JOIN equipment_manufacturers m ON m.id = op.manufacturer_id
          LEFT JOIN oem_part_standard_parts osl ON osl.oem_part_id = op.id
          LEFT JOIN oem_part_model_fitments f ON f.oem_part_id = op.id
          LEFT JOIN supplier_part_oem_parts spl ON spl.oem_part_id = op.id
         WHERE osl.oem_part_id IS NULL
         GROUP BY op.id, op.part_number, op.description_ru, op.description_en, m.name
         ORDER BY supplier_links DESC, fitments DESC, op.part_number
         LIMIT ${safeLimit}
      `,
    },
    oem_missing_logistics: {
      label: 'OEM детали без полного веса/габаритов',
      sql: `
        SELECT op.id,
               op.part_number AS title,
               CONCAT_WS(' / ', op.description_ru, op.description_en, m.name) AS subtitle,
               COUNT(DISTINCT f.equipment_model_id) AS equipment_models,
               MAX(f.weight_kg) AS weight_kg,
               MAX(f.length_cm) AS length_cm,
               MAX(f.width_cm) AS width_cm,
               MAX(f.height_cm) AS height_cm
          FROM oem_parts op
          LEFT JOIN equipment_manufacturers m ON m.id = op.manufacturer_id
          LEFT JOIN oem_part_model_fitments f ON f.oem_part_id = op.id
         GROUP BY op.id, op.part_number, op.description_ru, op.description_en, m.name
        HAVING MAX(f.weight_kg IS NOT NULL) = 0
            OR MAX(f.length_cm IS NOT NULL AND f.width_cm IS NOT NULL AND f.height_cm IS NOT NULL) = 0
         ORDER BY equipment_models DESC, op.part_number
         LIMIT ${safeLimit}
      `,
    },
    supplier_parts_without_standard_link: {
      label: 'Детали поставщиков без связи со стандартной деталью',
      sql: `
        SELECT sp.id,
               sp.supplier_part_number AS title,
               CONCAT_WS(' / ', sp.description_ru, sp.description_en, ps.name) AS subtitle,
               COUNT(DISTINCT sol.oem_part_id) AS oem_links,
               CASE
                 WHEN sp.weight_kg IS NULL OR sp.length_cm IS NULL OR sp.width_cm IS NULL OR sp.height_cm IS NULL
                 THEN 1 ELSE 0
               END AS missing_logistics
          FROM supplier_parts sp
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
          LEFT JOIN supplier_part_standard_parts ssl ON ssl.supplier_part_id = sp.id
          LEFT JOIN supplier_part_oem_parts sol ON sol.supplier_part_id = sp.id
         WHERE ssl.supplier_part_id IS NULL
         GROUP BY sp.id, sp.supplier_part_number, sp.description_ru, sp.description_en, ps.name,
                  sp.weight_kg, sp.length_cm, sp.width_cm, sp.height_cm
         ORDER BY oem_links DESC, missing_logistics ASC, ps.name, sp.supplier_part_number
         LIMIT ${safeLimit}
      `,
    },
    supplier_parts_missing_logistics: {
      label: 'Детали поставщиков без полного веса/габаритов',
      sql: `
        SELECT sp.id,
               sp.supplier_part_number AS title,
               CONCAT_WS(' / ', sp.description_ru, sp.description_en, ps.name) AS subtitle,
               sp.weight_kg,
               sp.length_cm,
               sp.width_cm,
               sp.height_cm
          FROM supplier_parts sp
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
         WHERE sp.weight_kg IS NULL
            OR sp.length_cm IS NULL
            OR sp.width_cm IS NULL
            OR sp.height_cm IS NULL
         ORDER BY ps.name, sp.supplier_part_number
         LIMIT ${safeLimit}
      `,
    },
    standard_classes_without_fields: {
      label: 'Классы стандартных деталей без настроенных полей',
      sql: `
        SELECT c.id,
               c.name AS title,
               c.code AS subtitle,
               COUNT(DISTINCT sp.id) AS standard_parts
          FROM standard_part_classes c
          LEFT JOIN standard_part_class_fields f ON f.class_id = c.id
          LEFT JOIN standard_parts sp ON sp.class_id = c.id
         WHERE f.id IS NULL
         GROUP BY c.id, c.name, c.code
         ORDER BY standard_parts DESC, c.name
         LIMIT ${safeLimit}
      `,
    },
    standard_parts_without_links: {
      label: 'Стандартные детали без связей с OEM или деталями поставщиков',
      sql: `
        SELECT sp.id,
               COALESCE(sp.display_name, sp.designation, CONCAT('Standard part #', sp.id)) AS title,
               CONCAT_WS(' / ', sp.designation, sp.description_ru, c.name) AS subtitle
          FROM standard_parts sp
          LEFT JOIN standard_part_classes c ON c.id = sp.class_id
          LEFT JOIN oem_part_standard_parts osl ON osl.standard_part_id = sp.id
          LEFT JOIN supplier_part_standard_parts ssl ON ssl.standard_part_id = sp.id
         WHERE osl.standard_part_id IS NULL
           AND ssl.standard_part_id IS NULL
         ORDER BY COALESCE(sp.display_name, sp.designation, CONCAT('Standard part #', sp.id))
         LIMIT ${safeLimit}
      `,
    },
  }

  const summary = await getCatalogHealthSummary()
  if (normalizedQueue === 'summary' || normalizedQueue === 'all') {
    return {
      queues: Object.entries(summary.counts || {}).map(([key, value]) => ({
        key,
        label: queues[key]?.label || key,
        count: Number(value || 0),
      })),
      answer_policy:
        'Ответь как обзор качества каталогов: что требует нормализации, что тестовые пробелы, с чего начать. Не показывай технические имена таблиц.',
    }
  }

  const selected = queues[normalizedQueue]
  if (!selected) {
    return {
      queue: normalizedQueue,
      supported_queues: Object.keys(queues),
      answer_policy: 'Такой очереди качества пока нет. Покажи доступные очереди человеческими названиями.',
    }
  }

  const [rows] = await db.execute(selected.sql)
  return {
    queue: normalizedQueue,
    label: selected.label,
    total: Number(summary.counts?.[normalizedQueue] || rows.length || 0),
    shown: rows.length,
    items: rows.map((row) => ({
      ...row,
      open_in_interface:
        normalizedQueue.startsWith('oem_')
          ? buildObjectLink('oem_part', row.id)
          : normalizedQueue.startsWith('supplier_parts')
            ? buildObjectLink('supplier_part', row.id)
            : normalizedQueue.startsWith('standard_parts')
              ? buildObjectLink('standard_part', row.id)
              : normalizedQueue.startsWith('standard_classes')
                ? 'Каталоги -> Стандартные детали, вкладка "Классификатор"'
                : normalizedQueue.startsWith('equipment_models')
                  ? 'Каталоги -> Классификатор оборудования'
                  : null,
    })),
    answer_policy:
      'Покажи очередь нормализации человеческим языком: что за проблема, сколько всего, примеры и где исправлять в интерфейсе.',
  }
}

const explainMeasurementUnitUsage = async ({ code, query, limit } = {}) => {
  const safeLimit = clampLimit(limit, 8, 20)
  const rawTerm = String(code || query || '').trim()
  const normalizedCode = rawTerm ? rawTerm.toLowerCase().replace(/ё/g, 'е') : ''

  let units = []
  if (normalizedCode) {
    const [rows] = await db.execute(
      `
      SELECT mu.id,
             mu.code,
             mu.name_ru,
             mu.name_en,
             mu.symbol,
             mu.dimension_type,
             base.code AS base_code,
             base.name_ru AS base_name_ru,
             mu.factor_to_base,
             mu.is_active,
             mu.is_system,
             mu.note
        FROM measurement_units mu
        LEFT JOIN measurement_units base ON base.id = mu.base_unit_id
       WHERE LOWER(mu.code) = ?
          OR LOWER(mu.name_ru) LIKE ?
          OR LOWER(COALESCE(mu.name_en, '')) LIKE ?
          OR LOWER(COALESCE(mu.symbol, '')) = ?
       ORDER BY CASE WHEN LOWER(mu.code) = ? THEN 0 ELSE 1 END, mu.code
       LIMIT ${safeLimit}
      `,
      [normalizedCode, likePattern(normalizedCode), likePattern(normalizedCode), normalizedCode, normalizedCode]
    )
    units = rows
  } else {
    const [rows] = await db.execute(
      `
      SELECT mu.id,
             mu.code,
             mu.name_ru,
             mu.name_en,
             mu.symbol,
             mu.dimension_type,
             base.code AS base_code,
             base.name_ru AS base_name_ru,
             mu.factor_to_base,
             mu.is_active,
             mu.is_system,
             mu.note
        FROM measurement_units mu
        LEFT JOIN measurement_units base ON base.id = mu.base_unit_id
       ORDER BY mu.dimension_type, mu.code
       LIMIT ${safeLimit}
      `
    )
    units = rows
  }

  const usageByUnit = []
  const unknownMatches = []
  const targetCodes = units.map((unit) => String(unit.code || '').toLowerCase())

  for (const source of MEASUREMENT_UNIT_USAGE_SOURCES) {
    const [rows] = await db.query(
      `
      SELECT ${source.field} AS raw_value, COUNT(*) AS cnt
      FROM ${source.table}
      WHERE ${source.field} IS NOT NULL
        AND TRIM(${source.field}) <> ''
      GROUP BY ${source.field}
      `
    )

    for (const row of rows || []) {
      const raw = String(row.raw_value || '').trim()
      const normalized = raw.toLowerCase().replace(/ё/g, 'е')
      const count = Number(row.cnt || 0)
      if (!raw || !count) continue

      if (targetCodes.includes(normalized)) {
        usageByUnit.push({
          unit_code: normalized,
          section: source.label,
          count,
          raw_value: raw,
        })
      } else if (normalizedCode && normalized.includes(normalizedCode)) {
        unknownMatches.push({
          raw_value: raw,
          normalized,
          section: source.label,
          count,
        })
      }
    }
  }

  if (targetCodes.includes('кг')) {
    const [[supplierWeights]] = await db.execute(`
      SELECT COUNT(*) AS cnt
        FROM supplier_parts
       WHERE weight_kg IS NOT NULL
    `)
    const [[oemFitmentWeights]] = await db.execute(`
      SELECT COUNT(*) AS cnt
        FROM oem_part_model_fitments
       WHERE weight_kg IS NOT NULL
    `)
    if (Number(supplierWeights?.cnt || 0) > 0) {
      usageByUnit.push({
        unit_code: 'кг',
        section: 'Вес деталей поставщиков',
        count: Number(supplierWeights.cnt || 0),
        raw_value: 'кг',
      })
    }
    if (Number(oemFitmentWeights?.cnt || 0) > 0) {
      usageByUnit.push({
        unit_code: 'кг',
        section: 'Вес OEM деталей в применяемости по моделям',
        count: Number(oemFitmentWeights.cnt || 0),
        raw_value: 'кг',
      })
    }
  }

  if (targetCodes.includes('см')) {
    const [[supplierDimensions]] = await db.execute(`
      SELECT COUNT(*) AS cnt
        FROM supplier_parts
       WHERE length_cm IS NOT NULL
          OR width_cm IS NOT NULL
          OR height_cm IS NOT NULL
    `)
    const [[oemFitmentDimensions]] = await db.execute(`
      SELECT COUNT(*) AS cnt
        FROM oem_part_model_fitments
       WHERE length_cm IS NOT NULL
          OR width_cm IS NOT NULL
          OR height_cm IS NOT NULL
    `)
    if (Number(supplierDimensions?.cnt || 0) > 0) {
      usageByUnit.push({
        unit_code: 'см',
        section: 'Габариты деталей поставщиков',
        count: Number(supplierDimensions.cnt || 0),
        raw_value: 'см',
      })
    }
    if (Number(oemFitmentDimensions?.cnt || 0) > 0) {
      usageByUnit.push({
        unit_code: 'см',
        section: 'Габариты OEM деталей в применяемости по моделям',
        count: Number(oemFitmentDimensions.cnt || 0),
        raw_value: 'см',
      })
    }
  }

  const totalByCode = usageByUnit.reduce((acc, item) => {
    acc[item.unit_code] = (acc[item.unit_code] || 0) + item.count
    return acc
  }, {})

  return {
    query: rawTerm || null,
    units: units.map((unit) => ({
      code: unit.code,
      name: unit.name_ru,
      symbol: unit.symbol || unit.code,
      type: unit.dimension_type,
      base_unit: unit.base_code
        ? `${unit.base_name_ru || unit.base_code} (${unit.base_code})`
        : null,
      factor_to_base: unit.factor_to_base,
      is_active: Boolean(unit.is_active),
      is_system: Boolean(unit.is_system),
      usage_total: totalByCode[String(unit.code || '').toLowerCase()] || 0,
      note: unit.note || null,
    })),
    usage_by_sections: usageByUnit,
    possible_unknown_or_legacy_values: unknownMatches.slice(0, safeLimit),
    answer_policy:
      'Объясняй единицы измерения как справочник для пользователя: код, название, где используется, как выбрать в формах. Не показывай source key, table или field.',
  }
}

module.exports = {
  getBusinessSnapshot,
  getCatalogHealthSummary,
  getOpenContracts,
  findTnvedAssignmentCandidates,
  listTnvedCodesByDutyRate,
  searchBusinessObjects,
  getBusinessObjectTimeline,
  getRfqTimeline,
  getCatalogQualityQueue,
  explainMeasurementUnitUsage,
  searchSystemRecords,
}
