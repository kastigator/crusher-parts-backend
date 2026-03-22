const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  updateRequestStatus,
  fetchRequestIdByRevisionId,
  fetchRequestIdBySelectionId,
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
const roundMoney = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(4)))
const roundPct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(2)))

const loadGlobalPricingPolicy = async (conn) => {
  const [[row]] = await conn.execute(
    `SELECT *
       FROM sales_quote_pricing_policies
      WHERE scope_type = 'GLOBAL'
        AND is_active = 1
      ORDER BY id DESC
      LIMIT 1`
  )
  return row || null
}

const resolveQuoteLinePricing = ({ qty, cost, sellPrice, marginPct, policy }) => {
  const resolvedQty = qty !== null ? qty : null
  const resolvedCost = cost !== null ? cost : null
  let resolvedSellPrice = sellPrice !== null ? sellPrice : null
  let resolvedMarginPct = marginPct !== null ? marginPct : null

  // Preserve existing UI meaning: margin_pct is an editable markup-style helper.
  if (resolvedCost !== null && resolvedSellPrice === null && resolvedMarginPct !== null) {
    resolvedSellPrice = resolvedCost * (1 + resolvedMarginPct / 100)
  } else if (resolvedCost !== null && resolvedSellPrice !== null && resolvedMarginPct === null && resolvedCost !== 0) {
    resolvedMarginPct = ((resolvedSellPrice - resolvedCost) / resolvedCost) * 100
  }

  const grossProfitUnit =
    resolvedCost !== null && resolvedSellPrice !== null ? resolvedSellPrice - resolvedCost : null
  const grossProfitAbs =
    grossProfitUnit !== null && resolvedQty !== null ? grossProfitUnit * resolvedQty : null
  const grossMarginPct =
    resolvedCost !== null && resolvedSellPrice !== null && resolvedSellPrice !== 0
      ? ((resolvedSellPrice - resolvedCost) / resolvedSellPrice) * 100
      : null
  const markupPct =
    resolvedCost !== null && resolvedSellPrice !== null && resolvedCost !== 0
      ? ((resolvedSellPrice - resolvedCost) / resolvedCost) * 100
      : null

  let pricingStatus = 'OK'
  if (resolvedSellPrice === null || resolvedCost === null) {
    pricingStatus = 'INCOMPLETE'
  } else if (policy?.min_profit_abs != null && grossProfitAbs != null && grossProfitAbs < Number(policy.min_profit_abs)) {
    pricingStatus = 'LOW_PROFIT'
  } else if (policy?.min_markup_pct != null && markupPct != null && markupPct < Number(policy.min_markup_pct)) {
    pricingStatus = 'LOW_MARKUP'
  } else if (policy?.min_gross_margin_pct != null && grossMarginPct != null && grossMarginPct < Number(policy.min_gross_margin_pct)) {
    pricingStatus = 'LOW_MARGIN'
  }

  return {
    qty: resolvedQty,
    cost: resolvedCost,
    sellPrice: resolvedSellPrice !== null ? roundMoney(resolvedSellPrice) : null,
    marginPct: resolvedMarginPct !== null ? roundPct(resolvedMarginPct) : null,
    grossProfitAbs: grossProfitAbs !== null ? roundMoney(grossProfitAbs) : null,
    grossMarginPct: grossMarginPct !== null ? roundPct(grossMarginPct) : null,
    markupPct: markupPct !== null ? roundPct(markupPct) : null,
    pricingStatus,
  }
}

const buildSalesQuoteSelectExtras = async (conn, alias = 'sq') => {
  const canPersistLegalSnapshot = await salesQuotesSupportLegalSnapshot(conn)
  if (!canPersistLegalSnapshot) {
    return `NULL AS company_legal_profile_id,
            NULL AS company_legal_snapshot_json`
  }
  return `${alias}.company_legal_profile_id,
          ${alias}.company_legal_snapshot_json`
}

