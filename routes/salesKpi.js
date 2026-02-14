const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { convertAmount } = require('../utils/fxRatesService')

const KPI_CURRENCY = String(process.env.KPI_CURRENCY || 'RUB').trim().toUpperCase()
const MAX_RANGE_DAYS = Number(process.env.KPI_MAX_RANGE_DAYS || 370)

const SELLER_EXPR =
  'COALESCE(co.responsible_user_id, co.assigned_to_user_id, co.created_by_user_id)'

let rebuildInProgress = false

const normalizeDate = (value) => {
  if (!value) return null
  const trimmed = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const dt = new Date(trimmed)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString().slice(0, 10)
}

const readRange = (req, res, source = 'query') => {
  const payload = source === 'body' ? req.body || {} : req.query || {}
  const dateFrom = normalizeDate(payload.date_from)
  const dateTo = normalizeDate(payload.date_to)
  if (!dateFrom || !dateTo) {
    res.status(400).json({ message: 'Нужно указать период (date_from и date_to)' })
    return null
  }
  const from = new Date(dateFrom)
  const to = new Date(dateTo)
  const diffDays = Math.ceil((to - from) / (24 * 60 * 60 * 1000)) + 1
  if (!Number.isFinite(diffDays) || diffDays <= 0) {
    res.status(400).json({ message: 'Некорректный диапазон дат' })
    return null
  }
  if (diffDays > MAX_RANGE_DAYS) {
    res.status(400).json({ message: `Слишком большой период (>${MAX_RANGE_DAYS} дней)` })
    return null
  }
  return { dateFrom, dateTo }
}

const parseSellerId = (value) => {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const normalizeRole = (user) =>
  String(user?.role_slug || user?.role || '')
    .trim()
    .toLowerCase()

const isAdmin = (user) =>
  !!(
    user &&
    (normalizeRole(user) === 'admin' ||
      user.role === 'admin' ||
      user.role_id === 1 ||
      user.is_admin === true)
  )

const requireAdmin = (req, res, next) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Нет доступа' })
  }
  return next()
}

const toRangeBounds = (dateFrom, dateTo) => ({
  fromTs: `${dateFrom} 00:00:00`,
  toTs: `${dateTo} 23:59:59`,
})

