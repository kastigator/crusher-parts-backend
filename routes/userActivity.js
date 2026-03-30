const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { canonicalizeEntityType } = require('../utils/activityEntityTypes')
const {
  asDate,
  buildUserActivitySummary,
  normalizeEventType,
  normalizePath,
  normalizeSessionId,
  parseRange,
  recordUserActivityEvent,
  getClientIp,
  getUserAgent,
} = require('../utils/userActivity')

const MAX_TIMELINE_LIMIT = 500

const isAdmin = (user) =>
  user &&
  (user.role === 'admin' || user.role_id === 1 || user.is_admin)

function requireAdmin(req, res) {
  if (isAdmin(req.user)) return false
  res.status(403).json({ message: 'Нет доступа' })
  return true
}

const ENTITY_LABEL_RESOLVERS = {
  clients: { table: 'clients', labelExpr: 'company_name' },
  suppliers: { table: 'part_suppliers', labelExpr: 'name' },
  part_suppliers: { table: 'part_suppliers', labelExpr: 'name' },
  supplier_parts: {
    table: 'supplier_parts',
    labelExpr: `COALESCE(NULLIF(supplier_part_number, ''), NULLIF(canonical_part_number, ''), CONCAT('Деталь поставщика #', id))`,
  },
  oem_parts: { table: 'oem_parts', labelExpr: 'part_number' },
  original_parts: { table: 'oem_parts', labelExpr: 'part_number' },
  original_part_groups: { table: 'original_part_groups', labelExpr: `CONCAT('Группа OEM #', id)` },
  oem_part_model_bom: { table: 'oem_part_model_bom', labelExpr: `CONCAT('BOM #', id)` },
  original_part_bom: { table: 'oem_part_model_bom', labelExpr: `CONCAT('BOM #', id)` },
  original_part_alt_groups: { table: 'oem_part_alt_groups', labelExpr: `CONCAT('Группа аналогов #', id)` },
  original_part_alt_items: { table: 'oem_part_alt_items', labelExpr: `CONCAT('Аналог #', id)` },
  supplier_part_originals: { table: 'supplier_part_oem_parts', labelExpr: `CONCAT('Связь OEM #', id)` },
  standard_parts: { table: 'standard_parts', labelExpr: 'display_name' },
  tnved_codes: { table: 'tnved_codes', labelExpr: 'code' },
  materials: { table: 'materials', labelExpr: `COALESCE(NULLIF(code, ''), name)` },
  equipment_classifier_nodes: { table: 'equipment_classifier_nodes', labelExpr: 'name' },
  logistics_route_templates: { table: 'logistics_route_templates', labelExpr: 'name' },
  client_request: { table: 'client_requests', labelExpr: 'internal_number' },
  client_requests: { table: 'client_requests', labelExpr: 'internal_number' },
  client_orders: { table: 'client_requests', labelExpr: 'internal_number' },
  client_order_items: {
    table: 'client_request_revision_items',
    labelExpr:
      `CONCAT('Позиция #', line_number, COALESCE(CONCAT(' · ', NULLIF(client_part_number, '')), ''), COALESCE(CONCAT(' · ', NULLIF(client_description, '')), ''))`,
  },
  rfq: { table: 'rfqs', labelExpr: 'rfq_number' },
  rfqs: { table: 'rfqs', labelExpr: 'rfq_number' },
  sales_quote: { table: 'sales_quotes', labelExpr: `CONCAT('КП #', id)` },
  sales_quotes: { table: 'sales_quotes', labelExpr: `CONCAT('КП #', id)` },
  sales_quote_lines: {
    table: 'sales_quote_lines',
    labelExpr:
      `CONCAT('Строка КП #', id, COALESCE(CONCAT(' · ', NULLIF(client_display_part_number_snapshot, '')), ''), COALESCE(CONCAT(' · ', NULLIF(client_display_description_snapshot, '')), ''))`,
  },
  client_contract: { table: 'client_contracts', labelExpr: `COALESCE(contract_number, CONCAT('Контракт #', id))` },
  client_contracts: { table: 'client_contracts', labelExpr: `COALESCE(contract_number, CONCAT('Контракт #', id))` },
  client_order_contracts: { table: 'client_contracts', labelExpr: `COALESCE(contract_number, CONCAT('Контракт #', id))` },
  supplier_purchase_order: { table: 'supplier_purchase_orders', labelExpr: `COALESCE(NULLIF(supplier_reference, ''), CONCAT('PO #', id))` },
  supplier_purchase_orders: { table: 'supplier_purchase_orders', labelExpr: `COALESCE(NULLIF(supplier_reference, ''), CONCAT('PO #', id))` },
  supplier_purchase_order_lines: {
    table: 'supplier_purchase_order_lines',
    labelExpr:
      `CONCAT('Строка PO #', id, COALESCE(CONCAT(' · ', NULLIF(supplier_display_part_number_snapshot, '')), ''), COALESCE(CONCAT(' · ', NULLIF(supplier_display_description_snapshot, '')), ''))`,
  },
  client_billing_addresses: {
    table: 'client_billing_addresses',
    labelExpr: `COALESCE(NULLIF(label, ''), NULLIF(city, ''), CONCAT('Платежный адрес #', id))`,
  },
  client_shipping_addresses: {
    table: 'client_shipping_addresses',
    labelExpr: `COALESCE(NULLIF(city, ''), NULLIF(formatted_address, ''), CONCAT('Адрес доставки #', id))`,
  },
  client_bank_details: {
    table: 'client_bank_details',
    labelExpr: `CONCAT(bank_name, ' · ', account_number)`,
  },
  client_equipment_units: {
    table: 'client_equipment_units',
    labelExpr: `COALESCE(NULLIF(internal_name, ''), NULLIF(serial_number, ''), CONCAT('Единица оборудования #', id))`,
  },
  supplier_bundles: {
    table: 'supplier_bundles',
    labelExpr: `COALESCE(NULLIF(title, ''), NULLIF(name, ''), CONCAT('Комплект #', id))`,
  },
  supplier_bundle_items: {
    table: 'supplier_bundle_items',
    labelExpr: `CONCAT('Позиция комплекта #', id, COALESCE(CONCAT(' · ', NULLIF(role_label, '')), ''))`,
  },
  supplier_bundle_item_links: {
    table: 'supplier_bundle_item_links',
    labelExpr: `CONCAT('Связь комплекта #', id)`,
  },
  supplier_part_oem_parts: {
    table: 'supplier_part_oem_parts',
    labelExpr: `CONCAT('Связь OEM #', id)`,
  },
  supplier_part_standard_parts: {
    table: 'supplier_part_standard_parts',
    labelExpr: `CONCAT('Связь стандартной детали #', id)`,
  },
  equipment_models: { table: 'equipment_models', labelExpr: 'model_name' },
  equipment_manufacturers: { table: 'equipment_manufacturers', labelExpr: 'name' },
  standard_part_classes: { table: 'standard_part_classes', labelExpr: 'name' },
  users: { table: 'users', labelExpr: `COALESCE(NULLIF(full_name, ''), username)` },
}