const loadQuoteHeader = async (conn, quoteId) => {
  const selectExtras = await buildSalesQuoteSelectExtras(conn, 'sq')
  const [[row]] = await conn.execute(
    `SELECT sq.*,
            cr.client_request_id,
            cr.rev_number,
            c.company_name AS client_name,
            ${selectExtras}
       FROM sales_quotes sq
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
       JOIN client_requests req ON req.id = cr.client_request_id
       JOIN clients c ON c.id = req.client_id
      WHERE sq.id = ?`,
    [quoteId]
  )
  return row || null
}

const loadLatestRevisionId = async (conn, quoteId) => {
  const [[row]] = await conn.execute(
    `SELECT id
       FROM sales_quote_revisions
      WHERE sales_quote_id = ?
      ORDER BY rev_number DESC, id DESC
      LIMIT 1`,
    [quoteId]
  )
  return row?.id || null
}

const buildAutofillQuoteLines = async (conn, selectionId, clientRequestRevisionId) => {
  const [rows] = await conn.execute(
    `SELECT ri.client_request_revision_item_id,
            cri.requested_qty,
            SUM(COALESCE(sl.goods_amount, 0)) AS goods_total,
            SUM(COALESCE(sl.freight_amount, 0)) AS freight_total,
            SUM(COALESCE(sl.duty_amount, 0)) AS duty_total,
            SUM(COALESCE(sl.other_amount, 0)) AS other_total,
            SUM(COALESCE(sl.landed_amount, 0)) AS landed_total,
            MIN(sl.currency) AS currency
       FROM selection_lines sl
       JOIN rfq_items ri ON ri.id = sl.rfq_item_id
       JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
      WHERE sl.selection_id = ?
        AND cri.client_request_revision_id = ?
      GROUP BY ri.client_request_revision_item_id, cri.requested_qty
      ORDER BY ri.client_request_revision_item_id ASC`,
    [selectionId, clientRequestRevisionId]
  )

  return rows.map((row) => {
    const qty = Number(row.requested_qty || 0) || 1
    const landedTotal = Number(row.landed_total || 0)
    const unitCost = qty > 0 ? landedTotal / qty : landedTotal
    return {
      client_request_revision_item_id: Number(row.client_request_revision_item_id),
      qty,
      cost: Number.isFinite(unitCost) ? unitCost : null,
      sell_price: null,
      margin_pct: null,
      currency: row.currency || 'USD',
      note: null,
    }
  })
}

const salesQuotesSupportLegalSnapshot = async (conn) =>
  (await hasTableColumn(conn, 'sales_quotes', 'company_legal_profile_id')) &&
  (await hasTableColumn(conn, 'sales_quotes', 'company_legal_snapshot_json'))

const salesQuoteLinesSupportLineStatus = async (conn) =>
  hasTableColumn(conn, 'sales_quote_lines', 'line_status')