const toNumber = (value) => {
  if (value === undefined || value === null || value === '') return 0
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

const toNullableNumber = (value) => {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const roundMoney = (value) => Math.round(toNumber(value) * 100) / 100

const getRateFor = async (from, to) => {
  if (!from || !to || from === to) return 1
  try {
    const res = await convertAmount(1, from, to)
    return Number.isFinite(res?.rate) ? Number(res.rate) : 1
  } catch (err) {
    console.warn('KPI FX rate fallback:', err?.message || err)
    return 1
  }
}

const buildRateMap = async (rows, baseCurrency) => {
  const currencies = new Set()
  rows.forEach((row) => {
    const cur = row?.currency
    if (cur) currencies.add(String(cur).toUpperCase())
  })

  const map = new Map()
  for (const cur of currencies) {
    if (cur === baseCurrency) {
      map.set(cur, 1)
      continue
    }
    const rate = await getRateFor(cur, baseCurrency)
    map.set(cur, rate)
  }
  if (!map.has(baseCurrency)) map.set(baseCurrency, 1)
  return map
}

const fetchAggregates = async ({ dateFrom, dateTo, sellerId }) => {
  const { fromTs, toTs } = toRangeBounds(dateFrom, dateTo)
  const sellerFilter = sellerId ? `AND ${SELLER_EXPR} = ?` : ''

  const sql = `
    SELECT
      seller_id,
      day,
      currency,
      SUM(orders_count) AS orders_count,
      SUM(revenue) AS revenue,
      SUM(margin) AS margin,
      SUM(proposals_sent) AS proposals_sent,
      SUM(proposals_approved) AS proposals_approved
    FROM (
      SELECT
        ${SELLER_EXPR} AS seller_id,
        DATE(o.approved_at) AS day,
        COALESCE(NULLIF(o.client_currency,''), NULLIF(co.currency,''), ?) AS currency,
        COUNT(DISTINCT i.id) AS orders_count,
        SUM(COALESCE(o.client_price,0) * i.requested_qty) AS revenue,
        SUM((COALESCE(o.client_price,0) - COALESCE(o.landed_cost,0)) * i.requested_qty) AS margin,
        COUNT(*) AS proposals_approved,
        0 AS proposals_sent
      FROM client_order_line_offers o
      JOIN client_order_items i ON i.id = o.order_item_id
      JOIN client_orders co ON co.id = i.order_id
      WHERE o.approved_at IS NOT NULL
        AND o.approved_at BETWEEN ? AND ?
        AND (
          (i.decision_offer_id IS NOT NULL AND i.decision_offer_id = o.id)
          OR (i.decision_offer_id IS NULL AND o.status = 'approved')
        )
        ${sellerFilter}
      GROUP BY seller_id, day, currency

      UNION ALL

      SELECT
        ${SELLER_EXPR} AS seller_id,
        DATE(o.proposed_at) AS day,
        COALESCE(NULLIF(o.client_currency,''), NULLIF(co.currency,''), ?) AS currency,
        0 AS orders_count,
        0 AS revenue,
        0 AS margin,
        0 AS proposals_approved,
        COUNT(*) AS proposals_sent
      FROM client_order_line_offers o
      JOIN client_order_items i ON i.id = o.order_item_id
      JOIN client_orders co ON co.id = i.order_id
      WHERE o.proposed_at IS NOT NULL
        AND o.proposed_at BETWEEN ? AND ?
        ${sellerFilter}
      GROUP BY seller_id, day, currency
    ) t
    GROUP BY seller_id, day, currency
    ORDER BY day ASC
  `

  const params = [KPI_CURRENCY, fromTs, toTs]
  if (sellerId) params.push(sellerId)
  params.push(KPI_CURRENCY, fromTs, toTs)
  if (sellerId) params.push(sellerId)

  const [rows] = await db.execute(sql, params)
  return rows || []
}

const rebuildDaily = async ({ dateFrom, dateTo, sellerId }) => {
  const rows = await fetchAggregates({ dateFrom, dateTo, sellerId })
  const rateMap = await buildRateMap(rows, KPI_CURRENCY)
  const dailyMap = new Map()

  rows.forEach((row) => {
    const seller = Number(row?.seller_id)
    const day = row?.day
    if (!seller || !day) return

    const currency = String(row?.currency || KPI_CURRENCY).toUpperCase()
    const rate = rateMap.get(currency) || 1

    const key = `${seller}__${day}`
    const current = dailyMap.get(key) || {
      seller_user_id: seller,
      day,
      orders_count: 0,
      revenue: 0,
      margin: 0,
      proposals_sent: 0,
      proposals_approved: 0,
    }

    current.orders_count += Math.trunc(toNumber(row?.orders_count))
    current.proposals_sent += Math.trunc(toNumber(row?.proposals_sent))
    current.proposals_approved += Math.trunc(toNumber(row?.proposals_approved))
    current.revenue += toNumber(row?.revenue) * rate
    current.margin += toNumber(row?.margin) * rate

    dailyMap.set(key, current)
  })

  const deleteParams = sellerId
    ? [dateFrom, dateTo, sellerId]
    : [dateFrom, dateTo]
  const deleteSql = `
    DELETE FROM sales_kpi_daily
    WHERE day BETWEEN ? AND ?
    ${sellerId ? 'AND seller_user_id = ?' : ''}
  `
  await db.execute(deleteSql, deleteParams)

  const entries = Array.from(dailyMap.values())
  if (!entries.length) {
    return { inserted: 0 }
  }

  const values = []
  entries.forEach((row) => {
    values.push([
      row.seller_user_id,
      row.day,
      Math.trunc(row.orders_count),
      roundMoney(row.revenue),
      roundMoney(row.margin),
      Math.trunc(row.proposals_sent),
      Math.trunc(row.proposals_approved),
    ])
  })

  const placeholders = values.map(() => '(?,?,?,?,?,?,?)').join(',')
  const flat = values.flat()
  await db.execute(
    `
      INSERT INTO sales_kpi_daily
        (seller_user_id, day, orders_count, revenue, margin, proposals_sent, proposals_approved)
      VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        orders_count = VALUES(orders_count),
        revenue = VALUES(revenue),
        margin = VALUES(margin),
        proposals_sent = VALUES(proposals_sent),
        proposals_approved = VALUES(proposals_approved)
    `,
    flat
  )

  return { inserted: entries.length }
}

// --------------------------------------------------
// GET /sales-kpi/sellers
// --------------------------------------------------
router.get('/sellers', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT u.id, u.username, u.full_name, u.role_id, r.slug AS role, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.slug = 'prodavec'
      ORDER BY COALESCE(NULLIF(u.full_name,''), u.username) ASC
      `
    )
    res.json(rows || [])
  } catch (err) {
    console.error('GET /sales-kpi/sellers error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке продавцов' })
  }
})

// --------------------------------------------------
// POST /sales-kpi/rebuild
// --------------------------------------------------
router.post('/rebuild', requireAdmin, async (req, res) => {
  const range = readRange(req, res, 'body')
  if (!range) return
  const sellerId = parseSellerId(req.body?.seller_id)

  if (rebuildInProgress) {
    return res.status(409).json({ message: 'Пересчёт KPI уже выполняется' })
  }

  try {
    rebuildInProgress = true
    const result = await rebuildDaily({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sellerId,
    })
    res.json({ ok: true, inserted: result.inserted || 0 })
  } catch (err) {
    console.error('POST /sales-kpi/rebuild error:', err)
    res.status(500).json({ message: 'Ошибка сервера при пересчёте KPI' })
  } finally {
    rebuildInProgress = false
  }
})

// --------------------------------------------------
// GET /sales-kpi/summary
// --------------------------------------------------
router.get('/summary', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const sellerId = parseSellerId(req.query.seller_id)

  const sql = `
    SELECT
      COALESCE(SUM(orders_count), 0) AS orders_count,
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(margin), 0) AS margin,
      COALESCE(SUM(proposals_sent), 0) AS proposals_sent,
      COALESCE(SUM(proposals_approved), 0) AS proposals_approved
    FROM sales_kpi_daily
    WHERE day BETWEEN ? AND ?
    ${sellerId ? 'AND seller_user_id = ?' : ''}
  `

  try {
    const params = sellerId
      ? [range.dateFrom, range.dateTo, sellerId]
      : [range.dateFrom, range.dateTo]
    const [rows] = await db.execute(sql, params)
    const row = rows?.[0] || {}
    res.json({ ...row, currency: KPI_CURRENCY })
  } catch (err) {
    console.error('GET /sales-kpi/summary error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке KPI summary' })
  }
})

// --------------------------------------------------
// GET /sales-kpi/daily
// --------------------------------------------------
router.get('/daily', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const sellerId = parseSellerId(req.query.seller_id)

  const sql = `
    SELECT
      seller_user_id,
      day,
      orders_count,
      revenue,
      margin,
      proposals_sent,
      proposals_approved
    FROM sales_kpi_daily
    WHERE day BETWEEN ? AND ?
    ${sellerId ? 'AND seller_user_id = ?' : ''}
    ORDER BY day ASC
  `

  try {
    const params = sellerId
      ? [range.dateFrom, range.dateTo, sellerId]
      : [range.dateFrom, range.dateTo]
    const [rows] = await db.execute(sql, params)
    res.json(rows || [])
  } catch (err) {
    console.error('GET /sales-kpi/daily error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке KPI daily' })
  }
})

// --------------------------------------------------
// GET /sales-kpi/targets
// --------------------------------------------------
router.get('/targets', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const sellerId = parseSellerId(req.query.seller_id)

  const sql = `
    SELECT
      t.id,
      t.seller_user_id,
      t.period_start,
      t.period_end,
      t.target_revenue,
      t.target_margin,
      t.target_orders,
      t.target_proposals,
      COALESCE(u.full_name, u.username) AS seller_name,
      u.username,
      COALESCE(SUM(d.orders_count), 0) AS actual_orders,
      COALESCE(SUM(d.revenue), 0) AS actual_revenue,
      COALESCE(SUM(d.margin), 0) AS actual_margin,
      COALESCE(SUM(d.proposals_sent), 0) AS actual_proposals_sent,
      COALESCE(SUM(d.proposals_approved), 0) AS actual_proposals_approved
    FROM sales_kpi_targets t
    LEFT JOIN users u
      ON u.id = t.seller_user_id
    LEFT JOIN sales_kpi_daily d
      ON d.seller_user_id = t.seller_user_id
      AND d.day BETWEEN GREATEST(t.period_start, ?) AND LEAST(t.period_end, ?)
    WHERE t.period_end >= ?
      AND t.period_start <= ?
      ${sellerId ? 'AND t.seller_user_id = ?' : ''}
    GROUP BY t.id
    ORDER BY t.period_start DESC
  `

  try {
    const params = sellerId
      ? [range.dateFrom, range.dateTo, range.dateFrom, range.dateTo, sellerId]
      : [range.dateFrom, range.dateTo, range.dateFrom, range.dateTo]
    const [rows] = await db.execute(sql, params)
    const payload = (rows || []).map((row) => ({
      ...row,
      currency: KPI_CURRENCY,
    }))
    res.json(payload)
  } catch (err) {
    console.error('GET /sales-kpi/targets error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке KPI targets' })
  }
})

// --------------------------------------------------
// POST /sales-kpi/targets
// --------------------------------------------------
router.post('/targets', requireAdmin, async (req, res) => {
  const sellerUserId = parseSellerId(req.body?.seller_user_id)
  const periodStart = normalizeDate(req.body?.period_start)
  const periodEnd = normalizeDate(req.body?.period_end)

  if (!sellerUserId || !periodStart || !periodEnd) {
    return res.status(400).json({ message: 'Нужно выбрать продавца и период' })
  }
  if (periodStart > periodEnd) {
    return res.status(400).json({ message: 'period_start должен быть раньше period_end' })
  }

  const targetRevenue = toNullableNumber(req.body?.target_revenue)
  const targetMargin = toNullableNumber(req.body?.target_margin)
  const targetOrders = toNullableNumber(req.body?.target_orders)
  const targetProposals = toNullableNumber(req.body?.target_proposals)

  try {
    const [result] = await db.execute(
      `
        INSERT INTO sales_kpi_targets
          (seller_user_id, period_start, period_end, target_revenue, target_margin, target_orders, target_proposals)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        sellerUserId,
        periodStart,
        periodEnd,
        targetRevenue,
        targetMargin,
        targetOrders,
        targetProposals,
      ]
    )
    const [[created]] = await db.execute('SELECT * FROM sales_kpi_targets WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Цель на этот период уже существует' })
    }
    console.error('POST /sales-kpi/targets error:', err)
    res.status(500).json({ message: 'Ошибка сервера при создании цели' })
  }
})

