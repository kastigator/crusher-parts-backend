const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  hasTableColumn,
  fetchCurrentCompanyLegalProfile,
  parseSnapshot,
} = require('../utils/companyLegalProfiles')
const {
  createPdfBuffer,
  uploadPdfBuffer,
  beginDocument,
  drawFieldGrid,
  drawSimpleTable,
  formatMoney,
  formatDateRu,
} = require('../utils/documentPdf')
const {
  createDocxBuffer,
  uploadDocxBuffer,
  formatMoney: formatMoneyDocx,
  formatDateRu: formatDateRuDocx,
} = require('../utils/documentDocx')
const {
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  HeadingLevel,
  AlignmentType,
  ShadingType,
} = require('docx')

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
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

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

const normalizeProfileText = (value, { upper = false } = {}) => {
  const text = nz(value)
  if (!text) return null
  const normalized = String(text).trim().replace(/\s+/g, ' ')
  return upper ? normalized.toUpperCase() : normalized.toLowerCase()
}

const buildExecutionProfileKey = (row) => {
  const shipmentGroupId = toId(row?.shipment_group_id)
  if (shipmentGroupId) return `group:${shipmentGroupId}`
  const routeType = normalizeProfileText(row?.route_type)
  const incoterms = normalizeProfileText(row?.incoterms, { upper: true })
  const incotermsPlace = normalizeProfileText(row?.incoterms_place)
  const currency = normalizeProfileText(row?.currency, { upper: true })
  return ['manual', routeType || '-', incoterms || '-', incotermsPlace || '-', currency || '-'].join('|')
}

const describeExecutionProfile = (row) => {
  const parts = []
  const routeType = nz(row?.route_type)
  const incoterms = nz(row?.incoterms)
  const incotermsPlace = nz(row?.incoterms_place)
  const currency = nz(row?.currency)
  if (routeType) parts.push(`маршрут ${routeType}`)
  if (incoterms) parts.push(incotermsPlace ? `${incoterms} ${incotermsPlace}` : incoterms)
  if (currency) parts.push(`валюта ${currency}`)
  const shipmentGroupId = toId(row?.shipment_group_id)
  if (shipmentGroupId) parts.push(`группа #${shipmentGroupId}`)
  return parts.join(' / ') || 'профиль не определен'
}

const loadApprovedSelectionLines = async (
  conn,
  selectionId,
  supplierId,
  salesQuoteRevisionId,
  { shipmentGroupId = null } = {}
) => {
  const approvedLineFactors = await loadApprovedLineFactors(conn, salesQuoteRevisionId)
  const [rows] = await conn.execute(
    `SELECT sl.*,
            ri.client_request_revision_item_id
       FROM selection_lines sl
       JOIN rfq_items ri ON ri.id = sl.rfq_item_id
      WHERE sl.selection_id = ?
        AND sl.supplier_id = ?
        AND (? IS NULL OR sl.shipment_group_id = ?)
      ORDER BY sl.id ASC`,
    [selectionId, supplierId, shipmentGroupId, shipmentGroupId]
  )

  return rows
    .map((row) => ({
      ...row,
      approved_factor: approvedLineFactors.get(Number(row.client_request_revision_item_id)),
      execution_profile_key: buildExecutionProfileKey(row),
    }))
    .filter((row) => row.approved_factor !== undefined && row.approved_factor > 0)
}

const ensureSingleExecutionProfile = (rows) => {
  const uniqueProfiles = Array.from(
    new Map(rows.map((row) => [row.execution_profile_key, row])).values()
  )

  if (!uniqueProfiles.length) {
    throw Object.assign(
      new Error('В подписанной ревизии нет активных строк этого поставщика для исполнения'),
      { statusCode: 409 }
    )
  }

  if (uniqueProfiles.length > 1) {
    const profileList = uniqueProfiles
      .map((row) => describeExecutionProfile(row))
      .join('; ')
    throw Object.assign(
      new Error(
        `У этого поставщика в утвержденном выборе несколько разных профилей исполнения. Разделите заказ на отдельные PO по профилям/консолидационным группам: ${profileList}`
      ),
      { statusCode: 409 }
    )
  }

  return uniqueProfiles[0]
}

