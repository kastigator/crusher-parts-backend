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
const demoCode = `DEMO-MULTI-${stamp}`

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
    company_name: `ДЕМО ${demoCode} Лебединский ГОК`,
    contact_person: 'Семен Семенович',
    phone: '+7-900-123-45-67',
    email: `${demoCode.toLowerCase()}@example.com`,
    website: 'https://example.com',
    notes: 'Демо клиент для многопоставочного сквозного сценария',
  }
  const data = expect2xx('create client', await api.post('/clients', payload))
  return data.id
}

async function createEquipmentUnit(clientId, equipmentModelId) {
  const payload = {
    client_id: clientId,
    equipment_model_id: equipmentModelId,
    serial_number: `${demoCode}-HP800-01`,
    manufacture_year: 2022,
    site_name: 'Дробильный участок №1',
    internal_name: 'Конусная дробилка HP800, линия 1',
    status: 'active',
    notes: 'Демо единица оборудования клиента для проверки equipment-flow',
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

async function createSupplier({ name, publicCode, country, reliability, risk }) {
  const data = expect2xx(
    'create supplier',
    await api.post('/suppliers', {
      name,
      public_code: publicCode,
      preferred_currency: 'USD',
      payment_terms: '100% предоплата',
      default_pickup_location: country === 'TR' ? 'Istanbul' : 'Shanghai',
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
      processing_deadline: '2026-04-05',
      client_reference: `${demoCode}-REF`,
      contact_name: 'Семен Семенович',
      contact_email: `${demoCode.toLowerCase()}@example.com`,
      contact_phone: '+7-900-123-45-67',
      comment_internal: 'Многопоставочный demo-case с вложенной сборкой и отдельными заказами поставщикам',
      comment_client: 'Нужны варианты поставки по узлу и запасным частям',
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
  const data = expect2xx('add request item', await api.post(`/client-requests/revisions/${revisionId}/items`, payload))
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
      processing_deadline: '2026-04-05',
      note: 'Автосоздание RFQ для multi-supplier demo-case',
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
  const data = expect2xx('create coverage option', await api.post(`/coverage/rfq/${rfqId}/options`, { option }))
  return data.coverage_option_id
}

async function createScenario(rfqId, payload) {
  const data = expect2xx('create scenario', await api.post(`/economics/rfq/${rfqId}/scenarios`, payload))
  return data.row.id
}

async function autoShipmentGroups(rfqId, scenarioId) {
  expect2xx('auto shipment groups', await api.post(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/shipment-groups/auto`, {}))
}

async function selectFirstRoutesForScenario(rfqId, scenarioId) {
  const routesResp = expect2xx('get group routes', await api.get(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/group-routes`))
  const catalogs = expect2xx('get route catalogs', await api.get(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/route-catalogs`))
  const firstTemplate = catalogs.templates?.[0]
  if (!firstTemplate) return
  const doneGroups = new Set()
  for (const row of routesResp.rows || []) {
    const groupId = Number(row.shipment_group_id || 0)
    if (!groupId || doneGroups.has(groupId)) continue
    expect2xx(
      'assign route template',
      await api.put(`/economics/shipment-group-routes/${row.id}/template`, {
        route_template_id: firstTemplate.id,
      })
    )
    expect2xx(
      'select route',
      await api.patch(`/economics/shipment-group-routes/${row.id}/selected`, { selected: true })
    )
    doneGroups.add(groupId)
  }
}

async function recalculateScenario(rfqId, scenarioId) {
  expect2xx('recalculate scenario', await api.post(`/economics/rfq/${rfqId}/scenarios/${scenarioId}/calculate`, {}))
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
        margin_pct: 32,
        currency: row.currency || 'USD',
        note: `Демо наценка ${demoCode}`,
        line_status: 'active',
      })
    )
  }
  return expect2xx('get updated quote lines', await api.get(`/sales-quotes/revisions/${revisionId}/lines`))
}

async function patchQuoteStatus(quoteId) {
  expect2xx('patch quote status to sent_to_client', await api.patch(`/sales-quotes/${quoteId}`, {
    status: 'sent_to_client',
    currency: 'USD',
  }))
  expect2xx('patch quote status to client_approved', await api.patch(`/sales-quotes/${quoteId}`, {
    status: 'client_approved',
  }))
}

async function createSignedContract(quoteId, revisionId, amount, currency) {
  const created = expect2xx(
    'create contract',
    await api.post('/contracts', {
      sales_quote_id: quoteId,
      sales_quote_revision_id: revisionId,
      contract_number: `${demoCode}-CONTRACT`,
      contract_date: '2026-03-22',
      amount,
      currency,
      note: `Демо подписанный контракт ${demoCode}`,
    })
  )
  expect2xx('sign contract', await api.patch(`/contracts/${created.id}`, {
    status: 'signed',
  }))
  return created.id
}

function sumSellAmount(rows) {
  return rows.reduce((sum, row) => sum + Number(row.qty || 0) * Number(row.sell_price || 0), 0)
}

async function createSupplierOrders(selectionId, demoSuppliers) {
  const selectionLines = expect2xx('load selection lines', await api.get(`/selection/${selectionId}/lines`))
  const grouped = new Map()
  for (const line of selectionLines) {
    const supplierId = Number(line?.supplier_id || 0)
    const shipmentGroupId = Number(line?.shipment_group_id || 0)
    if (!supplierId || !shipmentGroupId) continue
    const key = `${supplierId}:${shipmentGroupId}`
    if (!grouped.has(key)) grouped.set(key, { supplierId, shipmentGroupId, lines: [] })
    grouped.get(key).lines.push(line)
  }

  const results = []
  let seq = 1
  for (const group of grouped.values()) {
    const supplierMeta = demoSuppliers.find((item) => Number(item.id) === Number(group.supplierId))
    const ref = `${demoCode}-PO-${pad(seq)}`
    const po = expect2xx(
      'create supplier po',
      await api.post('/purchase-orders', {
        supplier_id: group.supplierId,
        selection_id: selectionId,
        shipment_group_id: group.shipmentGroupId,
        status: 'draft',
        supplier_reference: ref,
        autofill_from_selection: true,
      })
    )
    const doc = expect2xx('generate supplier po docx', await api.post(`/purchase-orders/${po.id}/generate`))
    results.push({
      id: po.id,
      supplier_id: group.supplierId,
      supplier_name: supplierMeta?.name || group.lines[0]?.supplier_name || `Supplier #${group.supplierId}`,
      shipment_group_id: group.shipmentGroupId,
      supplier_reference: ref,
      line_count: group.lines.length,
      file_url: doc.file_url || doc.url || null,
      preview_url: `/purchase-orders/${po.id}/preview`,
    })
    seq += 1
  }
  return results
}

async function createQualityEventForFirstPo(selectionId, salesQuoteId, supplierOrders) {
  if (!supplierOrders.length) return null
  const targetPo = supplierOrders[supplierOrders.length - 1]
  const poLines = expect2xx('get po lines', await api.get(`/purchase-orders/${targetPo.id}/lines`))
  const firstLine = poLines[0]
  if (!firstLine) return null

  const event = expect2xx(
    'create supplier quality event',
    await api.post(`/suppliers/${targetPo.supplier_id}/quality-events`, {
      event_type: 'COMPLAINT',
      severity: 2,
      status: 'open',
      occurred_at: '2026-03-22',
      note: `Демо рекламация по заказу ${targetPo.supplier_reference}: повреждение уплотнений при приемке`,
      supplier_purchase_order_id: targetPo.id,
      supplier_purchase_order_line_id: firstLine.id,
      rfq_response_line_id: firstLine.rfq_response_line_id,
      selection_id: selectionId,
      selection_line_id: firstLine.selection_line_id,
      sales_quote_id: salesQuoteId,
      oem_part_id: firstLine.original_part_id,
      qty_affected: 1,
    })
  )
  return { supplier_purchase_order_id: targetPo.id, supplier_quality_event_id: event.id }
}

async function main() {
  log('API base', API_BASE_URL)

  const model = await sqlOne('SELECT id, model_name FROM equipment_models WHERE id = 1')
  if (!model) throw new Error('equipment_models.id=1 не найден')

  const tnvedDrive = await sqlOne('SELECT id, code, duty_rate FROM tnved_codes WHERE id = 80')
  const tnvedShaft = await sqlOne('SELECT id, code, duty_rate FROM tnved_codes WHERE id = 83')
  const tnvedBrake = await sqlOne('SELECT id, code, duty_rate FROM tnved_codes WHERE id = 79')
  const tnvedFrame = await sqlOne('SELECT id, code, duty_rate FROM tnved_codes WHERE id = 87')
  const tnvedSeal = await sqlOne('SELECT id, code, duty_rate FROM tnved_codes WHERE id = 86')
  if (!tnvedDrive || !tnvedShaft || !tnvedBrake || !tnvedFrame || !tnvedSeal) {
    throw new Error('Не найдены ожидаемые ТН ВЭД для demo-case')
  }

  const clientId = await createClient()
  const equipmentUnitId = await createEquipmentUnit(clientId, model.id)

  const driveAssemblyId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedDrive.id,
    catNumber: `${demoCode}-DRV-ASM`,
    descriptionRu: 'Главный привод в сборе',
    uom: 'set',
  })
  const gearboxAssemblyId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedShaft.id,
    catNumber: `${demoCode}-GBX-ASM`,
    descriptionRu: 'Редуктор в сборе',
    uom: 'set',
  })
  const intermediateShaftId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedShaft.id,
    catNumber: `${demoCode}-INT-SHAFT`,
    descriptionRu: 'Промежуточный вал',
  })
  const brakeBlockId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedBrake.id,
    catNumber: `${demoCode}-BRAKE-BLOCK`,
    descriptionRu: 'Блок тормоза',
  })
  const mountingFrameId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedFrame.id,
    catNumber: `${demoCode}-MOUNT-FRAME`,
    descriptionRu: 'Монтажная рама',
  })
  const sealKitId = await createOriginalPart({
    modelId: model.id,
    tnvedId: tnvedSeal.id,
    catNumber: `${demoCode}-SEAL-KIT`,
    descriptionRu: 'Комплект уплотнений',
  })

  await addBom(driveAssemblyId, gearboxAssemblyId, 1)
  await addBom(driveAssemblyId, mountingFrameId, 1)
  await addBom(gearboxAssemblyId, intermediateShaftId, 1)
  await addBom(gearboxAssemblyId, brakeBlockId, 1)

  const supplierWholeId = await createSupplier({
    name: `${demoCode} Шанхай Драйв Системс`,
    publicCode: `${demoCode.replace(/-/g, '').slice(-18)}W`,
    country: 'CN',
    reliability: 81,
    risk: 'medium',
  })
  const supplierGearboxId = await createSupplier({
    name: `${demoCode} Циндао Редуктор`,
    publicCode: `${demoCode.replace(/-/g, '').slice(-18)}G`,
    country: 'CN',
    reliability: 84,
    risk: 'low',
  })
  const supplierFrameId = await createSupplier({
    name: `${demoCode} Стамбул Металл`,
    publicCode: `${demoCode.replace(/-/g, '').slice(-18)}F`,
    country: 'TR',
    reliability: 77,
    risk: 'medium',
  })
  const supplierSealId = await createSupplier({
    name: `${demoCode} Анкара Сил Тех`,
    publicCode: `${demoCode.replace(/-/g, '').slice(-18)}S`,
    country: 'TR',
    reliability: 79,
    risk: 'low',
  })

  const wholeDriveSupplierPartId = await createSupplierPart({
    supplierId: supplierWholeId,
    number: `${demoCode}-W-DRV`,
    descriptionRu: 'Главный привод в сборе',
    weightKg: 210,
    leadTimeDays: 34,
    partType: 'OEM',
  })
  const wholeSealSupplierPartId = await createSupplierPart({
    supplierId: supplierWholeId,
    number: `${demoCode}-W-SEAL`,
    descriptionRu: 'Комплект уплотнений',
    weightKg: 8,
    leadTimeDays: 18,
    partType: 'OEM',
  })
  const gearboxSupplierPartId = await createSupplierPart({
    supplierId: supplierGearboxId,
    number: `${demoCode}-G-GBX`,
    descriptionRu: 'Редуктор в сборе',
    weightKg: 98,
    leadTimeDays: 23,
    partType: 'OEM',
  })
  const shaftSupplierPartId = await createSupplierPart({
    supplierId: supplierGearboxId,
    number: `${demoCode}-G-SHAFT`,
    descriptionRu: 'Промежуточный вал',
    weightKg: 34,
    leadTimeDays: 21,
    partType: 'OEM',
  })
  const frameSupplierPartId = await createSupplierPart({
    supplierId: supplierFrameId,
    number: `${demoCode}-F-FRAME`,
    descriptionRu: 'Монтажная рама',
    weightKg: 68,
    leadTimeDays: 19,
    partType: 'OEM',
  })
  const sealSupplierPartId = await createSupplierPart({
    supplierId: supplierSealId,
    number: `${demoCode}-S-SEAL`,
    descriptionRu: 'Комплект уплотнений',
    weightKg: 7,
    leadTimeDays: 14,
    partType: 'OEM',
  })

  await linkSupplierPartToOriginal(wholeDriveSupplierPartId, driveAssemblyId)
  await linkSupplierPartToOriginal(wholeSealSupplierPartId, sealKitId)
  await linkSupplierPartToOriginal(gearboxSupplierPartId, gearboxAssemblyId)
  await linkSupplierPartToOriginal(shaftSupplierPartId, intermediateShaftId)
  await linkSupplierPartToOriginal(frameSupplierPartId, mountingFrameId)
  await linkSupplierPartToOriginal(sealSupplierPartId, sealKitId)

  const requestId = await createClientRequest(clientId)
  const revisionId = await createRevision(requestId)

  const driveRequestItemId = await addRequestItem(revisionId, {
    oem_part_id: driveAssemblyId,
    equipment_model_id: model.id,
    client_description: 'Требуется главный привод в сборе на дробилку HP 800',
    requested_qty: 1,
    uom: 'set',
    priority: 'high',
    oem_only: 1,
    client_comment: 'Допустимы варианты: узел целиком или поставка узла по подузлам',
    internal_comment: 'Проверить whole-vs-multi supplier scenario',
  })
  const sealRequestItemId = await addRequestItem(revisionId, {
    oem_part_id: sealKitId,
    equipment_model_id: model.id,
    client_description: 'Дополнительно нужен комплект уплотнений',
    requested_qty: 2,
    uom: 'pcs',
    priority: 'medium',
    oem_only: 1,
    client_comment: 'Желательно добавить в общую поставку',
    internal_comment: 'Вторая строка для мультипоставочного выбора',
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
  const rfqDriveItem = rfqItems.find((row) => Number(row.client_request_revision_item_id) === Number(driveRequestItemId))
  const rfqSealItem = rfqItems.find((row) => Number(row.client_request_revision_item_id) === Number(sealRequestItemId))
  if (!rfqDriveItem || !rfqSealItem) throw new Error('RFQ items not found for created request items')

  const rfqWholeSupplierId = await addRfqSupplier(rfq.id, supplierWholeId)
  const rfqGearboxSupplierId = await addRfqSupplier(rfq.id, supplierGearboxId)
  const rfqFrameSupplierId = await addRfqSupplier(rfq.id, supplierFrameId)
  const rfqSealSupplierId = await addRfqSupplier(rfq.id, supplierSealId)

  await putLineSelections(rfq.id, rfqWholeSupplierId, [
    {
      selection_key: `DEMAND-${rfqDriveItem.id}`,
      rfq_item_id: rfqDriveItem.id,
      line_type: 'DEMAND',
      original_part_id: driveAssemblyId,
      line_label: 'Главный привод целиком',
      qty: 1,
      uom: 'set',
    },
    {
      selection_key: `DEMAND-${rfqSealItem.id}`,
      rfq_item_id: rfqSealItem.id,
      line_type: 'DEMAND',
      original_part_id: sealKitId,
      line_label: 'Комплект уплотнений',
      qty: 2,
      uom: 'pcs',
    },
  ])

  await putLineSelections(rfq.id, rfqGearboxSupplierId, [
    {
      selection_key: `BOM-${rfqDriveItem.id}-${gearboxAssemblyId}`,
      rfq_item_id: rfqDriveItem.id,
      line_type: 'BOM_COMPONENT',
      original_part_id: gearboxAssemblyId,
      line_label: 'Подузел: редуктор в сборе',
      qty: 1,
      uom: 'set',
    },
    {
      selection_key: `BOM-${rfqDriveItem.id}-${intermediateShaftId}`,
      rfq_item_id: rfqDriveItem.id,
      line_type: 'BOM_COMPONENT',
      original_part_id: intermediateShaftId,
      line_label: 'Компонент: промежуточный вал',
      qty: 1,
      uom: 'pcs',
    },
  ])

  await putLineSelections(rfq.id, rfqFrameSupplierId, [
    {
      selection_key: `BOM-${rfqDriveItem.id}-${mountingFrameId}`,
      rfq_item_id: rfqDriveItem.id,
      line_type: 'BOM_COMPONENT',
      original_part_id: mountingFrameId,
      line_label: 'Компонент: монтажная рама',
      qty: 1,
      uom: 'pcs',
    },
  ])

  await putLineSelections(rfq.id, rfqSealSupplierId, [
    {
      selection_key: `DEMAND-${rfqSealItem.id}`,
      rfq_item_id: rfqSealItem.id,
      line_type: 'DEMAND',
      original_part_id: sealKitId,
      line_label: 'Комплект уплотнений',
      qty: 2,
      uom: 'pcs',
    },
  ])

  const responseWholeDriveId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierWholeId,
    rfq_item_id: rfqDriveItem.id,
    selection_key: `DEMAND-${rfqDriveItem.id}`,
    supplier_part_id: wholeDriveSupplierPartId,
    original_part_id: driveAssemblyId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 1,
    moq: 1,
    packaging: 'crate',
    lead_time_days: 34,
    price: 6300,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Shanghai',
    origin_country: 'CN',
    note: 'Поставка узла целиком одним поставщиком',
  })
  const responseWholeSealId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierWholeId,
    rfq_item_id: rfqSealItem.id,
    selection_key: `DEMAND-${rfqSealItem.id}`,
    supplier_part_id: wholeSealSupplierPartId,
    original_part_id: sealKitId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 2,
    moq: 1,
    packaging: 'box',
    lead_time_days: 18,
    price: 95,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Shanghai',
    origin_country: 'CN',
    note: 'Уплотнения от поставщика whole',
  })
  const responseGearboxId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierGearboxId,
    rfq_item_id: rfqDriveItem.id,
    selection_key: `BOM-${rfqDriveItem.id}-${gearboxAssemblyId}`,
    supplier_part_id: gearboxSupplierPartId,
    original_part_id: gearboxAssemblyId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 1,
    moq: 1,
    packaging: 'crate',
    lead_time_days: 23,
    price: 2950,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Qingdao',
    origin_country: 'CN',
    note: 'Редуктор в сборе от профильного поставщика',
  })
  const responseShaftId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierGearboxId,
    rfq_item_id: rfqDriveItem.id,
    selection_key: `BOM-${rfqDriveItem.id}-${intermediateShaftId}`,
    supplier_part_id: shaftSupplierPartId,
    original_part_id: intermediateShaftId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 1,
    moq: 1,
    packaging: 'box',
    lead_time_days: 21,
    price: 1180,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FOB',
    incoterms_place: 'Qingdao',
    origin_country: 'CN',
    note: 'Промежуточный вал от поставщика редуктора',
  })
  const responseFrameId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierFrameId,
    rfq_item_id: rfqDriveItem.id,
    selection_key: `BOM-${rfqDriveItem.id}-${mountingFrameId}`,
    supplier_part_id: frameSupplierPartId,
    original_part_id: mountingFrameId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 1,
    moq: 1,
    packaging: 'pallet',
    lead_time_days: 19,
    price: 980,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '30/70',
    incoterms: 'FCA',
    incoterms_place: 'Istanbul',
    origin_country: 'TR',
    note: 'Монтажная рама от турецкого поставщика',
  })
  const responseSealId = await manualResponse({
    rfq_id: rfq.id,
    supplier_id: supplierSealId,
    rfq_item_id: rfqSealItem.id,
    selection_key: `DEMAND-${rfqSealItem.id}`,
    supplier_part_id: sealSupplierPartId,
    original_part_id: sealKitId,
    offer_type: 'OEM',
    supplier_reply_status: 'QUOTED',
    offered_qty: 2,
    moq: 1,
    packaging: 'box',
    lead_time_days: 14,
    price: 74,
    currency: 'USD',
    validity_days: 30,
    payment_terms: '100% TT',
    incoterms: 'FCA',
    incoterms_place: 'Istanbul',
    origin_country: 'TR',
    note: 'Уплотнения от специализированного поставщика',
  })

  const coverageWholeDriveId = await createCoverageOption(rfq.id, {
    rfq_item_id: rfqDriveItem.id,
    option_code: `${demoCode}-DRV-WHOLE`,
    option_kind: 'WHOLE',
    coverage_status: 'FULL',
    completeness_pct: 100,
    priced_pct: 100,
    is_oem_ok: 1,
    goods_total: 6300,
    goods_currency: 'USD',
    supplier_count: 1,
    lead_time_min_days: 34,
    lead_time_max_days: 34,
    note: 'Главный привод целиком от одного поставщика',
    lines: [
      {
        rfq_response_line_id: responseWholeDriveId,
        supplier_id: supplierWholeId,
        original_part_id: driveAssemblyId,
        line_code: `${demoCode}-DRV-WHOLE-L1`,
        line_role: 'WHOLE',
        line_status: 'SELECTED',
        qty: 1,
        uom: 'set',
        unit_price: 6300,
        goods_amount: 6300,
        goods_currency: 'USD',
        weight_kg: 210,
        lead_time_days: 34,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'CN',
        incoterms: 'FOB',
        incoterms_place: 'Shanghai',
        note: 'Whole drive',
      },
    ],
  })

  const coverageDriveMultiId = await createCoverageOption(rfq.id, {
    rfq_item_id: rfqDriveItem.id,
    option_code: `${demoCode}-DRV-MULTI`,
    option_kind: 'BOM',
    coverage_status: 'FULL',
    completeness_pct: 100,
    priced_pct: 100,
    is_oem_ok: 1,
    goods_total: 3930,
    goods_currency: 'USD',
    supplier_count: 2,
    lead_time_min_days: 19,
    lead_time_max_days: 23,
    note: 'Главный привод по подузлам от двух поставщиков',
    lines: [
      {
        rfq_response_line_id: responseGearboxId,
        supplier_id: supplierGearboxId,
        original_part_id: gearboxAssemblyId,
        line_code: `${demoCode}-DRV-MULTI-L1`,
        line_role: 'COMPONENT',
        line_status: 'SELECTED',
        qty: 1,
        uom: 'set',
        unit_price: 2950,
        goods_amount: 2950,
        goods_currency: 'USD',
        weight_kg: 98,
        lead_time_days: 23,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'CN',
        incoterms: 'FOB',
        incoterms_place: 'Qingdao',
        note: 'Редукторный узел',
      },
      {
        rfq_response_line_id: responseFrameId,
        supplier_id: supplierFrameId,
        original_part_id: mountingFrameId,
        line_code: `${demoCode}-DRV-MULTI-L2`,
        line_role: 'COMPONENT',
        line_status: 'SELECTED',
        qty: 1,
        uom: 'pcs',
        unit_price: 980,
        goods_amount: 980,
        goods_currency: 'USD',
        weight_kg: 68,
        lead_time_days: 19,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'TR',
        incoterms: 'FCA',
        incoterms_place: 'Istanbul',
        note: 'Монтажная рама',
      },
    ],
  })

  const coverageSealWholeId = await createCoverageOption(rfq.id, {
    rfq_item_id: rfqSealItem.id,
    option_code: `${demoCode}-SEAL-WHOLE`,
    option_kind: 'WHOLE',
    coverage_status: 'FULL',
    completeness_pct: 100,
    priced_pct: 100,
    is_oem_ok: 1,
    goods_total: 190,
    goods_currency: 'USD',
    supplier_count: 1,
    lead_time_min_days: 18,
    lead_time_max_days: 18,
    note: 'Комплект уплотнений от поставщика whole',
    lines: [
      {
        rfq_response_line_id: responseWholeSealId,
        supplier_id: supplierWholeId,
        original_part_id: sealKitId,
        line_code: `${demoCode}-SEAL-WHOLE-L1`,
        line_role: 'WHOLE',
        line_status: 'SELECTED',
        qty: 2,
        uom: 'pcs',
        unit_price: 95,
        goods_amount: 190,
        goods_currency: 'USD',
        weight_kg: 8,
        lead_time_days: 18,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'CN',
        incoterms: 'FOB',
        incoterms_place: 'Shanghai',
        note: 'Seal whole supplier',
      },
    ],
  })

  const coverageSealSpecId = await createCoverageOption(rfq.id, {
    rfq_item_id: rfqSealItem.id,
    option_code: `${demoCode}-SEAL-SPEC`,
    option_kind: 'WHOLE',
    coverage_status: 'FULL',
    completeness_pct: 100,
    priced_pct: 100,
    is_oem_ok: 1,
    goods_total: 148,
    goods_currency: 'USD',
    supplier_count: 1,
    lead_time_min_days: 14,
    lead_time_max_days: 14,
    note: 'Комплект уплотнений от специализированного поставщика',
    lines: [
      {
        rfq_response_line_id: responseSealId,
        supplier_id: supplierSealId,
        original_part_id: sealKitId,
        line_code: `${demoCode}-SEAL-SPEC-L1`,
        line_role: 'WHOLE',
        line_status: 'SELECTED',
        qty: 2,
        uom: 'pcs',
        unit_price: 74,
        goods_amount: 148,
        goods_currency: 'USD',
        weight_kg: 7,
        lead_time_days: 14,
        has_price: 1,
        is_oem_offer: 1,
        origin_country: 'TR',
        incoterms: 'FCA',
        incoterms_place: 'Istanbul',
        note: 'Seal specialized supplier',
      },
    ],
  })

  const scenarioSingleId = await createScenario(rfq.id, {
    name: `${demoCode} Один поставщик`,
    basis: 'MANUAL',
    calc_currency: 'USD',
    items: [
      { rfq_item_id: rfqDriveItem.id, coverage_option_id: coverageWholeDriveId },
      { rfq_item_id: rfqSealItem.id, coverage_option_id: coverageSealWholeId },
    ],
  })

  const scenarioMultiId = await createScenario(rfq.id, {
    name: `${demoCode} Несколько поставщиков`,
    basis: 'MANUAL',
    calc_currency: 'USD',
    items: [
      { rfq_item_id: rfqDriveItem.id, coverage_option_id: coverageDriveMultiId },
      { rfq_item_id: rfqSealItem.id, coverage_option_id: coverageSealSpecId },
    ],
  })

  await autoShipmentGroups(rfq.id, scenarioSingleId)
  await autoShipmentGroups(rfq.id, scenarioMultiId)
  await selectFirstRoutesForScenario(rfq.id, scenarioSingleId)
  await selectFirstRoutesForScenario(rfq.id, scenarioMultiId)
  await recalculateScenario(rfq.id, scenarioSingleId)
  await recalculateScenario(rfq.id, scenarioMultiId)

  const selectionId = await finalizeSelection(rfq.id, scenarioMultiId)
  log('selection finalized', selectionId)

  const { quoteId, revisionId: quoteRevisionId } = await createSalesQuote(revisionId, selectionId)
  log('commercial proposal created', { quoteId, quoteRevisionId })
  const quoteLines = await updateQuoteLines(quoteRevisionId)
  log('commercial proposal lines updated', quoteLines.length)
  await patchQuoteStatus(quoteId)
  log('commercial proposal approved', quoteId)
  const quoteAmount = Number(sumSellAmount(quoteLines).toFixed(2))
  const contractId = await createSignedContract(quoteId, quoteRevisionId, quoteAmount, 'USD')
  log('contract signed', contractId)
  const contractDoc = expect2xx('generate contract docx', await api.post(`/contracts/${contractId}/generate`))
  log('contract doc generated', contractDoc?.file_url || contractDoc?.url || 'ok')

  const supplierOrders = await createSupplierOrders(selectionId, [
    { id: supplierWholeId, name: `${demoCode} Шанхай Драйв Системс` },
    { id: supplierGearboxId, name: `${demoCode} Циндао Редуктор` },
    { id: supplierFrameId, name: `${demoCode} Стамбул Металл` },
    { id: supplierSealId, name: `${demoCode} Анкара Сил Тех` },
  ])
  log('supplier orders created', supplierOrders.length)
  const quality = await createQualityEventForFirstPo(selectionId, quoteId, supplierOrders)
  log('quality event created', quality)

  const selectionLines = expect2xx('load final selection lines', await api.get(`/selection/${selectionId}/lines`))
  const selectedSuppliers = Array.from(
    new Map(selectionLines.map((line) => [Number(line.supplier_id), {
      supplier_id: Number(line.supplier_id),
      supplier_name: line.supplier_name,
    }])).values()
  )

  const summary = {
    demo_code: demoCode,
    client_id: clientId,
    equipment_unit_id: equipmentUnitId,
    request_id: requestId,
    request_revision_id: revisionId,
    rfq_id: rfq.id,
    rfq_number: rfq.rfq_number,
    rfq_item_ids: {
      drive_assembly: rfqDriveItem.id,
      seal_kit: rfqSealItem.id,
    },
    original_part_ids: {
      drive_assembly: driveAssemblyId,
      gearbox_assembly: gearboxAssemblyId,
      intermediate_shaft: intermediateShaftId,
      brake_block: brakeBlockId,
      mounting_frame: mountingFrameId,
      seal_kit: sealKitId,
    },
    coverage_option_ids: {
      drive_whole: coverageWholeDriveId,
      drive_multi: coverageDriveMultiId,
      seal_whole: coverageSealWholeId,
      seal_specialized: coverageSealSpecId,
    },
    scenario_ids: {
      single_supplier: scenarioSingleId,
      multi_supplier: scenarioMultiId,
    },
    selection_id: selectionId,
    sales_quote_id: quoteId,
    sales_quote_revision_id: quoteRevisionId,
    contract_id: contractId,
    contract_docx_url: contractDoc.file_url || contractDoc.url || null,
    contract_preview_url: `/contracts/${contractId}/preview`,
    supplier_ids: {
      whole_supplier: supplierWholeId,
      gearbox_supplier: supplierGearboxId,
      frame_supplier: supplierFrameId,
      seal_supplier: supplierSealId,
    },
    selected_suppliers: selectedSuppliers,
    supplier_orders: supplierOrders,
    quality_event: quality,
  }

  const outDir = path.resolve(__dirname, '..', 'tmp')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${demoCode}.json`)
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2))

  log('Multi-supplier demo-case created successfully')
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
