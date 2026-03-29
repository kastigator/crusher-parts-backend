// routes/partSuppliers.js
const express = require('express')
const db = require('../utils/db')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const checkTabAccess = require('../middleware/requireTabAccess')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { buildTrashPreview, MODE } = require('../utils/trashPreview')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')

// вкладка Поставщики
const TAB_PATH = '/catalogs'

// helpers
const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) =>
  v == null
    ? null
    : typeof v === 'string'
    ? v.trim().toUpperCase().slice(0, n || v.length)
    : v
const toInt = (v) => (v === '' || v == null ? null : Number(v))
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const SUPPLIER_DEFAULT_CURRENCIES = new Set(['EUR', 'USD', 'CNY', 'RUB', 'TRY', 'AED'])
const SUPPLIER_DEFAULT_PAYMENT_TERMS = [
  '100% предоплата',
  '30% предоплата / 70% перед отгрузкой',
  '50% предоплата / 50% перед отгрузкой',
  'Оплата по факту отгрузки',
  'NET 30',
  'NET 45',
  'Аккредитив',
  'По договоренности',
]

const normalizeSupplierDefaultCurrency = (value) => {
  const raw = nz(value)
  if (!raw) return null
  const normalized = up(raw, 3)
  return SUPPLIER_DEFAULT_CURRENCIES.has(normalized) ? normalized : null
}

const normalizeSupplierDefaultPaymentTerms = (value) => {
  const raw = nz(value)
  if (!raw) return null
  const normalized = String(raw).trim().replace(/\s+/g, ' ')
  const upper = normalized.toUpperCase()
  const matched = SUPPLIER_DEFAULT_PAYMENT_TERMS.find(
    (item) => String(item).toUpperCase() === upper
  )
  return matched || null
}

const QUALITY_TYPES = new Set(['COMPLAINT', 'DELAY', 'PROCESSING_RATING'])
const QUALITY_STATUSES = new Set(['open', 'closed'])
const QUALITY_RISK_LEVELS = ['low', 'medium', 'high', 'critical']

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const loadSupplierQualityEventById = async (conn, eventId) => {
  const [[row]] = await conn.execute(
    `SELECT e.*,
            op.part_number AS original_cat_number,
            po.supplier_reference,
            po.id AS po_id,
            sqr.rev_number AS sales_quote_revision_number
       FROM supplier_quality_events e
       LEFT JOIN oem_parts op ON op.id = e.oem_part_id
       LEFT JOIN supplier_purchase_orders po ON po.id = e.supplier_purchase_order_id
       LEFT JOIN sales_quote_lines ql ON ql.id = e.sales_quote_line_id
       LEFT JOIN sales_quote_revisions sqr ON sqr.id = ql.sales_quote_revision_id
      WHERE e.id = ?`,
    [eventId]
  )
  return row || null
}