const buildPoExecutionProfileKey = (po) =>
  buildExecutionProfileKey({
    shipment_group_id: po?.shipment_group_id,
    route_type: po?.route_type,
    incoterms: po?.incoterms,
    incoterms_place: po?.incoterms_place,
    currency: po?.currency,
  })

const ensureRequestedExecutionFieldsMatchProfile = (body, profile) => {
  const requestedCurrency = normalizeProfileText(body?.currency, { upper: true })
  const requestedIncoterms = normalizeProfileText(body?.incoterms, { upper: true })
  const requestedIncotermsPlace = normalizeProfileText(body?.incoterms_place)
  const requestedRouteType = normalizeProfileText(body?.route_type)

  const profileCurrency = normalizeProfileText(profile?.currency, { upper: true })
  const profileIncoterms = normalizeProfileText(profile?.incoterms, { upper: true })
  const profileIncotermsPlace = normalizeProfileText(profile?.incoterms_place)
  const profileRouteType = normalizeProfileText(profile?.route_type)

  if (requestedCurrency && profileCurrency && requestedCurrency !== profileCurrency) {
    throw Object.assign(
      new Error(`Валюта PO должна совпадать с утвержденным профилем исполнения: ${profileCurrency}`),
      { statusCode: 409 }
    )
  }
  if (requestedIncoterms && profileIncoterms && requestedIncoterms !== profileIncoterms) {
    throw Object.assign(
      new Error(`Incoterms PO должны совпадать с утвержденным профилем исполнения: ${profileIncoterms}`),
      { statusCode: 409 }
    )
  }
  if (requestedIncotermsPlace && profileIncotermsPlace && requestedIncotermsPlace !== profileIncotermsPlace) {
    throw Object.assign(
      new Error(`Пункт Incoterms PO должен совпадать с утвержденным профилем исполнения: ${profile.incoterms_place}`),
      { statusCode: 409 }
    )
  }
  if (requestedRouteType && profileRouteType && requestedRouteType !== profileRouteType) {
    throw Object.assign(
      new Error(`Тип маршрута PO должен совпадать с утвержденным профилем исполнения: ${profile.route_type}`),
      { statusCode: 409 }
    )
  }
}

