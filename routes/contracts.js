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

const CONTRACT_STATUSES = new Set([
  'draft',
  'sent_to_client',
  'signed',
  'in_execution',
  'completed',
  'closed_with_issues',
])

const CONTRACT_CREATE_STATUSES = new Set(['draft', 'sent_to_client', 'signed'])

const CONTRACT_STATUS_TRANSITIONS = {
  draft: new Set(['sent_to_client', 'signed']),
  sent_to_client: new Set(['draft', 'signed']),
  signed: new Set(['in_execution', 'completed', 'closed_with_issues']),
  in_execution: new Set(['completed', 'closed_with_issues']),
  completed: new Set(),
  closed_with_issues: new Set(),
}

const normalizeContractStatus = (value, fallback = null) => {
  const normalized = nz(value)?.toLowerCase() || fallback
  return normalized && CONTRACT_STATUSES.has(normalized) ? normalized : null
}

const contractsSupportLegalSnapshot = async (conn) =>
  (await hasTableColumn(conn, 'client_contracts', 'company_legal_profile_id')) &&
  (await hasTableColumn(conn, 'client_contracts', 'company_legal_snapshot_json'))

const salesQuotesSupportLegalSnapshot = async (conn) =>
  (await hasTableColumn(conn, 'sales_quotes', 'company_legal_profile_id')) &&
  (await hasTableColumn(conn, 'sales_quotes', 'company_legal_snapshot_json'))

const contractsSupportQuoteRevision = async (conn) =>
  hasTableColumn(conn, 'client_contracts', 'sales_quote_revision_id')

const buildContractSelectExtras = async (conn, alias = 'cc') => {
  const canPersist = await contractsSupportLegalSnapshot(conn)
  if (!canPersist) {
    return `NULL AS company_legal_profile_id,
            NULL AS company_legal_snapshot_json`
  }
  return `${alias}.company_legal_profile_id,
          ${alias}.company_legal_snapshot_json`
}

const fetchRequestIdBySalesQuoteIdStrict = async (conn, salesQuoteId) => {
  const [[row]] = await conn.execute(
    `SELECT cr.client_request_id
       FROM sales_quotes sq
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
      WHERE sq.id = ?`,
    [salesQuoteId]
  )
  return row?.client_request_id || null
}

const ensureSingleSignedContractPerRequest = async (conn, salesQuoteId, excludeContractId = null) => {
  const requestId = await fetchRequestIdBySalesQuoteIdStrict(conn, salesQuoteId)
  if (!requestId) {
    throw Object.assign(new Error('Не удалось определить заявку клиента для контракта'), { statusCode: 400 })
  }

  const params = [requestId]
  const exclusionSql = excludeContractId ? 'AND cc.id <> ?' : ''
  if (excludeContractId) params.push(excludeContractId)

  const [[row]] = await conn.execute(
    `SELECT cc.id,
            cc.contract_number
       FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
      WHERE cr.client_request_id = ?
        AND cc.status = 'signed'
        ${exclusionSql}
      ORDER BY cc.contract_date DESC, cc.id DESC
      LIMIT 1`,
    params
  )

  if (row) {
    throw Object.assign(
      new Error(
        `Для этой заявки уже есть подписанный контракт ${row.contract_number || `#${row.id}`}. Допускается только один финальный signed-контракт.`
      ),
      { statusCode: 409 }
    )
  }

  return requestId
}

const ensureContractStatusTransition = (currentStatus, nextStatus, { isCreate = false } = {}) => {
  const current = normalizeContractStatus(currentStatus, 'draft')
  const next = normalizeContractStatus(nextStatus)
  if (!next) {
    throw Object.assign(new Error('Некорректный статус контракта'), { statusCode: 400 })
  }

  if (isCreate) {
    if (!CONTRACT_CREATE_STATUSES.has(next)) {
      throw Object.assign(
        new Error('При создании контракта допускаются только статусы draft, sent_to_client или signed'),
        { statusCode: 400 }
      )
    }
    return next
  }

  if (!current || current === next) return next
  const allowedTargets = CONTRACT_STATUS_TRANSITIONS[current] || new Set()
  if (!allowedTargets.has(next)) {
    throw Object.assign(
      new Error(`Недопустимый переход статуса контракта: ${current} -> ${next}`),
      { statusCode: 409 }
    )
  }
  return next
}

