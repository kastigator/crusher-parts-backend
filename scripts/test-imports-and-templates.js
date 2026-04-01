#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const XLSX = require('xlsx')
const dotenv = require('dotenv')
const db = require('../utils/db')

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
  responseType: 'json',
  validateStatus: () => true,
})

const runId = `import-audit-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const outDir = path.resolve(__dirname, '..', 'tmp', runId)
fs.mkdirSync(outDir, { recursive: true })

const expect2xx = (label, response) => {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed: ${JSON.stringify(response?.data || response)}`)
  }
  return response.data
}

const saveBuffer = (filePath, buffer) => {
  fs.writeFileSync(filePath, Buffer.from(buffer))
}

const readHeaders = (filePath) => {
  const wb = XLSX.readFile(filePath)
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  return Array.isArray(rows[0]) ? rows[0] : []
}

const normalizeSupplierPriceListHeader = (value) => {
  const s = String(value || '').trim()
  if (!s) return ''
  return s
    .toLowerCase()
    .replace(/[№#]/g, 'number')
    .replace(/\s+/g, '')
    .replace(/[^a-zа-я0-9_]/gi, '')
}

const makeWorkbookByHeaders = (headers, valueByHeader) => {
  const row = headers.map((header) => valueByHeader[header] ?? '')
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([headers, row])
  XLSX.utils.book_append_sheet(wb, ws, 'import')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

const mapHeaderRowToImportRow = (headers, valueByHeader, headerMap) => {
  const row = {}
  headers.forEach((header) => {
    const field = headerMap[header]
    if (!field) return
    row[field] = valueByHeader[header] ?? ''
  })
  return row
}

const assertTemplateMatchesSchema = ({ type, headers, schema }) => {
  const requiredFields = Array.isArray(schema?.requiredFields) ? schema.requiredFields : []
  const missingRequired = requiredFields.filter((field) => !headers.some((header) => schema?.headerMap?.[header] === field))
  if (missingRequired.length) {
    throw new Error(
      `${type} template/schema mismatch: required fields without template columns: ${missingRequired.join(', ')}`
    )
  }
}

const assertClientRequestTemplateHeaders = (headers) => {
  const requiredHeaders = ['Кат. номер*', 'Кол-во*']
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header))
  if (missingHeaders.length) {
    throw new Error(`client_requests template mismatch: missing required headers: ${missingHeaders.join(', ')}`)
  }
}

const assertSupplierPriceListTemplateHeaders = (headers) => {
  const aliasMap = {
    'Номер у поставщика': ['номерупоставщика'],
    'Цена': ['цена', 'price', 'стоимость'],
    'Валюта (ISO3)': ['валюта', 'currency', 'iso3', 'валютаiso3'],
    'Тип предложения (OEM/ANALOG)': ['типпредложения', 'тип', 'offertype', 'типпредложенияoemanalog'],
  }
  const missingHeaders = Object.entries(aliasMap)
    .filter(([header, aliases]) => {
      const normalized = normalizeSupplierPriceListHeader(header)
      return !aliases.includes(normalized)
    })
    .map(([header]) => header)
  if (missingHeaders.length) {
    throw new Error(`supplier_price_lists template mismatch: parser aliases do not cover headers: ${missingHeaders.join(', ')}`)
  }
  const absentInTemplate = Object.keys(aliasMap).filter((header) => !headers.includes(header))
  if (absentInTemplate.length) {
    throw new Error(`supplier_price_lists template mismatch: template is missing expected headers: ${absentInTemplate.join(', ')}`)
  }
}

async function downloadTemplate(type) {
  const response = await axios.get(`${API_BASE_URL}/import/template/${type}`, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    validateStatus: () => true,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`download template ${type} failed: ${JSON.stringify(response.data?.toString?.() || response.status)}`)
  }
  const filePath = path.join(outDir, `${type}_template.xlsx`)
  saveBuffer(filePath, response.data)
  return filePath
}

async function getSchema(type) {
  return expect2xx(`schema ${type}`, await api.get(`/import/schema/${type}`))
}

