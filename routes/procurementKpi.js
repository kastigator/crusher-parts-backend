const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { convertAmount } = require('../utils/fxRatesService')
const { createTrashEntry } = require('../utils/trashStore')

const DEFAULT_KPI_CURRENCY = String(process.env.KPI_CURRENCY || 'RUB').trim().toUpperCase()
const MAX_RANGE_DAYS = Number(process.env.KPI_MAX_RANGE_DAYS || 370)
const RESPONSIBLE_BUYER_EXPR = 'COALESCE(r.assigned_to_user_id, r.created_by_user_id)'

const normCode = (v) => {
  if (!v) return null
  const s = String(v).trim().toUpperCase()
  return s.length === 3 ? s : null
}

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

const readBaseCurrency = (req) => normCode(req.query?.base_currency) || DEFAULT_KPI_CURRENCY

const parseBuyerId = (value) => {
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

const isBuyer = (user) => normalizeRole(user) === 'zakupshchik'

const requireAdmin = (req, res, next) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Нет доступа' })
  }
  return next()
}

const resolveBuyerScope = (req) => {
  if (isAdmin(req.user)) return parseBuyerId(req.query.buyer_id)
  if (isBuyer(req.user)) return Number(req.user?.id) || null
  return parseBuyerId(req.query.buyer_id)
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
const roundPercent = (value) => Math.round(toNumber(value) * 10) / 10
const roundHours = (value) => Math.round(toNumber(value) * 10) / 10

const EVENT_TYPE_LABELS = {
  COMPLAINT: 'Жалоба',
  DELAY: 'Задержка',
  PROCESSING_RATING: 'Оценка обработки',
}

const getRateFor = async (from, to) => {
  if (!from || !to || from === to) return 1
  try {
    const res = await convertAmount(1, from, to)
    return Number.isFinite(res?.rate) ? Number(res.rate) : 1
  } catch (err) {
    console.warn('Procurement KPI FX rate fallback:', err?.message || err)
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

const fetchRfqRows = async ({ dateFrom, dateTo, buyerId }) => {
  const sql = `
    SELECT
      ${RESPONSIBLE_BUYER_EXPR} AS buyer_id,
      DATE(r.created_at) AS day,
      COUNT(*) AS rfqs_count,
      0 AS invites_count,
      0 AS responses_count,
      0 AS selections_count,
      0 AS purchase_orders_count,
      0 AS quality_events_count,
      0 AS landed_amount,
      NULL AS currency
    FROM rfqs r
    WHERE DATE(r.created_at) BETWEEN ? AND ?
      ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
    GROUP BY buyer_id, day
  `
  const params = buyerId ? [dateFrom, dateTo, buyerId] : [dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchInviteRows = async ({ dateFrom, dateTo, buyerId }) => {
  const sql = `
    SELECT
      ${RESPONSIBLE_BUYER_EXPR} AS buyer_id,
      DATE(COALESCE(rs.invited_at, r.sent_at, r.created_at)) AS day,
      0 AS rfqs_count,
      COUNT(*) AS invites_count,
      0 AS responses_count,
      0 AS selections_count,
      0 AS purchase_orders_count,
      0 AS quality_events_count,
      0 AS landed_amount,
      NULL AS currency
    FROM rfq_suppliers rs
    JOIN rfqs r
      ON r.id = rs.rfq_id
    WHERE DATE(COALESCE(rs.invited_at, r.sent_at, r.created_at)) BETWEEN ? AND ?
      ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
    GROUP BY buyer_id, day
  `
  const params = buyerId ? [dateFrom, dateTo, buyerId] : [dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchResponseRows = async ({ dateFrom, dateTo, buyerId }) => {
  const sql = `
    SELECT
      ${RESPONSIBLE_BUYER_EXPR} AS buyer_id,
      DATE(COALESCE(rs.responded_at, fr.first_response_at)) AS day,
      0 AS rfqs_count,
      0 AS invites_count,
      COUNT(*) AS responses_count,
      0 AS selections_count,
      0 AS purchase_orders_count,
      0 AS quality_events_count,
      0 AS landed_amount,
      NULL AS currency
    FROM rfq_suppliers rs
    JOIN rfqs r
      ON r.id = rs.rfq_id
    LEFT JOIN (
      SELECT rfq_supplier_id, MIN(created_at) AS first_response_at
      FROM rfq_supplier_responses
      GROUP BY rfq_supplier_id
    ) fr
      ON fr.rfq_supplier_id = rs.id
    WHERE DATE(COALESCE(rs.responded_at, fr.first_response_at)) BETWEEN ? AND ?
      ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
    GROUP BY buyer_id, day
  `
  const params = buyerId ? [dateFrom, dateTo, buyerId] : [dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchSelectionRows = async ({ dateFrom, dateTo, buyerId, baseCurrency }) => {
  const sql = `
    SELECT
      ${RESPONSIBLE_BUYER_EXPR} AS buyer_id,
      DATE(COALESCE(s.selected_at, s.created_at)) AS day,
      0 AS rfqs_count,
      0 AS invites_count,
      0 AS responses_count,
      COUNT(*) AS selections_count,
      0 AS purchase_orders_count,
      0 AS quality_events_count,
      SUM(COALESCE(s.landed_total, 0)) AS landed_amount,
      COALESCE(NULLIF(s.calc_currency, ''), ?) AS currency
    FROM selections s
    JOIN rfqs r
      ON r.id = s.rfq_id
    WHERE s.status = 'approved'
      AND DATE(COALESCE(s.selected_at, s.created_at)) BETWEEN ? AND ?
      ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
    GROUP BY buyer_id, day, currency
  `
  const params = buyerId
    ? [baseCurrency, dateFrom, dateTo, buyerId]
    : [baseCurrency, dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchPurchaseOrderRows = async ({ dateFrom, dateTo, buyerId }) => {
  const sql = `
    SELECT
      ${RESPONSIBLE_BUYER_EXPR} AS buyer_id,
      DATE(po.created_at) AS day,
      0 AS rfqs_count,
      0 AS invites_count,
      0 AS responses_count,
      0 AS selections_count,
      COUNT(*) AS purchase_orders_count,
      0 AS quality_events_count,
      0 AS landed_amount,
      NULL AS currency
    FROM supplier_purchase_orders po
    JOIN selections s
      ON s.id = po.selection_id
    JOIN rfqs r
      ON r.id = s.rfq_id
    WHERE DATE(po.created_at) BETWEEN ? AND ?
      ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
    GROUP BY buyer_id, day
  `
  const params = buyerId ? [dateFrom, dateTo, buyerId] : [dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchQualityRows = async ({ dateFrom, dateTo, buyerId }) => {
  const sql = `
    SELECT
      ${RESPONSIBLE_BUYER_EXPR} AS buyer_id,
      DATE(COALESCE(sqe.occurred_at, sqe.created_at)) AS day,
      0 AS rfqs_count,
      0 AS invites_count,
      0 AS responses_count,
      0 AS selections_count,
      0 AS purchase_orders_count,
      COUNT(*) AS quality_events_count,
      0 AS landed_amount,
      NULL AS currency
    FROM supplier_quality_events sqe
    LEFT JOIN supplier_purchase_orders po
      ON po.id = sqe.supplier_purchase_order_id
    LEFT JOIN selections s
      ON s.id = COALESCE(sqe.selection_id, po.selection_id)
    LEFT JOIN rfqs r
      ON r.id = s.rfq_id
    WHERE r.id IS NOT NULL
      AND DATE(COALESCE(sqe.occurred_at, sqe.created_at)) BETWEEN ? AND ?
      ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
    GROUP BY buyer_id, day
  `
  const params = buyerId ? [dateFrom, dateTo, buyerId] : [dateFrom, dateTo]
  const [rows] = await db.execute(sql, params)
  return rows || []
}

const fetchDailyRows = async ({ dateFrom, dateTo, buyerId, baseCurrency }) => {
  const [rfqRows, inviteRows, responseRows, selectionRows, poRows, qualityRows] = await Promise.all([
    fetchRfqRows({ dateFrom, dateTo, buyerId }),
    fetchInviteRows({ dateFrom, dateTo, buyerId }),
    fetchResponseRows({ dateFrom, dateTo, buyerId }),
    fetchSelectionRows({ dateFrom, dateTo, buyerId, baseCurrency }),
    fetchPurchaseOrderRows({ dateFrom, dateTo, buyerId }),
    fetchQualityRows({ dateFrom, dateTo, buyerId }),
  ])

  const rows = [...rfqRows, ...inviteRows, ...responseRows, ...selectionRows, ...poRows, ...qualityRows]
  const rateMap = await buildRateMap(rows, baseCurrency)
  const dailyMap = new Map()

  rows.forEach((row) => {
    const buyer = Number(row?.buyer_id)
    const day = normalizeDate(row?.day)
    if (!buyer || !day) return

    const key = `${buyer}__${day}`
    const current = dailyMap.get(key) || {
      buyer_user_id: buyer,
      day,
      rfqs_count: 0,
      invites_count: 0,
      responses_count: 0,
      selections_count: 0,
      purchase_orders_count: 0,
      quality_events_count: 0,
      landed_amount: 0,
      currency: baseCurrency,
    }

    const currency = row?.currency ? String(row.currency).toUpperCase() : null
    const rate = currency ? rateMap.get(currency) || 1 : 1

    current.rfqs_count += Math.trunc(toNumber(row?.rfqs_count))
    current.invites_count += Math.trunc(toNumber(row?.invites_count))
    current.responses_count += Math.trunc(toNumber(row?.responses_count))
    current.selections_count += Math.trunc(toNumber(row?.selections_count))
    current.purchase_orders_count += Math.trunc(toNumber(row?.purchase_orders_count))
    current.quality_events_count += Math.trunc(toNumber(row?.quality_events_count))
    current.landed_amount += toNumber(row?.landed_amount) * rate

    dailyMap.set(key, current)
  })

  return Array.from(dailyMap.values())
    .map((row) => ({
      ...row,
      landed_amount: roundMoney(row.landed_amount),
    }))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
}

const buildSummary = async ({ dailyRows, dateFrom, dateTo, buyerId, baseCurrency }) => {
  const base = dailyRows.reduce(
    (acc, row) => ({
      rfqs_count: acc.rfqs_count + Math.trunc(toNumber(row?.rfqs_count)),
      invites_count: acc.invites_count + Math.trunc(toNumber(row?.invites_count)),
      responses_count: acc.responses_count + Math.trunc(toNumber(row?.responses_count)),
      selections_count: acc.selections_count + Math.trunc(toNumber(row?.selections_count)),
      purchase_orders_count:
        acc.purchase_orders_count + Math.trunc(toNumber(row?.purchase_orders_count)),
      quality_events_count:
        acc.quality_events_count + Math.trunc(toNumber(row?.quality_events_count)),
      landed_amount: roundMoney(acc.landed_amount + toNumber(row?.landed_amount)),
      currency: baseCurrency,
    }),
    {
      rfqs_count: 0,
      invites_count: 0,
      responses_count: 0,
      selections_count: 0,
      purchase_orders_count: 0,
      quality_events_count: 0,
      landed_amount: 0,
      currency: baseCurrency,
    }
  )

  base.response_rate_pct = base.invites_count
    ? roundPercent((base.responses_count / base.invites_count) * 100)
    : 0

  const selectionSpeedSql = `
    SELECT AVG(
      CASE
        WHEN TIMESTAMPDIFF(HOUR, r.created_at, COALESCE(s.selected_at, s.created_at)) >= 0
          THEN TIMESTAMPDIFF(HOUR, r.created_at, COALESCE(s.selected_at, s.created_at))
        ELSE NULL
      END
    ) AS avg_hours_to_selection
    FROM selections s
    JOIN rfqs r
      ON r.id = s.rfq_id
    WHERE s.status = 'approved'
      AND DATE(COALESCE(s.selected_at, s.created_at)) BETWEEN ? AND ?
      ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
  `
  const selectionParams = buyerId ? [dateFrom, dateTo, buyerId] : [dateFrom, dateTo]
  const [[selectionSpeed]] = await db.execute(selectionSpeedSql, selectionParams)

  const firstResponseSql = `
    SELECT AVG(first_response_hours) AS avg_hours_to_first_response
    FROM (
      SELECT
        r.id,
        CASE
          WHEN MIN(
            CASE
              WHEN COALESCE(rs.responded_at, fr.first_response_at) IS NOT NULL
                THEN TIMESTAMPDIFF(
                  HOUR,
                  COALESCE(r.sent_at, r.created_at),
                  COALESCE(rs.responded_at, fr.first_response_at)
                )
              ELSE NULL
            END
          ) >= 0
          THEN MIN(
            CASE
              WHEN COALESCE(rs.responded_at, fr.first_response_at) IS NOT NULL
                THEN TIMESTAMPDIFF(
                  HOUR,
                  COALESCE(r.sent_at, r.created_at),
                  COALESCE(rs.responded_at, fr.first_response_at)
                )
              ELSE NULL
            END
          )
          ELSE NULL
        END AS first_response_hours
      FROM rfqs r
      JOIN rfq_suppliers rs
        ON rs.rfq_id = r.id
      LEFT JOIN (
        SELECT rfq_supplier_id, MIN(created_at) AS first_response_at
        FROM rfq_supplier_responses
        GROUP BY rfq_supplier_id
      ) fr
        ON fr.rfq_supplier_id = rs.id
      WHERE DATE(COALESCE(rs.responded_at, fr.first_response_at)) BETWEEN ? AND ?
        ${buyerId ? `AND ${RESPONSIBLE_BUYER_EXPR} = ?` : ''}
      GROUP BY r.id
    ) x
  `
  const firstResponseParams = buyerId ? [dateFrom, dateTo, buyerId] : [dateFrom, dateTo]
  const [[firstResponse]] = await db.execute(firstResponseSql, firstResponseParams)

  base.avg_hours_to_selection = roundHours(selectionSpeed?.avg_hours_to_selection)
  base.avg_hours_to_first_response = roundHours(firstResponse?.avg_hours_to_first_response)

  return base
}

const rowsForTarget = (dailyRows, buyerUserId, periodStart, periodEnd) =>
  dailyRows.filter((row) =>
    Number(row?.buyer_user_id) === Number(buyerUserId) &&
    String(row?.day || '') >= String(periodStart) &&
    String(row?.day || '') <= String(periodEnd)
  )

const buildTargetActuals = (rows) => {
  const totals = rows.reduce(
    (acc, row) => ({
      actual_rfqs: acc.actual_rfqs + Math.trunc(toNumber(row?.rfqs_count)),
      actual_invites: acc.actual_invites + Math.trunc(toNumber(row?.invites_count)),
      actual_selections: acc.actual_selections + Math.trunc(toNumber(row?.selections_count)),
      actual_purchase_orders:
        acc.actual_purchase_orders + Math.trunc(toNumber(row?.purchase_orders_count)),
      actual_landed_amount:
        roundMoney(acc.actual_landed_amount + toNumber(row?.landed_amount)),
    }),
    {
      actual_rfqs: 0,
      actual_invites: 0,
      actual_selections: 0,
      actual_purchase_orders: 0,
      actual_landed_amount: 0,
    }
  )

  return totals
}

router.get('/buyers', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT DISTINCT u.id, u.username, u.full_name, u.role_id, r.slug AS role, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.slug IN ('zakupshchik', 'nachalnik-otdela-zakupok', 'admin')
      ORDER BY COALESCE(NULLIF(u.full_name,''), u.username) ASC
      `
    )
    res.json(rows || [])
  } catch (err) {
    console.error('GET /procurement-kpi/buyers error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке закупщиков' })
  }
})

router.post('/rebuild', requireAdmin, async (_req, res) => {
  return res.json({
    ok: true,
    mode: 'live',
    message: 'KPI закупки считается по текущим данным и не требует отдельного пересчета',
  })
})

router.get('/summary', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const buyerId = parseBuyerId(req.query.buyer_id)
  const baseCurrency = readBaseCurrency(req)

  try {
    const dailyRows = await fetchDailyRows({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      buyerId,
      baseCurrency,
    })
    const summary = await buildSummary({
      dailyRows,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      buyerId,
      baseCurrency,
    })
    res.json(summary)
  } catch (err) {
    console.error('GET /procurement-kpi/summary error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке закупочного KPI' })
  }
})

router.get('/daily', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const buyerId = resolveBuyerScope(req)
  const baseCurrency = readBaseCurrency(req)

  try {
    const dailyRows = await fetchDailyRows({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      buyerId,
      baseCurrency,
    })
    res.json(dailyRows)
  } catch (err) {
    console.error('GET /procurement-kpi/daily error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке закупочного KPI по дням' })
  }
})

router.get('/details', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const buyerId = resolveBuyerScope(req)
  const metric = String(req.query.metric || '').trim()

  if (!buyerId) {
    return res.status(400).json({ message: 'Нужно выбрать закупщика' })
  }

  try {
    let rows = []

    if (metric === 'rfqs_count') {
      const [result] = await db.execute(
        `
          SELECT
            r.id,
            r.id AS rfq_id,
            DATE(r.created_at) AS event_date,
            r.rfq_number,
            r.status,
            cr.internal_number AS client_request_number
          FROM rfqs r
          LEFT JOIN client_request_revisions crr ON crr.id = r.client_request_revision_id
          LEFT JOIN client_requests cr ON cr.id = crr.client_request_id
          WHERE DATE(r.created_at) BETWEEN ? AND ?
            AND ${RESPONSIBLE_BUYER_EXPR} = ?
          ORDER BY event_date DESC, r.id DESC
          LIMIT 300
        `,
        [range.dateFrom, range.dateTo, buyerId]
      )
      rows = (result || []).map((row) => ({
        ...row,
        title: row.rfq_number || `RFQ #${row.id}`,
        subtitle: row.client_request_number || 'Без номера заявки клиента',
        object_kind: 'rfq',
        workspace: 'rfq',
        workspace_tab: 'rfq',
      }))
    } else if (metric === 'invites_count') {
      const [result] = await db.execute(
        `
          SELECT
            rs.id,
            r.id AS rfq_id,
            DATE(COALESCE(rs.invited_at, r.sent_at, r.created_at)) AS event_date,
            rs.status,
            r.rfq_number,
            ps.name AS supplier_name
          FROM rfq_suppliers rs
          JOIN rfqs r ON r.id = rs.rfq_id
          JOIN part_suppliers ps ON ps.id = rs.supplier_id
          WHERE DATE(COALESCE(rs.invited_at, r.sent_at, r.created_at)) BETWEEN ? AND ?
            AND ${RESPONSIBLE_BUYER_EXPR} = ?
          ORDER BY event_date DESC, rs.id DESC
          LIMIT 300
        `,
        [range.dateFrom, range.dateTo, buyerId]
      )
      rows = (result || []).map((row) => ({
        ...row,
        title: row.rfq_number || `RFQ supplier #${row.id}`,
        subtitle: row.supplier_name || 'Поставщик не указан',
        object_kind: 'rfq_invite',
        workspace: 'rfq',
        workspace_tab: 'suppliers',
      }))
    } else if (metric === 'responses_count') {
      const [result] = await db.execute(
        `
          SELECT
            rs.id,
            r.id AS rfq_id,
            DATE(COALESCE(rs.responded_at, fr.first_response_at)) AS event_date,
            rs.status,
            r.rfq_number,
            ps.name AS supplier_name
          FROM rfq_suppliers rs
          JOIN rfqs r ON r.id = rs.rfq_id
          JOIN part_suppliers ps ON ps.id = rs.supplier_id
          LEFT JOIN (
            SELECT rfq_supplier_id, MIN(created_at) AS first_response_at
            FROM rfq_supplier_responses
            GROUP BY rfq_supplier_id
          ) fr ON fr.rfq_supplier_id = rs.id
          WHERE DATE(COALESCE(rs.responded_at, fr.first_response_at)) BETWEEN ? AND ?
            AND ${RESPONSIBLE_BUYER_EXPR} = ?
          ORDER BY event_date DESC, rs.id DESC
          LIMIT 300
        `,
        [range.dateFrom, range.dateTo, buyerId]
      )
      rows = (result || []).map((row) => ({
        ...row,
        title: row.rfq_number || `Ответ #${row.id}`,
        subtitle: row.supplier_name || 'Поставщик не указан',
        object_kind: 'rfq_response',
        workspace: 'rfq',
        workspace_tab: 'responses',
      }))
    } else if (metric === 'selections_count' || metric === 'landed_amount') {
      const [result] = await db.execute(
        `
          SELECT
            s.id,
            s.rfq_id,
            DATE(COALESCE(s.selected_at, s.created_at)) AS event_date,
            s.status,
            s.landed_total,
            s.calc_currency,
            r.rfq_number
          FROM selections s
          JOIN rfqs r ON r.id = s.rfq_id
          WHERE s.status = 'approved'
            AND DATE(COALESCE(s.selected_at, s.created_at)) BETWEEN ? AND ?
            AND ${RESPONSIBLE_BUYER_EXPR} = ?
          ORDER BY event_date DESC, s.id DESC
          LIMIT 300
        `,
        [range.dateFrom, range.dateTo, buyerId]
      )
      rows = result || []
      if (metric === 'landed_amount') {
        const rateMap = await buildRateMap(rows.map((row) => ({ currency: row.calc_currency })), readBaseCurrency(req))
        rows = rows.map((row) => ({
          ...row,
          landed_amount_normalized: roundMoney(
            toNumber(row.landed_total) *
              (rateMap.get(String(row.calc_currency || readBaseCurrency(req)).toUpperCase()) || 1)
          ),
        }))
      }
      rows = rows.map((row) => ({
        ...row,
        title: `Выбор #${row.id}`,
        subtitle: row.rfq_number || 'Без номера RFQ',
        object_kind: 'selection',
        workspace: 'rfq',
        workspace_tab: 'selection',
      }))
    } else if (metric === 'purchase_orders_count') {
      const [result] = await db.execute(
        `
          SELECT
            po.id,
            r.id AS rfq_id,
            DATE(po.created_at) AS event_date,
            po.status,
            po.supplier_reference,
            r.rfq_number,
            ps.name AS supplier_name
          FROM supplier_purchase_orders po
          JOIN selections s ON s.id = po.selection_id
          JOIN rfqs r ON r.id = s.rfq_id
          JOIN part_suppliers ps ON ps.id = po.supplier_id
          WHERE DATE(po.created_at) BETWEEN ? AND ?
            AND ${RESPONSIBLE_BUYER_EXPR} = ?
          ORDER BY event_date DESC, po.id DESC
          LIMIT 300
        `,
        [range.dateFrom, range.dateTo, buyerId]
      )
      rows = (result || []).map((row) => ({
        ...row,
        title: row.supplier_reference || `Заказ поставщику #${row.id}`,
        subtitle: [row.supplier_name, row.rfq_number].filter(Boolean).join(' · ') || 'Без привязки',
        object_kind: 'purchase_order',
        workspace: 'rfq',
        workspace_tab: 'po',
      }))
    } else if (metric === 'quality_events_count') {
      const [result] = await db.execute(
        `
          SELECT
            sqe.id,
            r.id AS rfq_id,
            DATE(COALESCE(sqe.occurred_at, sqe.created_at)) AS event_date,
            sqe.event_type,
            sqe.severity,
            sqe.status,
            ps.name AS supplier_name,
            po.supplier_reference,
            r.rfq_number
          FROM supplier_quality_events sqe
          LEFT JOIN supplier_purchase_orders po ON po.id = sqe.supplier_purchase_order_id
          LEFT JOIN selections s ON s.id = COALESCE(sqe.selection_id, po.selection_id)
          LEFT JOIN rfqs r ON r.id = s.rfq_id
          LEFT JOIN part_suppliers ps ON ps.id = COALESCE(sqe.supplier_id, po.supplier_id)
          WHERE r.id IS NOT NULL
            AND DATE(COALESCE(sqe.occurred_at, sqe.created_at)) BETWEEN ? AND ?
            AND ${RESPONSIBLE_BUYER_EXPR} = ?
          ORDER BY event_date DESC, sqe.id DESC
          LIMIT 300
        `,
        [range.dateFrom, range.dateTo, buyerId]
      )
      rows = (result || []).map((row) => ({
        ...row,
        title: EVENT_TYPE_LABELS[row.event_type] || row.event_type || `Инцидент #${row.id}`,
        subtitle: [row.supplier_name, row.supplier_reference || row.rfq_number].filter(Boolean).join(' · ') || 'Без привязки',
        object_kind: 'quality_event',
        workspace: 'rfq',
        workspace_tab: 'po',
      }))
    } else {
      return res.status(400).json({ message: 'Неизвестная метрика' })
    }

    return res.json({ metric, rows })
  } catch (err) {
    console.error('GET /procurement-kpi/details error:', err)
    return res.status(500).json({ message: 'Ошибка сервера при загрузке деталей закупочного KPI' })
  }
})

router.get('/targets', async (req, res) => {
  const range = readRange(req, res)
  if (!range) return
  const buyerId = parseBuyerId(req.query.buyer_id)
  const baseCurrency = readBaseCurrency(req)

  try {
    const targetSql = `
      SELECT
        t.id,
        t.buyer_user_id,
        t.period_start,
        t.period_end,
        t.target_rfqs,
        t.target_invites,
        t.target_selections,
        t.target_purchase_orders,
        t.target_landed_amount,
        COALESCE(NULLIF(t.target_currency, ''), ?) AS target_currency,
        COALESCE(u.full_name, u.username) AS buyer_name,
        u.username
      FROM procurement_kpi_targets t
      LEFT JOIN users u
        ON u.id = t.buyer_user_id
      WHERE t.period_end >= ?
        AND t.period_start <= ?
        ${buyerId ? 'AND t.buyer_user_id = ?' : ''}
      ORDER BY t.period_start DESC
    `
    const params = buyerId
      ? [DEFAULT_KPI_CURRENCY, range.dateFrom, range.dateTo, buyerId]
      : [DEFAULT_KPI_CURRENCY, range.dateFrom, range.dateTo]

    const [rows] = await db.execute(targetSql, params)
    const dailyRows = await fetchDailyRows({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      buyerId,
      baseCurrency,
    })

    const targetRateMap = await buildRateMap(
      (rows || []).map((row) => ({ currency: row.target_currency })),
      baseCurrency
    )

    const payload = (rows || []).map((row) => {
      const effectiveFrom = String(row.period_start) > range.dateFrom
        ? String(row.period_start)
        : range.dateFrom
      const effectiveTo = String(row.period_end) < range.dateTo
        ? String(row.period_end)
        : range.dateTo

      return {
        ...row,
        target_landed_amount: roundMoney(
          toNumber(row.target_landed_amount) *
            (targetRateMap.get(String(row.target_currency || baseCurrency).toUpperCase()) || 1)
        ),
        ...buildTargetActuals(
          rowsForTarget(dailyRows, row.buyer_user_id, effectiveFrom, effectiveTo)
        ),
        currency: baseCurrency,
      }
    })

    res.json(payload)
  } catch (err) {
    console.error('GET /procurement-kpi/targets error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке целей закупочного KPI' })
  }
})

router.post('/targets', requireAdmin, async (req, res) => {
  const buyerUserId = parseBuyerId(req.body?.buyer_user_id)
  const periodStart = normalizeDate(req.body?.period_start)
  const periodEnd = normalizeDate(req.body?.period_end)

  if (!buyerUserId || !periodStart || !periodEnd) {
    return res.status(400).json({ message: 'Нужно выбрать закупщика и период' })
  }
  if (periodStart > periodEnd) {
    return res.status(400).json({ message: 'period_start должен быть раньше period_end' })
  }

  const targetRfqs = toNullableNumber(req.body?.target_rfqs)
  const targetInvites = toNullableNumber(req.body?.target_invites)
  const targetSelections = toNullableNumber(req.body?.target_selections)
  const targetPurchaseOrders = toNullableNumber(req.body?.target_purchase_orders)
  const targetLandedAmount = toNullableNumber(req.body?.target_landed_amount)
  const targetCurrency = normCode(req.body?.target_currency) || DEFAULT_KPI_CURRENCY

  try {
    const [result] = await db.execute(
      `
        INSERT INTO procurement_kpi_targets
          (buyer_user_id, period_start, period_end, target_rfqs, target_invites, target_selections, target_purchase_orders, target_landed_amount, target_currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        buyerUserId,
        periodStart,
        periodEnd,
        targetRfqs,
        targetInvites,
        targetSelections,
        targetPurchaseOrders,
        targetLandedAmount,
        targetCurrency,
      ]
    )
    const [[created]] = await db.execute('SELECT * FROM procurement_kpi_targets WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Цель на этот период уже существует' })
    }
    console.error('POST /procurement-kpi/targets error:', err)
    res.status(500).json({ message: 'Ошибка сервера при создании цели закупочного KPI' })
  }
})

router.put('/targets/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор цели' })
  }

  try {
    const [[current]] = await db.execute('SELECT * FROM procurement_kpi_targets WHERE id = ?', [id])
    if (!current) {
      return res.status(404).json({ message: 'Цель не найдена' })
    }

    const buyerUserId = req.body?.buyer_user_id !== undefined
      ? parseBuyerId(req.body?.buyer_user_id)
      : current.buyer_user_id
    const periodStart = req.body?.period_start !== undefined
      ? normalizeDate(req.body?.period_start)
      : current.period_start
    const periodEnd = req.body?.period_end !== undefined
      ? normalizeDate(req.body?.period_end)
      : current.period_end

    if (!buyerUserId || !periodStart || !periodEnd) {
      return res.status(400).json({ message: 'Нужно выбрать закупщика и период' })
    }
    if (periodStart > periodEnd) {
      return res.status(400).json({ message: 'period_start должен быть раньше period_end' })
    }

    const targetRfqs = toNullableNumber(
      req.body?.target_rfqs !== undefined ? req.body?.target_rfqs : current.target_rfqs
    )
    const targetInvites = toNullableNumber(
      req.body?.target_invites !== undefined ? req.body?.target_invites : current.target_invites
    )
    const targetSelections = toNullableNumber(
      req.body?.target_selections !== undefined ? req.body?.target_selections : current.target_selections
    )
    const targetPurchaseOrders = toNullableNumber(
      req.body?.target_purchase_orders !== undefined
        ? req.body?.target_purchase_orders
        : current.target_purchase_orders
    )
    const targetLandedAmount = toNullableNumber(
      req.body?.target_landed_amount !== undefined
        ? req.body?.target_landed_amount
        : current.target_landed_amount
    )
    const targetCurrency = req.body?.target_currency !== undefined
      ? (normCode(req.body?.target_currency) || DEFAULT_KPI_CURRENCY)
      : (normCode(current.target_currency) || DEFAULT_KPI_CURRENCY)

    await db.execute(
      `
        UPDATE procurement_kpi_targets
        SET buyer_user_id = ?,
            period_start = ?,
            period_end = ?,
            target_rfqs = ?,
            target_invites = ?,
            target_selections = ?,
            target_purchase_orders = ?,
            target_landed_amount = ?,
            target_currency = ?
        WHERE id = ?
      `,
      [
        buyerUserId,
        periodStart,
        periodEnd,
        targetRfqs,
        targetInvites,
        targetSelections,
        targetPurchaseOrders,
        targetLandedAmount,
        targetCurrency,
        id,
      ]
    )

    const [[updated]] = await db.execute('SELECT * FROM procurement_kpi_targets WHERE id = ?', [id])
    res.json(updated)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Цель на этот период уже существует' })
    }
    console.error('PUT /procurement-kpi/targets/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера при обновлении цели закупочного KPI' })
  }
})

router.delete('/targets/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор цели' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[target]] = await conn.execute('SELECT * FROM procurement_kpi_targets WHERE id = ? FOR UPDATE', [id])
    if (!target) {
      await conn.rollback()
      return res.status(404).json({ message: 'Цель не найдена' })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'procurement_kpi_targets',
      entityId: id,
      rootEntityType: 'procurement_kpi_targets',
      rootEntityId: id,
      deleteMode: 'trash',
      title: `KPI target #${id}`,
      subtitle: `${target.period_start} - ${target.period_end}`,
      snapshot: target,
    })

    await conn.execute('DELETE FROM procurement_kpi_targets WHERE id = ?', [id])
    await conn.commit()
    res.json({ ok: true, trash_entry_id: trashEntryId, message: 'Цель перемещена в корзину' })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /procurement-kpi/targets/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении цели закупочного KPI' })
  } finally {
    conn.release()
  }
})

module.exports = router
