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
      `SELECT s.*,
              c.company_name AS client_name
         FROM selections s
         JOIN rfqs r ON r.id = s.rfq_id
         JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
        ORDER BY s.id DESC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /selection error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const rfq_id = toId(req.body.rfq_id)
    if (!rfq_id) return res.status(400).json({ message: 'rfq_id обязателен' })

    const status = nz(req.body.status) || 'draft'
    const note = nz(req.body.note)
    const created_by_user_id = toId(req.user?.id)

    const [result] = await db.execute(
      `INSERT INTO selections (rfq_id, status, note, created_by_user_id)
       VALUES (?,?,?,?)`,
      [rfq_id, status, note, created_by_user_id]
    )

    const [[created]] = await db.execute('SELECT * FROM selections WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /selection error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/lines', async (req, res) => {
  try {
    const selection_id = toId(req.params.id)
    if (!selection_id) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      'SELECT * FROM selection_lines WHERE selection_id = ? ORDER BY id DESC',
      [selection_id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /selection/:id/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/lines', async (req, res) => {
  try {
    const selection_id = toId(req.params.id)
    if (!selection_id) return res.status(400).json({ message: 'Некорректный ID' })

    const rfq_item_id = toId(req.body.rfq_item_id)
    if (!rfq_item_id) return res.status(400).json({ message: 'rfq_item_id обязателен' })

    const rfq_response_line_id = toId(req.body.rfq_response_line_id)

    const [result] = await db.execute(
      `INSERT INTO selection_lines (selection_id, rfq_item_id, rfq_response_line_id, qty, decision_note)
       VALUES (?,?,?,?,?)`,
      [
        selection_id,
        rfq_item_id,
        rfq_response_line_id,
        numOrNull(req.body.qty),
        nz(req.body.decision_note),
      ]
    )

    if (rfq_response_line_id) {
      await db.execute(
        `UPDATE rfq_supplier_responses rsr
          JOIN rfq_response_revisions rr ON rr.rfq_supplier_response_id = rsr.id
          JOIN rfq_response_lines rl ON rl.rfq_response_revision_id = rr.id
           SET rsr.status = 'approved'
         WHERE rl.id = ?`,
        [rfq_response_line_id]
      )
    }

    const [[created]] = await db.execute('SELECT * FROM selection_lines WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /selection/:id/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
