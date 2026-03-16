const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { hasTableColumn } = require('../utils/companyLegalProfiles')

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

const contractsSupportQuoteRevision = async (conn) =>
  hasTableColumn(conn, 'client_contracts', 'sales_quote_revision_id')

const salesQuoteLinesSupportLineStatus = async (conn) =>
  hasTableColumn(conn, 'sales_quote_lines', 'line_status')

const PO_ELIGIBLE_CONTRACT_STATUSES = new Set(['signed', 'in_execution'])

const loadApprovedCommercialContext = async (conn, selectionId) => {
  const supportsQuoteRevision = await contractsSupportQuoteRevision(conn)
  const [[selectionRow]] = await conn.execute(
    `SELECT s.id, r.client_request_id
       FROM selections s
       JOIN rfqs r ON r.id = s.rfq_id
      WHERE s.id = ?`,
    [selectionId]
  )
  if (!selectionRow?.client_request_id) return null

  const [contracts] = await conn.execute(
    `SELECT cc.id,
            cc.sales_quote_id,
            ${supportsQuoteRevision ? 'cc.sales_quote_revision_id,' : 'NULL AS sales_quote_revision_id,'}
            cc.contract_number,
            cc.contract_date,
            sq.selection_id AS contract_selection_id
       FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
      WHERE cr.client_request_id = ?
        AND cc.status IN (?, ?)
      ORDER BY cc.contract_date DESC, cc.id DESC`,
    [selectionRow.client_request_id, ...PO_ELIGIBLE_CONTRACT_STATUSES]
  )
  if (!contracts.length) return null
  if (contracts.length > 1) {
    throw Object.assign(
      new Error('Для этой заявки найдено несколько signed-контрактов. PO нельзя создавать, пока не останется один финальный контракт.'),
      { statusCode: 409 }
    )
  }

  const contract = contracts[0]
  if (Number(contract.contract_selection_id) !== Number(selectionId)) {
    throw Object.assign(
      new Error('Подписанный контракт относится к другому выбору закупки. PO можно создавать только из выбора, который зафиксирован в финальном контракте.'),
      { statusCode: 409 }
    )
  }

  let revisionId = contract.sales_quote_revision_id || null
  if (!revisionId) {
    const [[latestRevision]] = await conn.execute(
      `SELECT id
         FROM sales_quote_revisions
        WHERE sales_quote_id = ?
        ORDER BY rev_number DESC, id DESC
        LIMIT 1`,
      [contract.sales_quote_id]
    )
    revisionId = latestRevision?.id || null
  }
  return revisionId ? { ...contract, sales_quote_revision_id: revisionId } : null
}

const promoteContractToExecutionIfNeeded = async (conn, contractId) => {
  if (!contractId) return
  await conn.execute(
    `UPDATE client_contracts
        SET status = 'in_execution',
            updated_at = NOW()
      WHERE id = ?
        AND status = 'signed'`,
    [contractId]
  )
}

const loadApprovedLineFactors = async (conn, salesQuoteRevisionId) => {
  const lineStatusSupported = await salesQuoteLinesSupportLineStatus(conn)
  const [rows] = await conn.execute(
    `SELECT ql.client_request_revision_item_id,
            ql.qty AS approved_qty,
            cri.requested_qty AS base_qty,
            ${lineStatusSupported ? "COALESCE(ql.line_status, 'active')" : "'active'"} AS line_status
       FROM sales_quote_lines ql
       JOIN client_request_revision_items cri ON cri.id = ql.client_request_revision_item_id
      WHERE ql.sales_quote_revision_id = ?`,
    [salesQuoteRevisionId]
  )

  const factors = new Map()
  rows.forEach((row) => {
    const status = String(row.line_status || 'active').trim().toLowerCase()
    if (status !== 'active') return
    const approvedQty = numOrNull(row.approved_qty)
    const baseQty = numOrNull(row.base_qty)
    const factor =
      approvedQty === null
        ? 1
        : baseQty !== null && Number(baseQty) > 0
          ? Number(approvedQty) / Number(baseQty)
          : Number(approvedQty) > 0
            ? Number(approvedQty)
            : 0
    factors.set(Number(row.client_request_revision_item_id), factor)
  })
  return factors
}

const uniqueNonEmptyValues = (rows, field) =>
  Array.from(
    new Set(
      rows
        .map((row) => nz(row?.[field]))
        .filter(Boolean)
    )
  )

