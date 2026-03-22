const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { convertAmount } = require('../utils/fxRatesService')

const KPI_CURRENCY = String(process.env.KPI_CURRENCY || 'RUB').trim().toUpperCase()
const MAX_RANGE_DAYS = Number(process.env.KPI_MAX_RANGE_DAYS || 370)

const REQUEST_SELLER_EXPR = 'COALESCE(cr.assigned_to_user_id, cr.created_by_user_id)'
const QUOTE_SELLER_EXPR = 'COALESCE(cr.assigned_to_user_id, sq.created_by_user_id, cr.created_by_user_id)'
const CONTRACT_SELLER_EXPR = 'COALESCE(cr.assigned_to_user_id, sq.created_by_user_id, cr.created_by_user_id)'
const SIGNED_CONTRACT_STATUSES = ['signed', 'in_execution', 'completed', 'closed_with_issues']

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

const fetchRequestRows = async ({ dateFrom, dateTo, sellerId }) => {
  const sql = `
    SELECT
      ${REQUEST_SELLER_EXPR} AS seller_id,
      DATE(COALESCE(cr.received_at, cr.created_at)) AS day,
      COUNT(*) AS requests_count,
      0 AS quotes_count,
      0 AS contracts_count,
      0 AS signed_amount,
      NULL AS currency
    FROM client_requests cr
    WHERE DATE(COALESCE(cr.received_at, cr.created_at)) BETWEEN ? AND ?
      ${sellerId ? `AND ${REQUEST_SELLER_EXPR} = ?` : ''}
    GROUP BY seller_id, day
  `
  const params = sellerId ? [dateFrom, dateTo, sellerId] : [dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchQuoteRows = async ({ dateFrom, dateTo, sellerId }) => {
  const sql = `
    SELECT
      ${QUOTE_SELLER_EXPR} AS seller_id,
      DATE(sq.created_at) AS day,
      0 AS requests_count,
      COUNT(*) AS quotes_count,
      0 AS contracts_count,
      0 AS signed_amount,
      NULL AS currency
    FROM sales_quotes sq
    JOIN client_request_revisions crr
      ON crr.id = sq.client_request_revision_id
    JOIN client_requests cr
      ON cr.id = crr.client_request_id
    WHERE DATE(sq.created_at) BETWEEN ? AND ?
      ${sellerId ? `AND ${QUOTE_SELLER_EXPR} = ?` : ''}
    GROUP BY seller_id, day
  `
  const params = sellerId ? [dateFrom, dateTo, sellerId] : [dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchContractRows = async ({ dateFrom, dateTo, sellerId }) => {
  const statusPlaceholders = SIGNED_CONTRACT_STATUSES.map(() => '?').join(',')
  const sql = `
    SELECT
      ${CONTRACT_SELLER_EXPR} AS seller_id,
      cc.contract_date AS day,
      0 AS requests_count,
      0 AS quotes_count,
      COUNT(*) AS contracts_count,
      SUM(COALESCE(cc.amount, 0)) AS signed_amount,
      COALESCE(NULLIF(cc.currency, ''), NULLIF(sq.currency, ''), ?) AS currency
    FROM client_contracts cc
    JOIN sales_quotes sq
      ON sq.id = cc.sales_quote_id
    JOIN client_request_revisions crr
      ON crr.id = sq.client_request_revision_id
    JOIN client_requests cr
      ON cr.id = crr.client_request_id
    WHERE cc.contract_date BETWEEN ? AND ?
      AND cc.status IN (${statusPlaceholders})
      ${sellerId ? `AND ${CONTRACT_SELLER_EXPR} = ?` : ''}
    GROUP BY seller_id, day, currency
  `
  const params = [KPI_CURRENCY, dateFrom, dateTo, ...SIGNED_CONTRACT_STATUSES]
  if (sellerId) params.push(sellerId)
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchDailyRows = async ({ dateFrom, dateTo, sellerId }) => {
  const [requestRows, quoteRows, contractRows] = await Promise.all([
    fetchRequestRows({ dateFrom, dateTo, sellerId }),
    fetchQuoteRows({ dateFrom, dateTo, sellerId }),
    fetchContractRows({ dateFrom, dateTo, sellerId }),
  ])

  const rows = [...requestRows, ...quoteRows, ...contractRows]
  const rateMap = await buildRateMap(rows, KPI_CURRENCY)
  const dailyMap = new Map()

  rows.forEach((row) => {
    const seller = Number(row?.seller_id)
    const day = normalizeDate(row?.day)
    if (!seller || !day) return

    const key = `${seller}__${day}`
    const current = dailyMap.get(key) || {
      seller_user_id: seller,
      day,
      requests_count: 0,
      quotes_count: 0,
      contracts_count: 0,
      signed_amount: 0,
      currency: KPI_CURRENCY,
    }

    const currency = row?.currency ? String(row.currency).toUpperCase() : null
    const rate = currency ? rateMap.get(currency) || 1 : 1

    current.requests_count += Math.trunc(toNumber(row?.requests_count))
    current.quotes_count += Math.trunc(toNumber(row?.quotes_count))
    current.contracts_count += Math.trunc(toNumber(row?.contracts_count))
    current.signed_amount += toNumber(row?.signed_amount) * rate

    dailyMap.set(key, current)
  })

  return Array.from(dailyMap.values())
    .map((row) => ({
      ...row,
      signed_amount: roundMoney(row.signed_amount),
    }))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
}

const buildSummary = (dailyRows) => dailyRows.reduce(
  (acc, row) => ({
    requests_count: acc.requests_count + Math.trunc(toNumber(row?.requests_count)),
    quotes_count: acc.quotes_count + Math.trunc(toNumber(row?.quotes_count)),
    contracts_count: acc.contracts_count + Math.trunc(toNumber(row?.contracts_count)),
    signed_amount: roundMoney(acc.signed_amount + toNumber(row?.signed_amount)),
    currency: KPI_CURRENCY,
  }),
  {
    requests_count: 0,
    quotes_count: 0,
    contracts_count: 0,
    signed_amount: 0,
    currency: KPI_CURRENCY,
  }
)

const rowsForTarget = (dailyRows, sellerUserId, periodStart, periodEnd) =>
  dailyRows.filter((row) =>
    Number(row?.seller_user_id) === Number(sellerUserId) &&
    String(row?.day || '') >= String(periodStart) &&
    String(row?.day || '') <= String(periodEnd)
  )

const buildTargetActuals = (rows) => rows.reduce(
  (acc, row) => ({
    actual_requests: acc.actual_requests + Math.trunc(toNumber(row?.requests_count)),
    actual_quotes: acc.actual_quotes + Math.trunc(toNumber(row?.quotes_count)),
    actual_contracts: acc.actual_contracts + Math.trunc(toNumber(row?.contracts_count)),
    actual_signed_amount: roundMoney(acc.actual_signed_amount + toNumber(row?.signed_amount)),
  }),
  {
    actual_requests: 0,
    actual_quotes: 0,
    actual_contracts: 0,
    actual_signed_amount: 0,
  }
)

router.get('/sellers', async (_req, res) => {
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

router.post('/rebuild', requireAdmin, async (_req, res) => {
  return res.json({
    ok: true,
    mode: 'live',
    message: 'KPI продавцов считается по текущим данным и не требует отдельного пересчета',
  })
})

router.get('/summary', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const sellerId = parseSellerId(req.query.seller_id)

  try {
    const dailyRows = await fetchDailyRows({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sellerId,
    })
    res.json(buildSummary(dailyRows))
  } catch (err) {
    console.error('GET /sales-kpi/summary error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке KPI summary' })
  }
})

router.get('/daily', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const sellerId = parseSellerId(req.query.seller_id)

  try {
    const dailyRows = await fetchDailyRows({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sellerId,
    })
    res.json(dailyRows)
  } catch (err) {
    console.error('GET /sales-kpi/daily error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке KPI daily' })
  }
})

router.get('/targets', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const sellerId = parseSellerId(req.query.seller_id)

  try {
    const targetSql = `
      SELECT
        t.id,
        t.seller_user_id,
        t.period_start,
        t.period_end,
        t.target_requests,
        t.target_quotes,
        t.target_contracts,
        t.target_signed_amount,
        COALESCE(u.full_name, u.username) AS seller_name,
        u.username
      FROM sales_kpi_targets t
      LEFT JOIN users u
        ON u.id = t.seller_user_id
      WHERE t.period_end >= ?
        AND t.period_start <= ?
        ${sellerId ? 'AND t.seller_user_id = ?' : ''}
      ORDER BY t.period_start DESC
    `

    const params = sellerId
      ? [range.dateFrom, range.dateTo, sellerId]
      : [range.dateFrom, range.dateTo]

    const [rows] = await db.execute(targetSql, params)
    const targetRows = rows || []
    const dailyRows = await fetchDailyRows({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sellerId,
    })

    const payload = targetRows.map((row) => {
      const effectiveFrom = String(row.period_start) > range.dateFrom
        ? String(row.period_start)
        : range.dateFrom
      const effectiveTo = String(row.period_end) < range.dateTo
        ? String(row.period_end)
        : range.dateTo

      const actuals = buildTargetActuals(
        rowsForTarget(dailyRows, row.seller_user_id, effectiveFrom, effectiveTo)
      )

      return {
        ...row,
        ...actuals,
        currency: KPI_CURRENCY,
      }
    })

    res.json(payload)
  } catch (err) {
    console.error('GET /sales-kpi/targets error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке KPI targets' })
  }
})

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

  const targetRequests = toNullableNumber(req.body?.target_requests)
  const targetQuotes = toNullableNumber(req.body?.target_quotes)
  const targetContracts = toNullableNumber(req.body?.target_contracts)
  const targetSignedAmount = toNullableNumber(req.body?.target_signed_amount)

  try {
    const [result] = await db.execute(
      `
        INSERT INTO sales_kpi_targets
          (seller_user_id, period_start, period_end, target_requests, target_quotes, target_contracts, target_signed_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        sellerUserId,
        periodStart,
        periodEnd,
        targetRequests,
        targetQuotes,
        targetContracts,
        targetSignedAmount,
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

    const targetRequests = toNullableNumber(
      req.body?.target_requests !== undefined ? req.body?.target_requests : current.target_requests
    )
    const targetQuotes = toNullableNumber(
      req.body?.target_quotes !== undefined ? req.body?.target_quotes : current.target_quotes
    )
    const targetContracts = toNullableNumber(
      req.body?.target_contracts !== undefined ? req.body?.target_contracts : current.target_contracts
    )
    const targetSignedAmount = toNullableNumber(
      req.body?.target_signed_amount !== undefined ? req.body?.target_signed_amount : current.target_signed_amount
    )

    await db.execute(
      `
        UPDATE sales_kpi_targets
        SET seller_user_id = ?,
            period_start = ?,
            period_end = ?,
            target_requests = ?,
            target_quotes = ?,
            target_contracts = ?,
            target_signed_amount = ?
        WHERE id = ?
      `,
      [
        sellerUserId,
        periodStart,
        periodEnd,
        targetRequests,
        targetQuotes,
        targetContracts,
        targetSignedAmount,
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

router.delete('/targets/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор цели' })
  }

  try {
    await db.execute('DELETE FROM sales_kpi_targets WHERE id = ?', [id])
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE /sales-kpi/targets/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении цели' })
  }
})

module.exports = router
