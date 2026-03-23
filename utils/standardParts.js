const { normalizeUom } = require('./uom')

const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'date'])

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const toBool = (v) => v === true || v === '1' || v === 1 || v === 'true'

const clampLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const sqlValue = (v) => (v === undefined ? null : v)

const parseCanonicalUom = (value, fallback = 'pcs') => {
  const { uom, error } = normalizeUom(value || fallback, { allowEmpty: false })
  if (error || uom === undefined) {
    return { uom: null, error: error || 'Единица измерения обязательна' }
  }
  return { uom, error: null }
}

const normalizeFieldType = (value) => {
  const type = String(value || '').trim().toLowerCase()
  return FIELD_TYPES.has(type) ? type : null
}

const buildTree = (rows = []) => {
  const byId = new Map()
  const roots = []

  rows.forEach((row) => byId.set(Number(row.id), { ...row, children: [] }))

  byId.forEach((node) => {
    const parentId = toId(node.parent_id)
    if (parentId && byId.has(parentId)) {
      byId.get(parentId).children.push(node)
    } else {
      roots.push(node)
    }
  })

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      const orderDiff = Number(a.sort_order || 0) - Number(b.sort_order || 0)
      if (orderDiff !== 0) return orderDiff
      return String(a.name || '').localeCompare(String(b.name || ''), 'ru')
    })
    nodes.forEach((node) => sortNodes(node.children || []))
  }

  sortNodes(roots)
  return roots
}

const normalizeDateValue = (value) => {
  const raw = nz(value)
  if (!raw) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  return raw
}

const normalizeFieldInput = (field, rawValue) => {
  const type = normalizeFieldType(field?.field_type)
  if (!type) return { error: `Некорректный тип поля ${field?.code || field?.id || ''}` }

  if (type === 'text' || type === 'textarea' || type === 'select') {
    return { value_text: nz(rawValue), value_json: null }
  }

  if (type === 'number') {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return { value_number: null }
    }
    const n = Number(String(rawValue).replace(',', '.'))
    if (!Number.isFinite(n)) return { error: `Поле ${field.label || field.code}: нужно число` }
    return { value_number: n }
  }

  if (type === 'boolean') {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return { value_boolean: null }
    }
    return { value_boolean: toBool(rawValue) ? 1 : 0 }
  }

  if (type === 'date') {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return { value_date: null }
    }
    const value = normalizeDateValue(rawValue)
    if (!value) return { error: `Поле ${field.label || field.code}: нужна дата в формате YYYY-MM-DD` }
    return { value_date: value }
  }

  if (type === 'multiselect') {
    const values = Array.isArray(rawValue)
      ? rawValue.map((item) => nz(item)).filter(Boolean)
      : nz(rawValue)
      ? [nz(rawValue)]
      : []
    return { value_json: values.length ? JSON.stringify(values) : null }
  }

  return { error: `Тип поля ${type} пока не поддержан` }
}

const extractDisplayValue = (field, valueRow, optionsMap = new Map()) => {
  const type = normalizeFieldType(field?.field_type)
  if (!type || !valueRow) return null

  if (type === 'text' || type === 'textarea' || type === 'select') {
    const raw = nz(valueRow.value_text)
    if (!raw) return null
    if (type === 'select' && optionsMap.has(raw)) return optionsMap.get(raw)
    return raw
  }

  if (type === 'number') {
    return valueRow.value_number === null || valueRow.value_number === undefined
      ? null
      : String(Number(valueRow.value_number))
  }

  if (type === 'boolean') {
    if (valueRow.value_boolean === null || valueRow.value_boolean === undefined) return null
    return Number(valueRow.value_boolean) === 1 ? 'Да' : 'Нет'
  }

  if (type === 'date') {
    return valueRow.value_date || null
  }

  if (type === 'multiselect') {
    let arr = []
    try {
      arr = Array.isArray(valueRow.value_json)
        ? valueRow.value_json
        : JSON.parse(valueRow.value_json || '[]')
    } catch {
      arr = []
    }
    if (!arr.length) return null
    return arr.map((item) => optionsMap.get(String(item)) || String(item)).join(', ')
  }

  return null
}

const buildDisplayName = ({ classRow, fields = [], valuesByFieldId = new Map(), optionsByFieldId = new Map(), designation }) => {
  const titleParts = []
  const titleFields = fields
    .filter((field) => Number(field.is_in_title || 0) === 1 && Number(field.is_active || 0) === 1)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))

  titleFields.forEach((field) => {
    const valueRow = valuesByFieldId.get(Number(field.id))
    const value = extractDisplayValue(field, valueRow, optionsByFieldId.get(Number(field.id)) || new Map())
    if (!value) return
    titleParts.push(value)
  })

  if (!titleParts.length && designation) titleParts.push(String(designation).trim())
  if (!titleParts.length) titleParts.push('Без названия')

  const prefix = nz(classRow?.name)
  return prefix ? `${prefix} ${titleParts.join(' ')}`.trim() : titleParts.join(' ').trim()
}

const buildSearchText = ({ classRow, displayName, designation, descriptions = [], values = [], fieldsById = new Map(), optionsByFieldId = new Map() }) => {
  const chunks = []
  if (classRow?.name) chunks.push(classRow.name)
  if (displayName) chunks.push(displayName)
  if (designation) chunks.push(designation)
  descriptions.forEach((item) => {
    if (item) chunks.push(item)
  })
  values.forEach((row) => {
    const field = fieldsById.get(Number(row.field_id))
    if (!field || Number(field.is_searchable || 0) !== 1) return
    const value = extractDisplayValue(field, row, optionsByFieldId.get(Number(field.id)) || new Map())
    if (value) chunks.push(value)
  })
  return chunks.join(' | ').trim() || null
}

const normalizeAttributeInput = (payload = []) => {
  if (!Array.isArray(payload)) return []
  return payload
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      return {
        field_id: toId(entry.field_id),
        field_code: nz(entry.field_code),
        value: Object.prototype.hasOwnProperty.call(entry, 'value') ? entry.value : undefined,
      }
    })
    .filter(Boolean)
}

module.exports = {
  FIELD_TYPES,
  nz,
  toId,
  toBool,
  clampLimit,
  sqlValue,
  parseCanonicalUom,
  normalizeFieldType,
  buildTree,
  normalizeFieldInput,
  extractDisplayValue,
  buildDisplayName,
  buildSearchText,
  normalizeAttributeInput,
}
