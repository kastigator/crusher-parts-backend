#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const dotenv = require('dotenv')
const mysql = require('mysql2/promise')

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') })

const API_BASE_URL = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5050}/api`
const JWT_SECRET = process.env.JWT_SECRET

const token = jwt.sign(
  { id: 4, username: 'admin', role: 'admin', role_id: 1, is_admin: true },
  JWT_SECRET,
  { expiresIn: '8h' }
)

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  validateStatus: () => true,
})

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 4,
})

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const demoCode = `DEMO-PROFILE-${stamp}`

const expect2xx = (label, response) => {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed: ${JSON.stringify(response?.data || response)}`)
  }
  return response.data
}

const sqlOne = async (query, params = []) => {
  const [rows] = await db.execute(query, params)
  return rows[0] || null
}

const sumSellAmount = (rows) =>
  rows.reduce((sum, row) => sum + Number(row.qty || 0) * Number(row.sell_price || 0), 0)

async function main() {
  const model = await sqlOne('SELECT id FROM equipment_models WHERE id = 1')
  const tnved = await sqlOne('SELECT id FROM tnved_codes WHERE id = 83')
  if (!model || !tnved) throw new Error('equipment_models.id=1 or tnved_codes.id=83 not found')

  const client = expect2xx(
    'create client',
    await api.post('/clients', {
      company_name: `${demoCode} Клиент`,
      contact_person: 'Демо менеджер',
      phone: '+7-900-000-00-11',
      email: `${demoCode.toLowerCase()}@example.com`,
      notes: 'Проверка presentation profile',
    })
  )

  const oemPart = expect2xx(
    'create original part',
    await api.post('/original-parts', {
      equipment_model_id: model.id,
      cat_number: `${demoCode}-OEM`,
      description_ru: `${demoCode} OEM деталь`,
      description_en: `${demoCode} OEM detail`,
      uom: 'pcs',
      tnved_code_id: tnved.id,
    })
  )

  const profile = expect2xx(
    'save presentation profile',
    await api.put(`/original-parts/${oemPart.id}/presentation-profile`, {
      internal_part_number: `${demoCode}-INT`,
      internal_part_name: `${demoCode} Внутреннее имя`,
      supplier_visible_part_number: `${demoCode}-DRAW`,
      supplier_visible_description: `${demoCode} Поставщику под нашим номером`,
      drawing_code: `${demoCode}-DWG`,
      use_by_default_in_supplier_rfq: true,
      note: 'E2E presentation profile',
    })
  )

  const supplier = expect2xx(
    'create supplier',
    await api.post('/suppliers', {
      name: `${demoCode} Supplier`,
      public_code: `${demoCode.replace(/-/g, '').slice(-20)}S`,
      preferred_currency: 'USD',
      payment_terms: '100% предоплата',
      default_pickup_location: 'Shanghai',
      can_oem: true,
      can_analog: true,
      reliability_rating: 80,
      risk_level: 'low',
      default_lead_time_days: 25,
      country: 'CN',
    })
  )

  const supplierPart = expect2xx(
    'create supplier part',
    await api.post('/supplier-parts', {
      supplier_id: supplier.id,
      supplier_part_number: `${demoCode}-SUPP`,
      description_ru: `${demoCode} Supplier part`,
      description_en: `${demoCode} Supplier part`,
      uom: 'pcs',
      weight_kg: 12,
      lead_time_days: 25,
      min_order_qty: 1,
      packaging: 'box',
      active: true,
      part_type: 'OEM',
    })
  )

  expect2xx(
    'link supplier part',
    await api.post('/supplier-part-originals', {
      supplier_part_id: supplierPart.id,
      oem_part_id: oemPart.id,
      is_preferred: 1,
    })
  )

  const request = expect2xx(
    'create client request',
    await api.post('/client-requests', {
      client_id: client.id,
      internal_number: `${demoCode}-REQ`,
      source_type: 'email',
      processing_deadline: '2026-03-31',
      client_reference: `${demoCode}-REF`,
      contact_name: 'Демо менеджер',
      contact_email: `${demoCode.toLowerCase()}@example.com`,
      contact_phone: '+7-900-000-00-12',
      comment_internal: 'presentation profile e2e',
    })
  )

  const revision = expect2xx(
    'create request revision',
    await api.post(`/client-requests/${request.id}/revisions`, { note: 'rev1' })
  )

  const item = expect2xx(
    'add request item',
    await api.post(`/client-requests/revisions/${revision.id}/items`, {
      oem_part_id: oemPart.id,
      equipment_model_id: model.id,
      client_description: 'Клиент просит OEM по OEM номеру',
      requested_qty: 1,
      uom: 'pcs',
      priority: 'high',
      oem_only: 1,
    })
  )

  expect2xx('release request', await api.post(`/client-requests/${request.id}/release`, {}))

  expect2xx(
    'assign rfq',
    await api.post(`/client-requests/${request.id}/assign-rfq`, {
      assigned_to_user_id: 4,
      processing_deadline: '2026-03-31',
      note: 'presentation profile rfq',
    })
  )

  const rfq = await sqlOne(
    'SELECT id, rfq_number FROM rfqs WHERE client_request_id = ? ORDER BY id DESC LIMIT 1',
    [request.id]
  )
  const rfqItem = await sqlOne(
    'SELECT id FROM rfq_items WHERE rfq_id = ? AND client_request_revision_item_id = ? ORDER BY id DESC LIMIT 1',
    [rfq.id, item.id]
  )
  if (!rfq?.id || !rfqItem?.id) throw new Error('RFQ or RFQ item not found')

  const rfqSupplier = expect2xx(
    'add rfq supplier',
    await api.post(`/rfqs/${rfq.id}/suppliers`, {
      supplier_id: supplier.id,
      status: 'invited',
      language: 'ru',
      rfq_format: 'excel',
      note: 'presentation profile supplier',
    })
  )

  const selectionKey = `PROFILE-${rfqItem.id}-${profile.id}`
  expect2xx(
    'put line selections',
    await api.put(`/rfqs/${rfq.id}/suppliers/${rfqSupplier.id}/line-selections`, {
      selections: [
        {
          selection_key: selectionKey,
          rfq_item_id: rfqItem.id,
          line_type: 'DEMAND',
          original_part_id: oemPart.id,
          presentation_profile_id: profile.id,
          line_label: `${demoCode}-DRAW`,
          line_description: `${demoCode} Поставщику под нашим номером`,
          qty: 1,
          uom: 'pcs',
        },
      ],
    })
  )

  const savedSelections = expect2xx(
    'get line selections',
    await api.get(`/rfqs/${rfq.id}/suppliers/${rfqSupplier.id}/line-selections`)
  )
  if (!savedSelections.length || Number(savedSelections[0].presentation_profile_id) !== Number(profile.id)) {
    throw new Error('RFQ line selection did not persist presentation_profile_id')
  }

  const responseLine = expect2xx(
    'manual supplier response',
    await api.post('/supplier-responses/manual-line', {
      rfq_id: rfq.id,
      supplier_id: supplier.id,
      rfq_item_id: rfqItem.id,
      selection_key: selectionKey,
      supplier_part_id: supplierPart.id,
      original_part_id: oemPart.id,
      offer_type: 'OEM',
      supplier_reply_status: 'QUOTED',
      offered_qty: 1,
      moq: 1,
      packaging: 'box',
      lead_time_days: 25,
      price: 777,
      currency: 'USD',
      validity_days: 30,
      payment_terms: '100% TT',
      incoterms: 'FOB',
      incoterms_place: 'Shanghai',
      origin_country: 'CN',
      note: 'presentation profile response',
    })
  )

  const coverage = expect2xx(
    'create coverage option',
    await api.post(`/coverage/rfq/${rfq.id}/options`, {
      option: {
        rfq_item_id: rfqItem.id,
        option_code: `${demoCode}-WHOLE`,
        option_kind: 'WHOLE',
        coverage_status: 'FULL',
        completeness_pct: 100,
        priced_pct: 100,
        is_oem_ok: 1,
        goods_total: 777,
        goods_currency: 'USD',
        supplier_count: 1,
        lead_time_min_days: 25,
        lead_time_max_days: 25,
        note: 'presentation profile coverage',
        lines: [
          {
            rfq_response_line_id: responseLine.id,
            supplier_id: supplier.id,
            original_part_id: oemPart.id,
            line_code: `${demoCode}-L1`,
            line_role: 'WHOLE',
            line_status: 'SELECTED',
            qty: 1,
            uom: 'pcs',
            unit_price: 777,
            goods_amount: 777,
            goods_currency: 'USD',
            weight_kg: 12,
            lead_time_days: 25,
            has_price: 1,
            is_oem_offer: 1,
            origin_country: 'CN',
            incoterms: 'FOB',
            incoterms_place: 'Shanghai',
            note: 'presentation profile line',
          },
        ],
      },
    })
  )

  const scenario = expect2xx(
    'create scenario',
    await api.post(`/economics/rfq/${rfq.id}/scenarios`, {
      name: `${demoCode} Scenario`,
      basis: 'MANUAL',
      calc_currency: 'USD',
      items: [{ rfq_item_id: rfqItem.id, coverage_option_id: coverage.coverage_option_id }],
    })
  )

  expect2xx(
    'auto shipment groups',
    await api.post(`/economics/rfq/${rfq.id}/scenarios/${scenario.row.id}/shipment-groups/auto`, {})
  )

  const routes = expect2xx(
    'get group routes',
    await api.get(`/economics/rfq/${rfq.id}/scenarios/${scenario.row.id}/group-routes`)
  )
  const catalogs = expect2xx(
    'get route catalogs',
    await api.get(`/economics/rfq/${rfq.id}/scenarios/${scenario.row.id}/route-catalogs`)
  )
  const firstRoute = routes.rows?.[0]
  const firstTemplate = catalogs.templates?.[0]
  if (!firstRoute?.id || !firstTemplate?.id) throw new Error('No route/template found for scenario')

  expect2xx(
    'assign route template',
    await api.put(`/economics/shipment-group-routes/${firstRoute.id}/template`, {
      route_template_id: firstTemplate.id,
    })
  )
  expect2xx(
    'select route',
    await api.patch(`/economics/shipment-group-routes/${firstRoute.id}/selected`, { selected: true })
  )
  expect2xx(
    'recalculate scenario',
    await api.post(`/economics/rfq/${rfq.id}/scenarios/${scenario.row.id}/calculate`, {})
  )

  const selection = expect2xx(
    'finalize selection',
    await api.post(`/economics/rfq/${rfq.id}/scenarios/${scenario.row.id}/finalize-selection`, {
      note: 'presentation profile finalize',
    })
  )

  const selectionLines = expect2xx(
    'get selection lines',
    await api.get(`/selection/${selection.selection_id}/lines`)
  )
  if (!selectionLines.length) throw new Error('Selection lines missing')
  if (selectionLines[0].supplier_display_part_number !== `${demoCode}-DRAW`) {
    throw new Error(`Selection kept wrong supplier display: ${selectionLines[0].supplier_display_part_number}`)
  }

  const quote = expect2xx(
    'create sales quote',
    await api.post('/sales-quotes', {
      client_request_revision_id: revision.id,
      selection_id: selection.selection_id,
      currency: 'USD',
      revision_note: 'presentation profile quote',
    })
  )

  const quoteLines = expect2xx(
    'get quote lines',
    await api.get(`/sales-quotes/revisions/${quote.created_revision_id}/lines`)
  )
  for (const row of quoteLines) {
    expect2xx(
      'patch quote line',
      await api.patch(`/sales-quotes/lines/${row.id}`, {
        qty: row.qty,
        cost: row.cost,
        margin_pct: 20,
        currency: row.currency || 'USD',
        line_status: 'active',
      })
    )
  }
  const updatedQuoteLines = expect2xx(
    'get updated quote lines',
    await api.get(`/sales-quotes/revisions/${quote.created_revision_id}/lines`)
  )

  expect2xx(
    'patch quote status to sent_to_client',
    await api.patch(`/sales-quotes/${quote.id}`, { status: 'sent_to_client', currency: 'USD' })
  )
  if (updatedQuoteLines[0]?.id) {
    const blockedEdit = await api.patch(`/sales-quotes/lines/${updatedQuoteLines[0].id}`, {
      qty: updatedQuoteLines[0].qty,
      cost: updatedQuoteLines[0].cost,
      margin_pct: 21,
      currency: updatedQuoteLines[0].currency || 'USD',
      line_status: updatedQuoteLines[0].line_status || 'active',
    })
    if (blockedEdit.status !== 409) {
      throw new Error(`Expected presentation-profile quote line edit to be blocked after sent_to_client, got ${blockedEdit.status}`)
    }
  }
  expect2xx(
    'patch quote status to client_approved',
    await api.patch(`/sales-quotes/${quote.id}`, { status: 'client_approved' })
  )

  const contractAmount = Number(sumSellAmount(updatedQuoteLines).toFixed(2))
  const contract = expect2xx(
    'create contract',
    await api.post('/contracts', {
      sales_quote_id: quote.id,
      sales_quote_revision_id: quote.created_revision_id,
      contract_number: `${demoCode}-CONTRACT`,
      contract_date: '2026-03-22',
      amount: contractAmount,
      currency: 'USD',
      note: 'presentation profile contract',
    })
  )
  expect2xx(
    'sign contract',
    await api.patch(`/contracts/${contract.id}`, {
      status: 'signed',
    })
  )

  const selectionLinesAfter = expect2xx(
    'selection lines after contract',
    await api.get(`/selection/${selection.selection_id}/lines`)
  )
  const shipmentGroupId = selectionLinesAfter[0]?.shipment_group_id
  if (!shipmentGroupId) throw new Error('shipment_group_id missing for PO creation')

  const po = expect2xx(
    'create purchase order',
    await api.post('/purchase-orders', {
      supplier_id: supplier.id,
      selection_id: selection.selection_id,
      shipment_group_id: shipmentGroupId,
      status: 'draft',
      supplier_reference: `${demoCode}-PO-01`,
      autofill_from_selection: true,
    })
  )

  const poLines = expect2xx('get po lines', await api.get(`/purchase-orders/${po.id}/lines`))
  if (!poLines.length) throw new Error('PO lines missing')
  if (poLines[0].supplier_display_part_number !== `${demoCode}-DRAW`) {
    throw new Error(`PO kept wrong supplier display: ${poLines[0].supplier_display_part_number}`)
  }

  const result = {
    demo_code: demoCode,
    profile_id: profile.id,
    request_id: request.id,
    rfq_id: rfq.id,
    selection_id: selection.selection_id,
    sales_quote_id: quote.id,
    contract_id: contract.id,
    supplier_purchase_order_id: po.id,
    selection_supplier_display_part_number: selectionLines[0].supplier_display_part_number,
    po_supplier_display_part_number: poLines[0].supplier_display_part_number,
    quote_client_display_part_number: updatedQuoteLines[0]?.client_display_part_number,
  }

  const outDir = path.resolve(__dirname, '..', 'tmp')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${demoCode}.json`)
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: true, ...result, outPath }, null, 2))
}

main()
  .catch((err) => {
    console.error(err?.message || err)
    process.exit(1)
  })
  .finally(async () => {
    await db.end()
  })
