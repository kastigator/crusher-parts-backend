const crypto = require('crypto')
const db = require('../../utils/db')

const MAX_ROWS = 500
const MATCH_CANDIDATE_LIMIT = 5

const cleanText = (value, max = 1000) => {
  if (value === undefined || value === null) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

const normalizeLookup = (value) => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s\-_/.,:;()[\]{}]+/g, '')
  .trim()

const tokenize = (...values) => Array.from(new Set(
  values
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[a-zа-яё0-9]{3,}/giu) || []
)).slice(0, 24)

const parseQuantity = (value) => {
  if (value === undefined || value === null || value === '') return null
  const number = Number(String(value).replace(',', '.'))
  return Number.isFinite(number) && number > 0 ? number : null
}

const normalizeDate = (value) => {
  if (!value) return null
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null
}

const normalizeRow = (raw = {}, index = 0, defaults = {}) => {
  const sourceRow = Number(raw.source_row || raw.row_number) || index + 1
  const description = cleanText(raw.client_description ?? raw.description ?? raw.client_line_text)
  const catalogNumber = cleanText(raw.client_catalog_number ?? raw.catalog_number ?? raw.part_number, 150)
  const manufacturer = cleanText(raw.client_manufacturer_text ?? raw.manufacturer ?? defaults.client_manufacturer_text, 255)
  const model = cleanText(raw.client_equipment_model_text ?? raw.equipment_model ?? raw.model ?? defaults.client_equipment_model_text, 255)
  const quantity = parseQuantity(raw.requested_qty ?? raw.quantity ?? defaults.requested_qty)
  const uom = cleanText(raw.uom ?? defaults.uom ?? 'шт', 32)
  const requiredDateInput = raw.required_date ?? defaults.required_date
  const requiredDate = normalizeDate(requiredDateInput)
  const selectedCatalogPositionId = Number(raw.confirmed_catalog_position_id || raw.catalog_position_id) || null
  const errors = []
  if (!description && !catalogNumber) errors.push({ code: 'SOURCE_REQUIRED', message: 'Укажите описание или каталожный номер' })
  if (quantity === null) errors.push({ code: 'INVALID_QUANTITY', message: 'Количество должно быть больше нуля' })
  if (!uom) errors.push({ code: 'MISSING_UOM', message: 'Укажите единицу измерения' })
  if (requiredDateInput && !requiredDate) errors.push({ code: 'INVALID_DATE', message: 'Дата должна быть в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД' })
  return {
    row_key: cleanText(raw.row_key, 80) || `row-${sourceRow}`,
    source_row: sourceRow,
    client_description: description,
    client_catalog_number: catalogNumber,
    client_manufacturer_text: manufacturer,
    client_equipment_model_text: model,
    requested_qty: quantity,
    uom,
    required_date: requiredDate,
    client_comment: cleanText(raw.client_comment ?? raw.comment),
    priority: cleanText(raw.priority ?? defaults.priority, 16) || 'normal',
    confirmed_catalog_position_id: selectedCatalogPositionId,
    source_payload: raw.source_payload && typeof raw.source_payload === 'object' ? raw.source_payload : raw,
    errors,
  }
}

const duplicateKey = (row) => [
  normalizeLookup(row.client_catalog_number),
  normalizeLookup(row.client_description),
  normalizeLookup(row.client_manufacturer_text),
  normalizeLookup(row.client_equipment_model_text),
].join('|')

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const hashPayload = (value) => crypto.createHash('sha256').update(stableJson(value)).digest('hex')

const candidateProjection = (row, score, reasons) => ({
  catalog_position_id: Number(row.id),
  position_code: row.position_code || null,
  manufacturer_part_number: row.manufacturer_part_number || null,
  name: row.display_name_ru || row.display_name || row.display_name_en || row.description || null,
  manufacturer_name: row.manufacturer_name || null,
  equipment_model_name: row.model_name || null,
  classifier_node_name: row.classifier_node_name || null,
  score,
  reasons,
})

const scoreCandidate = (source, candidate) => {
  const reasons = []
  let score = 0
  const sourceNumber = normalizeLookup(source.client_catalog_number)
  const candidateNumbers = [candidate.manufacturer_part_number, candidate.position_code].map(normalizeLookup).filter(Boolean)
  if (sourceNumber && candidateNumbers.includes(sourceNumber)) {
    score += 100
    reasons.push('Точное совпадение номера')
  } else if (sourceNumber && candidateNumbers.some((value) => value.includes(sourceNumber) || sourceNumber.includes(value))) {
    score += 55
    reasons.push('Частичное совпадение номера')
  }

  const sourceManufacturer = normalizeLookup(source.client_manufacturer_text)
  const candidateManufacturer = normalizeLookup(candidate.manufacturer_name)
  if (sourceManufacturer && candidateManufacturer && (candidateManufacturer.includes(sourceManufacturer) || sourceManufacturer.includes(candidateManufacturer))) {
    score += 20
    reasons.push('Совпадает производитель')
  }

  const sourceModel = normalizeLookup(source.client_equipment_model_text)
  const candidateModel = normalizeLookup(candidate.model_name)
  if (sourceModel && candidateModel && (candidateModel.includes(sourceModel) || sourceModel.includes(candidateModel))) {
    score += 15
    reasons.push('Совпадает модель оборудования')
  }

  const sourceTokens = tokenize(source.client_description)
  const candidateTokens = new Set(tokenize(
    candidate.display_name_ru,
    candidate.display_name,
    candidate.display_name_en,
    candidate.description,
    candidate.classifier_node_name
  ))
  const common = sourceTokens.filter((token) => candidateTokens.has(token))
  if (common.length) {
    score += Math.min(35, common.length * 7)
    reasons.push(`Совпадает описание: ${common.slice(0, 4).join(', ')}`)
  }
  return { score, reasons, exactNumber: sourceNumber && candidateNumbers.includes(sourceNumber) }
}