const loadSupplierQualityAggregate = async (conn, supplierId) => {
  const [[row]] = await conn.execute(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN event_type = 'COMPLAINT' THEN 1 ELSE 0 END) AS complaints,
      SUM(CASE WHEN event_type = 'DELAY' THEN 1 ELSE 0 END) AS delays,
      SUM(CASE WHEN event_type = 'PROCESSING_RATING' THEN 1 ELSE 0 END) AS processing_ratings,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
      SUM(CASE WHEN event_type = 'COMPLAINT' THEN severity ELSE 0 END) AS complaint_severity_sum,
      SUM(CASE WHEN event_type = 'DELAY' THEN severity ELSE 0 END) AS delay_severity_sum,
      SUM(CASE WHEN status = 'open' AND severity >= 4 THEN 1 ELSE 0 END) AS open_critical_count,
      AVG(CASE WHEN event_type = 'PROCESSING_RATING' THEN rating END) AS avg_processing_rating,
      AVG(CASE WHEN event_type = 'DELAY' THEN delay_days END) AS avg_delay_days,
      MAX(COALESCE(occurred_at, created_at)) AS last_event_at
    FROM supplier_quality_events
    WHERE supplier_id = ?
    `,
    [supplierId]
  )
  return row || null
}

const deriveSupplierQualityMetrics = (summary) => {
  const total = Number(summary?.total || 0)
  if (!total) {
    return {
      reliability_rating: null,
      risk_level: null,
      risk_score: null,
      quality_score: null,
    }
  }

  const complaintSeverity = Number(summary?.complaint_severity_sum || 0)
  const delaySeverity = Number(summary?.delay_severity_sum || 0)
  const openCount = Number(summary?.open_count || 0)
  const openCriticalCount = Number(summary?.open_critical_count || 0)
  const avgDelayDays = Number(summary?.avg_delay_days || 0)
  const avgProcessingRatingRaw = summary?.avg_processing_rating
  const avgProcessingRating =
    avgProcessingRatingRaw === null || avgProcessingRatingRaw === undefined
      ? null
      : Number(avgProcessingRatingRaw)

  let qualityScore = 100
  qualityScore -= complaintSeverity * 8
  qualityScore -= delaySeverity * 5
  qualityScore -= openCount * 6
  qualityScore -= openCriticalCount * 7
  qualityScore -= clamp(avgDelayDays, 0, 60) * 0.4

  if (avgProcessingRating !== null && Number.isFinite(avgProcessingRating)) {
    qualityScore += (avgProcessingRating - 3) * 6
  }

  qualityScore = clamp(Math.round(qualityScore), 1, 100)

  let reliabilityRating = 1
  if (qualityScore >= 85) reliabilityRating = 5
  else if (qualityScore >= 70) reliabilityRating = 4
  else if (qualityScore >= 50) reliabilityRating = 3
  else if (qualityScore >= 30) reliabilityRating = 2

  let riskLevel = 'critical'
  if (qualityScore >= 85) riskLevel = 'low'
  else if (qualityScore >= 65) riskLevel = 'medium'
  else if (qualityScore >= 40) riskLevel = 'high'

  return {
    reliability_rating: reliabilityRating,
    risk_level: riskLevel,
    risk_score: qualityScore,
    quality_score: qualityScore,
  }
}

const syncSupplierQualityDerivedFields = async (conn, supplierId) => {
  const summary = await loadSupplierQualityAggregate(conn, supplierId)
  const derived = deriveSupplierQualityMetrics(summary)

  await conn.execute(
    `UPDATE part_suppliers
        SET reliability_rating = ?,
            risk_level = ?
      WHERE id = ?`,
    [derived.reliability_rating, derived.risk_level, supplierId]
  )

  await conn.execute(
    `UPDATE supplier_risk_overrides
        SET is_active = 0,
            valid_to = COALESCE(valid_to, CURRENT_DATE())
      WHERE supplier_id = ?
        AND source = 'QUALITY_EVENTS'
        AND is_active = 1`,
    [supplierId]
  )

  if (derived.risk_level && QUALITY_RISK_LEVELS.includes(derived.risk_level)) {
    await conn.execute(
      `INSERT INTO supplier_risk_overrides
        (supplier_id, risk_level, risk_score, source, valid_from, is_active, note, created_by_user_id)
       VALUES (?,?,?,?,CURRENT_DATE(),1,?,?)`,
      [
        supplierId,
        derived.risk_level,
        derived.risk_score,
        'QUALITY_EVENTS',
        `Автопересчет по quality events: complaints=${Number(summary?.complaints || 0)}, delays=${Number(summary?.delays || 0)}, open=${Number(summary?.open_count || 0)}`,
        null,
      ]
    )
  }

  return {
    ...summary,
    ...derived,
  }
}

const SUPPLIER_WITH_CONTACT_SELECT = `
  SELECT
    ps.id,
    ps.name,
    ps.vat_number,
    sa.country AS country,
    ps.website,
    ps.payment_terms,
    ps.preferred_currency,
    ps.default_pickup_location,
    ps.can_oem,
    ps.can_analog,
    ps.reliability_rating,
    ps.risk_level,
    ps.default_lead_time_days,
    ps.notes,
    ps.version,
    ps.created_at,
    ps.updated_at,
    ps.public_code,
    sc.name AS contact_person,
    sc.email AS email,
    sc.phone AS phone
  FROM part_suppliers ps
  LEFT JOIN (
    SELECT
      sa1.*,
      ROW_NUMBER() OVER (
        PARTITION BY supplier_id
        ORDER BY is_primary DESC, created_at DESC, id DESC
      ) AS rn
    FROM supplier_addresses sa1
  ) sa ON sa.supplier_id = ps.id AND sa.rn = 1
  LEFT JOIN (
    SELECT
      sc1.*,
      ROW_NUMBER() OVER (
        PARTITION BY supplier_id
        ORDER BY is_primary DESC, created_at DESC, id DESC
      ) AS rn
    FROM supplier_contacts sc1
  ) sc ON sc.supplier_id = ps.id AND sc.rn = 1
`

const fetchSupplierWithContact = async (conn, id) => {
  const [rows] = await conn.execute(
    `${SUPPLIER_WITH_CONTACT_SELECT} WHERE ps.id=?`,
    [id]
  )
  return rows[0] || null
}

// утилита для разбора конфликтов уникальности
const handleDuplicateError = (e, res) => {
  if (e && e.code === 'ER_DUP_ENTRY') {
    const msg = e.sqlMessage || e.message || ''
    let field = 'unknown'
    if (msg.includes('uniq_part_suppliers_vat')) field = 'vat_number'
    else if (msg.includes('uniq_part_suppliers_public_code')) field = 'public_code'

    let type = 'duplicate_key'
    let message = 'Конфликт уникальности'

    if (field === 'vat_number') {
      type = 'duplicate_vat'
      message = 'Поставщик с таким VAT уже существует'
    } else if (field === 'public_code') {
      type = 'duplicate_public_code'
      message = 'Поставщик с таким публичным кодом уже существует'
    }

    return res.status(409).json({ type, field, message })
  }
  return null
}

/* =========================================================
   ЛОГИ ПО ПОСТАВЩИКАМ (агрегированные) — ВАЖНО: до "/:id"
   ========================================================= */

// Все логи данного поставщика (история)
// ⛔ только для admin (или кого захочешь в будущем)
router.get('/:id/logs/combined', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный идентификатор записи' })
  try {
    const [logs] = await db.execute(
      `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'suppliers' AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `,
      [id]
    )
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/:id/logs/combined error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении логов' })
  }
})

// Удалённые логи по всем поставщикам
router.get('/logs/deleted', auth, adminOnly, async (_req, res) => {
  try {
    const [logs] = await db.execute(
      `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete' AND a.entity_type = 'suppliers'
      ORDER BY a.created_at DESC
    `
    )
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/logs/deleted error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

// Удалённые логи по конкретному поставщику
router.get('/:id/logs/deleted', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный идентификатор записи' })
  try {
    const [logs] = await db.execute(
      `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND a.entity_type = 'suppliers'
        AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `,
      [id]
    )
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/:id/logs/deleted error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

// Универсальный маркер изменений (COUNT:SUM(version))
router.get('/etag', auth, checkTabAccess(TAB_PATH), async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
       FROM part_suppliers`
    )
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /part-suppliers/etag error', e)
    res.status(500).json({ message: 'Server error' })
  }
})