const loadContractExecutionEvidence = async (conn, selectionId) => {
  if (!selectionId) {
    return {
      po_total: 0,
      po_confirmed: 0,
      open_quality_events: 0,
    }
  }

  const [[row]] = await conn.execute(
    `SELECT
        (SELECT COUNT(*)
           FROM supplier_purchase_orders po
          WHERE po.selection_id = ?) AS po_total,
        (SELECT COUNT(*)
           FROM supplier_purchase_orders po
          WHERE po.selection_id = ?
            AND po.status = 'confirmed') AS po_confirmed,
        (SELECT COUNT(*)
           FROM supplier_quality_events sqe
          WHERE sqe.selection_id = ?
            AND sqe.status = 'open') AS open_quality_events`,
    [selectionId, selectionId, selectionId]
  )

  return {
    po_total: Number(row?.po_total || 0),
    po_confirmed: Number(row?.po_confirmed || 0),
    open_quality_events: Number(row?.open_quality_events || 0),
  }
}

const ensureContractExecutionCanClose = async (conn, contractRow, targetStatus) => {
  if (!['completed', 'closed_with_issues'].includes(targetStatus)) return

  const [[quote]] = await conn.execute(
    `SELECT selection_id
       FROM sales_quotes
      WHERE id = ?`,
    [contractRow.sales_quote_id]
  )
  const selectionId = toId(quote?.selection_id)
  const evidence = await loadContractExecutionEvidence(conn, selectionId)

  if (evidence.po_total <= 0) {
    throw Object.assign(
      new Error('Контракт нельзя закрыть без созданных PO по утвержденному выбору закупки'),
      { statusCode: 409 }
    )
  }

  if (targetStatus === 'completed') {
    if (evidence.po_confirmed < evidence.po_total) {
      throw Object.assign(
        new Error('Контракт можно перевести в completed только когда все PO подтверждены'),
        { statusCode: 409 }
      )
    }
    if (evidence.open_quality_events > 0) {
      throw Object.assign(
        new Error('Контракт нельзя перевести в completed, пока есть открытые события качества'),
        { statusCode: 409 }
      )
    }
  }
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
    const includeRevision = await contractsSupportQuoteRevision(db)
    const [rows] = await db.execute(
      `SELECT cc.*,
              c.company_name AS client_name,
              sq.selection_id,
              cr.client_request_id,
              cr.rev_number,
              (SELECT COUNT(*) FROM supplier_purchase_orders po WHERE po.selection_id = sq.selection_id) AS po_total,
              (SELECT COUNT(*) FROM supplier_purchase_orders po WHERE po.selection_id = sq.selection_id AND po.status = 'confirmed') AS po_confirmed,
              (SELECT COUNT(*) FROM supplier_quality_events sqe WHERE sqe.selection_id = sq.selection_id AND sqe.status = 'open') AS open_quality_events,
              ${includeRevision ? 'cc.sales_quote_revision_id,' : 'NULL AS sales_quote_revision_id,'}
              ${includeRevision ? 'sqr.rev_number AS sales_quote_revision_number,' : 'NULL AS sales_quote_revision_number,'}
              ${selectExtras}
         FROM client_contracts cc
         JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
         JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
         ${includeRevision ? 'LEFT JOIN sales_quote_revisions sqr ON sqr.id = cc.sales_quote_revision_id' : ''}
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
    const nextStatus = ensureContractStatusTransition('draft', nz(req.body.status) || 'draft', { isCreate: true })
    if (nextStatus === 'signed') {
      await ensureSingleSignedContractPerRequest(db, salesQuoteId)
    }
    const supportsQuoteRevision = await contractsSupportQuoteRevision(db)
    let salesQuoteRevisionId = null
    if (supportsQuoteRevision) {
      salesQuoteRevisionId = toId(req.body.sales_quote_revision_id)
      if (salesQuoteRevisionId) {
        const [[revision]] = await db.execute(
          `SELECT id, sales_quote_id
             FROM sales_quote_revisions
            WHERE id = ?`,
          [salesQuoteRevisionId]
        )
        if (!revision || Number(revision.sales_quote_id) !== Number(salesQuoteId)) {
          return res.status(400).json({ message: 'Ревизия КП не относится к выбранному КП' })
        }
      } else {
        const [[latestRevision]] = await db.execute(
          `SELECT id
             FROM sales_quote_revisions
            WHERE sales_quote_id = ?
            ORDER BY rev_number DESC, id DESC
            LIMIT 1`,
          [salesQuoteId]
        )
        salesQuoteRevisionId = latestRevision?.id || null
      }
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
            ${supportsQuoteRevision ? 'sales_quote_revision_id,' : ''}
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
         VALUES (${supportsQuoteRevision ? '?,?,?,?,?,?,?,?,?,?,?' : '?,?,?,?,?,?,?,?,?,?'})`
      : `INSERT INTO client_contracts
          (${supportsQuoteRevision ? 'sales_quote_id, sales_quote_revision_id,' : 'sales_quote_id,'} contract_number, contract_date, amount, currency, status, file_url, note)
         VALUES (${supportsQuoteRevision ? '?,?,?,?,?,?,?,?,?' : '?,?,?,?,?,?,?,?'})`
    const insertParams = canPersistLegalSnapshot
      ? [
          salesQuoteId,
          ...(supportsQuoteRevision ? [salesQuoteRevisionId] : []),
          contractNumber,
          contractDate,
          numOrNull(req.body.amount),
          nz(req.body.currency),
          nextStatus,
          nz(req.body.file_url),
          nz(req.body.note),
          legalProfile?.id || null,
          legalProfile?.snapshot_json || null,
        ]
      : [
          salesQuoteId,
          ...(supportsQuoteRevision ? [salesQuoteRevisionId] : []),
          contractNumber,
          contractDate,
          numOrNull(req.body.amount),
          nz(req.body.currency),
          nextStatus,
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
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сервера' })
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const contractId = toId(req.params.id)
    if (!contractId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[existing]] = await db.execute('SELECT * FROM client_contracts WHERE id = ?', [contractId])
    if (!existing) return res.status(404).json({ message: 'Контракт не найден' })
    const nextStatus = ensureContractStatusTransition(existing.status, nz(req.body.status) || existing.status)
    if (nextStatus === 'signed') {
      await ensureSingleSignedContractPerRequest(db, existing.sales_quote_id, contractId)
    }
    await ensureContractExecutionCanClose(db, existing, nextStatus)
    const supportsQuoteRevision = await contractsSupportQuoteRevision(db)
    const nextRevisionId = supportsQuoteRevision ? toId(req.body.sales_quote_revision_id) : null
    if (supportsQuoteRevision && nextRevisionId) {
      const [[revision]] = await db.execute(
        `SELECT id, sales_quote_id
           FROM sales_quote_revisions
          WHERE id = ?`,
        [nextRevisionId]
      )
      if (!revision || Number(revision.sales_quote_id) !== Number(existing.sales_quote_id)) {
        return res.status(400).json({ message: 'Ревизия КП не относится к этому контракту' })
      }
    }

    await db.execute(
      `UPDATE client_contracts
          SET contract_number = COALESCE(?, contract_number),
              contract_date = COALESCE(?, contract_date),
              amount = ?,
              currency = COALESCE(?, currency),
              status = COALESCE(?, status),
              ${supportsQuoteRevision ? 'sales_quote_revision_id = COALESCE(?, sales_quote_revision_id),' : ''}
              file_url = ?,
              note = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [
        nz(req.body.contract_number),
        nz(req.body.contract_date),
        numOrNull(req.body.amount),
        nz(req.body.currency),
        nextStatus,
        ...(supportsQuoteRevision ? [nextRevisionId] : []),
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
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сервера' })
  }
})

module.exports = router
