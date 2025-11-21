// routes/clientOrders.js
const express = require('express')
const router = express.Router()

const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// ---------------- helpers ----------------

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return ''
  const s = String(v).trim()
  return s
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Простейший генератор номера заказа
const generateOrderNumber = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const datePart =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate())
  const timePart =
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  return `CO${datePart}-${timePart}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`
}

// -------------------------------------------------------------
// GET /client-orders — список заказов (с фильтрами и пагинацией)
// -------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1)
    const pageSize = Math.min(
      Math.max(Number(req.query.pageSize) || 20, 1),
      100
    )

    const clientId = toId(req.query.client_id)
    const status = nz(req.query.status)
    const search = nz(req.query.search)

    const where = []
    const params = []

    if (clientId) {
      where.push('co.client_id = ?')
      params.push(clientId)
    }

    if (status) {
      where.push('co.status = ?')
      params.push(status)
    }

    if (search) {
      where.push(
        '(co.order_number LIKE ? OR c.company_name LIKE ? OR co.external_comment LIKE ?)'
      )
      const like = `%${search}%`
      params.push(like, like, like)
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const offset = (page - 1) * pageSize

    const [rows] = await db.query(
      `
      SELECT
        co.*,
        c.company_name AS client_company_name
      FROM client_orders co
      JOIN clients c ON co.client_id = c.id
      ${whereSql}
      ORDER BY co.created_at DESC, co.id DESC
      LIMIT ? OFFSET ?
    `,
      [...params, pageSize, offset]
    )

    const [[{ total }]] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM client_orders co
      JOIN clients c ON co.client_id = c.id
      ${whereSql}
    `,
      params
    )

    res.json({
      data: rows,
      pagination: {
        page,
        pageSize,
        total,
      },
    })
  } catch (e) {
    console.error('GET /client-orders error:', e)
    res.status(500).json({ message: 'Ошибка загрузки заказов' })
  }
})

// -------------------------------------------------------------
// GET /client-orders/:id — один заказ + позиции
// -------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) {
      return res.status(400).json({ message: 'Некорректный id заказа' })
    }

    const [[order]] = await db.query(
      `
      SELECT
        co.*,
        c.company_name AS client_company_name
      FROM client_orders co
      JOIN clients c ON co.client_id = c.id
      WHERE co.id = ?
    `,
      [id]
    )

    if (!order) {
      return res.status(404).json({ message: 'Заказ не найден' })
    }

    const [items] = await db.query(
      `
      SELECT
        i.*,
        op.cat_number,
        op.description_en,
        op.description_ru,
        em.model_name
      FROM client_order_items i
      LEFT JOIN original_parts op ON i.original_part_id = op.id
      LEFT JOIN equipment_models em ON i.equipment_model_id = em.id
      WHERE i.order_id = ?
      ORDER BY i.line_no ASC, i.id ASC
    `,
      [id]
    )

    res.json({ order, items })
  } catch (e) {
    console.error('GET /client-orders/:id error:', e)
    res.status(500).json({ message: 'Ошибка загрузки заказа' })
  }
})

// -------------------------------------------------------------
// POST /client-orders — создание заказа с позициями
// -------------------------------------------------------------
router.post('/', async (req, res) => {
  let conn
  try {
    const {
      client_id,
      source,
      client_contact_name,
      client_contact_phone,
      client_contact_email,
      billing_address_id,
      shipping_address_id,
      external_comment,
      internal_comment,
      requested_delivery_date,
      items = [],
    } = req.body || {}

    const clientId = toId(client_id)
    if (!clientId) {
      return res.status(400).json({ message: 'client_id обязателен' })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ message: 'Нужно добавить хотя бы одну позицию' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const orderNumber = generateOrderNumber()

    const [orderResult] = await conn.execute(
      `
      INSERT INTO client_orders (
        order_number,
        client_id,
        status,
        source,
        client_contact_name,
        client_contact_phone,
        client_contact_email,
        billing_address_id,
        shipping_address_id,
        external_comment,
        internal_comment,
        requested_delivery_date
      ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        orderNumber,
        clientId,
        nz(source || 'manual'),
        nz(client_contact_name),
        nz(client_contact_phone),
        nz(client_contact_email),
        toId(billing_address_id),
        toId(shipping_address_id),
        nz(external_comment),
        nz(internal_comment),
        requested_delivery_date || null,
      ]
    )

    const orderId = orderResult.insertId

    // Позиции
    let lineNo = 1
    for (const item of items) {
      const originalPartId = toId(item.original_part_id)
      const equipmentModelId = toId(item.equipment_model_id)
      const qty = numOrNull(item.qty_requested) || 0
      const unit = nz(item.qty_unit || 'pcs')

      if (!originalPartId || qty <= 0) {
        throw new Error(
          `Некорректная позиция заказа (original_part_id / qty): ${JSON.stringify(
            item
          )}`
        )
      }

      await conn.execute(
        `
        INSERT INTO client_order_items (
          order_id,
          line_no,
          original_part_id,
          equipment_model_id,
          qty_requested,
          qty_unit,
          comment_client,
          comment_internal,
          status,
          requested_delivery_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `,
        [
          orderId,
          lineNo++,
          originalPartId,
          equipmentModelId,
          qty,
          unit,
          nz(item.comment_client),
          nz(item.comment_internal),
          item.requested_delivery_date || null,
        ]
      )
    }

    await logActivity(conn, {
      entity_type: 'client_orders',
      entity_id: orderId,
      action: 'create',
      user_id: req.user?.id,
      client_id: clientId,
      payload: {
        order_number: orderNumber,
        client_id: clientId,
        items_count: items.length,
      },
      comment: `Создан заказ ${orderNumber} (черновик)`,
    })

    await conn.commit()
    conn.release()

    // Возвращаем созданный заказ
    const [[createdOrder]] = await db.query(
      `
      SELECT
        co.*,
        c.company_name AS client_company_name
      FROM client_orders co
      JOIN clients c ON co.client_id = c.id
      WHERE co.id = ?
    `,
      [orderId]
    )

    const [createdItems] = await db.query(
      `
      SELECT
        i.*,
        op.cat_number,
        op.description_en,
        op.description_ru,
        em.model_name
      FROM client_order_items i
      LEFT JOIN original_parts op ON i.original_part_id = op.id
      LEFT JOIN equipment_models em ON i.equipment_model_id = em.id
      WHERE i.order_id = ?
      ORDER BY i.line_no ASC, i.id ASC
    `,
      [orderId]
    )

    res.status(201).json({ order: createdOrder, items: createdItems })
  } catch (e) {
    console.error('POST /client-orders error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка создания заказа' })
  }
})

