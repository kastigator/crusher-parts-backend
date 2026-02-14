const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  updateRequestStatus,
  fetchRequestIdBySalesQuoteId,
} = require('../utils/clientRequestStatus')

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

router.get('/', async (req, res) => {
  try {
    const clientId = Number(req.query.client_id)
    const params = []
    const where = []
    if (Number.isInteger(clientId) && clientId > 0) {
      where.push('c.id = ?')
      params.push(clientId)
    }

    const [rows] = await db.execute(
      `SELECT cc.*,
              c.company_name AS client_name
         FROM client_contracts cc
         JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
         JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY cc.id DESC`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /contracts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const sales_quote_id = toId(req.body.sales_quote_id)
    const contract_number = nz(req.body.contract_number)
    const contract_date = nz(req.body.contract_date)
    if (!sales_quote_id || !contract_number || !contract_date) {
      return res.status(400).json({ message: 'Нужно указать КП, номер контракта и дату' })
    }

    const [result] = await db.execute(
      `INSERT INTO client_contracts
        (sales_quote_id, contract_number, contract_date, amount, currency, status, file_url, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        sales_quote_id,
        contract_number,
        contract_date,
        numOrNull(req.body.amount),
        nz(req.body.currency),
        nz(req.body.status) || 'draft',
        nz(req.body.file_url),
        nz(req.body.note),
      ]
    )

    const requestId = await fetchRequestIdBySalesQuoteId(db, sales_quote_id)
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    const [[created]] = await db.execute('SELECT * FROM client_contracts WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /contracts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
