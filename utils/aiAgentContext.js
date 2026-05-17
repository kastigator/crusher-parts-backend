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

const buildObjectLink = (type, id) => {
  if (!id) return null
  if (type === 'client') return `/clients/${id}`
  if (type === 'client_request') return `/client-requests?focus=${id}`
  if (type === 'rfq') return `/rfq-workspace?rfq_id=${id}`
  if (type === 'sales_quote') return `/sales-quotes?focus=${id}`
  if (type === 'client_contract') return `/contracts?focus=${id}`
  if (type === 'supplier_purchase_order') return `/purchase-orders?focus=${id}`
  if (type === 'oem_part') return `/original-parts/${id}`
  if (type === 'supplier_part') return `/supplier-parts/${id}`
  if (type === 'standard_part') return `/standard-parts`
  if (type === 'material') return `/materials`
  if (type === 'tnved_code') return `/tnved-codes`
  return null
}

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

module.exports = {
  getBusinessSnapshot,
  getCatalogHealthSummary,
  getOpenContracts,
  findTnvedAssignmentCandidates,
  searchBusinessObjects,
  getBusinessObjectTimeline,
  searchSystemRecords,
}