// -------------------------------------------------------------
// PUT /client-orders/:id — обновление шапки заказа
// -------------------------------------------------------------
router.put('/:id', async (req, res) => {
  let conn
  try {
    const id = toId(req.params.id)
    if (!id) {
      return res.status(400).json({ message: 'Некорректный id заказа' })
    }

    const {
      status,
      client_contact_name,
      client_contact_phone,
      client_contact_email,
      billing_address_id,
      shipping_address_id,
      external_comment,
      internal_comment,
      requested_delivery_date,
    } = req.body || {}

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      'SELECT * FROM client_orders WHERE id = ?',
      [id]
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Заказ не найден' })
    }

    const clientId = before.client_id

    await conn.execute(
      `
      UPDATE client_orders
      SET
        status = COALESCE(?, status),
        client_contact_name = ?,
        client_contact_phone = ?,
        client_contact_email = ?,
        billing_address_id = ?,
        shipping_address_id = ?,
        external_comment = ?,
        internal_comment = ?,
        requested_delivery_date = ?
      WHERE id = ?
    `,
      [
        status || before.status,
        nz(client_contact_name ?? before.client_contact_name),
        nz(client_contact_phone ?? before.client_contact_phone),
        nz(client_contact_email ?? before.client_contact_email),
        toId(billing_address_id ?? before.billing_address_id),
        toId(shipping_address_id ?? before.shipping_address_id),
        nz(external_comment ?? before.external_comment),
        nz(internal_comment ?? before.internal_comment),
        requested_delivery_date ?? before.requested_delivery_date,
        id,
      ]
    )

    const [afterRows] = await conn.execute(
      'SELECT * FROM client_orders WHERE id = ?',
      [id]
    )
    const after = afterRows[0]

    await logFieldDiffs(conn, {
      entity_type: 'client_orders',
      entity_id: id,
      user_id: req.user?.id,
      client_id: clientId,
      before,
      after,
      fields: [
        'status',
        'client_contact_name',
        'client_contact_phone',
        'client_contact_email',
        'billing_address_id',
        'shipping_address_id',
        'external_comment',
        'internal_comment',
        'requested_delivery_date',
      ],
    })

    await conn.commit()
    conn.release()

    res.json(after)
  } catch (e) {
    console.error('PUT /client-orders/:id error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка обновления заказа' })
  }
})

