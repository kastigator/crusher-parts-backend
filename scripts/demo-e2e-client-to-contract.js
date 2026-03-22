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
if (!JWT_SECRET) {
  console.error('JWT_SECRET не найден в .env.local')
  process.exit(1)
}

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
const demoCode = `DEMO-E2E-${stamp}`

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

const log = (...args) => console.log(`[${demoCode}]`, ...args)
const fail = (label, response) => {
  const payload = response?.data || response
  throw new Error(`${label} failed: ${JSON.stringify(payload)}`)
}
const expect2xx = (label, response) => {
  if (!response || response.status < 200 || response.status >= 300) fail(label, response)
  return response.data
}

const sqlOne = async (query, params = []) => {
  const [rows] = await db.execute(query, params)
  return rows[0] || null
}
const sqlAll = async (query, params = []) => {
  const [rows] = await db.execute(query, params)
  return rows
}

async function createClient() {
  const payload = {
    company_name: `${demoCode} Клиент`,
    contact_person: 'Демо менеджер',
    phone: '+7-900-000-00-01',
    email: `${demoCode.toLowerCase()}@example.com`,
    website: 'https://example.com',
    notes: 'Демо клиент для сквозного сценария RFQ -> КП -> контракт',
  }
  const data = expect2xx('create client', await api.post('/clients', payload))
  return data.id
}

async function createEquipmentUnit(clientId, equipmentModelId) {
  const payload = {
    client_id: clientId,
    equipment_model_id: equipmentModelId,
    serial_number: `${demoCode}-UNIT-01`,
    manufacture_year: 2024,
    site_name: 'Демо площадка',
    internal_name: 'Основная дробилка',
    status: 'active',
    notes: 'Создано для демонстрации исполнения оборудования клиента',
  }
  const data = expect2xx('create equipment unit', await api.post('/client-equipment-units', payload))
  return data.id
}

async function createOriginalPart({ modelId, tnvedId, catNumber, descriptionRu, uom = 'pcs' }) {
  const data = expect2xx(
    'create original part',
    await api.post('/original-parts', {
      equipment_model_id: modelId,
      cat_number: catNumber,
      description_ru: descriptionRu,
      description_en: descriptionRu,
      uom,
      tnved_code_id: tnvedId,
    })
  )
  return data.id
}

async function addBom(parentId, childId, quantity) {
  expect2xx(
    'add bom',
    await api.post('/original-part-bom', {
      parent_part_id: parentId,
      child_part_id: childId,
      quantity,
    })
  )
}

async function createSupplier({ name, publicCode, country = 'CN', reliability = 78, risk = 'medium' }) {
  const data = expect2xx(
    'create supplier',
    await api.post('/suppliers', {
      name,
      public_code: publicCode,
      preferred_currency: 'USD',
      payment_terms: '100% предоплата',
      default_pickup_location: 'Shanghai',
      can_oem: true,
      can_analog: true,
      reliability_rating: reliability,
      risk_level: risk,
      default_lead_time_days: 30,
      notes: `Демо поставщик ${demoCode}`,
      country,
    })
  )
  return data.id
}

async function createSupplierPart({
  supplierId,
  number,
  descriptionRu,
  weightKg,
  leadTimeDays,
  minOrderQty = 1,
  partType = 'OEM',
}) {
  const data = expect2xx(
    'create supplier part',
    await api.post('/supplier-parts', {
      supplier_id: supplierId,
      supplier_part_number: number,
      description_ru: descriptionRu,
      description_en: descriptionRu,
      uom: 'pcs',
      weight_kg: weightKg,
      lead_time_days: leadTimeDays,
      min_order_qty: minOrderQty,
      packaging: 'box',
      active: true,
      part_type: partType,
    })
  )
  return data.id
}

