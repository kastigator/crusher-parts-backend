const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  updateRequestStatus,
  fetchRequestIdBySalesQuoteId,
} = require('../utils/clientRequestStatus')
const {
  fetchCurrentCompanyLegalProfile,
  hasTableColumn,
} = require('../utils/companyLegalProfiles')

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

const contractsSupportLegalSnapshot = async (conn) =>
  (await hasTableColumn(conn, 'client_contracts', 'company_legal_profile_id')) &&
  (await hasTableColumn(conn, 'client_contracts', 'company_legal_snapshot_json'))

const salesQuotesSupportLegalSnapshot = async (conn) =>
  (await hasTableColumn(conn, 'sales_quotes', 'company_legal_profile_id')) &&
  (await hasTableColumn(conn, 'sales_quotes', 'company_legal_snapshot_json'))

const buildContractSelectExtras = async (conn, alias = 'cc') => {
  const canPersist = await contractsSupportLegalSnapshot(conn)
  if (!canPersist) {
    return `NULL AS company_legal_profile_id,
            NULL AS company_legal_snapshot_json`
  }
  return `${alias}.company_legal_profile_id,
          ${alias}.company_legal_snapshot_json`
}

router.get('/', async (req, res) => {
  try {
    const clientId = toId(req.query.client_id)
    const requestId = toId(req.query.request_id)
    const salesQuoteId = toId(req.query.sales_quote_id)
    const where = []
    const params = []

    if (clientId) {
      where.push('c.id = ?')
      params.push(clientId)
    }
    if (requestId) {
      where.push('cr.client_request_id = ?')
      params.push(requestId)
    }
    if (salesQuoteId) {
      where.push('cc.sales_quote_id = ?')
      params.push(salesQuoteId)
    }

    const selectExtras = await buildContractSelectExtras(db, 'cc')
    const [rows] = await db.execute(
      `SELECT cc.*,
              c.company_name AS client_name,
              sq.selection_id,
              cr.client_request_id,
              cr.rev_number,
              ${selectExtras}
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
    const salesQuoteId = toId(req.body.sales_quote_id)
    const contractNumber = nz(req.body.contract_number)
    const contractDate = nz(req.body.contract_date)
    if (!salesQuoteId || !contractNumber || !contractDate) {
      return res.status(400).json({ message: 'Нужно указать КП, номер контракта и дату' })
    }

    const [[quote]] = await db.execute(`SELECT * FROM sales_quotes WHERE id = ?`, [salesQuoteId])
    if (!quote) {
      return res.status(404).json({ message: 'КП не найдено' })
    }

    let legalProfile = null
    if (await salesQuotesSupportLegalSnapshot(db) && quote.company_legal_snapshot_json) {
      legalProfile = {
        id: quote.company_legal_profile_id || null,
        snapshot_json: quote.company_legal_snapshot_json,
      }
    } else {
      const profile = await fetchCurrentCompanyLegalProfile(db, contractDate)
      legalProfile = profile ? { id: profile.id, snapshot_json: JSON.stringify(profile) } : null
    }

    const canPersistLegalSnapshot = await contractsSupportLegalSnapshot(db)
    const insertSql = canPersistLegalSnapshot
      ? `INSERT INTO client_contracts
          (
            sales_quote_id,
            contract_number,
            contract_date,
            amount,
            currency,
            status,
            file_url,
            note,
            company_legal_profile_id,
            company_legal_snapshot_json
          )
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      : `INSERT INTO client_contracts
          (sales_quote_id, contract_number, contract_date, amount, currency, status, file_url, note)
         VALUES (?,?,?,?,?,?,?,?)`
    const insertParams = canPersistLegalSnapshot
      ? [
          salesQuoteId,
          contractNumber,
          contractDate,
          numOrNull(req.body.amount),
          nz(req.body.currency),
          nz(req.body.status) || 'draft',
          nz(req.body.file_url),
          nz(req.body.note),
          legalProfile?.id || null,
          legalProfile?.snapshot_json || null,
        ]
      : [
          salesQuoteId,
          contractNumber,
          contractDate,
          numOrNull(req.body.amount),
          nz(req.body.currency),
          nz(req.body.status) || 'draft',
          nz(req.body.file_url),
          nz(req.body.note),
        ]

    const [result] = await db.execute(
      insertSql,
      insertParams
    )

    const requestId = await fetchRequestIdBySalesQuoteId(db, salesQuoteId)
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

router.patch('/:id', async (req, res) => {
  try {
    const contractId = toId(req.params.id)
    if (!contractId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[existing]] = await db.execute('SELECT * FROM client_contracts WHERE id = ?', [contractId])
    if (!existing) return res.status(404).json({ message: 'Контракт не найден' })

    await db.execute(
      `UPDATE client_contracts
          SET contract_number = COALESCE(?, contract_number),
              contract_date = COALESCE(?, contract_date),
              amount = ?,
              currency = COALESCE(?, currency),
              status = COALESCE(?, status),
              file_url = ?,
              note = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [
        nz(req.body.contract_number),
        nz(req.body.contract_date),
        numOrNull(req.body.amount),
        nz(req.body.currency),
        nz(req.body.status),
        nz(req.body.file_url),
        nz(req.body.note),
        contractId,
      ]
    )

    const requestId = await fetchRequestIdBySalesQuoteId(db, existing.sales_quote_id)
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    const [[updated]] = await db.execute('SELECT * FROM client_contracts WHERE id = ?', [contractId])
    res.json(updated)
  } catch (e) {
    console.error('PATCH /contracts/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
