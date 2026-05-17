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
      (SELECT COUNT(*) FROM supplier_responses) AS supplier_responses,
      (SELECT COUNT(*) FROM sales_quotes) AS sales_quotes,
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
    SELECT 'client' AS type, id, company_name AS title, inn AS subtitle
      FROM clients
     WHERE ${buildLikeClause(['company_name', 'inn'], variants, clientParams)}
     ORDER BY company_name
     LIMIT ${safeLimit}
    `,
    clientParams
  )

  const supplierParams = []
  const [suppliers] = await db.execute(
    `
    SELECT 'supplier' AS type, id, name AS title, country AS subtitle
      FROM part_suppliers
     WHERE ${buildLikeClause(['name', 'country', 'inn'], variants, supplierParams)}
     ORDER BY name
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

module.exports = {
  getBusinessSnapshot,
  getCatalogHealthSummary,
  findTnvedAssignmentCandidates,
  searchSystemRecords,
}