async function linkSupplierPartToOriginal(supplierPartId, originalPartId) {
  expect2xx(
    'link supplier part to original',
    await api.post('/supplier-part-originals', {
      supplier_part_id: supplierPartId,
      oem_part_id: originalPartId,
      is_preferred: 1,
    })
  )
}

async function createClientRequest(clientId) {
  const data = expect2xx(
    'create client request',
    await api.post('/client-requests', {
      client_id: clientId,
      internal_number: `${demoCode}-REQ`,
      source_type: 'email',
      processing_deadline: '2026-03-31',
      client_reference: `${demoCode}-REF`,
      contact_name: 'Демо менеджер',
      contact_email: `${demoCode.toLowerCase()}@example.com`,
      contact_phone: '+7-900-000-00-02',
      comment_internal: 'Демо заявка для полного пути до контракта',
      comment_client: 'Просьба предложить варианты',
    })
  )
  return data.id
}

async function createRevision(requestId) {
  const data = expect2xx(
    'create request revision',
    await api.post(`/client-requests/${requestId}/revisions`, {
      note: 'Демо ревизия 1',
    })
  )
  return data.id
}

async function addRequestItem(revisionId, payload) {
  const data = expect2xx(
    'add request item',
    await api.post(`/client-requests/revisions/${revisionId}/items`, payload)
  )
  return data.id
}

async function releaseRequest(requestId) {
  expect2xx('release request', await api.post(`/client-requests/${requestId}/release`, {}))
}

async function assignRfq(requestId, assigneeId = 4) {
  expect2xx(
    'assign rfq',
    await api.post(`/client-requests/${requestId}/assign-rfq`, {
      assigned_to_user_id: assigneeId,
      processing_deadline: '2026-03-31',
      note: 'Автосоздание RFQ для demo-case',
    })
  )
  const row = await sqlOne('SELECT id, rfq_number, client_request_revision_id FROM rfqs WHERE client_request_id = ? ORDER BY id DESC LIMIT 1', [requestId])
  if (!row) throw new Error('RFQ not found after assign-rfq')
  return row
}

async function addRfqSupplier(rfqId, supplierId) {
  const data = expect2xx(
    'add rfq supplier',
    await api.post(`/rfqs/${rfqId}/suppliers`, {
      supplier_id: supplierId,
      status: 'invited',
      language: 'ru',
      rfq_format: 'excel',
      note: `Демо поставщик ${demoCode}`,
    })
  )
  return data.id
}

async function putLineSelections(rfqId, rfqSupplierId, selections) {
  expect2xx(
    'put line selections',
    await api.put(`/rfqs/${rfqId}/suppliers/${rfqSupplierId}/line-selections`, { selections })
  )
}

async function manualResponse(payload) {
  const data = expect2xx('manual supplier response', await api.post('/supplier-responses/manual-line', payload))
  return data.id
}

async function createCoverageOption(rfqId, option) {
  const data = expect2xx(
    'create coverage option',
    await api.post(`/coverage/rfq/${rfqId}/options`, { option })
  )
  return data.coverage_option_id
}

async function createScenario(rfqId, payload) {
  const data = expect2xx('create scenario', await api.post(`/economics/rfq/${rfqId}/scenarios`, payload))
  return data.row.id
}