const loadSelectionExecutionDefaults = async (conn, selectionId, supplierId) => {
  const [rows] = await conn.execute(
    `SELECT route_type, incoterms, incoterms_place, currency, lead_time_days
       FROM selection_lines
      WHERE selection_id = ?
        AND supplier_id = ?`,
    [selectionId, supplierId]
  )
  if (!rows.length) {
    return {
      route_type: null,
      incoterms: null,
      incoterms_place: null,
      currency: null,
      lead_time_days: null,
    }
  }

  const routeTypes = uniqueNonEmptyValues(rows, 'route_type')
  const incotermsValues = uniqueNonEmptyValues(rows, 'incoterms')
  const incotermsPlaces = uniqueNonEmptyValues(rows, 'incoterms_place')
  const currencies = uniqueNonEmptyValues(rows, 'currency')
  const leadTimeValues = Array.from(
    new Set(
      rows
        .map((row) => numOrNull(row?.lead_time_days))
        .filter((value) => value !== null)
    )
  )

  return {
    route_type: routeTypes.length === 1 ? routeTypes[0] : null,
    incoterms: incotermsValues.length === 1 ? incotermsValues[0] : null,
    incoterms_place: incotermsPlaces.length === 1 ? incotermsPlaces[0] : null,
    currency: currencies.length === 1 ? currencies[0] : null,
    lead_time_days: leadTimeValues.length === 1 ? leadTimeValues[0] : null,
  }
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
              po.selection_id,
              po.supplier_id,
              sl.rfq_item_id,
              sl.id AS selection_line_id,
              sl.scenario_line_id,
              sl.supplier_name_snapshot,
              sl.supplier_public_code_snapshot,
              sl.route_type,
              sl.origin_country,
              ri.line_number,
              cri.client_part_number,
              cri.client_description,
              cri.oem_part_id AS original_part_id,
              op.part_number AS original_cat_number
         FROM supplier_purchase_order_lines pol
         JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
         LEFT JOIN rfq_response_lines rl ON rl.id = pol.rfq_response_line_id
         LEFT JOIN selection_lines sl
           ON sl.selection_id = po.selection_id
          AND sl.rfq_response_line_id = rl.id
          AND (sl.supplier_id = po.supplier_id OR sl.supplier_id IS NULL)
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

    const approvedContext = await loadApprovedCommercialContext(conn, selectionId)
    if (!approvedContext) {
      return res.status(400).json({ message: 'PO можно создавать только после контракта со статусом signed или in_execution' })
    }

    const executionDefaults = await loadSelectionExecutionDefaults(conn, selectionId, supplierId)

    await conn.beginTransaction()
    const [result] = await conn.execute(
      `INSERT INTO supplier_purchase_orders
        (supplier_id, selection_id, status, supplier_reference, currency, incoterms, incoterms_place, route_type)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        supplierId,
        selectionId,
        nz(req.body.status) || 'draft',
        nz(req.body.supplier_reference),
        nz(req.body.currency) || executionDefaults.currency,
        nz(req.body.incoterms) || executionDefaults.incoterms,
        nz(req.body.incoterms_place) || executionDefaults.incoterms_place,
        executionDefaults.route_type,
      ]
    )
    const poId = result.insertId

    if (autofill) {
      const approvedLineFactors = await loadApprovedLineFactors(conn, approvedContext.sales_quote_revision_id)
      const [lines] = await conn.execute(
        `SELECT sl.*,
                ri.client_request_revision_item_id
           FROM selection_lines sl
           JOIN rfq_items ri ON ri.id = sl.rfq_item_id
          WHERE sl.selection_id = ?
            AND sl.supplier_id = ?
          ORDER BY sl.id ASC`,
        [selectionId, supplierId]
      )

      let insertedCount = 0
      for (const line of lines) {
        const factor = approvedLineFactors.get(Number(line.client_request_revision_item_id))
        if (factor === undefined || factor <= 0) continue
        const baseQty = numOrNull(line.qty) || 0
        const qty = Number((baseQty * factor).toFixed(3))
        if (qty <= 0) continue
        const unitPrice =
          baseQty > 0 && numOrNull(line.goods_amount) !== null
            ? numOrNull(line.goods_amount) / baseQty
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
            numOrNull(line.lead_time_days),
            nz(line.decision_note) ||
              `Автосоздание из selection по контракту ${approvedContext.contract_number || `#${approvedContext.id}`}`,
          ]
        )
        insertedCount += 1
      }

      if (insertedCount === 0) {
        throw Object.assign(new Error('В подписанной ревизии нет активных строк для этого поставщика'), { statusCode: 409 })
      }
    }

    await promoteContractToExecutionIfNeeded(conn, approvedContext.id)

    await conn.commit()
    const [[created]] = await db.execute('SELECT * FROM supplier_purchase_orders WHERE id = ?', [poId])
    res.status(201).json(created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /purchase-orders error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сервера' })
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
