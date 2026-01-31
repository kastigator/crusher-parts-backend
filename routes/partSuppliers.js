// routes/partSuppliers.js
const express = require('express')
const db = require('../utils/db')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const checkTabAccess = require('../middleware/requireTabAccess')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

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

const QUALITY_TYPES = new Set(['COMPLAINT', 'DELAY', 'PROCESSING_RATING'])
const QUALITY_STATUSES = new Set(['open', 'closed'])

const SUPPLIER_WITH_CONTACT_SELECT = `
  SELECT
    ps.id,
    ps.name,
    ps.vat_number,
    sa.country AS country,
    ps.website,
    ps.payment_terms,
    ps.preferred_currency,
    ps.default_incoterms,
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
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
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
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
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
  if (!supplierId) return res.status(400).json({ message: 'Некорректный ID' })
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
  if (!supplierId || !poId) return res.status(400).json({ message: 'Некорректный ID' })
  try {
    const [rows] = await db.execute(
      `
      SELECT
        pol.*,
        rrl.original_part_id,
        rrl.rfq_item_id,
        rrl.offer_type,
        op.cat_number AS original_cat_number,
        op.description_ru AS original_description_ru,
        op.description_en AS original_description_en
      FROM supplier_purchase_order_lines pol
      JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
      LEFT JOIN rfq_response_lines rrl ON rrl.id = pol.rfq_response_line_id
      LEFT JOIN original_parts op ON op.id = rrl.original_part_id
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
  if (!supplierId) return res.status(400).json({ message: 'Некорректный ID' })
  try {
    const [rows] = await db.execute(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN event_type = 'COMPLAINT' THEN 1 ELSE 0 END) AS complaints,
        SUM(CASE WHEN event_type = 'DELAY' THEN 1 ELSE 0 END) AS delays,
        SUM(CASE WHEN event_type = 'PROCESSING_RATING' THEN 1 ELSE 0 END) AS processing_ratings,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
        AVG(CASE WHEN event_type = 'PROCESSING_RATING' THEN rating END) AS avg_processing_rating,
        AVG(CASE WHEN event_type = 'DELAY' THEN delay_days END) AS avg_delay_days,
        MAX(COALESCE(occurred_at, created_at)) AS last_event_at
      FROM supplier_quality_events
      WHERE supplier_id = ?
      `,
      [supplierId]
    )
    res.json(rows[0] || {})
  } catch (e) {
    console.error('GET /part-suppliers/:id/quality-summary error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/quality-events', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  const supplierId = toId(req.params.id)
  if (!supplierId) return res.status(400).json({ message: 'Некорректный ID' })
  const limitRaw = Number(req.query.limit)
  const offsetRaw = Number(req.query.offset)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
  try {
    const [rows] = await db.execute(
      `
      SELECT
        e.*,
        op.cat_number AS original_cat_number,
        po.supplier_reference,
        po.id AS po_id
      FROM supplier_quality_events e
      LEFT JOIN original_parts op ON op.id = e.original_part_id
      LEFT JOIN supplier_purchase_orders po ON po.id = e.supplier_purchase_order_id
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
  if (!supplierId) return res.status(400).json({ message: 'Некорректный ID' })

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
  const original_part_id = toId(req.body.original_part_id)

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

  try {
    const [result] = await db.execute(
      `
      INSERT INTO supplier_quality_events
        (supplier_id, event_type, severity, status, occurred_at, created_by_user_id, note,
         supplier_purchase_order_id, supplier_purchase_order_line_id, rfq_response_line_id,
         selection_id, selection_line_id, sales_quote_id, sales_quote_line_id, original_part_id,
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
        original_part_id,
        Number.isFinite(qtyAffected) ? qtyAffected : null,
        expectedDate,
        actualDate,
        Number.isFinite(delayDays) ? delayDays : null,
        Number.isFinite(rating) ? rating : null
      ]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: supplierId,
      comment: `Создано событие качества (${eventType})`
    })

    const [[created]] = await db.execute(
      'SELECT * FROM supplier_quality_events WHERE id = ?',
      [result.insertId]
    )
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /part-suppliers/:id/quality-events error', e)
    res.status(500).json({ message: 'Ошибка сервера' })
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
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })

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
    default_incoterms,
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
  preferred_currency = nz(preferred_currency) ? up(preferred_currency, 3) : null
  default_incoterms = nz(default_incoterms) ? up(default_incoterms) : null

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO part_suppliers
       (name, vat_number, website,
        payment_terms, preferred_currency, default_incoterms, default_pickup_location, can_oem, can_analog, reliability_rating, risk_level, default_lead_time_days, notes, public_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name.trim(),
        nz(vat_number),
        nz(website),
        nz(payment_terms),
        preferred_currency,
        default_incoterms,
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
    return res.status(400).json({ message: 'id must be numeric' })
  }
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  const body = { ...req.body }

  if (body.preferred_currency !== undefined)
    body.preferred_currency = nz(body.preferred_currency) ? up(body.preferred_currency, 3) : null
  if (body.default_incoterms !== undefined) body.default_incoterms = nz(body.default_incoterms) ? up(body.default_incoterms) : null
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
    'default_incoterms',
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
    return res.status(400).json({ message: 'id must be numeric' })
  }
  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'version must be numeric' })
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

    // FK ON DELETE CASCADE удалит дочерние записи
    await conn.execute('DELETE FROM part_suppliers WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: id,
      comment: `Поставщик "${old.name}" удалён`
    })

    await conn.commit()
    res.json({ message: 'Поставщик удалён' })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /part-suppliers/:id error', e)
    res.status(500).json({ message: 'Ошибка сервера при удалении поставщика' })
  } finally {
    conn.release()
  }
})

module.exports = router