async function autoShipmentGroups(rfqId, scenarioId) {
  expect2xx(
    'auto shipment groups',
    await api.post(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/shipment-groups/auto`, {})
  )
}

async function selectRoutesForScenario(rfqId, scenarioId, preferredTemplateCodes = []) {
  const routesResp = expect2xx(
    'get group routes',
    await api.get(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/group-routes`)
  )
  const catalogs = expect2xx(
    'get route catalogs',
    await api.get(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/route-catalogs`)
  )
  const templatesByCode = new Map((catalogs.templates || []).map((t) => [t.code, t]))
  const routesByGroup = new Map()
  for (const row of routesResp.rows || []) {
    const key = Number(row.shipment_group_id)
    const list = routesByGroup.get(key) || []
    list.push(row)
    routesByGroup.set(key, list)
  }

  let index = 0
  for (const [groupId, routes] of routesByGroup.entries()) {
    const route = routes[0]
    if (!route) continue
    const wantedCode = preferredTemplateCodes[index] || preferredTemplateCodes[preferredTemplateCodes.length - 1]
    const template = templatesByCode.get(wantedCode) || catalogs.templates?.[0]
    if (!template) throw new Error('Нет доступных шаблонов маршрута')
    expect2xx(
      'assign route template',
      await api.put(`/economics/shipment-group-routes/${route.id}/template`, {
        route_template_id: template.id,
      })
    )
    expect2xx(
      'select route',
      await api.patch(`/economics/shipment-group-routes/${route.id}/selected`, {
        selected: true,
      })
    )
    index += 1
  }
}

async function recalculateScenario(rfqId, scenarioId) {
  expect2xx(
    'recalculate scenario',
    await api.post(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/calculate`, {})
  )
}