async function downloadBinary(pathname, outFileName) {
  const response = await axios.get(`${API_BASE_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    validateStatus: () => true,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`download ${pathname} failed: ${JSON.stringify(response.data?.toString?.() || response.status)}`)
  }
  const filePath = path.join(outDir, outFileName)
  saveBuffer(filePath, response.data)
  return filePath
}

async function main() {
  const results = {
    run_id: runId,
    out_dir: outDir,
    templates: {},
    template_checks: {},
    imports: {},
    rfq_response_import: {},
  }

  const [modelRows] = await db.execute('SELECT id, manufacturer_id FROM equipment_models ORDER BY id ASC LIMIT 1')
  if (!modelRows.length) throw new Error('No equipment_models found')
  const equipmentModelId = Number(modelRows[0].id)

  const ts = Date.now()
  const supplierPublicCode = `IMP-SUP-${ts}`
  const supplierPartNumber = `IMP-SP-${ts}`
  const oemPartNumber = `IMP-OEM-${ts}`
  const tnvedCode = `9900${String(ts).slice(-6)}`

  const types = ['tnved_codes', 'suppliers', 'supplier_parts', 'original_parts']
  const schemaMap = {}
  for (const type of types) {
    const templatePath = await downloadTemplate(type)
    const schema = await getSchema(type)
    schemaMap[type] = schema
    const headers = readHeaders(templatePath)
    assertTemplateMatchesSchema({ type, headers, schema })
    results.templates[type] = {
      file: templatePath,
      headers,
    }
  }

  const clientRequestTemplatePath = await downloadBinary(
    '/client-requests/import-template/items',
    'client_request_items_template.xlsx'
  )
  const clientRequestHeaders = readHeaders(clientRequestTemplatePath)
  assertClientRequestTemplateHeaders(clientRequestHeaders)
  results.template_checks.client_request_items = {
    file: clientRequestTemplatePath,
    headers: clientRequestHeaders,
  }

  const supplierPriceListTemplatePath = await downloadBinary(
    '/supplier-price-lists/template',
    'supplier_price_list_template.xlsx'
  )
  const supplierPriceListHeaders = readHeaders(supplierPriceListTemplatePath)
  assertSupplierPriceListTemplateHeaders(supplierPriceListHeaders)
  results.template_checks.supplier_price_list = {
    file: supplierPriceListTemplatePath,
    headers: supplierPriceListHeaders,
  }

  const supplierHeaderValues = {
    'Название (обязательно)': `Import Supplier ${ts}`,
    'Публичный код*': supplierPublicCode,
    'VAT / ИНН': `VAT-${ts}`,
    'Страна (ISO2)': 'CN',
    'Сайт': 'https://example.test',
    'Условия оплаты': '30% предоплата / 70% перед отгрузкой',
    'Валюта (ISO3)': 'USD',
    'Точка самовывоза / pickup': 'Shanghai',
    'Работает с OEM (1/0)': 1,
    'Работает с аналогами (1/0)': 1,
    'Срок поставки, дни': 25,
    'Примечания': 'Тестовый импорт поставщика',
  }
  const suppliersFilled = path.join(outDir, 'suppliers_filled.xlsx')
  saveBuffer(suppliersFilled, makeWorkbookByHeaders(results.templates.suppliers.headers, supplierHeaderValues))
  const supplierImportRow = mapHeaderRowToImportRow(results.templates.suppliers.headers, supplierHeaderValues, schemaMap.suppliers.headerMap)
  results.imports.suppliers = expect2xx('import suppliers', await api.post('/import/suppliers', { rows: [supplierImportRow] }))

  const [[supplierRow]] = await db.execute('SELECT * FROM part_suppliers WHERE public_code = ? LIMIT 1', [supplierPublicCode])
  if (!supplierRow?.id) throw new Error('Imported supplier not found')

  const supplierPartHeaderValues = {
    'Номер у поставщика*': supplierPartNumber,
    'Описание (RU)': 'Тестовая деталь поставщика',
    'Description (EN)': 'Imported supplier part',
    'Ед. изм.': 'pcs',
    'Комментарий': 'Тестовый импорт',
    'Срок поставки, дни': 17,
    MOQ: 2,
    'Упаковка': 'Box',
    'Активна (1/0)': 1,
    'Каталожный номер OEM': oemPartNumber,
    'Вес, кг': 14.2,
    'Длина, см': 55,
    'Ширина, см': 21,
    'Высота, см': 19,
    'Сверхтяжелая (1/0)': 0,
    'Негабарит (1/0)': 0,
    'Тип детали': 'OEM',
    'Цена': 1450,
    'Валюта': 'USD',
    'Валюта наценки': 'USD',
    'Наценка, %': 12,
    'Наценка, сумма': 0,
  }
  const supplierPartsFilled = path.join(outDir, 'supplier_parts_filled.xlsx')
  saveBuffer(supplierPartsFilled, makeWorkbookByHeaders(results.templates.supplier_parts.headers, supplierPartHeaderValues))
  const supplierPartImportRow = mapHeaderRowToImportRow(
    results.templates.supplier_parts.headers,
    supplierPartHeaderValues,
    schemaMap.supplier_parts.headerMap
  )
  results.imports.supplier_parts = expect2xx(
    'import supplier_parts',
    await api.post(`/import/supplier_parts?supplier_id=${supplierRow.id}`, { rows: [supplierPartImportRow] })
  )

  const tnvedHeaderValues = {
    'Код': tnvedCode,
    'Описание': 'Тестовый ТН ВЭД импорт',
    'Ставка пошлины (%)': 7.5,
    'Примечания': 'Автотест',
  }
  const tnvedFilled = path.join(outDir, 'tnved_codes_filled.xlsx')
  saveBuffer(tnvedFilled, makeWorkbookByHeaders(results.templates.tnved_codes.headers, tnvedHeaderValues))
  const tnvedImportRow = mapHeaderRowToImportRow(
    results.templates.tnved_codes.headers,
    tnvedHeaderValues,
    schemaMap.tnved_codes.headerMap
  )
  results.imports.tnved_codes = expect2xx('import tnved_codes', await api.post('/import/tnved_codes', { rows: [tnvedImportRow] }))

  const originalHeaderValues = {
    'Каталожный номер*': oemPartNumber,
    'Description (EN)': 'Imported OEM part',
    'Описание (RU)': 'Импортированная OEM деталь',
    'Тех. описание': 'Создано из автотеста',
    'Ед. изм.': 'pcs',
    'Код ТН ВЭД': tnvedCode,
    'ID группы': '',
    'Есть чертеж (1/0)': 1,
    'Негабарит (1/0)': 0,
    'Сверхтяжелая (1/0)': 0,
  }
  const originalFilled = path.join(outDir, 'original_parts_filled.xlsx')
  saveBuffer(originalFilled, makeWorkbookByHeaders(results.templates.original_parts.headers, originalHeaderValues))
  const originalImportRow = mapHeaderRowToImportRow(
    results.templates.original_parts.headers,
    originalHeaderValues,
    schemaMap.original_parts.headerMap
  )
  results.imports.original_parts = expect2xx(
    'import original_parts',
    await api.post(`/import/original_parts?equipment_model_id=${equipmentModelId}`, { rows: [originalImportRow] })
  )

  const [[importedSupplierPart]] = await db.execute(
    'SELECT * FROM supplier_parts WHERE supplier_id = ? AND supplier_part_number = ? LIMIT 1',
    [supplierRow.id, supplierPartNumber]
  )
  const [[importedOemPart]] = await db.execute(
    `SELECT p.*, EXISTS(SELECT 1 FROM oem_part_model_fitments f WHERE f.oem_part_id = p.id AND f.equipment_model_id = ?) AS fitted_to_model
       FROM oem_parts p
      WHERE p.manufacturer_id = ? AND p.part_number = ?
      LIMIT 1`,
    [equipmentModelId, modelRows[0].manufacturer_id, oemPartNumber]
  )

  results.imports._created_entities = {
    supplier_id: supplierRow.id,
    supplier_part_id: importedSupplierPart?.id || null,
    oem_part_id: importedOemPart?.id || null,
    equipment_model_id: equipmentModelId,
  }

  const [[demoRfq]] = await db.execute(
    `SELECT id, supplier_id
       FROM rfq_suppliers
      WHERE rfq_id = 94 AND supplier_id = 41
      LIMIT 1`
  )
  if (!demoRfq) throw new Error('Demo RFQ supplier not found')

  const [[spareLine]] = await db.execute(
    `SELECT ri.id AS rfq_item_id,
            cri.line_number,
            rfls.selection_key
       FROM rfq_items ri
       JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
       JOIN rfq_supplier_line_selections rfls
         ON rfls.rfq_item_id = ri.id
        AND rfls.rfq_supplier_id = ?
      WHERE ri.rfq_id = ?
        AND cri.line_number = 2
      LIMIT 1`,
    [demoRfq.id, 94]
  )
  if (!spareLine) throw new Error('Demo spare RFQ line not found')

  const responseImportRow = {
    line_number: spareLine.line_number,
    selection_key: spareLine.selection_key,
    supplier_reply_status: 'QUOTED',
    offer_type: 'OEM',
    price: 188.5,
    currency: 'USD',
    lead_time_days: 11,
    moq: 1,
    packaging: 'Box',
    supplier_part_number: `RFQ-IMP-SP-${ts}`,
    supplier_description: 'Created from RFQ import',
    weight_kg: 6.4,
    incoterms: 'FOB',
    incoterms_place: 'Shanghai',
    origin_country: 'CN',
    note: 'Тест импорта ответа поставщика',
  }

  results.rfq_response_import.preview = expect2xx(
    'rfq response import preview',
    await api.post('/rfqs/94/responses/import', {
      supplier_id: 41,
      preview: true,
      rows: [responseImportRow],
    })
  )

  results.rfq_response_import.actual = expect2xx(
    'rfq response import actual',
    await api.post('/rfqs/94/responses/import', {
      supplier_id: 41,
      preview: false,
      rows: [responseImportRow],
    })
  )

  const [[importedResponseLine]] = await db.execute(
    `SELECT rl.id, rl.origin_country, rl.supplier_part_id, sp.supplier_part_number
       FROM rfq_response_lines rl
       LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
      WHERE rl.rfq_item_id = ?
        AND sp.supplier_part_number = ?
      ORDER BY rl.id DESC
      LIMIT 1`,
    [spareLine.rfq_item_id, responseImportRow.supplier_part_number]
  )
  results.rfq_response_import.created_line = importedResponseLine || null

  const summaryPath = path.join(outDir, 'summary.json')
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ ok: true, summary_path: summaryPath, results }, null, 2))
}

main()
  .then(() => db.end())
  .catch(async (err) => {
    console.error(err.message || err)
    try { await db.end() } catch (_) {}
    process.exit(1)
  })
