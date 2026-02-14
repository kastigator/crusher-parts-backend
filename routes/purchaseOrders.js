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

router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT po.*, ps.name AS supplier_name
         FROM supplier_purchase_orders po
         JOIN part_suppliers ps ON ps.id = po.supplier_id
        ORDER BY po.id DESC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /purchase-orders error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/lines', async (req, res) => {
  try {
    const supplier_purchase_order_id = toId(req.params.id)
    if (!supplier_purchase_order_id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `SELECT * FROM supplier_purchase_order_lines WHERE supplier_purchase_order_id = ? ORDER BY id DESC`,
      [supplier_purchase_order_id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /purchase-orders/:id/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const supplier_id = toId(req.body.supplier_id)
    const selection_id = toId(req.body.selection_id)
    if (!supplier_id || !selection_id) {
      return res.status(400).json({ message: 'Нужно выбрать поставщика и выбор' })
    }

    const [result] = await db.execute(
      `INSERT INTO supplier_purchase_orders
        (supplier_id, selection_id, status, supplier_reference, currency, incoterms)
       VALUES (?,?,?,?,?,?)`,
      [
        supplier_id,
        selection_id,
        nz(req.body.status) || 'draft',
        nz(req.body.supplier_reference),
        nz(req.body.currency),
        nz(req.body.incoterms),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM supplier_purchase_orders WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /purchase-orders error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/lines', async (req, res) => {
  try {
    const supplier_purchase_order_id = toId(req.params.id)
    if (!supplier_purchase_order_id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [result] = await db.execute(
      `INSERT INTO supplier_purchase_order_lines
        (supplier_purchase_order_id, rfq_response_line_id, qty, price, currency, lead_time_days, note)
       VALUES (?,?,?,?,?,?,?)`,
      [
        supplier_purchase_order_id,
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