const loadSelectionExecutionDefaults = async (conn, selectionId, supplierId, shipmentGroupId = null) => {
  const [rows] = await conn.execute(
    `SELECT route_type, incoterms, incoterms_place, currency, lead_time_days
       FROM selection_lines
      WHERE selection_id = ?
        AND supplier_id = ?
        AND (? IS NULL OR shipment_group_id = ?)`,
    [selectionId, supplierId, shipmentGroupId, shipmentGroupId]
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

const loadPurchaseOrderDocumentContext = async (conn, poId) => {
  const [[po]] = await conn.execute(
    `SELECT po.*,
            ps.name AS supplier_name,
            ps.country AS supplier_country,
            ps.vat_number AS supplier_vat_number,
            ps.website AS supplier_website,
            ps.public_code AS supplier_public_code,
            s.rfq_id
       FROM supplier_purchase_orders po
       JOIN part_suppliers ps ON ps.id = po.supplier_id
       JOIN selections s ON s.id = po.selection_id
      WHERE po.id = ?`,
    [poId]
  )
  if (!po) return null

  const [lines] = await conn.execute(
    `SELECT pol.*,
            po.selection_id,
            rl.supplier_part_id,
            sp.supplier_part_number,
            cri.line_number,
            cri.client_part_number,
            cri.client_description,
            op.part_number AS original_cat_number
       FROM supplier_purchase_order_lines pol
       JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
       LEFT JOIN rfq_response_lines rl ON rl.id = pol.rfq_response_line_id
       LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
       LEFT JOIN selection_lines sl ON sl.selection_id = po.selection_id AND sl.rfq_response_line_id = rl.id
       LEFT JOIN rfq_items ri ON ri.id = sl.rfq_item_id
       LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
       LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
      WHERE pol.supplier_purchase_order_id = ?
      ORDER BY pol.id ASC`,
    [poId]
  )

  const [[contract]] = await conn.execute(
    `SELECT cc.company_legal_snapshot_json, cc.contract_number, cc.contract_date
       FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
      WHERE sq.selection_id = ?
        AND cc.status IN ('signed', 'in_execution', 'completed', 'closed_with_issues')
      ORDER BY cc.contract_date DESC, cc.id DESC
      LIMIT 1`,
    [po.selection_id]
  )

  return {
    po,
    lines,
    legalProfile:
      parseSnapshot(contract?.company_legal_snapshot_json) ||
      (await fetchCurrentCompanyLegalProfile(conn)),
  }
}

const renderPurchaseOrderPreviewHtml = ({ po, lines, legalProfile }) => {
  const statusMap = {
    draft: 'Черновик',
    sent: 'Отправлен поставщику',
    confirmed: 'Подтвержден поставщиком',
    cancelled: 'Отменен',
  }
  const buyerName = legalProfile?.full_name_ru || legalProfile?.short_name_ru || '—'
  const buyerSigner = [legalProfile?.signer?.title_ru, legalProfile?.signer?.full_name].filter(Boolean).join(' ') || '—'
  const incotermsText = [po.incoterms, po.incoterms_place].filter(Boolean).join(' ') || '—'
  const rowsHtml = lines
    .map(
      (line) => `
        <tr>
          <td>${escapeHtml(line.line_number || '—')}</td>
          <td>${escapeHtml(line.supplier_part_number || line.client_part_number || line.original_cat_number || `#${line.id}`)}</td>
          <td>${escapeHtml(line.client_description || line.note || '—')}</td>
          <td class="num">${escapeHtml(line.qty)}</td>
          <td class="num">${escapeHtml(formatMoneyDocx(line.price, line.currency || po.currency))}</td>
          <td class="num">${escapeHtml(formatMoneyDocx((Number(line.qty || 0) * Number(line.price || 0)), line.currency || po.currency))}</td>
        </tr>`
    )
    .join('')

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>Заказ поставщику ${escapeHtml(po.supplier_reference || po.id)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px auto; max-width: 980px; color: #1f2937; line-height: 1.45; }
      .head { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom: 24px; }
      h1 { margin: 0 0 8px; color:#163A70; font-size: 28px; }
      h2 { color:#163A70; font-size: 20px; margin: 28px 0 12px; }
      .sub { color:#4b5563; font-size: 18px; }
      .grid { display:grid; grid-template-columns: 240px 1fr; gap: 8px 16px; margin: 18px 0; }
      .label { font-weight: 700; }
      .card { border:1px solid #dbe3f0; border-radius: 14px; padding: 20px 24px; margin-bottom: 18px; }
      table { width:100%; border-collapse: collapse; margin-top: 12px; }
      th, td { border:1px solid #dbe3f0; padding:10px 12px; vertical-align: top; }
      th { background:#f5f8ff; text-align:left; color:#163A70; }
      td.num { text-align:right; white-space: nowrap; }
      .sign { display:grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 28px; }
      .line { margin-top: 56px; border-top:1px solid #9ca3af; padding-top: 8px; color:#4b5563; }
      @media print { body { margin: 0; } .card { break-inside: avoid; } }
    </style>
  </head>
  <body>
    <div class="head">
      <div>
        <h1>Заказ поставщику</h1>
        <div class="sub">№ ${escapeHtml(po.supplier_reference || po.id)} от ${escapeHtml(formatDateRuDocx(po.created_at))}</div>
      </div>
      <div style="color:#163A70;font-weight:700;">ГОК</div>
    </div>

    <div class="card">
      <div class="grid">
        <div class="label">Поставщик</div><div>${escapeHtml(po.supplier_name)}</div>
        <div class="label">Публичный код</div><div>${escapeHtml(po.supplier_public_code || '—')}</div>
        <div class="label">Страна</div><div>${escapeHtml(po.supplier_country || '—')}</div>
        <div class="label">Валюта</div><div>${escapeHtml(po.currency || '—')}</div>
        <div class="label">Incoterms</div><div>${escapeHtml(incotermsText)}</div>
        <div class="label">Способ доставки</div><div>${escapeHtml(po.route_type || '—')}</div>
        <div class="label">Статус</div><div>${escapeHtml(statusMap[String(po.status || '').trim().toLowerCase()] || po.status || '—')}</div>
      </div>
    </div>

    <div class="card">
      <div class="grid">
        <div class="label">Покупатель</div><div>${escapeHtml(buyerName)}</div>
        <div class="label">ИНН / КПП</div><div>${escapeHtml([legalProfile?.inn, legalProfile?.kpp].filter(Boolean).join(' / ') || '—')}</div>
        <div class="label">Юр. адрес</div><div>${escapeHtml(legalProfile?.legal_address || '—')}</div>
        <div class="label">Банк</div><div>${escapeHtml(legalProfile?.bank?.bank_name || '—')}</div>
        <div class="label">Р/с</div><div>${escapeHtml(legalProfile?.bank?.account_number || '—')}</div>
        <div class="label">БИК</div><div>${escapeHtml(legalProfile?.bank?.bic || '—')}</div>
      </div>
    </div>

    <h2>Условия заказа</h2>
    <p>Настоящий заказ оформлен для поставщика ${escapeHtml(po.supplier_name)}. Условия поставки: ${escapeHtml(incotermsText)}. Способ доставки: ${escapeHtml(po.route_type || '—')}.</p>
    <p>Валюта заказа: ${escapeHtml(po.currency || '—')}. Публичный код поставщика: ${escapeHtml(po.supplier_public_code || '—')}.</p>

    <h2>Позиции заказа</h2>
    <table>
      <thead>
        <tr>
          <th>Строка</th>
          <th>Номер</th>
          <th>Описание</th>
          <th>Кол-во</th>
          <th>Цена</th>
          <th>Сумма</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <h2>Подтверждение сторон</h2>
    <div class="sign">
      <div>
        <div><strong>Покупатель:</strong> ${escapeHtml(buyerName)}</div>
        <div><strong>Подписант:</strong> ${escapeHtml(buyerSigner)}</div>
        <div class="line">Подпись / печать</div>
      </div>
      <div>
        <div><strong>Поставщик:</strong> ${escapeHtml(po.supplier_name)}</div>
        <div><strong>Референс поставщика:</strong> ${escapeHtml(po.supplier_reference || '—')}</div>
        <div class="line">Подпись / печать</div>
      </div>
    </div>
  </body>
</html>`
}

const generatePurchaseOrderDocxAndPersist = async (conn, supplierPurchaseOrderId) => {
  const context = await loadPurchaseOrderDocumentContext(conn, supplierPurchaseOrderId)
  if (!context) {
    throw Object.assign(new Error('Заказ поставщику не найден'), { statusCode: 404 })
  }
  const buffer = await buildPurchaseOrderDocx(context)
  const fileName = `supplier-po-${supplierPurchaseOrderId}-${Date.now()}.docx`
  const publicUrl = await uploadDocxBuffer({
    folder: 'purchase-orders',
    fileName,
    buffer,
  })
  await conn.execute(
    `UPDATE supplier_purchase_orders
        SET file_url = ?,
            updated_at = NOW()
      WHERE id = ?`,
    [publicUrl, supplierPurchaseOrderId]
  )
  return { publicUrl, context }
}

const buildPurchaseOrderPdf = async ({ po, lines, legalProfile }) =>
  createPdfBuffer(async (doc, ctx) => {
    const statusMap = {
      draft: 'Черновик',
      sent: 'Отправлен поставщику',
      confirmed: 'Подтвержден поставщиком',
      cancelled: 'Отменен',
    }
    const buyerName = legalProfile?.full_name_ru || legalProfile?.short_name_ru || '—'
    const buyerSigner = [legalProfile?.signer?.title_ru, legalProfile?.signer?.full_name].filter(Boolean).join(' ') || '—'

    beginDocument(doc, {
      title: 'Заказ поставщику',
      subtitle: `№ ${po.supplier_reference || po.id} от ${formatDateRu(po.created_at)}`,
      logoPath: ctx.logoPath,
      regularFont: ctx.regularFont,
      boldFont: ctx.boldFont,
    })

    drawFieldGrid(
      doc,
      [
        { label: 'Поставщик', value: po.supplier_name },
        { label: 'Публичный код', value: po.supplier_public_code },
        { label: 'Страна', value: po.supplier_country },
        { label: 'Валюта', value: po.currency },
        { label: 'Incoterms', value: [po.incoterms, po.incoterms_place].filter(Boolean).join(' ') || '—' },
        { label: 'Способ доставки', value: po.route_type || '—' },
        { label: 'Статус', value: statusMap[String(po.status || '').trim().toLowerCase()] || po.status || '—' },
      ],
      ctx
    )

    if (legalProfile) {
      drawFieldGrid(
        doc,
        [
          { label: 'Покупатель', value: legalProfile.short_name_ru || legalProfile.full_name_ru },
          { label: 'ИНН / КПП', value: [legalProfile.inn, legalProfile.kpp].filter(Boolean).join(' / ') || '—' },
          { label: 'Юр. адрес', value: legalProfile.legal_address },
          { label: 'Банк', value: legalProfile.bank?.bank_name },
          { label: 'Р/с', value: legalProfile.bank?.account_number },
          { label: 'БИК', value: legalProfile.bank?.bic },
        ],
        ctx
      )
    }

    doc.moveDown(0.3)
    doc
      .font(ctx.boldFont ? 'bold' : 'Helvetica-Bold')
      .fontSize(12)
      .fillColor('#163A70')
      .text('Условия заказа')
    doc.moveDown(0.5)
    doc
      .font(ctx.regularFont ? 'regular' : 'Helvetica')
      .fontSize(10)
      .fillColor('#222')
      .text(
        `Настоящий заказ оформлен для поставщика ${po.supplier_name}. Условия поставки: ${[po.incoterms, po.incoterms_place].filter(Boolean).join(' ') || '—'}. Способ доставки: ${po.route_type || '—'}.`
      )
    doc.moveDown(0.3)
    doc.text(
      `Валюта заказа: ${po.currency || '—'}. Публичный код поставщика: ${po.supplier_public_code || '—'}.`
    )

    doc.font(ctx.boldFont ? 'bold' : 'Helvetica-Bold').fontSize(12).fillColor('#163A70').text('Позиции заказа')
    doc.moveDown(0.5)
    drawSimpleTable(
      doc,
      [
        { title: 'Строка', key: 'line_number', width: 42 },
        { title: 'Номер', key: 'part_number', width: 120 },
        { title: 'Описание', key: 'description', width: 170 },
        { title: 'Кол-во', key: 'qty', width: 56 },
        { title: 'Цена', key: 'price', width: 78 },
        { title: 'Сумма', key: 'total', width: 78 },
      ],
      lines.map((line) => ({
        line_number: line.line_number || '—',
        part_number: line.supplier_part_number || line.client_part_number || line.original_cat_number || `#${line.id}`,
        description: line.client_description || line.note || '—',
        qty: line.qty,
        price: formatMoney(line.price, line.currency || po.currency),
        total: formatMoney((Number(line.qty || 0) * Number(line.price || 0)), line.currency || po.currency),
      })),
      ctx
    )

    doc.moveDown(0.8)
    doc
      .font(ctx.boldFont ? 'bold' : 'Helvetica-Bold')
      .fontSize(12)
      .fillColor('#163A70')
      .text('Подтверждение сторон')
    doc.moveDown(0.6)
    drawFieldGrid(
      doc,
      [
        { label: 'Покупатель', value: buyerName },
        { label: 'Подписант покупателя', value: buyerSigner },
        { label: 'Поставщик', value: po.supplier_name },
        { label: 'Референс поставщика', value: po.supplier_reference || '—' },
      ],
      ctx
    )
    doc.moveDown(0.6)
    doc
      .font(ctx.regularFont ? 'regular' : 'Helvetica')
      .fontSize(10)
      .fillColor('#222')
      .text('Покупатель: ________________________________', 48)
      .text('Поставщик: _________________________________', 320, doc.y - 12)
  })

const docxLabelValue = (label, value) =>
  new Paragraph({
    spacing: { after: 100 },
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: value ?? '—' }),
    ],
  })