async function enrichEventEntityLabels(rows) {
  const grouped = new Map()

  for (const row of rows || []) {
    const entityType = canonicalizeEntityType(row.entity_type)
    const entityId = Number(row.entity_id)
    if (!entityType || !Number.isFinite(entityId)) continue
    if (!ENTITY_LABEL_RESOLVERS[entityType]) continue

    const ids = grouped.get(entityType) || new Set()
    ids.add(entityId)
    grouped.set(entityType, ids)
  }

  const labelsByType = new Map()

  for (const [entityType, idSet] of grouped.entries()) {
    const resolver = ENTITY_LABEL_RESOLVERS[entityType]
    const ids = Array.from(idSet)
    if (!ids.length) continue

    const placeholders = ids.map(() => '?').join(', ')
    const [labelRows] = await db.execute(
      `
      SELECT id, ${resolver.labelExpr} AS entity_label
      FROM ${resolver.table}
      WHERE id IN (${placeholders})
      `,
      ids
    )

    const labels = new Map()
    for (const labelRow of labelRows || []) {
      labels.set(Number(labelRow.id), labelRow.entity_label || null)
    }
    labelsByType.set(entityType, labels)
  }

  return (rows || []).map((row) => {
    const entityType = canonicalizeEntityType(row.entity_type)
    const entityId = Number(row.entity_id)
    const labels = labelsByType.get(entityType)
    return {
      ...row,
      entity_label: labels && Number.isFinite(entityId) ? labels.get(entityId) || null : null,
    }
  })
}

router.post('/events', async (req, res) => {
  const sessionId = normalizeSessionId(req.body?.session_id)
  const userId = Number(req.user?.id)
  const eventType = normalizeEventType(req.body?.event_type)

  if (!sessionId || !userId || !eventType) {
    return res.status(400).json({ message: 'Нужно указать session_id и event_type' })
  }

  try {
    await recordUserActivityEvent({
      sessionId,
      userId,
      eventType,
      path: normalizePath(req.body?.path),
      entityType: canonicalizeEntityType(req.body?.entity_type),
      entityId: req.body?.entity_id,
      meta: req.body?.meta,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    })

    if (eventType !== 'logout') {
      await db.execute(
        `
        UPDATE user_sessions
        SET last_action_at = NOW(),
            last_path = COALESCE(?, last_path),
            is_visible = COALESCE(?, is_visible)
        WHERE session_id = ? AND user_id = ?
        `,
        [
          normalizePath(req.body?.path),
          req.body?.is_visible === undefined ? null : req.body?.is_visible ? 1 : 0,
          sessionId,
          userId,
        ]
      )
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('POST /user-activity/events error:', err)
    res.status(500).json({ message: 'Ошибка сервера при записи события активности' })
  }
})

router.get('/summary', async (req, res) => {
  if (requireAdmin(req, res)) return

  try {
    const summary = await buildUserActivitySummary({
      date: req.query.date,
      from: req.query.from,
      to: req.query.to,
    })
    res.json(summary)
  } catch (err) {
    console.error('GET /user-activity/summary error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке сводки активности' })
  }
})