const classifyRows = (rows, catalogRows = []) => {
  const duplicateGroups = new Map()
  for (const row of rows) {
    const key = duplicateKey(row)
    if (key !== '|||') duplicateGroups.set(key, [...(duplicateGroups.get(key) || []), row.source_row])
  }

  const activeIds = new Set(catalogRows.map((row) => Number(row.id)))
  return rows.map((row) => {
    const duplicateRows = duplicateGroups.get(duplicateKey(row)) || []
    if (row.errors.length) return { ...row, match_status: 'malformed', candidates: [], duplicate_rows: duplicateRows }
    if (duplicateRows.length > 1) {
      return {
        ...row,
        match_status: 'duplicate',
        errors: [{ code: 'DUPLICATE_SOURCE_ROW', message: `Строка повторяется: ${duplicateRows.join(', ')}` }],
        candidates: [],
        duplicate_rows: duplicateRows,
      }
    }
    if (row.confirmed_catalog_position_id) {
      if (!activeIds.has(Number(row.confirmed_catalog_position_id))) {
        return {
          ...row,
          match_status: 'malformed',
          errors: [{ code: 'CATALOG_POSITION_NOT_FOUND', message: 'Выбранная позиция каталога недоступна' }],
          candidates: [],
          duplicate_rows: [],
        }
      }
      const selected = catalogRows.find((item) => Number(item.id) === Number(row.confirmed_catalog_position_id))
      return { ...row, match_status: 'already_resolved', candidates: [candidateProjection(selected, 100, ['Выбрано пользователем'])], duplicate_rows: [] }
    }

    const scored = catalogRows
      .map((candidate) => ({ candidate, ...scoreCandidate(row, candidate) }))
      .filter((entry) => entry.score >= 20)
      .sort((a, b) => b.score - a.score || Number(a.candidate.id) - Number(b.candidate.id))
    const exact = scored.filter((entry) => entry.exactNumber)
    const candidates = (exact.length ? exact : scored).slice(0, MATCH_CANDIDATE_LIMIT)
      .map((entry) => candidateProjection(entry.candidate, entry.score, entry.reasons))
    const matchStatus = exact.length === 1 ? 'exact_unique' : candidates.length ? 'probable' : 'no_match'
    return { ...row, match_status: matchStatus, candidates, duplicate_rows: [] }
  })
}

const loadCatalogSearchModel = async (executor = db) => {
  const [rows] = await executor.execute(
    `SELECT cp.id, cp.position_code, cp.manufacturer_part_number,
            cp.display_name, cp.display_name_ru, cp.display_name_en, cp.description,
            mf.name AS manufacturer_name, em.model_name, n.name AS classifier_node_name
       FROM catalog_positions cp
       JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
       LEFT JOIN equipment_manufacturers mf ON mf.id = cp.manufacturer_id
       LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      WHERE cp.is_active = 1 AND (cp.status IS NULL OR cp.status <> 'archived')
      ORDER BY cp.id`
  )
  return rows
}

const validateBatch = async (payload = {}, executor = db) => {
  const inputRows = Array.isArray(payload.rows) ? payload.rows : []
  if (!inputRows.length) return { rows: [], summary: { total: 0, errors: 1 }, errors: [{ code: 'EMPTY_BATCH', message: 'Добавьте хотя бы одну позицию' }] }
  if (inputRows.length > MAX_ROWS) return { rows: [], summary: { total: inputRows.length, errors: 1 }, errors: [{ code: 'BATCH_TOO_LARGE', message: `За один раз можно обработать не более ${MAX_ROWS} строк` }] }
  const normalizedRows = inputRows.map((row, index) => normalizeRow(row, index, payload.defaults || {}))
  const catalogRows = await loadCatalogSearchModel(executor)
  const rows = classifyRows(normalizedRows, catalogRows)
  const summary = rows.reduce((result, row) => {
    result.total += 1
    result[row.match_status] = (result[row.match_status] || 0) + 1
    if (row.errors.length) result.errors += 1
    return result
  }, { total: 0, errors: 0, exact_unique: 0, probable: 0, no_match: 0, duplicate: 0, malformed: 0, already_resolved: 0 })
  const hashInput = {
    header: payload.header || {},
    rows: rows.map(({ source_payload, candidates, errors, duplicate_rows, ...row }) => ({ ...row, candidates, errors, duplicate_rows })),
  }
  return { rows, summary, errors: [], payload_hash: hashPayload(hashInput) }
}

module.exports = {
  MAX_ROWS,
  classifyRows,
  cleanText,
  hashPayload,
  loadCatalogSearchModel,
  normalizeLookup,
  normalizeRow,
  stableJson,
  validateBatch,
}