const docxSectionTitle = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 220, after: 120 },
  })

const docxTableCell = (text, opts = {}) =>
  new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.header
      ? {
          fill: 'EAF2FF',
          type: ShadingType.CLEAR,
          color: 'auto',
        }
      : undefined,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
    },
    children: [
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({
            text: text == null ? '—' : String(text),
            bold: Boolean(opts.header),
          }),
        ],
      }),
    ],
  })

const buildPurchaseOrderDocx = async ({ po, lines, legalProfile }) => {
  const statusMap = {
    draft: 'Черновик',
    sent: 'Отправлен поставщику',
    confirmed: 'Подтвержден поставщиком',
    cancelled: 'Отменен',
  }
  const buyerName = legalProfile?.full_name_ru || legalProfile?.short_name_ru || '—'
  const buyerSigner = [legalProfile?.signer?.title_ru, legalProfile?.signer?.full_name].filter(Boolean).join(' ') || '—'

  return createDocxBuffer([
    {
      properties: {},
      children: [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 220 },
          children: [new TextRun({ text: 'GOK', bold: true, size: 34, color: '1E4ED8' })],
        }),
        new Paragraph({
          text: 'ЗАКАЗ ПОСТАВЩИКУ',
          heading: HeadingLevel.TITLE,
          spacing: { after: 160 },
        }),
        new Paragraph({
          text: `№ ${po.supplier_reference || po.id} от ${formatDateRuDocx(po.created_at)}`,
          spacing: { after: 240 },
        }),
        docxLabelValue('Поставщик', po.supplier_name),
        docxLabelValue('Публичный код', po.supplier_public_code || '—'),
        docxLabelValue('Страна', po.supplier_country || '—'),
        docxLabelValue('Валюта', po.currency || '—'),
        docxLabelValue('Incoterms', [po.incoterms, po.incoterms_place].filter(Boolean).join(' ') || '—'),
        docxLabelValue('Способ доставки', po.route_type || '—'),
        docxLabelValue('Статус', statusMap[String(po.status || '').trim().toLowerCase()] || po.status || '—'),

        docxSectionTitle('Реквизиты покупателя'),
        docxLabelValue('Покупатель', buyerName),
        docxLabelValue('ИНН / КПП', [legalProfile?.inn, legalProfile?.kpp].filter(Boolean).join(' / ') || '—'),
        docxLabelValue('Юр. адрес', legalProfile?.legal_address || '—'),
        docxLabelValue('Банк', legalProfile?.bank?.bank_name || '—'),
        docxLabelValue('Р/с', legalProfile?.bank?.account_number || '—'),
        docxLabelValue('БИК', legalProfile?.bank?.bic || '—'),

        docxSectionTitle('Условия заказа'),
        new Paragraph({
          spacing: { after: 100 },
          text: `Настоящий заказ оформлен для поставщика ${po.supplier_name}. Условия поставки: ${[po.incoterms, po.incoterms_place].filter(Boolean).join(' ') || '—'}. Способ доставки: ${po.route_type || '—'}.`,
        }),
        new Paragraph({
          spacing: { after: 160 },
          text: `Валюта заказа: ${po.currency || '—'}. Публичный код поставщика: ${po.supplier_public_code || '—'}.`,
        }),

        docxSectionTitle('Позиции заказа'),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              children: [
                docxTableCell('Строка', { header: true, width: 10 }),
                docxTableCell('Номер', { header: true, width: 24 }),
                docxTableCell('Описание', { header: true, width: 31 }),
                docxTableCell('Кол-во', { header: true, width: 10 }),
                docxTableCell('Цена', { header: true, width: 12 }),
                docxTableCell('Сумма', { header: true, width: 13 }),
              ],
            }),
            ...lines.map(
              (line) =>
                new TableRow({
                  children: [
                    docxTableCell(line.line_number || '—', { width: 10 }),
                    docxTableCell(line.supplier_part_number || line.client_part_number || line.original_cat_number || `#${line.id}`, {
                      width: 24,
                    }),
                    docxTableCell(line.client_description || line.note || '—', { width: 31 }),
                    docxTableCell(line.qty, { width: 10 }),
                    docxTableCell(formatMoneyDocx(line.price, line.currency || po.currency), { width: 12 }),
                    docxTableCell(formatMoneyDocx(Number(line.qty || 0) * Number(line.price || 0), line.currency || po.currency), {
                      width: 13,
                    }),
                  ],
                })
            ),
          ],
        }),

        docxSectionTitle('Подтверждение сторон'),
        docxLabelValue('Покупатель', buyerName),
        docxLabelValue('Подписант покупателя', buyerSigner),
        docxLabelValue('Поставщик', po.supplier_name),
        docxLabelValue('Референс поставщика', po.supplier_reference || '—'),
        new Paragraph({ spacing: { before: 280, after: 120 }, text: 'Покупатель: ________________________________' }),
        new Paragraph({ spacing: { after: 120 }, text: 'Поставщик: __________________________________' }),
      ],
    },
  ])
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
      `SELECT po.*,
              ps.name AS supplier_name,
              ps.public_code AS supplier_public_code,
              s.rfq_id,
              sg.name AS shipment_group_name,
              sgr.route_name_snapshot AS shipment_group_route_name
         FROM supplier_purchase_orders po
         JOIN part_suppliers ps ON ps.id = po.supplier_id
         JOIN selections s ON s.id = po.selection_id
         LEFT JOIN rfq_shipment_groups sg ON sg.id = po.shipment_group_id
         LEFT JOIN rfq_shipment_group_routes sgr ON sgr.id = po.shipment_group_route_id
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
    const shipmentGroupId = toId(req.body.shipment_group_id)
    const autofill = req.body.autofill_from_selection !== false
    if (!supplierId || !selectionId) {
      return res.status(400).json({ message: 'Нужно выбрать поставщика и выбор' })
    }

    const approvedContext = await loadApprovedCommercialContext(conn, selectionId)
    if (!approvedContext) {
      return res.status(400).json({ message: 'PO можно создавать только после контракта со статусом signed или in_execution' })
    }

    const approvedSelectionLines = await loadApprovedSelectionLines(conn, selectionId, supplierId, approvedContext.sales_quote_revision_id, {
      shipmentGroupId,
    })
    const singleExecutionProfile = ensureSingleExecutionProfile(approvedSelectionLines)
    ensureRequestedExecutionFieldsMatchProfile(req.body, singleExecutionProfile)

    const executionDefaults = await loadSelectionExecutionDefaults(conn, selectionId, supplierId, shipmentGroupId)

    await conn.beginTransaction()
    const [result] = await conn.execute(
      `INSERT INTO supplier_purchase_orders
        (supplier_id, selection_id, shipment_group_id, shipment_group_route_id, status, supplier_reference, currency, incoterms, incoterms_place, route_type)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        supplierId,
        selectionId,
        toId(singleExecutionProfile.shipment_group_id),
        toId(singleExecutionProfile.shipment_group_route_id),
        nz(req.body.status) || 'draft',
        nz(req.body.supplier_reference),
        nz(req.body.currency) || executionDefaults.currency || nz(singleExecutionProfile.currency),
        nz(req.body.incoterms) || executionDefaults.incoterms || nz(singleExecutionProfile.incoterms),
        nz(req.body.incoterms_place) || executionDefaults.incoterms_place || nz(singleExecutionProfile.incoterms_place),
        executionDefaults.route_type || nz(singleExecutionProfile.route_type),
      ]
    )
    const poId = result.insertId

    if (autofill) {
      let insertedCount = 0
      for (const line of approvedSelectionLines) {
        const factor = Number(line.approved_factor || 0)
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
    let documentWarning = null
    try {
      await generatePurchaseOrderDocxAndPersist(db, poId)
    } catch (documentError) {
      console.error('Auto-generate purchase order DOCX error:', documentError)
      documentWarning = 'Заказ создан, но DOCX не удалось сформировать автоматически'
    }
    const [[created]] = await db.execute('SELECT * FROM supplier_purchase_orders WHERE id = ?', [poId])
    res.status(201).json(documentWarning ? { ...created, document_warning: documentWarning } : created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /purchase-orders error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.post('/:id/lines', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const supplierPurchaseOrderId = toId(req.params.id)
    if (!supplierPurchaseOrderId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const rfqResponseLineId = toId(req.body.rfq_response_line_id)
    if (!rfqResponseLineId) {
      return res.status(400).json({ message: 'Нужно выбрать строку ответа поставщика' })
    }

    const [[po]] = await conn.execute(
      `SELECT *
         FROM supplier_purchase_orders
        WHERE id = ?`,
      [supplierPurchaseOrderId]
    )
    if (!po) return res.status(404).json({ message: 'PO не найден' })

    const approvedContext = await loadApprovedCommercialContext(conn, po.selection_id)
    if (!approvedContext) {
      return res.status(409).json({ message: 'Для этого PO нет действующего финального коммерческого основания' })
    }

    if (Number(approvedContext.id) && Number(po.selection_id) !== Number(approvedContext.contract_selection_id)) {
      return res.status(409).json({ message: 'PO больше не соответствует финальному контракту по выбору закупки' })
    }

    const approvedSelectionLines = await loadApprovedSelectionLines(conn, po.selection_id, po.supplier_id, approvedContext.sales_quote_revision_id, {
      shipmentGroupId: toId(po.shipment_group_id),
    })
    const singleExecutionProfile = ensureSingleExecutionProfile(approvedSelectionLines)
    const poProfileKey = buildPoExecutionProfileKey(po)
    if (poProfileKey !== singleExecutionProfile.execution_profile_key) {
      return res.status(409).json({
        message:
          'Этот PO создан с другим профилем исполнения. Создайте отдельный PO для другой консолидационной группы или маршрута.',
      })
    }

    const matchingLines = approvedSelectionLines.filter(
      (line) =>
        Number(line.rfq_response_line_id) === Number(rfqResponseLineId) &&
        line.execution_profile_key === poProfileKey
    )

    if (!matchingLines.length) {
      return res.status(409).json({
        message:
          'Эта строка не входит в утвержденный активный состав данного PO. Можно добавлять только строки текущего поставщика из подписанной коммерческой ревизии.',
      })
    }

    const [result] = await conn.execute(
      `INSERT INTO supplier_purchase_order_lines
        (supplier_purchase_order_id, rfq_response_line_id, qty, price, currency, lead_time_days, note)
       VALUES (?,?,?,?,?,?,?)`,
      [
        supplierPurchaseOrderId,
        rfqResponseLineId,
        numOrNull(req.body.qty),
        numOrNull(req.body.price),
        nz(req.body.currency) || nz(po.currency) || nz(matchingLines[0]?.currency),
        toId(req.body.lead_time_days) ?? numOrNull(matchingLines[0]?.lead_time_days),
        nz(req.body.note),
      ]
    )

    const [[created]] = await conn.execute('SELECT * FROM supplier_purchase_order_lines WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /purchase-orders/:id/lines error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const supplierPurchaseOrderId = toId(req.params.id)
    if (!supplierPurchaseOrderId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[existing]] = await db.execute(`SELECT * FROM supplier_purchase_orders WHERE id = ?`, [supplierPurchaseOrderId])
    if (!existing) return res.status(404).json({ message: 'PO не найден' })

    const nextStatus = nz(req.body.status) || existing.status
    const allowedStatuses = new Set(['draft', 'sent', 'confirmed', 'cancelled'])
    if (!allowedStatuses.has(String(nextStatus).trim().toLowerCase())) {
      return res.status(400).json({ message: 'Некорректный статус PO' })
    }

    await db.execute(
      `UPDATE supplier_purchase_orders
          SET status = ?,
              supplier_reference = ?,
              currency = ?,
              incoterms = ?,
              incoterms_place = ?,
              route_type = ?,
              file_url = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [
        nextStatus,
        nz(req.body.supplier_reference) || existing.supplier_reference,
        nz(req.body.currency) || existing.currency,
        nz(req.body.incoterms) || existing.incoterms,
        nz(req.body.incoterms_place) || existing.incoterms_place,
        nz(req.body.route_type) || existing.route_type,
        nz(req.body.file_url) || existing.file_url,
        supplierPurchaseOrderId,
      ]
    )

    const [[updated]] = await db.execute('SELECT * FROM supplier_purchase_orders WHERE id = ?', [supplierPurchaseOrderId])
    res.json(updated)
  } catch (e) {
    console.error('PATCH /purchase-orders/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/generate', async (req, res) => {
  try {
    const supplierPurchaseOrderId = toId(req.params.id)
    if (!supplierPurchaseOrderId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const { publicUrl } = await generatePurchaseOrderDocxAndPersist(db, supplierPurchaseOrderId)

    res.json({ url: publicUrl, file_url: publicUrl, format: 'docx' })
  } catch (e) {
    console.error('POST /purchase-orders/:id/generate error:', e)
    res.status(500).json({ message: e?.message || 'Не удалось сформировать DOCX заказа поставщику' })
  }
})

router.get('/:id/preview', async (req, res) => {
  try {
    const supplierPurchaseOrderId = toId(req.params.id)
    if (!supplierPurchaseOrderId) return res.status(400).send('Некорректный идентификатор')
    const context = await loadPurchaseOrderDocumentContext(db, supplierPurchaseOrderId)
    if (!context) return res.status(404).send('Заказ поставщику не найден')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(renderPurchaseOrderPreviewHtml(context))
  } catch (e) {
    console.error('GET /purchase-orders/:id/preview error:', e)
    res.status(500).send('Не удалось открыть предпросмотр заказа поставщику')
  }
})

module.exports = router