/* ======================
   SUPPLIER QUALITY
   ====================== */
router.get('/:id/purchase-orders', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const supplierId = toId(req.params.id)
  if (!supplierId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  const limitRaw = Number(req.query.limit)
  const offsetRaw = Number(req.query.offset)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0

  try {
    const [rows] = await db.execute(
      `
      SELECT
        po.id,
        po.status,
        po.supplier_reference,
        po.currency,
        po.incoterms,
        po.selection_id,
        po.created_at
      FROM supplier_purchase_orders po
      WHERE po.supplier_id = ?
      ORDER BY po.id DESC
      LIMIT ${limit} OFFSET ${offset}
      `,
      [supplierId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /part-suppliers/:id/purchase-orders error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/purchase-orders/:poId/lines', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const supplierId = toId(req.params.id)
  const poId = toId(req.params.poId)
  if (!supplierId || !poId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  try {
    const [rows] = await db.execute(
      `
      SELECT
        pol.*,
        po.selection_id,
        rrl.oem_part_id AS original_part_id,
        rrl.rfq_item_id,
        rrl.offer_type,
        sl.id AS selection_line_id,
        sq.id AS sales_quote_id,
        cc.sales_quote_revision_id,
        ql.id AS sales_quote_line_id,
        op.part_number AS original_cat_number,
        op.description_ru AS original_description_ru,
        op.description_en AS original_description_en
      FROM supplier_purchase_order_lines pol
      JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
      LEFT JOIN rfq_response_lines rrl ON rrl.id = pol.rfq_response_line_id
      LEFT JOIN selection_lines sl
        ON sl.selection_id = po.selection_id
       AND sl.rfq_response_line_id = pol.rfq_response_line_id
      LEFT JOIN rfq_items ri ON ri.id = sl.rfq_item_id
      LEFT JOIN client_contracts cc
        ON cc.id = (
          SELECT cc2.id
          FROM client_contracts cc2
          JOIN sales_quotes sq2 ON sq2.id = cc2.sales_quote_id
          WHERE sq2.selection_id = po.selection_id
            AND cc2.status = 'signed'
          ORDER BY cc2.contract_date DESC, cc2.id DESC
          LIMIT 1
        )
      LEFT JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
      LEFT JOIN sales_quote_lines ql
        ON ql.sales_quote_revision_id = cc.sales_quote_revision_id
       AND ql.client_request_revision_item_id = ri.client_request_revision_item_id
       AND COALESCE(ql.line_status, 'active') = 'active'
      LEFT JOIN oem_parts op ON op.id = rrl.oem_part_id
      WHERE po.id = ?
        AND po.supplier_id = ?
      ORDER BY pol.id DESC
      `,
      [poId, supplierId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /part-suppliers/:id/purchase-orders/:poId/lines error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/quality-summary', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const supplierId = toId(req.params.id)
  if (!supplierId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  try {
    const summary = await loadSupplierQualityAggregate(db, supplierId)
    const derived = deriveSupplierQualityMetrics(summary)
    res.json({
      ...(summary || {}),
      ...derived,
    })
  } catch (e) {
    console.error('GET /part-suppliers/:id/quality-summary error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/quality-events', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const supplierId = toId(req.params.id)
  if (!supplierId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  const limitRaw = Number(req.query.limit)
  const offsetRaw = Number(req.query.offset)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
  try {
    const [rows] = await db.execute(
      `
      SELECT
        e.*,
        op.part_number AS original_cat_number,
        po.supplier_reference,
        po.id AS po_id,
        sqr.rev_number AS sales_quote_revision_number
      FROM supplier_quality_events e
      LEFT JOIN oem_parts op ON op.id = e.oem_part_id
      LEFT JOIN supplier_purchase_orders po ON po.id = e.supplier_purchase_order_id
      LEFT JOIN sales_quote_lines ql ON ql.id = e.sales_quote_line_id
      LEFT JOIN sales_quote_revisions sqr ON sqr.id = ql.sales_quote_revision_id
      WHERE e.supplier_id = ?
      ORDER BY COALESCE(e.occurred_at, e.created_at) DESC, e.id DESC
      LIMIT ${limit} OFFSET ${offset}
      `,
      [supplierId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /part-suppliers/:id/quality-events error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/quality-events', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const supplierId = toId(req.params.id)
  if (!supplierId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const eventType = String(req.body.event_type || '').trim().toUpperCase()
  if (!QUALITY_TYPES.has(eventType)) {
    return res.status(400).json({ message: 'Некорректный тип события' })
  }

  const severity = toInt(req.body.severity)
  const severityValue = Number.isFinite(severity) ? Math.min(Math.max(severity, 1), 5) : 3
  const statusRaw = String(req.body.status || 'open').trim().toLowerCase()
  const status = QUALITY_STATUSES.has(statusRaw) ? statusRaw : 'open'

  const occurredAt = nz(req.body.occurred_at)
  const note = nz(req.body.note)

  const supplier_purchase_order_id = toId(req.body.supplier_purchase_order_id)
  const supplier_purchase_order_line_id = toId(req.body.supplier_purchase_order_line_id)
  const rfq_response_line_id = toId(req.body.rfq_response_line_id)
  const selection_id = toId(req.body.selection_id)
  const selection_line_id = toId(req.body.selection_line_id)
  const sales_quote_id = toId(req.body.sales_quote_id)
  const sales_quote_line_id = toId(req.body.sales_quote_line_id)
  const oem_part_id = toId(req.body.oem_part_id) || toId(req.body.original_part_id)

  const qtyAffected = req.body.qty_affected === '' ? null : Number(req.body.qty_affected)

  const expectedDate = nz(req.body.expected_date)
  const actualDate = nz(req.body.actual_date)
  let delayDays =
    req.body.delay_days === '' || req.body.delay_days === undefined
      ? null
      : Number(req.body.delay_days)

  const rating = req.body.rating === '' ? null : Number(req.body.rating)

  if (eventType === 'PROCESSING_RATING' && !Number.isFinite(rating)) {
    return res.status(400).json({ message: 'rating обязателен для оценки обработки' })
  }

  if (eventType === 'DELAY' && delayDays == null && expectedDate && actualDate) {
    const expected = new Date(expectedDate)
    const actual = new Date(actualDate)
    if (!Number.isNaN(expected.getTime()) && !Number.isNaN(actual.getTime())) {
      const diff = Math.round((actual - expected) / 86400000)
      delayDays = Number.isFinite(diff) ? diff : null
    }
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.execute(
      `
      INSERT INTO supplier_quality_events
        (supplier_id, event_type, severity, status, occurred_at, created_by_user_id, note,
         supplier_purchase_order_id, supplier_purchase_order_line_id, rfq_response_line_id,
         selection_id, selection_line_id, sales_quote_id, sales_quote_line_id, oem_part_id,
         qty_affected, expected_date, actual_date, delay_days, rating)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
      [
        supplierId,
        eventType,
        severityValue,
        status,
        occurredAt,
        toId(req.user?.id),
        note,
        supplier_purchase_order_id,
        supplier_purchase_order_line_id,
        rfq_response_line_id,
        selection_id,
        selection_line_id,
        sales_quote_id,
        sales_quote_line_id,
        oem_part_id,
        Number.isFinite(qtyAffected) ? qtyAffected : null,
        expectedDate,
        actualDate,
        Number.isFinite(delayDays) ? delayDays : null,
        Number.isFinite(rating) ? rating : null
      ]
    )

    await syncSupplierQualityDerivedFields(conn, supplierId)

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: supplierId,
      comment: `Создано событие качества (${eventType})`
    })

    await conn.commit()
    const created = await loadSupplierQualityEventById(db, result.insertId)
    res.status(201).json(created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /part-suppliers/:id/quality-events error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.patch('/:id/quality-events/:eventId', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const supplierId = toId(req.params.id)
  const eventId = toId(req.params.eventId)
  if (!supplierId || !eventId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[existing]] = await conn.execute(
      `SELECT *
         FROM supplier_quality_events
        WHERE id = ?
          AND supplier_id = ?`,
      [eventId, supplierId]
    )
    if (!existing) return res.status(404).json({ message: 'Событие не найдено' })

    const nextStatusRaw = req.body.status == null ? null : String(req.body.status).trim().toLowerCase()
    if (nextStatusRaw && !QUALITY_STATUSES.has(nextStatusRaw)) {
      return res.status(400).json({ message: 'Некорректный статус события' })
    }
    const nextSeverityRaw = req.body.severity == null ? null : toInt(req.body.severity)
    const nextSeverity =
      nextSeverityRaw == null ? null : Math.min(Math.max(nextSeverityRaw, 1), 5)
    const occurredAt = nz(req.body.occurred_at)
    const note = nz(req.body.note)
    const qtyAffected =
      req.body.qty_affected === '' || req.body.qty_affected === undefined ? null : Number(req.body.qty_affected)
    const expectedDate = nz(req.body.expected_date)
    const actualDate = nz(req.body.actual_date)
    let delayDays =
      req.body.delay_days === '' || req.body.delay_days === undefined ? null : Number(req.body.delay_days)
    const rating = req.body.rating === '' || req.body.rating === undefined ? null : Number(req.body.rating)

    const nextType = String(existing.event_type || '').trim().toUpperCase()
    if (nextType === 'DELAY' && delayDays == null && expectedDate && actualDate) {
      const expected = new Date(expectedDate)
      const actual = new Date(actualDate)
      if (!Number.isNaN(expected.getTime()) && !Number.isNaN(actual.getTime())) {
        const diff = Math.round((actual - expected) / 86400000)
        delayDays = Number.isFinite(diff) ? diff : null
      }
    }

    await conn.execute(
      `UPDATE supplier_quality_events
          SET severity = COALESCE(?, severity),
              status = COALESCE(?, status),
              occurred_at = COALESCE(?, occurred_at),
              note = COALESCE(?, note),
              qty_affected = ?,
              expected_date = ?,
              actual_date = ?,
              delay_days = ?,
              rating = ?
        WHERE id = ?
          AND supplier_id = ?`,
      [
        nextSeverity,
        nextStatusRaw,
        occurredAt,
        note,
        Number.isFinite(qtyAffected) ? qtyAffected : null,
        expectedDate,
        actualDate,
        Number.isFinite(delayDays) ? delayDays : null,
        Number.isFinite(rating) ? rating : null,
        eventId,
        supplierId,
      ]
    )

    await syncSupplierQualityDerivedFields(conn, supplierId)

    await logActivity({
      req,
      action: 'update',
      entity_type: 'suppliers',
      entity_id: supplierId,
      comment: `Обновлено событие качества #${eventId}`,
    })

    await conn.commit()
    const updated = await loadSupplierQualityEventById(db, eventId)
    res.json(updated)
  } catch (e) {
    await conn.rollback()
    console.error('PATCH /part-suppliers/:id/quality-events/:eventId error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

/* ======================
   LIST
   ====================== */
router.get('/', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const { q } = req.query
    const bool = (v) => v === 1 || v === '1' || v === true || v === 'true'
    const numOrNull = (v) => {
      if (v === '' || v === undefined || v === null) return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const params = []
    let sql = SUPPLIER_WITH_CONTACT_SELECT
    const where = []

    if (q && q.trim()) {
      const like = `%${q.trim()}%`
      where.push(
        `(
          ps.name LIKE ?
          OR ps.vat_number LIKE ?
          OR ps.public_code LIKE ?
          OR sa.country LIKE ?
          OR sc.name LIKE ?
          OR sc.email LIKE ?
          OR sc.phone LIKE ?
        )`
      )
      params.push(like, like, like, like, like, like, like)
    }

    // filters
    if (bool(req.query.can_oem)) where.push('ps.can_oem = 1')
    if (bool(req.query.can_analog)) where.push('ps.can_analog = 1')

    const risk = (req.query.risk_level || '').toString().trim()
    if (risk) {
      where.push('ps.risk_level = ?')
      params.push(risk)
    }

    const relMin = numOrNull(req.query.reliability_min)
    const relMax = numOrNull(req.query.reliability_max)
    if (relMin != null) {
      where.push('ps.reliability_rating >= ?')
      params.push(relMin)
    }
    if (relMax != null) {
      where.push('ps.reliability_rating <= ?')
      params.push(relMax)
    }

    const ltMin = numOrNull(req.query.lead_time_min)
    const ltMax = numOrNull(req.query.lead_time_max)
    if (ltMin != null) {
      where.push('ps.default_lead_time_days >= ?')
      params.push(ltMin)
    }
    if (ltMax != null) {
      where.push('ps.default_lead_time_days <= ?')
      params.push(ltMax)
    }

    const country = (req.query.country || '').toString().trim()
    if (country) {
      where.push('sa.country LIKE ?')
      params.push(`%${country}%`)
    }

    if (bool(req.query.has_contact)) where.push('sc.id IS NOT NULL')
    if (bool(req.query.has_address)) where.push('sa.id IS NOT NULL')

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY ps.name ASC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('GET /part-suppliers error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении поставщиков' })
  }
})

/* ======================
   GET ONE
   ====================== */
router.get('/:id', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный идентификатор записи' })

    const row = await fetchSupplierWithContact(db, id)
    if (!row) return res.status(404).json({ message: 'Поставщик не найден' })
    res.json(row)
  } catch (e) {
    console.error('GET /part-suppliers/:id error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении поставщика' })
  }
})

/* ======================
   CREATE
   ====================== */
router.post('/', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  let {
    name,
    vat_number,
    website,
    payment_terms,
    preferred_currency,
    default_pickup_location,
    can_oem,
    can_analog,
    reliability_rating,
    risk_level,
    default_lead_time_days,
    notes,
    public_code
  } = req.body || {}

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  public_code = nz(public_code) ? up(public_code, 32) : null
  if (!public_code) {
    return res.status(400).json({ message: 'Публичный код поставщика (public_code) обязателен' })
  }

  default_lead_time_days = toInt(default_lead_time_days)
  if (nz(preferred_currency) && !normalizeSupplierDefaultCurrency(preferred_currency)) {
    return res.status(400).json({ message: 'Недопустимая валюта по умолчанию' })
  }
  preferred_currency = normalizeSupplierDefaultCurrency(preferred_currency)
  if (nz(payment_terms) && !normalizeSupplierDefaultPaymentTerms(payment_terms)) {
    return res.status(400).json({ message: 'Недопустимые базовые условия оплаты' })
  }
  payment_terms = normalizeSupplierDefaultPaymentTerms(payment_terms)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO part_suppliers
       (name, vat_number, website,
        payment_terms, preferred_currency, default_pickup_location, can_oem, can_analog, reliability_rating, risk_level, default_lead_time_days, notes, public_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name.trim(),
        nz(vat_number),
        nz(website),
        nz(payment_terms),
        preferred_currency,
        nz(default_pickup_location),
        can_oem ? 1 : 0,
        can_analog === undefined ? 1 : (can_analog ? 1 : 0),
        toInt(reliability_rating),
        nz(risk_level),
        default_lead_time_days,
        nz(notes),
        public_code
      ]
    )

    const id = ins.insertId
    const fresh = await fetchSupplierWithContact(conn, id)

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: id,
      comment: 'Создан поставщик'
    })

    await conn.commit()
    res.status(201).json(fresh)
  } catch (e) {
    await conn.rollback()
    console.error('POST /part-suppliers error', e)
    if (handleDuplicateError(e, res)) return
    res.status(500).json({ message: 'Ошибка сервера при добавлении поставщика' })
  } finally {
    conn.release()
  }
})

/* ======================
   UPDATE (optimistic by version)
   ====================== */
router.put('/:id', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const id = Number(req.params.id)
  const { version } = req.body || {}

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор записи' })
  }
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  const body = { ...req.body }

  if (body.preferred_currency !== undefined) {
    if (nz(body.preferred_currency) && !normalizeSupplierDefaultCurrency(body.preferred_currency)) {
      return res.status(400).json({ message: 'Недопустимая валюта по умолчанию' })
    }
    body.preferred_currency = normalizeSupplierDefaultCurrency(body.preferred_currency)
  }
  if (body.payment_terms !== undefined) {
    if (nz(body.payment_terms) && !normalizeSupplierDefaultPaymentTerms(body.payment_terms)) {
      return res.status(400).json({ message: 'Недопустимые базовые условия оплаты' })
    }
    body.payment_terms = normalizeSupplierDefaultPaymentTerms(body.payment_terms)
  }
  if (body.default_pickup_location !== undefined) body.default_pickup_location = nz(body.default_pickup_location)
  if (body.can_oem !== undefined) body.can_oem = body.can_oem ? 1 : 0
  if (body.can_analog !== undefined) body.can_analog = body.can_analog ? 1 : 0
  if (body.reliability_rating !== undefined) body.reliability_rating = toInt(body.reliability_rating)
  if (body.risk_level !== undefined) body.risk_level = nz(body.risk_level)
  if (body.default_lead_time_days !== undefined)
    body.default_lead_time_days =
      body.default_lead_time_days === '' || body.default_lead_time_days === null
        ? null
        : Number(body.default_lead_time_days)

  if (body.public_code !== undefined) {
    body.public_code = nz(body.public_code) ? up(body.public_code, 32) : null
  }

  const allowed = [
    'name',
    'vat_number',
    'website',
    'payment_terms',
    'preferred_currency',
    'default_pickup_location',
    'can_oem',
    'can_analog',
    'reliability_rating',
    'risk_level',
    'default_lead_time_days',
    'notes',
    'public_code'
  ]

  const set = []
  const vals = []

  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      if (f === 'name') {
        const nm = (body.name || '').trim()
        if (!nm) return res.status(400).json({ message: 'Поле name не может быть пустым' })
        set.push('`name`=?')
        vals.push(nm)
      } else if (f === 'public_code') {
        const code = body.public_code
        if (!code) {
          return res
            .status(400)
            .json({ message: 'Публичный код поставщика (public_code) не может быть пустым' })
        }
        set.push('`public_code`=?')
        vals.push(code)
      } else {
        set.push(`\`${f}\`=?`)
        vals.push(nz(body[f]))
      }
    }
  }

  if (!set.length) {
    return res.json({ message: 'Нет изменений' })
  }

  set.push('version = version + 1')
  set.push('updated_at = NOW()')

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }
    const oldData = oldRows[0]

    const [upd] = await conn.execute(
      `UPDATE part_suppliers SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, Number(version)]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Появились новые изменения. Обновите данные и повторите.',
        current: currentRows[0] || null
      })
    }

    const [freshRaw] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
    const fresh = await fetchSupplierWithContact(conn, id)

    await logFieldDiffs({
      req,
      oldData,
      newData: freshRaw[0],
      entity_type: 'suppliers',
      entity_id: id
    })

    await conn.commit()
    res.json(fresh)
  } catch (e) {
    await conn.rollback()
    console.error('PUT /part-suppliers/:id error', e)
    if (handleDuplicateError(e, res)) return
    res.status(500).json({ message: 'Ошибка сервера при обновлении поставщика' })
  } finally {
    conn.release()
  }
})

/* ======================
   DELETE (optional version check via ?version=)
   ====================== */
router.delete('/:id', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор записи' })
  }
  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'Некорректная версия записи' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }
    const old = oldRows[0]

    if (version !== undefined && version !== old.version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: old
      })
    }

    const preview = await buildTrashPreview('part_suppliers', id)
    if (!preview) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }
    if (preview.mode !== MODE.TRASH) {
      await conn.rollback()
      return res.status(409).json({
        type: 'delete_blocked',
        message: preview.summary?.message || 'Удаление поставщика в корзину недоступно',
        preview,
      })
    }

    const [contacts] = await conn.execute(
      'SELECT * FROM supplier_contacts WHERE supplier_id = ? ORDER BY id ASC',
      [id]
    )
    const [addresses] = await conn.execute(
      'SELECT * FROM supplier_addresses WHERE supplier_id = ? ORDER BY id ASC',
      [id]
    )
    const [bankDetails] = await conn.execute(
      'SELECT * FROM supplier_bank_details WHERE supplier_id = ? ORDER BY id ASC',
      [id]
    )
    const [supplierParts] = await conn.execute(
      'SELECT * FROM supplier_parts WHERE supplier_id = ? ORDER BY id ASC',
      [id]
    )
    const [priceLists] = await conn.execute(
      'SELECT * FROM supplier_price_lists WHERE supplier_id = ? ORDER BY id ASC',
      [id]
    )

    const supplierPartIds = supplierParts
      .map((row) => Number(row.id))
      .filter((n) => Number.isInteger(n) && n > 0)

    let supplierPartMaterials = []
    let supplierPartOemParts = []
    let supplierPartStandardParts = []
    let supplierPartPrices = []
    if (supplierPartIds.length) {
      const placeholders = supplierPartIds.map(() => '?').join(', ')
      const [rows1] = await conn.execute(
        `SELECT * FROM supplier_part_materials WHERE supplier_part_id IN (${placeholders}) ORDER BY supplier_part_id ASC, material_id ASC`,
        supplierPartIds
      )
      const [rows2] = await conn.execute(
        `SELECT * FROM supplier_part_oem_parts WHERE supplier_part_id IN (${placeholders}) ORDER BY supplier_part_id ASC, oem_part_id ASC`,
        supplierPartIds
      )
      const [rows3] = await conn.execute(
        `SELECT * FROM supplier_part_standard_parts WHERE supplier_part_id IN (${placeholders}) ORDER BY supplier_part_id ASC, standard_part_id ASC`,
        supplierPartIds
      )
      const [rows4] = await conn.execute(
        `SELECT * FROM supplier_part_prices WHERE supplier_part_id IN (${placeholders}) ORDER BY supplier_part_id ASC, id ASC`,
        supplierPartIds
      )
      supplierPartMaterials = rows1
      supplierPartOemParts = rows2
      supplierPartStandardParts = rows3
      supplierPartPrices = rows4
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'part_suppliers',
      entityId: id,
      rootEntityType: 'part_suppliers',
      rootEntityId: id,
      title: old.name,
      subtitle: old.public_code || old.vat_number || null,
      snapshot: old,
      context: {
        child_counts: {
          supplier_contacts: contacts.length,
          supplier_addresses: addresses.length,
          supplier_bank_details: bankDetails.length,
          supplier_parts: supplierParts.length,
          supplier_price_lists: priceLists.length,
          supplier_part_materials: supplierPartMaterials.length,
          supplier_part_oem_parts: supplierPartOemParts.length,
          supplier_part_standard_parts: supplierPartStandardParts.length,
          supplier_part_prices: supplierPartPrices.length,
        },
      },
    })

    let sortOrder = 0
    for (const row of contacts) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_contacts',
        itemId: row.id,
        itemRole: 'child_record',
        title: row.name || `Контакт поставщика #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of addresses) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_addresses',
        itemId: row.id,
        itemRole: 'child_record',
        title: row.label || row.formatted_address || `Адрес поставщика #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of bankDetails) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_bank_details',
        itemId: row.id,
        itemRole: 'child_record',
        title: row.bank_name || `Реквизиты поставщика #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of priceLists) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_price_lists',
        itemId: row.id,
        itemRole: 'child_record',
        title: row.list_name || row.list_code || `Прайс-лист #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of supplierParts) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_parts',
        itemId: row.id,
        itemRole: 'child_record',
        title: row.supplier_part_number || row.canonical_part_number || `Позиция поставщика #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of supplierPartMaterials) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_materials',
        itemId: null,
        itemRole: 'material_link',
        title: `Материал ${row.supplier_part_id}:${row.material_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of supplierPartOemParts) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_oem_parts',
        itemId: null,
        itemRole: 'oem_link',
        title: `OEM link ${row.supplier_part_id}:${row.oem_part_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of supplierPartStandardParts) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_standard_parts',
        itemId: null,
        itemRole: 'standard_part_link',
        title: `Standard link ${row.supplier_part_id}:${row.standard_part_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of supplierPartPrices) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_prices',
        itemId: row.id,
        itemRole: 'price_history',
        title: `Цена #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }

    await conn.execute('DELETE FROM part_suppliers WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: id,
      old_value: String(trashEntryId),
      comment: `Поставщик "${old.name}" перемещен в корзину вместе со связанными записями`
    })

    await conn.commit()
    res.json({ message: 'Поставщик перемещён в корзину', trash_entry_id: trashEntryId })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /part-suppliers/:id error', e)
    res.status(500).json({ message: 'Ошибка сервера при удалении поставщика' })
  } finally {
    conn.release()
  }
})

module.exports = router