router.get('/', async (req, res) => {
  try {
    const requestId = toId(req.query.request_id)
    const rfqId = toId(req.query.rfq_id)
    const selectionId = toId(req.query.selection_id)
    const where = []
    const params = []
    if (requestId) {
      where.push('cr.client_request_id = ?')
      params.push(requestId)
    }
    if (rfqId) {
      where.push('s.rfq_id = ?')
      params.push(rfqId)
    }
    if (selectionId) {
      where.push('sq.selection_id = ?')
      params.push(selectionId)
    }

    const selectExtras = await buildSalesQuoteSelectExtras(db, 'sq')
    const lineStatusSupported = await salesQuoteLinesSupportLineStatus(db)
    const activeLinePredicate = lineStatusSupported ? `AND COALESCE(ql.line_status, 'active') = 'active'` : ''
    const [rows] = await db.execute(
      `SELECT sq.*,
              cr.client_request_id,
              cr.rev_number,
              c.company_name AS client_name,
              r.rfq_number,
              COALESCE(quote_totals.total_cost, 0) AS total_cost,
              COALESCE(quote_totals.total_sell, 0) AS total_sell,
              COALESCE(quote_totals.gross_margin_pct_avg, 0) AS margin_pct_avg,
              rev_latest.id AS latest_revision_id,
              rev_latest.rev_number AS latest_revision_number,
              ${selectExtras}
         FROM sales_quotes sq
         JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
         JOIN selections s ON s.id = sq.selection_id
         JOIN rfqs r ON r.id = s.rfq_id
         LEFT JOIN sales_quote_revisions rev_latest
           ON rev_latest.id = (
             SELECT r2.id
               FROM sales_quote_revisions r2
              WHERE r2.sales_quote_id = sq.id
              ORDER BY r2.rev_number DESC, r2.id DESC
              LIMIT 1
           )
         LEFT JOIN (
           SELECT qr.sales_quote_id,
                  SUM(COALESCE(ql.cost, 0) * COALESCE(ql.qty, 0)) AS total_cost,
                  SUM(COALESCE(ql.sell_price, 0) * COALESCE(ql.qty, 0)) AS total_sell,
                  AVG(COALESCE(ql.gross_margin_pct, ql.margin_pct)) AS gross_margin_pct_avg
             FROM sales_quote_revisions qr
             JOIN sales_quote_lines ql ON ql.sales_quote_revision_id = qr.id
            WHERE qr.id = (
              SELECT r3.id
                FROM sales_quote_revisions r3
               WHERE r3.sales_quote_id = qr.sales_quote_id
               ORDER BY r3.rev_number DESC, r3.id DESC
               LIMIT 1
            )
             ${activeLinePredicate}
            GROUP BY qr.sales_quote_id
         ) quote_totals ON quote_totals.sales_quote_id = sq.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY sq.id DESC`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /sales-quotes error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/revisions', async (req, res) => {
  try {
    const salesQuoteId = toId(req.params.id)
    if (!salesQuoteId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const lineStatusSupported = await salesQuoteLinesSupportLineStatus(db)
    const totalCostExpr = lineStatusSupported
      ? `SUM(CASE WHEN COALESCE(l.line_status, 'active') = 'active' THEN COALESCE(l.cost, 0) * COALESCE(l.qty, 0) ELSE 0 END)`
      : `SUM(COALESCE(l.cost, 0) * COALESCE(l.qty, 0))`
    const totalSellExpr = lineStatusSupported
      ? `SUM(CASE WHEN COALESCE(l.line_status, 'active') = 'active' THEN COALESCE(l.sell_price, 0) * COALESCE(l.qty, 0) ELSE 0 END)`
      : `SUM(COALESCE(l.sell_price, 0) * COALESCE(l.qty, 0))`
    const marginExpr = lineStatusSupported
      ? `AVG(CASE WHEN COALESCE(l.line_status, 'active') = 'active' THEN COALESCE(l.gross_margin_pct, l.margin_pct) ELSE NULL END)`
      : `AVG(COALESCE(l.gross_margin_pct, l.margin_pct))`
    const [rows] = await db.execute(
      `SELECT r.*,
              COALESCE(${totalCostExpr}, 0) AS total_cost,
              COALESCE(${totalSellExpr}, 0) AS total_sell,
              ${marginExpr} AS margin_pct_avg
         FROM sales_quote_revisions r
         LEFT JOIN sales_quote_lines l ON l.sales_quote_revision_id = r.id
        WHERE r.sales_quote_id = ?
        GROUP BY r.id
        ORDER BY r.rev_number DESC`,
      [salesQuoteId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /sales-quotes/:id/revisions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const clientRequestRevisionId = toId(req.body.client_request_revision_id)
    const selectionId = toId(req.body.selection_id)
    const autoCreateRevision = req.body.auto_create_revision !== false
    const autofillFromSelection = req.body.autofill_from_selection !== false
    if (!clientRequestRevisionId || !selectionId) {
      return res.status(400).json({ message: 'Нужно указать ревизию заявки и выбор' })
    }

    const [[revisionRow]] = await conn.execute(
      `SELECT id, client_request_id
         FROM client_request_revisions
        WHERE id = ?`,
      [clientRequestRevisionId]
    )
    const selectionRequestId = await fetchRequestIdBySelectionId(conn, selectionId)
    if (!revisionRow || !selectionRequestId || Number(revisionRow.client_request_id) !== Number(selectionRequestId)) {
      return res.status(400).json({ message: 'Ревизия заявки и selection относятся к разным заявкам' })
    }

    await conn.beginTransaction()
    const legalProfile = await fetchCurrentCompanyLegalProfile(conn)
    const canPersistLegalSnapshot = await salesQuotesSupportLegalSnapshot(conn)
    const insertSql = canPersistLegalSnapshot
      ? `INSERT INTO sales_quotes
          (
            client_request_revision_id,
            selection_id,
            status,
            currency,
            created_by_user_id,
            company_legal_profile_id,
            company_legal_snapshot_json
          )
         VALUES (?,?,?,?,?,?,?)`
      : `INSERT INTO sales_quotes
          (client_request_revision_id, selection_id, status, currency, created_by_user_id)
         VALUES (?,?,?,?,?)`
    const insertParams = canPersistLegalSnapshot
      ? [
          clientRequestRevisionId,
          selectionId,
          nz(req.body.status) || 'draft',
          nz(req.body.currency) || 'USD',
          toId(req.user?.id),
          legalProfile?.id || null,
          legalProfile ? JSON.stringify(legalProfile) : null,
        ]
      : [
          clientRequestRevisionId,
          selectionId,
          nz(req.body.status) || 'draft',
          nz(req.body.currency) || 'USD',
          toId(req.user?.id),
        ]
    const [insertQuote] = await conn.execute(insertSql, insertParams)

    const quoteId = insertQuote.insertId
    let createdRevision = null
    if (autoCreateRevision) {
      const [insertRevision] = await conn.execute(
        `INSERT INTO sales_quote_revisions (sales_quote_id, rev_number, note, created_by_user_id)
         VALUES (?,?,?,?)`,
        [quoteId, 1, nz(req.body.revision_note) || 'Автосоздание из selection', toId(req.user?.id)]
      )
      createdRevision = { id: insertRevision.insertId, rev_number: 1 }

      if (autofillFromSelection) {
        const policy = await loadGlobalPricingPolicy(conn)
        const lineStatusSupported = await salesQuoteLinesSupportLineStatus(conn)
        const lines = await buildAutofillQuoteLines(conn, selectionId, clientRequestRevisionId)
        for (const line of lines) {
          const pricing = resolveQuoteLinePricing({
            qty: line.qty,
            cost: line.cost,
            sellPrice: line.sell_price,
            marginPct: line.margin_pct,
            policy,
          })
          const insertSql = lineStatusSupported
            ? `INSERT INTO sales_quote_lines
              (
                sales_quote_revision_id,
                client_request_revision_item_id,
                qty,
                cost,
                sell_price,
                margin_pct,
                gross_profit_abs,
                gross_margin_pct,
                markup_pct,
                pricing_status,
                currency,
                note,
                line_status
              )
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
            : `INSERT INTO sales_quote_lines
              (
                sales_quote_revision_id,
                client_request_revision_item_id,
                qty,
                cost,
                sell_price,
                margin_pct,
                gross_profit_abs,
                gross_margin_pct,
                markup_pct,
                pricing_status,
                currency,
                note
              )
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          const insertParams = lineStatusSupported
            ? [
              createdRevision.id,
              line.client_request_revision_item_id,
              pricing.qty,
              pricing.cost,
              pricing.sellPrice,
              pricing.marginPct,
              pricing.grossProfitAbs,
              pricing.grossMarginPct,
              pricing.markupPct,
              pricing.pricingStatus,
              line.currency,
              line.note,
              'active',
            ]
            : [
                createdRevision.id,
                line.client_request_revision_item_id,
                pricing.qty,
                pricing.cost,
                pricing.sellPrice,
                pricing.marginPct,
                pricing.grossProfitAbs,
                pricing.grossMarginPct,
                pricing.markupPct,
                pricing.pricingStatus,
                line.currency,
                line.note,
              ]
          await conn.execute(
            insertSql,
            insertParams
          )
        }
      }
    }

    await conn.commit()

    const requestId = await fetchRequestIdByRevisionId(conn, clientRequestRevisionId)
    if (requestId) {
      await updateRequestStatus(conn, requestId)
    }

    const created = await loadQuoteHeader(conn, quoteId)
    res.status(201).json({
      ...created,
      created_revision_id: createdRevision?.id || null,
    })
  } catch (e) {
    await conn.rollback()
    console.error('POST /sales-quotes error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.post('/:id/revisions', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const salesQuoteId = toId(req.params.id)
    if (!salesQuoteId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    await conn.beginTransaction()
    const [[quote]] = await conn.execute(`SELECT * FROM sales_quotes WHERE id = ?`, [salesQuoteId])
    if (!quote) {
      throw Object.assign(new Error('КП не найдено'), { statusCode: 404 })
    }

    const [[{ next_rev: nextRev }]] = await conn.execute(
      `SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev
         FROM sales_quote_revisions
        WHERE sales_quote_id = ?`,
      [salesQuoteId]
    )
    const previousRevisionId = req.body.copy_previous !== false
      ? await loadLatestRevisionId(conn, salesQuoteId)
      : null

    const [result] = await conn.execute(
      `INSERT INTO sales_quote_revisions (sales_quote_id, rev_number, note, created_by_user_id)
       VALUES (?,?,?,?)`,
      [salesQuoteId, nextRev, nz(req.body.note), toId(req.user?.id)]
    )
    const revisionId = result.insertId

    if (previousRevisionId && Number(previousRevisionId) !== Number(revisionId)) {
      const lineStatusSupported = await salesQuoteLinesSupportLineStatus(conn)
      const copySql = lineStatusSupported
        ? `INSERT INTO sales_quote_lines
          (
            sales_quote_revision_id,
            client_request_revision_item_id,
            qty,
            cost,
            sell_price,
            margin_pct,
            gross_profit_abs,
            gross_margin_pct,
            markup_pct,
            pricing_status,
            pricing_note,
            currency,
            note,
            line_status
          )
         SELECT ?,
                client_request_revision_item_id,
                qty,
                cost,
                sell_price,
                margin_pct,
                gross_profit_abs,
                gross_margin_pct,
                markup_pct,
                pricing_status,
                pricing_note,
                currency,
                note,
                COALESCE(line_status, 'active')
           FROM sales_quote_lines
          WHERE sales_quote_revision_id = ?`
        : `INSERT INTO sales_quote_lines
          (
            sales_quote_revision_id,
            client_request_revision_item_id,
            qty,
            cost,
            sell_price,
            margin_pct,
            gross_profit_abs,
            gross_margin_pct,
            markup_pct,
            pricing_status,
            pricing_note,
            currency,
            note
          )
         SELECT ?,
                client_request_revision_item_id,
                qty,
                cost,
                sell_price,
                margin_pct,
                gross_profit_abs,
                gross_margin_pct,
                markup_pct,
                pricing_status,
                pricing_note,
                currency,
                note
           FROM sales_quote_lines
          WHERE sales_quote_revision_id = ?`
      await conn.execute(
        copySql,
        [revisionId, previousRevisionId]
      )
    }

    await conn.commit()
    const [[created]] = await db.execute('SELECT * FROM sales_quote_revisions WHERE id = ?', [revisionId])
    res.status(201).json(created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /sales-quotes/:id/revisions error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const salesQuoteId = toId(req.params.id)
    if (!salesQuoteId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    await db.execute(
      `UPDATE sales_quotes
          SET status = COALESCE(?, status),
              currency = COALESCE(?, currency),
              updated_at = NOW()
        WHERE id = ?`,
      [nz(req.body.status), nz(req.body.currency), salesQuoteId]
    )

    const requestId = await fetchRequestIdBySalesQuoteId(db, salesQuoteId)
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    const created = await loadQuoteHeader(db, salesQuoteId)
    res.json(created)
  } catch (e) {
    console.error('PATCH /sales-quotes/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/revisions/:revisionId/lines', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const lineStatusSupported = await salesQuoteLinesSupportLineStatus(db)
    const [rows] = await db.execute(
      `SELECT ql.*,
              cri.client_request_revision_id,
              cri.client_part_number,
              cri.client_description,
              cri.requested_qty AS requested_qty_base,
              cri.uom,
              cri.oem_part_id AS original_part_id,
              op.part_number AS original_cat_number,
              GROUP_CONCAT(
                DISTINCT COALESCE(sl.supplier_public_code_snapshot, ps.public_code)
                ORDER BY COALESCE(sl.supplier_public_code_snapshot, ps.public_code)
                SEPARATOR ', '
              ) AS supplier_public_codes
         FROM sales_quote_lines ql
         JOIN sales_quote_revisions qr ON qr.id = ql.sales_quote_revision_id
         JOIN sales_quotes sq ON sq.id = qr.sales_quote_id
         JOIN client_request_revision_items cri ON cri.id = ql.client_request_revision_item_id
         LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
         LEFT JOIN selections s ON s.id = sq.selection_id
         LEFT JOIN selection_lines sl
           ON sl.selection_id = s.id
         LEFT JOIN rfq_items ri
           ON ri.id = sl.rfq_item_id
          AND ri.client_request_revision_item_id = ql.client_request_revision_item_id
         LEFT JOIN part_suppliers ps ON ps.id = sl.supplier_id
        WHERE ql.sales_quote_revision_id = ?
        GROUP BY ql.id
        ORDER BY ql.id ASC`,
      [revisionId]
    )
    res.json(
      rows.map((row) => ({
        ...row,
        line_status: lineStatusSupported ? row.line_status || 'active' : 'active',
      }))
    )
  } catch (e) {
    console.error('GET /sales-quotes/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/revisions/:revisionId/lines', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const clientRequestRevisionItemId = toId(req.body.client_request_revision_item_id)
    if (!clientRequestRevisionItemId) {
      return res.status(400).json({ message: 'Не выбрана строка заявки клиента' })
    }

    const [[revisionRow]] = await db.execute(
      `SELECT qr.id,
              sq.client_request_revision_id
         FROM sales_quote_revisions qr
         JOIN sales_quotes sq ON sq.id = qr.sales_quote_id
        WHERE qr.id = ?`,
      [revisionId]
    )
    if (!revisionRow) {
      return res.status(404).json({ message: 'Ревизия КП не найдена' })
    }

    const [[requestItemRow]] = await db.execute(
      `SELECT id, client_request_revision_id
         FROM client_request_revision_items
        WHERE id = ?`,
      [clientRequestRevisionItemId]
    )
    if (!requestItemRow) {
      return res.status(404).json({ message: 'Строка заявки клиента не найдена' })
    }
    if (Number(requestItemRow.client_request_revision_id) !== Number(revisionRow.client_request_revision_id)) {
      return res.status(400).json({
        message: 'Нельзя добавить в rev КП строку из другой ревизии заявки клиента',
      })
    }

    const policy = await loadGlobalPricingPolicy(db)
    const lineStatusSupported = await salesQuoteLinesSupportLineStatus(db)
    const pricing = resolveQuoteLinePricing({
      qty: numOrNull(req.body.qty),
      cost: numOrNull(req.body.cost),
      sellPrice: numOrNull(req.body.sell_price),
      marginPct: numOrNull(req.body.margin_pct),
      policy,
    })

    const insertSql = lineStatusSupported
      ? `INSERT INTO sales_quote_lines
        (
          sales_quote_revision_id,
          client_request_revision_item_id,
          qty,
          cost,
          sell_price,
          margin_pct,
          gross_profit_abs,
          gross_margin_pct,
          markup_pct,
          pricing_status,
          currency,
          note,
          line_status
        )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      : `INSERT INTO sales_quote_lines
        (
          sales_quote_revision_id,
          client_request_revision_item_id,
          qty,
          cost,
          sell_price,
          margin_pct,
          gross_profit_abs,
          gross_margin_pct,
          markup_pct,
          pricing_status,
          currency,
          note
        )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    const insertParams = lineStatusSupported
      ? [
        revisionId,
        clientRequestRevisionItemId,
        pricing.qty,
        pricing.cost,
        pricing.sellPrice,
        pricing.marginPct,
        pricing.grossProfitAbs,
        pricing.grossMarginPct,
        pricing.markupPct,
        pricing.pricingStatus,
        nz(req.body.currency),
        nz(req.body.note),
        nz(req.body.line_status) || 'active',
      ]
      : [
          revisionId,
          clientRequestRevisionItemId,
          pricing.qty,
          pricing.cost,
          pricing.sellPrice,
          pricing.marginPct,
          pricing.grossProfitAbs,
          pricing.grossMarginPct,
          pricing.markupPct,
          pricing.pricingStatus,
          nz(req.body.currency),
          nz(req.body.note),
        ]
    const [result] = await db.execute(insertSql, insertParams)

    const [[created]] = await db.execute('SELECT * FROM sales_quote_lines WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /sales-quotes/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.patch('/lines/:lineId', async (req, res) => {
  try {
    const lineId = toId(req.params.lineId)
    if (!lineId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM sales_quote_lines WHERE id = ?', [lineId])
    if (!before) return res.status(404).json({ message: 'Строка КП не найдена' })

    const qty = req.body.qty !== undefined ? numOrNull(req.body.qty) : numOrNull(before.qty)
    const cost = req.body.cost !== undefined ? numOrNull(req.body.cost) : numOrNull(before.cost)
    const sellPrice = req.body.sell_price !== undefined ? numOrNull(req.body.sell_price) : numOrNull(before.sell_price)
    const marginPct = req.body.margin_pct !== undefined ? numOrNull(req.body.margin_pct) : numOrNull(before.margin_pct)
    const currency = nz(req.body.currency)
    const note = nz(req.body.note)
    const lineStatus = nz(req.body.line_status)
    const lineStatusSupported = await salesQuoteLinesSupportLineStatus(db)
    const policy = await loadGlobalPricingPolicy(db)
    const pricing = resolveQuoteLinePricing({ qty, cost, sellPrice, marginPct, policy })

    const updateSql = lineStatusSupported
      ? `UPDATE sales_quote_lines
          SET qty = COALESCE(?, qty),
              cost = ?,
              sell_price = ?,
              margin_pct = ?,
              gross_profit_abs = ?,
              gross_margin_pct = ?,
              markup_pct = ?,
              pricing_status = ?,
              pricing_note = ?,
              line_status = COALESCE(?, line_status),
              currency = COALESCE(?, currency),
              note = COALESCE(?, note)
        WHERE id = ?`
      : `UPDATE sales_quote_lines
          SET qty = COALESCE(?, qty),
              cost = ?,
              sell_price = ?,
              margin_pct = ?,
              gross_profit_abs = ?,
              gross_margin_pct = ?,
              markup_pct = ?,
              pricing_status = ?,
              pricing_note = ?,
              currency = COALESCE(?, currency),
              note = COALESCE(?, note)
        WHERE id = ?`
    await db.execute(
      updateSql,
      [
        pricing.qty,
        pricing.cost,
        pricing.sellPrice,
        pricing.marginPct,
        pricing.grossProfitAbs,
        pricing.grossMarginPct,
        pricing.markupPct,
        pricing.pricingStatus,
        policy ? `Policy: ${policy.policy_name}` : null,
        ...(lineStatusSupported ? [lineStatus] : []),
        currency,
        note,
        lineId,
      ]
    )

    const [[updated]] = await db.execute('SELECT * FROM sales_quote_lines WHERE id = ?', [lineId])
    res.json(updated)
  } catch (e) {
    console.error('PATCH /sales-quotes/lines/:lineId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
