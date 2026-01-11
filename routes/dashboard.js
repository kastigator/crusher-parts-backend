const express = require('express')
const router = express.Router()

const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return ''
  return String(v).trim()
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

router.get('/summary', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    if (!userId) return res.status(401).json({ message: 'Нет пользователя в токене' })

    const admin = isAdmin(req.user)
    const scopeWhere = admin ? '1=1' : 'co.responsible_user_id = ?'
    const scopeParams = admin ? [] : [userId]

    const [[ordersTotalRow]] = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM client_orders co
        WHERE ${scopeWhere} AND co.status <> 'cancelled'
      `,
      scopeParams,
    )

    const [[ordersActiveRow]] = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM client_orders co
        WHERE ${scopeWhere} AND co.status IN ('new', 'submitted', 'confirmed', 'rework')
      `,
      scopeParams,
    )

    const [[ordersNewRow]] = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM client_orders co
        WHERE ${scopeWhere} AND co.status = 'new'
      `,
      scopeParams,
    )

    const [[ordersDraftRow]] = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM client_orders co
        WHERE ${scopeWhere} AND co.status = 'draft'
      `,
      scopeParams,
    )

    const [[unassignedRow]] = admin
      ? await db.query(
          `
          SELECT COUNT(*) AS total
          FROM client_orders co
          WHERE co.responsible_user_id IS NULL AND co.status <> 'cancelled'
        `,
        )
      : [[{ total: 0 }]]

    const [[itemsNoOffersRow]] = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM (
          SELECT i.id
          FROM client_order_items i
          JOIN client_orders co ON co.id = i.order_id
          LEFT JOIN client_order_line_offers o ON o.order_item_id = i.id
          WHERE ${scopeWhere} AND co.status <> 'cancelled'
          GROUP BY i.id
          HAVING COUNT(o.id) = 0
        ) t
      `,
      scopeParams,
    )

    const [[itemsAwaitDecisionRow]] = await db.query(
      `
        SELECT COUNT(DISTINCT i.id) AS total
        FROM client_order_items i
        JOIN client_orders co ON co.id = i.order_id
        JOIN client_order_line_offers o ON o.order_item_id = i.id
        WHERE ${scopeWhere}
          AND co.status <> 'cancelled'
          AND i.decision_offer_id IS NULL
          AND (o.status = 'proposed' OR o.client_visible = 1)
      `,
      scopeParams,
    )

    const [[contractsInWorkRow]] = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM client_order_contracts cc
        JOIN client_orders co ON co.id = cc.order_id
        WHERE ${scopeWhere} AND cc.status IN ('draft', 'sent')
      `,
      scopeParams,
    )

    const [[contractsNoFileRow]] = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM client_order_contracts cc
        JOIN client_orders co ON co.id = cc.order_id
        WHERE ${scopeWhere} AND cc.file_url IS NULL
      `,
      scopeParams,
    )

    const [recentOrders] = await db.query(
      `
        SELECT
          co.id,
          co.order_number,
          co.status,
          co.created_at,
          c.company_name AS client_company_name,
          COALESCE(u.full_name, u.username) AS responsible_name
        FROM client_orders co
        JOIN clients c ON c.id = co.client_id
        LEFT JOIN users u ON u.id = co.responsible_user_id
        WHERE ${scopeWhere}
        ORDER BY co.created_at DESC, co.id DESC
        LIMIT 10
      `,
      scopeParams,
    )

    const [recentContracts] = await db.query(
      `
        SELECT
          cc.id,
          cc.order_id,
          cc.contract_number,
          cc.contract_date,
          cc.status,
          cc.file_url,
          co.order_number,
          c.company_name AS client_company_name
        FROM client_order_contracts cc
        JOIN client_orders co ON co.id = cc.order_id
        JOIN clients c ON c.id = co.client_id
        WHERE ${scopeWhere}
        ORDER BY cc.updated_at DESC, cc.id DESC
        LIMIT 10
      `,
      scopeParams,
    )

    const [ordersWithoutOffers] = await db.query(
      `
        SELECT
          co.id,
          co.order_number,
          c.company_name AS client_company_name,
          COUNT(*) AS items_count
        FROM (
          SELECT i.id, i.order_id
          FROM client_order_items i
          LEFT JOIN client_order_line_offers o ON o.order_item_id = i.id
          GROUP BY i.id, i.order_id
          HAVING COUNT(o.id) = 0
        ) missing
        JOIN client_orders co ON co.id = missing.order_id
        JOIN clients c ON c.id = co.client_id
        WHERE ${scopeWhere} AND co.status <> 'cancelled'
        GROUP BY co.id, co.order_number, c.company_name
        ORDER BY items_count DESC, co.created_at DESC
        LIMIT 10
      `,
      scopeParams,
    )

    const [ordersAwaitingDecision] = await db.query(
      `
        SELECT
          co.id,
          co.order_number,
          c.company_name AS client_company_name,
          COUNT(DISTINCT i.id) AS items_count
        FROM client_order_items i
        JOIN client_orders co ON co.id = i.order_id
        JOIN clients c ON c.id = co.client_id
        JOIN client_order_line_offers o ON o.order_item_id = i.id
        WHERE ${scopeWhere}
          AND co.status <> 'cancelled'
          AND i.decision_offer_id IS NULL
          AND (o.status = 'proposed' OR o.client_visible = 1)
        GROUP BY co.id, co.order_number, c.company_name
        ORDER BY items_count DESC, co.created_at DESC
        LIMIT 10
      `,
      scopeParams,
    )

    const attention = [
      ...ordersWithoutOffers.map((row) => ({
        type: 'no_offers',
        order_id: row.id,
        order_number: row.order_number,
        client_company_name: row.client_company_name,
        items_count: Number(row.items_count || 0),
      })),
      ...ordersAwaitingDecision.map((row) => ({
        type: 'awaiting_decision',
        order_id: row.id,
        order_number: row.order_number,
        client_company_name: row.client_company_name,
        items_count: Number(row.items_count || 0),
      })),
    ]

    res.json({
      scope: admin ? 'all' : 'my',
      is_admin: admin,
      stats: {
        orders_total: Number(ordersTotalRow?.total || 0),
        orders_active: Number(ordersActiveRow?.total || 0),
        orders_new: Number(ordersNewRow?.total || 0),
        orders_draft: Number(ordersDraftRow?.total || 0),
        orders_unassigned: Number(unassignedRow?.total || 0),
        items_without_offers: Number(itemsNoOffersRow?.total || 0),
        items_awaiting_decision: Number(itemsAwaitDecisionRow?.total || 0),
        contracts_in_work: Number(contractsInWorkRow?.total || 0),
        contracts_no_file: Number(contractsNoFileRow?.total || 0),
      },
      attention,
      recent_orders: recentOrders,
      recent_contracts: recentContracts,
    })
  } catch (e) {
    console.error('GET /dashboard/summary error:', e)
    res.status(500).json({ message: 'Ошибка загрузки дашборда' })
  }
})

router.get('/events', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    if (!userId) return res.status(401).json({ message: 'Нет пользователя в токене' })

    const admin = isAdmin(req.user)
    const scopeWhere = admin ? '1=1' : 'co.responsible_user_id = ?'
    const scopeParams = admin ? [] : [userId]

    const afterParam = nz(req.query.after)
    const afterDate = afterParam ? new Date(afterParam) : null
    const afterId = Math.max(Number(req.query.after_id) || 0, 0)
    if (!afterDate || Number.isNaN(afterDate.getTime())) {
      return res.json({ events: [] })
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200)

    const [events] = await db.query(
      `
        SELECT
          e.*,
          co.order_number,
          c.company_name AS client_company_name,
          COALESCE(u.full_name, u.username) AS user_name
        FROM client_order_events e
        JOIN client_orders co ON co.id = e.order_id
        JOIN clients c ON c.id = co.client_id
        LEFT JOIN users u ON u.id = e.created_by
        WHERE ${scopeWhere}
          AND (e.created_at > ? OR (e.created_at = ? AND e.id > ?))
          AND (
            e.type = 'order_created'
            OR e.type = 'offer_selected'
            OR (e.type = 'offer_status_change' AND e.to_status = 'approved')
          )
        ORDER BY e.created_at ASC, e.id ASC
        LIMIT ?
      `,
      [...scopeParams, afterDate, afterDate, afterId, limit],
    )

    res.json({ events })
  } catch (e) {
    console.error('GET /dashboard/events error:', e)
    res.status(500).json({ message: 'Ошибка загрузки событий' })
  }
})

module.exports = router