async function finalizeSelection(rfqId, scenarioId) {
  const data = expect2xx(
    'finalize selection',
    await api.post(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/finalize-selection`, {
      note: `Демо финализация ${demoCode}`,
    })
  )
  return data.selection_id
}

async function createSalesQuote(clientRequestRevisionId, selectionId) {
  const data = expect2xx(
    'create sales quote',
    await api.post('/sales-quotes', {
      client_request_revision_id: clientRequestRevisionId,
      selection_id: selectionId,
      status: 'draft',
      currency: 'USD',
      revision_note: `Демо КП ${demoCode}`,
    })
  )
  return { quoteId: data.id, revisionId: data.created_revision_id }
}

async function updateQuoteLines(revisionId) {
  const rows = expect2xx('get quote lines', await api.get(`/sales-quotes/revisions/${revisionId}/lines`))
  for (const row of rows) {
    expect2xx(
      'patch quote line',
      await api.patch(`/sales-quotes/lines/${row.id}`, {
        qty: row.qty,
        cost: row.cost,
        margin_pct: 28,
        currency: row.currency || 'USD',
        note: `Демо наценка ${demoCode}`,
        line_status: 'active',
      })
    )
  }
  const updatedRows = expect2xx('get updated quote lines', await api.get(`/sales-quotes/revisions/${revisionId}/lines`))
  return updatedRows
}

async function patchQuoteStatus(quoteId) {
  expect2xx(
    'patch quote status',
    await api.patch(`/sales-quotes/${quoteId}`, {
      status: 'sent_to_client',
      currency: 'USD',
    })
  )
}

async function createSignedContract(quoteId, revisionId, amount, currency) {
  const data = expect2xx(
    'create contract',
    await api.post('/contracts', {
      sales_quote_id: quoteId,
      sales_quote_revision_id: revisionId,
      contract_number: `${demoCode}-CONTRACT`,
      contract_date: '2026-03-21',
      amount,
      currency,
      status: 'signed',
      note: `Демо подписанный контракт ${demoCode}`,
    })
  )
  return data.id
}

function sumSellAmount(rows) {
  return rows.reduce((sum, row) => {
    const qty = Number(row.qty || 0)
    const sell = Number(row.sell_price || 0)
    return sum + qty * sell
  }, 0)
}

async function main() {
  log('API base', API_BASE_URL)
  const model = await sqlOne('SELECT id, model_name FROM equipment_models WHERE id = 1')
  if (!model) throw new Error('equipment_models.id=1 не найден')
  const tnvedMain = await sqlOne('SELECT id, code, duty_rate FROM tnved_codes WHERE id = 83')
  const tnvedAlt = await sqlOne('SELECT id, code, duty_rate FROM tnved_codes WHERE id = 79')
  if (!tnvedMain || !tnvedAlt) throw new Error('Не найдены ожидаемые ТН ВЭД id=83/79')

  const clientId = await createClient()
  const equipmentUnitId = await createEquipmentUnit(clientId, model.id)

  const assemblyId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedMain.id,
    catNumber: `${demoCode}-ASM`,
    descriptionRu: `${demoCode} Сборка в сборе`,
    uom: 'set',
  })
  const childAId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedMain.id,
    catNumber: `${demoCode}-SHAFT`,
    descriptionRu: `${demoCode} Вал`,
  })
  const childBId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedAlt.id,
    catNumber: `${demoCode}-HOUSING`,
    descriptionRu: `${demoCode} Корпус`,
  })
  const spareId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedMain.id,
    catNumber: `${demoCode}-SPARE`,
    descriptionRu: `${demoCode} Запасная деталь`,
  })

  await addBom(assemblyId, childAId, 1)
  await addBom(assemblyId, childBId, 1)

  const supplierWholeId = await createSupplier({
    name: `${demoCode} Whole Supplier`,
    publicCode: `${demoCode.replace(/-/g, '').slice(-20)}W`,
    country: 'CN',
    reliability: 82,
    risk: 'low',
  })
  const supplierBomId = await createSupplier({
    name: `${demoCode} BOM Supplier`,
    publicCode: `${demoCode.replace(/-/g, '').slice(-20)}B`,
    country: 'CN',
    reliability: 74,
    risk: 'medium',
  })

  const wholeAssemblyPartId = await createSupplierPart({
    supplierId: supplierWholeId,
    number: `${demoCode}-W-ASM`,
    descriptionRu: 'Сборка целиком',
    weightKg: 120,
    leadTimeDays: 28,
    partType: 'OEM',
  })
  const wholeSparePartId = await createSupplierPart({
    supplierId: supplierWholeId,
    number: `${demoCode}-W-SPARE`,
    descriptionRu: 'Запасная деталь',
    weightKg: 12,
    leadTimeDays: 15,
    partType: 'OEM',
  })
  const bomChildAPartId = await createSupplierPart({
    supplierId: supplierBomId,
    number: `${demoCode}-B-SHAFT`,
    descriptionRu: 'Вал',
    weightKg: 35,
    leadTimeDays: 21,
    partType: 'OEM',
  })
  const bomChildBPartId = await createSupplierPart({
    supplierId: supplierBomId,
    number: `${demoCode}-B-HOUSING`,
    descriptionRu: 'Корпус',
    weightKg: 70,
    leadTimeDays: 24,
    partType: 'OEM',
  })

  await linkSupplierPartToOriginal(wholeAssemblyPartId, assemblyId)
  await linkSupplierPartToOriginal(wholeSparePartId, spareId)
  await linkSupplierPartToOriginal(bomChildAPartId, childAId)
  await linkSupplierPartToOriginal(bomChildBPartId, childBId)

  const requestId = await createClientRequest(clientId)
  const revisionId = await createRevision(requestId)
  const assemblyRequestItemId = await addRequestItem(revisionId, {
    oem_part_id: assemblyId,
    equipment_model_id: model.id,
    client_description: 'Нужна сборка с вариантами исполнения',
    requested_qty: 1,
    uom: 'set',
    priority: 'high',
    oem_only: 1,
    client_comment: 'Рассмотреть whole и BOM',
    internal_comment: 'Демо assembly line',
  })
  const spareRequestItemId = await addRequestItem(revisionId, {
    oem_part_id: spareId,
    equipment_model_id: model.id,
    client_description: 'Нужна отдельная запасная деталь',
    requested_qty: 2,
    uom: 'pcs',
    priority: 'medium',
    oem_only: 1,
    client_comment: 'Можно вместе с основной поставкой',
    internal_comment: 'Демо spare line',
  })

  await releaseRequest(requestId)
  const rfq = await assignRfq(requestId, 4)

  const rfqItems = await sqlAll(
    `SELECT ri.id, ri.line_number, ri.client_request_revision_item_id
       FROM rfq_items ri
      WHERE ri.rfq_id = ?
      ORDER BY ri.line_number ASC`,
    [rfq.id]
  )
  const rfqAssemblyItem = rfqItems.find((row) => Number(row.client_request_revision_item_id) === Number(assemblyRequestItemId))
  const rfqSpareItem = rfqItems.find((row) => Number(row.client_request_revision_item_id) === Number(spareRequestItemId))
  if (!rfqAssemblyItem || !rfqSpareItem) throw new Error('RFQ items not found for created request items')

  const rfqWholeSupplierId = await addRfqSupplier(rfq.id, supplierWholeId)
  const rfqBomSupplierId = await addRfqSupplier(rfq.id, supplierBomId)

  await putLineSelections(rfq.id, rfqWholeSupplierId, [
    {
      selection_key: `DEMAND-${rfqAssemblyItem.id}`,
      rfq_item_id: rfqAssemblyItem.id,
      line_type: 'DEMAND',
      original_part_id: assemblyId,
      line_label: 'Сборка целиком',
      qty: 1,
      uom: 'set',
    },
    {
      selection_key: `DEMAND-${rfqSpareItem.id}`,
      rfq_item_id: rfqSpareItem.id,
      line_type: 'DEMAND',
      original_part_id: spareId,
      line_label: 'Запасная деталь',
      qty: 2,
      uom: 'pcs',
    },
  ])

  await putLineSelections(rfq.id, rfqBomSupplierId, [
    {
      selection_key: `BOM-${rfqAssemblyItem.id}-${childAId}`,
      rfq_item_id: rfqAssemblyItem.id,
      line_type: 'BOM_COMPONENT',
      original_part_id: childAId,
      line_label: 'Компонент: вал',
      qty: 1,
      uom: 'pcs',
    },
    {
      selection_key: `BOM-${rfqAssemblyItem.id}-${childBId}`,
      rfq_item_id: rfqAssemblyItem.id,
      line_type: 'BOM_COMPONENT',
      original_part_id: childBId,
      line_label: 'Компонент: корпус',
      qty: 1,
      uom: 'pcs',
    },
  ])

  const responseWholeAssemblyId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierWholeId,
    rfq_item_id: rfqAssemblyItem.id,
    selection_key: `DEMAND-${rfqAssemblyItem.id}`,
    supplier_part_id: wholeAssemblyPartId,
    original_part_id: assemblyId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 1,
    moq: 1,
    packaging: 'crate',
    lead_time_days: 28,
    price: 3200,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Shanghai',
    origin_country: 'CN',
    note: 'Whole offer for assembly',
  })
  const responseWholeSpareId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierWholeId,
    rfq_item_id: rfqSpareItem.id,
    selection_key: `DEMAND-${rfqSpareItem.id}`,
    supplier_part_id: wholeSparePartId,
    original_part_id: spareId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 2,
    moq: 1,
    packaging: 'box',
    lead_time_days: 15,
    price: 180,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Shanghai',
    origin_country: 'CN',
    note: 'Whole spare offer',
  })
  const responseBomChildAId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierBomId,
    rfq_item_id: rfqAssemblyItem.id,
    selection_key: `BOM-${rfqAssemblyItem.id}-${childAId}`,
    supplier_part_id: bomChildAPartId,
    original_part_id: childAId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 1,
    moq: 1,
    packaging: 'crate',
    lead_time_days: 21,
    price: 900,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Shanghai',
    origin_country: 'CN',
    note: 'BOM shaft offer',
  })
  const responseBomChildBId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierBomId,
    rfq_item_id: rfqAssemblyItem.id,
    selection_key: `BOM-${rfqAssemblyItem.id}-${childBId}`,
    supplier_part_id: bomChildBPartId,
    original_part_id: childBId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 1,
    moq: 1,
    packaging: 'crate',
    lead_time_days: 24,
    price: 1100,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Shanghai',
    origin_country: 'CN',
    note: 'BOM housing offer',
  })

  const coverageWholeAssemblyId = await createCoverageOption(rfq.id, {
    rfq_item_id: rfqAssemblyItem.id,
    option_code: `${demoCode}-ASM-WHOLE`,
    option_kind: 'WHOLE',
    coverage_status: 'FULL',
    completeness_pct: 100,
    priced_pct: 100,
    is_oem_ok: 1,
    goods_total: 3200,
    goods_currency: 'USD',
    supplier_count: 1,
    lead_time_min_days: 28,
    lead_time_max_days: 28,
    note: 'Сборка целиком от одного поставщика',
    lines: [
      {
        rfq_response_line_id: responseWholeAssemblyId,
        supplier_id: supplierWholeId,
        original_part_id: assemblyId,
        line_code: `${demoCode}-ASM-WHOLE-L1`,
        line_role: 'WHOLE',
        line_status: 'SELECTED',
        qty: 1,
        uom: 'set',
        unit_price: 3200,
        goods_amount: 3200,
        goods_currency: 'USD',
        weight_kg: 120,
        lead_time_days: 28,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'CN',
        incoterms: 'FOB',
        incoterms_place: 'Shanghai',
        note: 'Whole line',
      },
    ],
  })

  const coverageBomAssemblyId = await createCoverageOption(rfq.id, {
    rfq_item_id: rfqAssemblyItem.id,
    option_code: `${demoCode}-ASM-BOM`,
    option_kind: 'BOM',
    coverage_status: 'FULL',
    completeness_pct: 100,
    priced_pct: 100,
    is_oem_ok: 1,
    goods_total: 2000,
    goods_currency: 'USD',
    supplier_count: 1,
    lead_time_min_days: 21,
    lead_time_max_days: 24,
    note: 'Сборка по составу от BOM поставщика',
    lines: [
      {
        rfq_response_line_id: responseBomChildAId,
        supplier_id: supplierBomId,
        original_part_id: childAId,
        line_code: `${demoCode}-ASM-BOM-L1`,
        line_role: 'COMPONENT',
        line_status: 'SELECTED',
        qty: 1,
        uom: 'pcs',
        unit_price: 900,
        goods_amount: 900,
        goods_currency: 'USD',
        weight_kg: 35,
        lead_time_days: 21,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'CN',
        incoterms: 'FOB',
        incoterms_place: 'Shanghai',
        note: 'BOM shaft',
      },
      {
        rfq_response_line_id: responseBomChildBId,
        supplier_id: supplierBomId,
        original_part_id: childBId,
        line_code: `${demoCode}-ASM-BOM-L2`,
        line_role: 'COMPONENT',
        line_status: 'SELECTED',
        qty: 1,
        uom: 'pcs',
        unit_price: 1100,
        goods_amount: 1100,
        goods_currency: 'USD',
        weight_kg: 70,
        lead_time_days: 24,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'CN',
        incoterms: 'FOB',
        incoterms_place: 'Shanghai',
        note: 'BOM housing',
      },
    ],
  })

  const coverageSpareId = await createCoverageOption(rfq.id, {
    rfq_item_id: rfqSpareItem.id,
    option_code: `${demoCode}-SPARE-WHOLE`,
    option_kind: 'WHOLE',
    coverage_status: 'FULL',
    completeness_pct: 100,
    priced_pct: 100,
    is_oem_ok: 1,
    goods_total: 360,
    goods_currency: 'USD',
    supplier_count: 1,
    lead_time_min_days: 15,
    lead_time_max_days: 15,
    note: 'Запасная деталь от whole supplier',
    lines: [
      {
        rfq_response_line_id: responseWholeSpareId,
        supplier_id: supplierWholeId,
        original_part_id: spareId,
        line_code: `${demoCode}-SPARE-L1`,
        line_role: 'WHOLE',
        line_status: 'SELECTED',
        qty: 2,
        uom: 'pcs',
        unit_price: 180,
        goods_amount: 360,
        goods_currency: 'USD',
        weight_kg: 12,
        lead_time_days: 15,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'CN',
        incoterms: 'FOB',
        incoterms_place: 'Shanghai',
        note: 'Spare line',
      },
    ],
  })

  const scenarioCheapestId = await createScenario(rfq.id, {
    name: `${demoCode} Дешевле`,
    basis: 'MANUAL',
    calc_currency: 'USD',
    items: [
      { rfq_item_id: rfqAssemblyItem.id, coverage_option_id: coverageBomAssemblyId },
      { rfq_item_id: rfqSpareItem.id, coverage_option_id: coverageSpareId },
    ],
  })
  const scenarioConsolidatedId = await createScenario(rfq.id, {
    name: `${demoCode} Консолидация`,
    basis: 'MANUAL',
    calc_currency: 'USD',
    items: [
      { rfq_item_id: rfqAssemblyItem.id, coverage_option_id: coverageWholeAssemblyId },
      { rfq_item_id: rfqSpareItem.id, coverage_option_id: coverageSpareId },
    ],
  })

  await autoShipmentGroups(rfq.id, scenarioCheapestId)
  await autoShipmentGroups(rfq.id, scenarioConsolidatedId)
  await selectRoutesForScenario(rfq.id, scenarioCheapestId, ['CN_RU_SEA_BASE', 'CN_RU_ROAD_BASE'])
  await selectRoutesForScenario(rfq.id, scenarioConsolidatedId, ['SHA_CHEL_ROAD_BASE'])
  await recalculateScenario(rfq.id, scenarioCheapestId)
  await recalculateScenario(rfq.id, scenarioConsolidatedId)

  const selectionId = await finalizeSelection(rfq.id, scenarioConsolidatedId)
  const { quoteId, revisionId: quoteRevisionId } = await createSalesQuote(revisionId, selectionId)
  const quoteLines = await updateQuoteLines(quoteRevisionId)
  await patchQuoteStatus(quoteId)
  const quoteAmount = Number(sumSellAmount(quoteLines).toFixed(2))
  const contractId = await createSignedContract(quoteId, quoteRevisionId, quoteAmount, 'USD')

  const summary = {
    demo_code: demoCode,
    client_id: clientId,
    equipment_unit_id: equipmentUnitId,
    request_id: requestId,
    request_revision_id: revisionId,
    rfq_id: rfq.id,
    rfq_number: rfq.rfq_number,
    rfq_item_ids: {
      assembly: rfqAssemblyItem.id,
      spare: rfqSpareItem.id,
    },
    coverage_option_ids: {
      assembly_whole: coverageWholeAssemblyId,
      assembly_bom: coverageBomAssemblyId,
      spare_whole: coverageSpareId,
    },
    scenario_ids: {
      cheapest: scenarioCheapestId,
      consolidated: scenarioConsolidatedId,
    },
    selection_id: selectionId,
    sales_quote_id: quoteId,
    sales_quote_revision_id: quoteRevisionId,
    contract_id: contractId,
    supplier_ids: {
      whole_supplier: supplierWholeId,
      bom_supplier: supplierBomId,
    },
    original_part_ids: {
      assembly: assemblyId,
      child_a: childAId,
      child_b: childBId,
      spare: spareId,
    },
  }

  const outDir = path.resolve(__dirname, '..', 'tmp')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${demoCode}.json`)
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2))

  log('Demo-case created successfully')
  log(JSON.stringify(summary, null, 2))
  log(`Summary file: ${outPath}`)
}

main()
  .catch((err) => {
    console.error(`[${demoCode}] ERROR`, err?.response?.data || err?.message || err)
    process.exit(1)
  })
  .finally(async () => {
    await db.end()
  })
