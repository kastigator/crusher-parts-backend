const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const hasSignedContractForSelection = async (conn, selectionId) => {
  const [[row]] = await conn.execute(
    `SELECT COUNT(*) AS cnt
       FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
      WHERE sq.selection_id = ?
        AND cc.status = 'signed'`,
    [selectionId]
  )
  return Number(row?.cnt || 0) > 0
}

router.get('/', async (req, res) => {
  try {
    const selectionId = toId(req.query.selection_id)
    const rfqId = toId(req.query.rfq_id)
    const where = []
    const params = []

    if (selectionId) {
      where.push('po.selection_id = ?')
      params.push(selectionId)
    }
    if (rfqId) {
      where.push('s.rfq_id = ?')
      params.push(rfqId)
    }

    const [rows] = await db.execute(
      `SELECT po.*, ps.name AS supplier_name, ps.public_code AS supplier_public_code, s.rfq_id
         FROM supplier_purchase_orders po
         JOIN part_suppliers ps ON ps.id = po.supplier_id
         JOIN selections s ON s.id = po.selection_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY po.id DESC`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /purchase-orders error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/lines', async (req, res) => {
  try {
    const supplierPurchaseOrderId = toId(req.params.id)
    if (!supplierPurchaseOrderId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `SELECT pol.*,
              sl.rfq_item_id,
              sl.supplier_name_snapshot,
              sl.route_type,
              sl.origin_country,
              ri.line_number,
              cri.client_part_number,
              cri.client_description,
              cri.oem_part_id AS original_part_id,
              op.part_number AS original_cat_number
         FROM supplier_purchase_order_lines pol
         LEFT JOIN rfq_response_lines rl ON rl.id = pol.rfq_response_line_id
         LEFT JOIN selection_lines sl ON sl.rfq_response_line_id = rl.id
         LEFT JOIN rfq_items ri ON ri.id = sl.rfq_item_id
         LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
        WHERE pol.supplier_purchase_order_id = ?
        ORDER BY pol.id DESC`,
      [supplierPurchaseOrderId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /purchase-orders/:id/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const supplierId = toId(req.body.supplier_id)
    const selectionId = toId(req.body.selection_id)
    const autofill = req.body.autofill_from_selection !== false
    if (!supplierId || !selectionId) {
      return res.status(400).json({ message: 'Нужно выбрать поставщика и выбор' })
    }

    const signed = await hasSignedContractForSelection(conn, selectionId)
    if (!signed) {
      return res.status(400).json({ message: 'PO можно создавать только после контракта со статусом signed' })
    }

    await conn.beginTransaction()
    const [result] = await conn.execute(
      `INSERT INTO supplier_purchase_orders
        (supplier_id, selection_id, status, supplier_reference, currency, incoterms, incoterms_place)
       VALUES (?,?,?,?,?,?,?)`,
      [
        supplierId,
        selectionId,
        nz(req.body.status) || 'draft',
        nz(req.body.supplier_reference),
        nz(req.body.currency),
        nz(req.body.incoterms),
        nz(req.body.incoterms_place),
      ]
    )
    const poId = result.insertId

    if (autofill) {
      const [lines] = await conn.execute(
        `SELECT sl.*
           FROM selection_lines sl
          WHERE sl.selection_id = ?
            AND sl.supplier_id = ?
          ORDER BY sl.id ASC`,
        [selectionId, supplierId]
      )

      for (const line of lines) {
        const qty = numOrNull(line.qty) || 0
        const unitPrice =
          qty > 0 && numOrNull(line.goods_amount) !== null
            ? numOrNull(line.goods_amount) / qty
            : null
        await conn.execute(
          `INSERT INTO supplier_purchase_order_lines
            (supplier_purchase_order_id, rfq_response_line_id, qty, price, currency, lead_time_days, note)
           VALUES (?,?,?,?,?,?,?)`,
          [
            poId,
            toId(line.rfq_response_line_id),
            qty,
            unitPrice,
            nz(line.currency),
            null,
            nz(line.decision_note) || 'Автосоздание из selection',
          ]
        )
      }
    }

    await conn.commit()
    const [[created]] = await db.execute('SELECT * FROM supplier_purchase_orders WHERE id = ?', [poId])
    res.status(201).json(created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /purchase-orders error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.post('/:id/lines', async (req, res) => {
  try {
    const supplierPurchaseOrderId = toId(req.params.id)
    if (!supplierPurchaseOrderId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [result] = await db.execute(
      `INSERT INTO supplier_purchase_order_lines
        (supplier_purchase_order_id, rfq_response_line_id, qty, price, currency, lead_time_days, note)
       VALUES (?,?,?,?,?,?,?)`,
      [
        supplierPurchaseOrderId,
        toId(req.body.rfq_response_line_id),
        numOrNull(req.body.qty),
        numOrNull(req.body.price),
        nz(req.body.currency),
        toId(req.body.lead_time_days),
        nz(req.body.note),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM supplier_purchase_order_lines WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /purchase-orders/:id/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
