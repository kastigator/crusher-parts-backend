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
      `SELECT sq.*,
              cr.rev_number,
              c.company_name AS client_name
         FROM sales_quotes sq
         JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
        ORDER BY sq.id DESC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /sales-quotes error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/revisions', async (req, res) => {
  try {
    const sales_quote_id = toId(req.params.id)
    if (!sales_quote_id) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT * FROM sales_quote_revisions WHERE sales_quote_id = ? ORDER BY rev_number DESC`,
      [sales_quote_id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /sales-quotes/:id/revisions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const client_request_revision_id = toId(req.body.client_request_revision_id)
    const selection_id = toId(req.body.selection_id)
    if (!client_request_revision_id || !selection_id) {
      return res.status(400).json({ message: 'client_request_revision_id и selection_id обязательны' })
    }

    const status = nz(req.body.status) || 'draft'
    const currency = nz(req.body.currency)
    const created_by_user_id = toId(req.user?.id)

    const [result] = await db.execute(
      `INSERT INTO sales_quotes (client_request_revision_id, selection_id, status, currency, created_by_user_id)
       VALUES (?,?,?,?,?)`,
      [client_request_revision_id, selection_id, status, currency, created_by_user_id]
    )

    const [[created]] = await db.execute('SELECT * FROM sales_quotes WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /sales-quotes error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/revisions', async (req, res) => {
  try {
    const sales_quote_id = toId(req.params.id)
    if (!sales_quote_id) return res.status(400).json({ message: 'Некорректный ID' })

    const created_by_user_id = toId(req.user?.id)
    const note = nz(req.body.note)

    const [[{ next_rev }]] = await db.execute(
      `SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev FROM sales_quote_revisions WHERE sales_quote_id = ?`,
      [sales_quote_id]
    )

    const [result] = await db.execute(
      `INSERT INTO sales_quote_revisions (sales_quote_id, rev_number, note, created_by_user_id)
       VALUES (?,?,?,?)`,
      [sales_quote_id, next_rev, note, created_by_user_id]
    )

    const [[created]] = await db.execute('SELECT * FROM sales_quote_revisions WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /sales-quotes/:id/revisions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/revisions/:revisionId/lines', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT * FROM sales_quote_lines WHERE sales_quote_revision_id = ? ORDER BY id DESC`,
      [revisionId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /sales-quotes/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/revisions/:revisionId/lines', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const client_request_revision_item_id = toId(req.body.client_request_revision_item_id)
    if (!client_request_revision_item_id) {
      return res.status(400).json({ message: 'client_request_revision_item_id обязателен' })
    }

    const [result] = await db.execute(
      `INSERT INTO sales_quote_lines
        (sales_quote_revision_id, client_request_revision_item_id, qty, cost, sell_price, margin_pct, currency, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        revisionId,
        client_request_revision_item_id,
        numOrNull(req.body.qty),
        numOrNull(req.body.cost),
        numOrNull(req.body.sell_price),
        numOrNull(req.body.margin_pct),
        nz(req.body.currency),
        nz(req.body.note),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM sales_quote_lines WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /sales-quotes/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
