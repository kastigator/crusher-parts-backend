const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const {
  updateRequestStatus,
  fetchRequestIdBySalesQuoteId,
} = require('../utils/clientRequestStatus')
const {
  fetchCurrentCompanyLegalProfile,
  hasTableColumn,
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
  formatDateRuLong,
} = require('../utils/documentPdf')
const {
  createDocxBuffer,
  uploadDocxBuffer,
  formatMoney: formatMoneyDocx,
  formatDateRu: formatDateRuDocx,
  formatDateRuLong: formatDateRuLongDocx,
} = require('../utils/documentDocx')
const {
  getClientFacingPartNumber,
  getClientFacingDescription,
} = require('../utils/partPresentation')
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
const normalizeCurrency = (value) => {
  const text = nz(value)
  return text ? text.toUpperCase() : null
}
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const CONTRACT_STATUSES = new Set([
  'draft',
  'sent_to_client',
  'signed',
  'in_execution',
  'completed',
  'closed_with_issues',
])

const CONTRACT_CREATE_STATUSES = new Set(['draft'])

const CONTRACT_STATUS_TRANSITIONS = {
  draft: new Set(['sent_to_client', 'signed']),
  sent_to_client: new Set(['draft', 'signed']),
  signed: new Set(['in_execution']),
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

const ensureCurrencyMatchesLockedValue = (requestedCurrency, lockedCurrency, entityLabel) => {
  const requested = normalizeCurrency(requestedCurrency)
  const locked = normalizeCurrency(lockedCurrency)
  if (requested && locked && requested !== locked) {
    throw Object.assign(
      new Error(`Валюта ${entityLabel} уже зафиксирована как ${locked}. Смена валюты без пересчёта недоступна.`),
      { statusCode: 409 }
    )
  }
  return locked || requested || null
}

const ensureSalesQuoteCanCreateContract = async (conn, salesQuoteId, requestedRevisionId = null) => {
  const [[quote]] = await conn.execute(
    `SELECT sq.id,
            sq.status,
            sq.currency,
            sq.company_legal_profile_id,
            sq.company_legal_snapshot_json,
            (
              SELECT r2.id
                FROM sales_quote_revisions r2
               WHERE r2.sales_quote_id = sq.id
               ORDER BY r2.rev_number DESC, r2.id DESC
               LIMIT 1
            ) AS latest_revision_id
       FROM sales_quotes sq
      WHERE sq.id = ?`,
    [salesQuoteId]
  )
  if (!quote) {
    throw Object.assign(new Error('КП не найдено'), { statusCode: 404 })
  }
  const quoteStatus = String(quote.status || '').trim().toLowerCase()
  if (quoteStatus !== 'client_approved' && quoteStatus !== 'contract_signed') {
    throw Object.assign(
      new Error('Контракт можно создавать только из коммерческого предложения со статусом «Согласовано клиентом»'),
      { statusCode: 409 }
    )
  }
  const latestRevisionId = Number(quote.latest_revision_id || 0) || null
  if (!latestRevisionId) {
    throw Object.assign(new Error('У коммерческого предложения нет ревизии, пригодной для контракта'), {
      statusCode: 409,
    })
  }
  if (requestedRevisionId && Number(requestedRevisionId) !== latestRevisionId) {
    throw Object.assign(
      new Error('Контракт должен фиксировать последнюю согласованную ревизию коммерческого предложения'),
      { statusCode: 409 }
    )
  }
  return { quote, latestRevisionId }
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
        new Error('При создании контракта статус определяется автоматически и должен быть «Черновик»'),
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

const syncSalesQuoteStatusForContract = async (conn, salesQuoteId, contractStatus) => {
  if (!salesQuoteId) return
  const normalized = normalizeContractStatus(contractStatus)
  if (!normalized) return
  if (['signed', 'in_execution', 'completed', 'closed_with_issues'].includes(normalized)) {
    await conn.execute(
      `UPDATE sales_quotes
          SET status = 'contract_signed',
              updated_at = NOW()
        WHERE id = ?`,
      [salesQuoteId]
    )
  }
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

const loadContractDocumentContext = async (conn, contractId) => {
  const includeRevision = await contractsSupportQuoteRevision(conn)
  const [[contract]] = await conn.execute(
    `SELECT cc.*,
            c.company_name AS client_name,
            NULL AS client_address,
            c.tax_id AS client_inn,
            c.registration_number AS client_registration_number,
            c.contact_person AS client_contact_person,
            c.email AS client_email,
            c.phone AS client_phone,
            sq.selection_id,
            sq.currency AS quote_currency,
            ${includeRevision ? 'cc.sales_quote_revision_id,' : 'NULL AS sales_quote_revision_id,'}
            ${includeRevision ? 'sqr.rev_number AS sales_quote_revision_number,' : 'NULL AS sales_quote_revision_number,'}
            cr.client_request_id
       FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
       JOIN client_requests req ON req.id = cr.client_request_id
       JOIN clients c ON c.id = req.client_id
       ${includeRevision ? 'LEFT JOIN sales_quote_revisions sqr ON sqr.id = cc.sales_quote_revision_id' : ''}
      WHERE cc.id = ?`,
    [contractId]
  )
  if (!contract) return null

  const revisionId = Number(contract.sales_quote_revision_id || 0) || null
  const lineStatusSupported = await hasTableColumn(conn, 'sales_quote_lines', 'line_status')
  const [lines] = await conn.execute(
    `SELECT ql.id,
            ql.qty,
            COALESCE(ql.sell_price, ql.cost, 0) AS price,
            ql.currency,
            ql.note,
            ${lineStatusSupported ? "COALESCE(ql.line_status, 'active') AS line_status," : "'active' AS line_status,"}
            cri.line_number,
            cri.client_part_number,
            cri.client_description,
            op.part_number AS original_cat_number,
            ql.client_display_part_number_snapshot AS client_display_part_number,
            ql.client_display_description_snapshot AS client_display_description
       FROM sales_quote_lines ql
       JOIN client_request_revision_items cri ON cri.id = ql.client_request_revision_item_id
       LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
      WHERE ql.sales_quote_revision_id = ?
      ORDER BY cri.line_number ASC, ql.id ASC`,
    [revisionId]
  )

  return {
    contract,
    lines: lines.filter((line) => String(line.line_status || 'active').toLowerCase() === 'active'),
    legalProfile:
      parseSnapshot(contract.company_legal_snapshot_json) ||
      (await fetchCurrentCompanyLegalProfile(conn, contract.contract_date)),
  }
}

const renderContractPreviewHtml = ({ contract, lines, legalProfile }) => {
  const statusMap = {
    draft: 'Черновик',
    sent_to_client: 'Отправлен клиенту',
    signed: 'Подписан',
    in_execution: 'В исполнении',
    completed: 'Исполнен',
    closed_with_issues: 'Закрыт с замечаниями',
  }
  const sellerName = legalProfile?.full_name_ru || legalProfile?.short_name_ru || '—'
  const sellerSigner = [legalProfile?.signer?.title_ru, legalProfile?.signer?.full_name].filter(Boolean).join(' ') || '—'
  const clientContact = contract.client_contact_person || '—'
  const clientContacts = [contract.client_phone, contract.client_email].filter(Boolean).join(' / ') || '—'
  const incotermsText = [contract.incoterms || '—', contract.incoterms_place || ''].filter(Boolean).join(' ')
  const rowsHtml = lines
    .map(
      (line) => `
        <tr>
          <td>${escapeHtml(line.line_number)}</td>
          <td>${escapeHtml(getClientFacingPartNumber(line, `#${line.id}`))}</td>
          <td>${escapeHtml(getClientFacingDescription(line))}</td>
          <td class="num">${escapeHtml(line.qty)}</td>
          <td class="num">${escapeHtml(formatMoneyDocx(line.price, line.currency))}</td>
          <td class="num">${escapeHtml(formatMoneyDocx((Number(line.qty || 0) * Number(line.price || 0)), line.currency))}</td>
        </tr>`
    )
    .join('')

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>Контракт ${escapeHtml(contract.contract_number)}</title>
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
        <h1>Договор поставки</h1>
        <div class="sub">№ ${escapeHtml(contract.contract_number)} от ${escapeHtml(formatDateRuDocx(contract.contract_date))}</div>
      </div>
      <div style="color:#163A70;font-weight:700;">ГОК</div>
    </div>

    <div class="card">
      <div class="grid">
        <div class="label">Клиент</div><div>${escapeHtml(contract.client_name)}</div>
        <div class="label">ИНН клиента</div><div>${escapeHtml(contract.client_inn || '—')}</div>
        <div class="label">Рег. номер клиента</div><div>${escapeHtml(contract.client_registration_number || '—')}</div>
        <div class="label">Контакт клиента</div><div>${escapeHtml(clientContact)}</div>
        <div class="label">Телефон / e-mail</div><div>${escapeHtml(clientContacts)}</div>
        <div class="label">Ревизия КП</div><div>${escapeHtml(contract.sales_quote_revision_number ? `№${contract.sales_quote_revision_number}` : '—')}</div>
        <div class="label">Сумма</div><div>${escapeHtml(formatMoneyDocx(contract.amount, contract.currency || contract.quote_currency))}</div>
        <div class="label">Статус</div><div>${escapeHtml(statusMap[String(contract.status || '').trim().toLowerCase()] || contract.status || '—')}</div>
      </div>
    </div>

    <div class="card">
      <div class="grid">
        <div class="label">Поставщик</div><div>${escapeHtml(sellerName)}</div>
        <div class="label">ИНН / КПП</div><div>${escapeHtml([legalProfile?.inn, legalProfile?.kpp].filter(Boolean).join(' / ') || '—')}</div>
        <div class="label">Юр. адрес</div><div>${escapeHtml(legalProfile?.legal_address || '—')}</div>
        <div class="label">Банк</div><div>${escapeHtml(legalProfile?.bank?.bank_name || '—')}</div>
        <div class="label">Р/с</div><div>${escapeHtml(legalProfile?.bank?.account_number || '—')}</div>
        <div class="label">БИК</div><div>${escapeHtml(legalProfile?.bank?.bic || '—')}</div>
      </div>
    </div>

    <h2>Основные условия</h2>
    <p>Поставщик обязуется поставить продукцию по спецификации к договору, а Клиент обязуется принять и оплатить поставку. Датой договора считается ${escapeHtml(formatDateRuLongDocx(contract.contract_date))}.</p>
    <p>Условия поставки: ${escapeHtml(incotermsText)}. Расчеты производятся в валюте ${escapeHtml(contract.currency || contract.quote_currency || '—')}.</p>
    <p>Основание коммерческих условий: КП ${escapeHtml(contract.sales_quote_revision_number ? `ревизия №${contract.sales_quote_revision_number}` : 'без указанной ревизии')}. Контактное лицо клиента: ${escapeHtml(clientContact)}.</p>

    <h2>Спецификация</h2>
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

    <h2>Подписи сторон</h2>
    <div class="sign">
      <div>
        <div><strong>Поставщик:</strong> ${escapeHtml(sellerName)}</div>
        <div><strong>Подписант:</strong> ${escapeHtml(sellerSigner)}</div>
        <div class="line">Подпись / печать</div>
      </div>
      <div>
        <div><strong>Клиент:</strong> ${escapeHtml(contract.client_name)}</div>
        <div><strong>Контакт:</strong> ${escapeHtml(clientContact)}</div>
        <div class="line">Подпись / печать</div>
      </div>
    </div>
  </body>
</html>`
}

const generateContractDocxAndPersist = async (conn, contractId) => {
  const context = await loadContractDocumentContext(conn, contractId)
  if (!context) {
    throw Object.assign(new Error('Контракт не найден'), { statusCode: 404 })
  }
  const buffer = await buildContractDocx(context)
  const fileName = `client-contract-${contractId}-${Date.now()}.docx`
  const publicUrl = await uploadDocxBuffer({
    folder: 'contracts',
    fileName,
    buffer,
  })
  await conn.execute(
    `UPDATE client_contracts
        SET file_url = ?,
            updated_at = NOW()
      WHERE id = ?`,
    [publicUrl, contractId]
  )
  return { publicUrl, context }
}

const buildContractPdf = async ({ contract, lines, legalProfile }) =>
  createPdfBuffer(async (doc, ctx) => {
    const statusMap = {
      draft: 'Черновик',
      sent_to_client: 'Отправлен клиенту',
      signed: 'Подписан',
      in_execution: 'В исполнении',
      completed: 'Исполнен',
      closed_with_issues: 'Закрыт с замечаниями',
    }
    const sellerName = legalProfile?.full_name_ru || legalProfile?.short_name_ru || '—'
    const sellerSigner = [legalProfile?.signer?.title_ru, legalProfile?.signer?.full_name].filter(Boolean).join(' ') || '—'
    const clientContact = contract.client_contact_person || '—'
    const clientContacts = [contract.client_phone, contract.client_email].filter(Boolean).join(' / ') || '—'

    beginDocument(doc, {
      title: 'Договор поставки',
      subtitle: `№ ${contract.contract_number} от ${formatDateRu(contract.contract_date)}`,
      logoPath: ctx.logoPath,
      regularFont: ctx.regularFont,
      boldFont: ctx.boldFont,
    })

    drawFieldGrid(
      doc,
      [
        { label: 'Клиент', value: contract.client_name },
        { label: 'ИНН клиента', value: contract.client_inn },
        { label: 'Рег. номер клиента', value: contract.client_registration_number || '—' },
        { label: 'Контакт клиента', value: contract.client_contact_person || '—' },
        { label: 'Телефон / e-mail', value: clientContacts },
        { label: 'Ревизия КП', value: contract.sales_quote_revision_number ? `№${contract.sales_quote_revision_number}` : '—' },
        { label: 'Сумма', value: formatMoney(contract.amount, contract.currency || contract.quote_currency) },
        { label: 'Статус', value: statusMap[String(contract.status || '').trim().toLowerCase()] || contract.status || '—' },
      ],
      ctx
    )

    if (legalProfile) {
      drawFieldGrid(
        doc,
        [
          { label: 'Поставщик', value: legalProfile.short_name_ru || legalProfile.full_name_ru },
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
      .text('Основные условия')
    doc.moveDown(0.5)
    doc
      .font(ctx.regularFont ? 'regular' : 'Helvetica')
      .fontSize(10)
      .fillColor('#222')
      .text(
        `Поставщик обязуется поставить продукцию по спецификации к договору, а Клиент обязуется принять и оплатить поставку. Датой договора считается ${formatDateRuLong(contract.contract_date)}.`
      )
    doc.moveDown(0.3)
    doc.text(
      `Условия поставки: ${[contract.incoterms || '—', contract.incoterms_place || ''].filter(Boolean).join(' ')}. Расчеты производятся в валюте ${contract.currency || contract.quote_currency || '—'}.`
    )
    doc.moveDown(0.3)
    doc.text(
      `Основание коммерческих условий: КП ${contract.sales_quote_revision_number ? `ревизия №${contract.sales_quote_revision_number}` : 'без указанной ревизии'}. Контактное лицо клиента: ${clientContact}.`
    )

    doc.font(ctx.boldFont ? 'bold' : 'Helvetica-Bold').fontSize(12).fillColor('#163A70').text('Спецификация')
    doc.moveDown(0.5)
    drawSimpleTable(
      doc,
      [
        { title: 'Строка', key: 'line_number', width: 42 },
        { title: 'Номер', key: 'part_number', width: 120 },
        { title: 'Описание', key: 'description', width: 180 },
        { title: 'Кол-во', key: 'qty', width: 56 },
        { title: 'Цена', key: 'price', width: 95 },
        { title: 'Сумма', key: 'total', width: 95 },
      ],
      lines.map((line) => ({
        line_number: line.line_number,
        part_number: getClientFacingPartNumber(line, `#${line.id}`),
        description: getClientFacingDescription(line),
        qty: line.qty,
        price: formatMoney(line.price, line.currency),
        total: formatMoney((Number(line.qty || 0) * Number(line.price || 0)), line.currency),
      })),
      ctx
    )

    doc.moveDown(0.8)
    doc
      .font(ctx.boldFont ? 'bold' : 'Helvetica-Bold')
      .fontSize(12)
      .fillColor('#163A70')
      .text('Подписи сторон')
    doc.moveDown(0.6)
    drawFieldGrid(
      doc,
      [
        { label: 'Поставщик', value: sellerName },
        { label: 'Подписант поставщика', value: sellerSigner },
        { label: 'Клиент', value: contract.client_name },
        { label: 'Контакт клиента', value: clientContact },
      ],
      ctx
    )
    doc.moveDown(0.6)
    doc
      .font(ctx.regularFont ? 'regular' : 'Helvetica')
      .fontSize(10)
      .fillColor('#222')
      .text('Поставщик: ________________________________', 48)
      .text('Клиент: ____________________________________', 320, doc.y - 12)
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
    thematicBreak: false,
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

const buildContractDocx = async ({ contract, lines, legalProfile }) => {
  const statusMap = {
    draft: 'Черновик',
    sent_to_client: 'Отправлен клиенту',
    signed: 'Подписан',
    in_execution: 'В исполнении',
    completed: 'Исполнен',
    closed_with_issues: 'Закрыт с замечаниями',
  }

  const sellerName = legalProfile?.full_name_ru || legalProfile?.short_name_ru || '—'
  const sellerSigner = [legalProfile?.signer?.title_ru, legalProfile?.signer?.full_name].filter(Boolean).join(' ') || '—'
  const clientContact = contract.client_contact_person || '—'
  const clientContacts = [contract.client_phone, contract.client_email].filter(Boolean).join(' / ') || '—'
  const currency = contract.currency || contract.quote_currency

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
          text: 'ДОГОВОР ПОСТАВКИ',
          heading: HeadingLevel.TITLE,
          spacing: { after: 160 },
        }),
        new Paragraph({
          text: `№ ${contract.contract_number} от ${formatDateRuDocx(contract.contract_date)}`,
          spacing: { after: 240 },
        }),

        docxLabelValue('Клиент', contract.client_name),
        docxLabelValue('ИНН клиента', contract.client_inn),
        docxLabelValue('Рег. номер клиента', contract.client_registration_number || '—'),
        docxLabelValue('Контакт клиента', clientContact),
        docxLabelValue('Телефон / e-mail', clientContacts),
        docxLabelValue(
          'Ревизия КП',
          contract.sales_quote_revision_number ? `№${contract.sales_quote_revision_number}` : '—'
        ),
        docxLabelValue('Сумма', formatMoneyDocx(contract.amount, currency)),
        docxLabelValue('Статус', statusMap[String(contract.status || '').trim().toLowerCase()] || contract.status || '—'),

        docxSectionTitle('Реквизиты поставщика'),
        docxLabelValue('Поставщик', sellerName),
        docxLabelValue('ИНН / КПП', [legalProfile?.inn, legalProfile?.kpp].filter(Boolean).join(' / ') || '—'),
        docxLabelValue('Юр. адрес', legalProfile?.legal_address || '—'),
        docxLabelValue('Банк', legalProfile?.bank?.bank_name || '—'),
        docxLabelValue('Р/с', legalProfile?.bank?.account_number || '—'),
        docxLabelValue('БИК', legalProfile?.bank?.bic || '—'),

        docxSectionTitle('Основные условия'),
        new Paragraph({
          spacing: { after: 100 },
          text: `Поставщик обязуется поставить продукцию по спецификации к договору, а Клиент обязуется принять и оплатить поставку. Датой договора считается ${formatDateRuLongDocx(contract.contract_date)}.`,
        }),
        new Paragraph({
          spacing: { after: 100 },
          text: `Условия поставки: ${[contract.incoterms || '—', contract.incoterms_place || ''].filter(Boolean).join(' ')}. Расчеты производятся в валюте ${currency || '—'}.`,
        }),
        new Paragraph({
          spacing: { after: 160 },
          text: `Основание коммерческих условий: КП ${contract.sales_quote_revision_number ? `ревизия №${contract.sales_quote_revision_number}` : 'без указанной ревизии'}. Контактное лицо клиента: ${clientContact}.`,
        }),

        docxSectionTitle('Спецификация'),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              children: [
                docxTableCell('Строка', { header: true, width: 10 }),
                docxTableCell('Номер', { header: true, width: 20 }),
                docxTableCell('Описание', { header: true, width: 35 }),
                docxTableCell('Кол-во', { header: true, width: 10 }),
                docxTableCell('Цена', { header: true, width: 12 }),
                docxTableCell('Сумма', { header: true, width: 13 }),
              ],
            }),
            ...lines.map(
              (line) =>
                new TableRow({
                  children: [
                    docxTableCell(line.line_number, { width: 10 }),
                    docxTableCell(getClientFacingPartNumber(line, `#${line.id}`), { width: 20 }),
                    docxTableCell(getClientFacingDescription(line), { width: 35 }),
                    docxTableCell(line.qty, { width: 10 }),
                    docxTableCell(formatMoneyDocx(line.price, line.currency), { width: 12 }),
                    docxTableCell(formatMoneyDocx(Number(line.qty || 0) * Number(line.price || 0), line.currency), {
                      width: 13,
                    }),
                  ],
                })
            ),
          ],
        }),

        docxSectionTitle('Подписи сторон'),
        docxLabelValue('Поставщик', sellerName),
        docxLabelValue('Подписант поставщика', sellerSigner),
        docxLabelValue('Клиент', contract.client_name),
        docxLabelValue('Контакт клиента', clientContact),
        new Paragraph({ spacing: { before: 280, after: 120 }, text: 'Поставщик: ________________________________' }),
        new Paragraph({ spacing: { after: 120 }, text: 'Клиент: ____________________________________' }),
      ],
    },
  ])
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
              (
                SELECT COUNT(*)
                  FROM sales_quote_lines ql
                  JOIN client_request_revision_items cri ON cri.id = ql.client_request_revision_item_id
                  LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
                 WHERE ql.sales_quote_revision_id = COALESCE(
                         ${includeRevision ? 'cc.sales_quote_revision_id,' : 'NULL,'}
                         (
                           SELECT sqr2.id
                             FROM sales_quote_revisions sqr2
                            WHERE sqr2.sales_quote_id = sq.id
                            ORDER BY sqr2.rev_number DESC, sqr2.id DESC
                            LIMIT 1
                         )
                       )
                   AND EXISTS (
                         SELECT 1
                           FROM selection_lines sl
                           JOIN rfq_items ri2 ON ri2.id = sl.rfq_item_id
                          WHERE sl.selection_id = sq.selection_id
                            AND ri2.client_request_revision_item_id = ql.client_request_revision_item_id
                            AND COALESCE(TRIM(sl.supplier_display_part_number_snapshot), '') <> ''
                            AND COALESCE(TRIM(sl.supplier_display_part_number_snapshot), '') <>
                                COALESCE(TRIM(op.part_number), '')
                       )
              ) AS procurement_substitution_count,
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

    const requestedRevisionId = toId(req.body.sales_quote_revision_id)
    const { quote, latestRevisionId } = await ensureSalesQuoteCanCreateContract(db, salesQuoteId, requestedRevisionId)
    const contractCurrency = ensureCurrencyMatchesLockedValue(req.body.currency, quote.currency, 'контракта')
    const nextStatus = ensureContractStatusTransition('draft', nz(req.body.status) || 'draft', { isCreate: true })
    if (nextStatus === 'signed') {
      await ensureSingleSignedContractPerRequest(db, salesQuoteId)
    }
    const supportsQuoteRevision = await contractsSupportQuoteRevision(db)
    let salesQuoteRevisionId = null
    if (supportsQuoteRevision) {
      salesQuoteRevisionId = requestedRevisionId || latestRevisionId
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
          contractCurrency,
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
          contractCurrency,
          nextStatus,
          nz(req.body.file_url),
          nz(req.body.note),
        ]

    const [result] = await db.execute(
      insertSql,
      insertParams
    )

    await syncSalesQuoteStatusForContract(db, salesQuoteId, nextStatus)

    const requestId = await fetchRequestIdBySalesQuoteId(db, salesQuoteId)
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    let documentWarning = null
    try {
      await generateContractDocxAndPersist(db, result.insertId)
    } catch (documentError) {
      console.error('Auto-generate contract DOCX error:', documentError)
      documentWarning = 'Контракт создан, но DOCX не удалось сформировать автоматически'
    }
    const [[created]] = await db.execute('SELECT * FROM client_contracts WHERE id = ?', [result.insertId])
    await logActivity({
      req,
      action: 'create',
      entity_type: 'client_contracts',
      entity_id: result.insertId,
      comment: `Создан контракт ${created?.contract_number || ''}`.trim(),
    })
    res.status(201).json(documentWarning ? { ...created, document_warning: documentWarning } : created)
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
    ensureCurrencyMatchesLockedValue(req.body.currency, existing.currency, 'контракта')
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
        nextStatus,
        ...(supportsQuoteRevision ? [nextRevisionId] : []),
        nz(req.body.file_url),
        nz(req.body.note),
        contractId,
      ]
    )

    await syncSalesQuoteStatusForContract(db, existing.sales_quote_id, nextStatus)

    const requestId = await fetchRequestIdBySalesQuoteId(db, existing.sales_quote_id)
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    const [[updated]] = await db.execute('SELECT * FROM client_contracts WHERE id = ?', [contractId])
    await logActivity({
      req,
      action: 'update',
      entity_type: 'client_contracts',
      entity_id: contractId,
      field_changed: nz(req.body.status) ? 'status' : 'contract',
      old_value: existing.status,
      new_value: updated?.status || existing.status,
      comment: nz(req.body.status) ? 'Изменен статус контракта' : 'Обновлен контракт',
    })
    res.json(updated)
  } catch (e) {
    console.error('PATCH /contracts/:id error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сервера' })
  }
})

router.post('/:id/generate', async (req, res) => {
  try {
    const contractId = toId(req.params.id)
    if (!contractId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const { publicUrl } = await generateContractDocxAndPersist(db, contractId)
    await logActivity({
      req,
      action: 'update',
      entity_type: 'client_contracts',
      entity_id: contractId,
      field_changed: 'file_url',
      new_value: publicUrl,
      comment: 'Сформирован DOCX контракта',
    })

    res.json({ url: publicUrl, file_url: publicUrl, format: 'docx' })
  } catch (e) {
    console.error('POST /contracts/:id/generate error:', e)
    res.status(500).json({ message: e?.message || 'Не удалось сформировать DOCX контракта' })
  }
})

router.get('/:id/preview', async (req, res) => {
  try {
    const contractId = toId(req.params.id)
    if (!contractId) return res.status(400).send('Некорректный идентификатор')
    const context = await loadContractDocumentContext(db, contractId)
    if (!context) return res.status(404).send('Контракт не найден')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(renderContractPreviewHtml(context))
  } catch (e) {
    console.error('GET /contracts/:id/preview error:', e)
    res.status(500).send('Не удалось открыть предпросмотр контракта')
  }
})

module.exports = router