// --------------------------------------------------
// PUT /sales-kpi/targets/:id
// --------------------------------------------------
router.put('/targets/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор цели' })
  }

  try {
    const [[current]] = await db.execute('SELECT * FROM sales_kpi_targets WHERE id = ?', [id])
    if (!current) {
      return res.status(404).json({ message: 'Цель не найдена' })
    }

    const sellerUserId = req.body?.seller_user_id !== undefined
      ? parseSellerId(req.body?.seller_user_id)
      : current.seller_user_id
    const periodStart = req.body?.period_start !== undefined
      ? normalizeDate(req.body?.period_start)
      : current.period_start
    const periodEnd = req.body?.period_end !== undefined
      ? normalizeDate(req.body?.period_end)
      : current.period_end

    if (!sellerUserId || !periodStart || !periodEnd) {
      return res.status(400).json({ message: 'Нужно выбрать продавца и период' })
    }
    if (periodStart > periodEnd) {
      return res.status(400).json({ message: 'period_start должен быть раньше period_end' })
    }

    const targetRevenue = toNullableNumber(req.body?.target_revenue)
    const targetMargin = toNullableNumber(req.body?.target_margin)
    const targetOrders = toNullableNumber(req.body?.target_orders)
    const targetProposals = toNullableNumber(req.body?.target_proposals)

    const finalRevenue = targetRevenue !== undefined ? targetRevenue : current.target_revenue
    const finalMargin = targetMargin !== undefined ? targetMargin : current.target_margin
    const finalOrders = targetOrders !== undefined ? targetOrders : current.target_orders
    const finalProposals = targetProposals !== undefined ? targetProposals : current.target_proposals

    await db.execute(
      `
        UPDATE sales_kpi_targets
        SET
          seller_user_id = ?,
          period_start = ?,
          period_end = ?,
          target_revenue = ?,
          target_margin = ?,
          target_orders = ?,
          target_proposals = ?
        WHERE id = ?
      `,
      [
        sellerUserId,
        periodStart,
        periodEnd,
        finalRevenue,
        finalMargin,
        finalOrders,
        finalProposals,
        id,
      ]
    )

    const [[updated]] = await db.execute('SELECT * FROM sales_kpi_targets WHERE id = ?', [id])
    res.json(updated)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Цель на этот период уже существует' })
    }
    console.error('PUT /sales-kpi/targets/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера при обновлении цели' })
  }
})

// --------------------------------------------------
// DELETE /sales-kpi/targets/:id
// --------------------------------------------------
router.delete('/targets/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор цели' })
  }

  try {
    await db.execute('DELETE FROM sales_kpi_targets WHERE id = ?', [id])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /sales-kpi/targets/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении цели' })
  }
})

module.exports = router