router.get('/users/:userId/overview', async (req, res) => {
  if (requireAdmin(req, res)) return

  const userId = Number(req.params.userId)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: 'Некорректный userId' })
  }

  try {
    const summary = await buildUserActivitySummary({
      date: req.query.date,
      from: req.query.from,
      to: req.query.to,
      userId,
    })
    const user = summary.users[0]
    if (!user) return res.status(404).json({ message: 'Пользователь не найден' })
    res.json({ range: summary.range, user })
  } catch (err) {
    console.error('GET /user-activity/users/:userId/overview error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке данных пользователя' })
  }
})

router.get('/users/:userId/sessions', async (req, res) => {
  if (requireAdmin(req, res)) return

  const userId = Number(req.params.userId)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: 'Некорректный userId' })
  }

  try {
    const range = parseRange({ date: req.query.date, from: req.query.from, to: req.query.to })
    const [sessions] = await db.execute(
      `
      SELECT
        s.id,
        s.session_id,
        s.user_id,
        s.started_at,
        s.ended_at,
        s.last_seen_at,
        s.last_ping_at,
        s.last_action_at,
        s.last_path,
        s.status,
        s.closed_reason,
        s.ip,
        s.user_agent,
        s.is_visible
      FROM user_sessions s
      WHERE s.user_id = ?
        AND s.started_at < ?
        AND COALESCE(s.ended_at, s.last_seen_at, s.started_at) > ?
      ORDER BY s.started_at DESC
      `,
      [userId, range.to.toISOString().slice(0, 19).replace('T', ' '), range.from.toISOString().slice(0, 19).replace('T', ' ')]
    )

    const [events] = await db.execute(
      `
      SELECT
        session_id,
        event_type,
        event_time,
        path
      FROM user_activity_events
      WHERE user_id = ?
        AND event_time >= ?
        AND event_time < ?
      ORDER BY event_time ASC, id ASC
      `,
      [userId, range.from.toISOString().slice(0, 19).replace('T', ' '), range.to.toISOString().slice(0, 19).replace('T', ' ')]
    )

    const eventsBySession = new Map()
    for (const event of events || []) {
      const list = eventsBySession.get(event.session_id) || []
      list.push(event)
      eventsBySession.set(event.session_id, list)
    }

    const payload = (sessions || []).map((session) => {
      const startedAt = asDate(session.started_at)
      const endedAt = asDate(session.ended_at) || asDate(session.last_seen_at) || startedAt
      const durationSec =
        startedAt && endedAt && endedAt > startedAt
          ? Math.floor((endedAt - startedAt) / 1000)
          : 0
      const sessionEvents = eventsBySession.get(session.session_id) || []
      let engagedSec = 0
      let topPath = session.last_path || null
      for (let i = 0; i < sessionEvents.length - 1; i += 1) {
        const current = sessionEvents[i]
        const next = sessionEvents[i + 1]
        const currentTime = asDate(current.event_time)
        const nextTime = asDate(next.event_time)
        if (!currentTime || !nextTime || nextTime <= currentTime) continue
        if (current.path) topPath = current.path
        if (current.event_type === 'blur' || current.event_type === 'logout') continue
        engagedSec += Math.min(Math.floor((nextTime - currentTime) / 1000), 300)
      }

      return {
        ...session,
        duration_sec: durationSec,
        engaged_duration_sec: engagedSec,
        top_path: topPath,
      }
    })

    res.json({
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      sessions: payload,
    })
  } catch (err) {
    console.error('GET /user-activity/users/:userId/sessions error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке сессий пользователя' })
  }
})

router.get('/users/:userId/timeline', async (req, res) => {
  if (requireAdmin(req, res)) return

  const userId = Number(req.params.userId)
  const requestedLimit = Number(req.query.limit || 200)
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.trunc(requestedLimit), MAX_TIMELINE_LIMIT)
    : 200
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: 'Некорректный userId' })
  }

  try {
    const range = parseRange({ date: req.query.date, from: req.query.from, to: req.query.to })
    const [rows] = await db.execute(
      `
      SELECT
        e.id,
        e.session_id,
        e.user_id,
        e.event_type,
        e.event_time,
        e.path,
        e.entity_type,
        e.entity_id,
        e.meta_json,
        e.ip,
        e.user_agent
      FROM user_activity_events e
      WHERE e.user_id = ?
        AND e.event_time >= ?
        AND e.event_time < ?
      ORDER BY e.event_time DESC, e.id DESC
      LIMIT ${limit}
      `,
      [
        userId,
        range.from.toISOString().slice(0, 19).replace('T', ' '),
        range.to.toISOString().slice(0, 19).replace('T', ' '),
      ]
    )

    const enrichedRows = await enrichEventEntityLabels(rows || [])

    res.json({
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      events: enrichedRows.map((row) => ({
        ...row,
        entity_type: canonicalizeEntityType(row.entity_type),
      })),
    })
  } catch (err) {
    console.error('GET /user-activity/users/:userId/timeline error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке таймлайна пользователя' })
  }
})

module.exports = router