// -------------------------------------------------------------
// POST /client-orders/:id/items — добавить позицию
// -------------------------------------------------------------
router.post('/:id/items', async (req, res) => {
  let conn
  try {
    const orderId = toId(req.params.id)
    if (!orderId) {
      return res.status(400).json({ message: 'Некорректный id заказа' })
    }

    const {
      original_part_id,
      equipment_model_id,
      qty_requested,
      qty_unit,
      comment_client,
      comment_internal,
      requested_delivery_date,
    } = req.body || {}

    const originalPartId = toId(original_part_id)
    const qty = numOrNull(qty_requested) || 0
    if (!originalPartId || qty <= 0) {
      return res
        .status(400)
        .json({ message: 'Нужно указать original_part_id и qty_requested > 0' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[order]] = await conn.execute(
      'SELECT * FROM client_orders WHERE id = ?',
      [orderId]
    )
    if (!order) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Заказ не найден' })
    }

    const [[{ maxLine }]] = await conn.execute(
      'SELECT COALESCE(MAX(line_no), 0) AS maxLine FROM client_order_items WHERE order_id = ?',
      [orderId]
    )
    const nextLine = (maxLine || 0) + 1

    const [ins] = await conn.execute(
      `
      INSERT INTO client_order_items (
        order_id,
        line_no,
        original_part_id,
        equipment_model_id,
        qty_requested,
        qty_unit,
        comment_client,
        comment_internal,
        status,
        requested_delivery_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `,
      [
        orderId,
        nextLine,
        originalPartId,
        toId(equipment_model_id),
        qty,
        nz(qty_unit || 'pcs'),
        nz(comment_client),
        nz(comment_internal),
        requested_delivery_date || null,
      ]
    )

    const itemId = ins.insertId

    await logActivity(conn, {
      entity_type: 'client_order_items',
      entity_id: itemId,
      action: 'create',
      user_id: req.user?.id,
      client_id: order.client_id,
      payload: {
        order_id: orderId,
        line_no: nextLine,
        original_part_id: originalPartId,
        qty_requested: qty,
      },
    })

    await conn.commit()
    conn.release()

    const [[created]] = await db.query(
      `
      SELECT
        i.*,
        op.cat_number,
        op.description_en,
        op.description_ru,
        em.model_name
      FROM client_order_items i
      LEFT JOIN original_parts op ON i.original_part_id = op.id
      LEFT JOIN equipment_models em ON i.equipment_model_id = em.id
      WHERE i.id = ?
    `,
      [itemId]
    )

    res.status(201).json(created)
  } catch (e) {
    console.error('POST /client-orders/:id/items error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка добавления позиции' })
  }
})

// -------------------------------------------------------------
// PUT /client-orders/items/:itemId — обновление позиции
// -------------------------------------------------------------
router.put('/items/:itemId', async (req, res) => {
  let conn
  try {
    const itemId = toId(req.params.itemId)
    if (!itemId) {
      return res.status(400).json({ message: 'Некорректный id позиции' })
    }

    const {
      original_part_id,
      equipment_model_id,
      qty_requested,
      qty_unit,
      comment_client,
      comment_internal,
      status,
      requested_delivery_date,
    } = req.body || {}

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      'SELECT * FROM client_order_items WHERE id = ?',
      [itemId]
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [[order]] = await conn.execute(
      'SELECT client_id FROM client_orders WHERE id = ?',
      [before.order_id]
    )

    const newQty = qty_requested !== undefined ? numOrNull(qty_requested) : before.qty_requested
    if (newQty !== null && newQty <= 0) {
      return res.status(400).json({ message: 'qty_requested должен быть > 0' })
    }

    await conn.execute(
      `
      UPDATE client_order_items
      SET
        original_part_id = ?,
        equipment_model_id = ?,
        qty_requested = ?,
        qty_unit = ?,
        comment_client = ?,
        comment_internal = ?,
        status = ?,
        requested_delivery_date = ?
      WHERE id = ?
    `,
      [
        toId(original_part_id ?? before.original_part_id),
        toId(equipment_model_id ?? before.equipment_model_id),
        newQty ?? before.qty_requested,
        nz(qty_unit ?? before.qty_unit),
        nz(comment_client ?? before.comment_client),
        nz(comment_internal ?? before.comment_internal),
        nz(status ?? before.status),
        requested_delivery_date ?? before.requested_delivery_date,
        itemId,
      ]
    )

    const [afterRows] = await conn.execute(
      'SELECT * FROM client_order_items WHERE id = ?',
      [itemId]
    )
    const after = afterRows[0]

    await logFieldDiffs(conn, {
      entity_type: 'client_order_items',
      entity_id: itemId,
      user_id: req.user?.id,
      client_id: order?.client_id,
      before,
      after,
      fields: [
        'original_part_id',
        'equipment_model_id',
        'qty_requested',
        'qty_unit',
        'comment_client',
        'comment_internal',
        'status',
        'requested_delivery_date',
      ],
    })

    await conn.commit()
    conn.release()

    res.json(after)
  } catch (e) {
    console.error('PUT /client-orders/items/:itemId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка обновления позиции' })
  }
})

// -------------------------------------------------------------
// DELETE /client-orders/items/:itemId — удаление позиции
// -------------------------------------------------------------
router.delete('/items/:itemId', async (req, res) => {
  let conn
  try {
    const itemId = toId(req.params.itemId)
    if (!itemId) {
      return res.status(400).json({ message: 'Некорректный id позиции' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      'SELECT * FROM client_order_items WHERE id = ?',
      [itemId]
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [[order]] = await conn.execute(
      'SELECT client_id FROM client_orders WHERE id = ?',
      [before.order_id]
    )

    await conn.execute('DELETE FROM client_order_items WHERE id = ?', [
      itemId,
    ])

    await logActivity(conn, {
      entity_type: 'client_order_items',
      entity_id: itemId,
      action: 'delete',
      user_id: req.user?.id,
      client_id: order?.client_id,
      payload: before,
      comment: 'Удалено пользователем',
    })

    await conn.commit()
    conn.release()

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /client-orders/items/:itemId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка удаления позиции' })
  }
})

module.exports = router
