const crypto = require('crypto')
const express = require('express')
const ExcelJS = require('exceljs')
const multer = require('multer')
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const ENTITY_TYPES = new Set(['equipment_model', 'catalog_position'])
const TEMPLATE_VERSION = 1
const MAX_IMPORT_ROWS = 3000

const textOrNull = (value) => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text || null
}

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const numberOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null
  const number = Number(String(value).replace(',', '.').replace(/\s/g, ''))
  return Number.isFinite(number) ? number : null
}

const parseJsonObject = (value) => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const normalizeKey = (value) => String(value || '').trim().toLocaleLowerCase('ru-RU')

const getCellValue = (cell) => {
  const value = cell?.value
  if (value && typeof value === 'object') {
    if (value.result !== undefined) return value.result
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('')
    if (value.text !== undefined) return value.text
  }
  return value
}

const getNodeContext = async (executor, nodeId) => {
  const [[node]] = await executor.execute(
    `
    SELECT n.*,
           (SELECT COUNT(*) FROM equipment_classifier_nodes c WHERE c.parent_id = n.id AND c.is_active = 1) AS children_count
    FROM equipment_classifier_nodes n
    WHERE n.id = ? AND n.is_active = 1
    `,
    [nodeId]
  )
  return node || null
}

const assertNodeSupportsEntity = (node, entityType) => {
  if (!node) return 'Раздел классификатора не найден'
  if (Number(node.children_count || 0) > 0) return 'Импорт доступен только в конечном разделе без подразделов'
  if (entityType === 'equipment_model' && node.card_kind !== 'equipment_model') {
    return 'Этот раздел не предназначен для моделей оборудования'
  }
  if (entityType === 'catalog_position' && !['catalog_position', 'material', 'service'].includes(node.card_kind)) {
    return 'Этот раздел не предназначен для карточек номенклатуры'
  }
  return null
}

const loadAttributes = async (executor, nodeId, entityType, { importableOnly = false } = {}) => {
  const importableSql = importableOnly ? 'AND a.is_importable = 1' : ''
  const [attributes] = await executor.execute(
    `
    SELECT a.*
    FROM equipment_classifier_node_attributes a
    JOIN equipment_classifier_attribute_scopes s
      ON s.attribute_id = a.id
     AND s.entity_type = ?
    WHERE a.classifier_node_id = ?
      AND a.is_active = 1
      ${importableSql}
    ORDER BY a.sort_order, a.id
    `,
    [entityType, nodeId]
  )
  if (!attributes.length) return []
  const [options] = await executor.query(
    `
    SELECT *
    FROM equipment_classifier_attribute_options
    WHERE attribute_id IN (?) AND is_active = 1
    ORDER BY attribute_id, sort_order, id
    `,
    [attributes.map((attribute) => Number(attribute.id))]
  )
  const byAttribute = new Map()
  options.forEach((option) => {
    const key = Number(option.attribute_id)
    if (!byAttribute.has(key)) byAttribute.set(key, [])
    byAttribute.get(key).push(option)
  })
  return attributes.map((attribute) => ({
    ...attribute,
    options: byAttribute.get(Number(attribute.id)) || [],
  }))
}

const baseColumnsFor = (entityType) =>
  entityType === 'equipment_model'
    ? [
        { key: 'manufacturer_name', label: 'Производитель', required: true, width: 28, list: 'manufacturers' },
        { key: 'model_name', label: 'Модель оборудования', required: true, width: 30 },
        { key: 'model_code', label: 'Код модели', width: 22 },
        { key: 'storage_uom', label: 'Единица хранения', width: 20, list: 'units' },
        { key: 'notes', label: 'Примечание', width: 42 },
      ]
    : [
        { key: 'display_name', label: 'Название позиции', required: true, width: 38 },
        { key: 'display_name_en', label: 'Название EN', width: 32 },
        { key: 'display_name_ru', label: 'Название RU', width: 32 },
        { key: 'position_code', label: 'Внутренний код / артикул', width: 28 },
        { key: 'manufacturer_name', label: 'Производитель', width: 28, list: 'manufacturers' },
        { key: 'manufacturer_part_number', label: 'Номер производителя', width: 30 },
        { key: 'uom', label: 'Единица хранения', width: 20, list: 'units' },
        { key: 'description', label: 'Описание', width: 46 },
      ]

const buildSchema = (node, entityType, attributes) => {
  const columns = [
    ...baseColumnsFor(entityType),
    ...attributes.map((attribute) => ({
      key: `attr:${attribute.id}`,
      attribute_id: Number(attribute.id),
      attribute_code: attribute.code,
      label: attribute.unit ? `${attribute.label}, ${attribute.unit}` : attribute.label,
      required: Number(attribute.is_required || 0) === 1,
      value_type: attribute.value_type,
      width: attribute.value_type === 'textarea' ? 42 : 24,
    })),
  ]
  const payload = {
    version: TEMPLATE_VERSION,
    node_id: Number(node.id),
    entity_type: entityType,
    columns: columns.map(({ key, attribute_id, attribute_code, required, value_type }) => ({
      key,
      attribute_id: attribute_id || null,
      attribute_code: attribute_code || null,
      required: !!required,
      value_type: value_type || 'text',
    })),
  }
  return {
    ...payload,
    columns,
    hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  }
}

const applyHeaderStyle = (row) => {
  row.height = 30
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      left: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      bottom: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      right: { style: 'thin', color: { argb: 'FFD9E2F3' } },
    }
  })
}

const escapeSheetName = (value) => String(value).replace(/'/g, "''")

const buildTemplateWorkbook = async ({ node, entityType, attributes, schema }) => {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Crusher Parts'
  workbook.created = new Date()

  const dataSheet = workbook.addWorksheet('Данные', { views: [{ state: 'frozen', ySplit: 1 }] })
  dataSheet.columns = schema.columns.map((column) => ({
    header: `${column.required ? '* ' : ''}${column.label}`,
    key: column.key,
    width: column.width || 24,
  }))
  dataSheet.autoFilter = { from: 'A1', to: `${dataSheet.getColumn(schema.columns.length).letter}1` }
  applyHeaderStyle(dataSheet.getRow(1))

  const referenceSheet = workbook.addWorksheet('Справочники')
  const [manufacturers, units] = await Promise.all([
    db.execute('SELECT name FROM equipment_manufacturers ORDER BY name'),
    db.execute('SELECT code, name_ru, symbol FROM measurement_units WHERE is_active = 1 ORDER BY name_ru, code'),
  ])
  referenceSheet.getCell('A1').value = 'Производители'
  manufacturers[0].forEach((row, index) => {
    referenceSheet.getCell(index + 2, 1).value = row.name
  })
  referenceSheet.getCell('B1').value = 'Единицы хранения'
  units[0].forEach((row, index) => {
    referenceSheet.getCell(index + 2, 2).value = row.code
    referenceSheet.getCell(index + 2, 2).note = [row.name_ru, row.symbol].filter(Boolean).join(' · ')
  })

  let referenceColumn = 3
  const optionReferenceByAttributeId = new Map()
  attributes.forEach((attribute) => {
    if (!['select', 'multiselect'].includes(attribute.value_type) || !attribute.options.length) return
    const column = referenceSheet.getColumn(referenceColumn)
    column.width = 32
    referenceSheet.getCell(1, referenceColumn).value = attribute.label
    attribute.options.forEach((option, index) => {
      referenceSheet.getCell(index + 2, referenceColumn).value = option.value_label
    })
    optionReferenceByAttributeId.set(Number(attribute.id), {
      letter: column.letter,
      count: attribute.options.length,
    })
    referenceColumn += 1
  })

  const refName = escapeSheetName(referenceSheet.name)
  schema.columns.forEach((column, index) => {
    const excelColumn = dataSheet.getColumn(index + 1)
    if (column.value_type === 'number') excelColumn.numFmt = '#,##0.######'
    let formula = null
    if (column.list === 'manufacturers' && manufacturers[0].length) {
      formula = `'${refName}'!$A$2:$A$${manufacturers[0].length + 1}`
    } else if (column.list === 'units' && units[0].length) {
      formula = `'${refName}'!$B$2:$B$${units[0].length + 1}`
    } else if (column.attribute_id && optionReferenceByAttributeId.has(Number(column.attribute_id))) {
      const ref = optionReferenceByAttributeId.get(Number(column.attribute_id))
      formula = `'${refName}'!$${ref.letter}$2:$${ref.letter}$${ref.count + 1}`
    }
    for (let rowIndex = 2; rowIndex <= 1001; rowIndex += 1) {
      const cell = dataSheet.getCell(rowIndex, index + 1)
      cell.alignment = { vertical: 'middle', wrapText: column.value_type === 'textarea' }
      if (formula && column.value_type !== 'multiselect') {
        cell.dataValidation = {
          type: 'list',
          allowBlank: !column.required,
          formulae: [formula],
          showErrorMessage: true,
          errorTitle: 'Выберите значение из списка',
          error: 'Используйте значение из выпадающего списка.',
        }
      } else if (column.value_type === 'number') {
        cell.dataValidation = {
          type: 'decimal',
          operator: 'greaterThanOrEqual',
          formulae: [0],
          allowBlank: !column.required,
          showErrorMessage: true,
          errorTitle: 'Нужно число',
          error: 'Введите число не меньше нуля.',
        }
      }
    }
  })

  const instructionSheet = workbook.addWorksheet('Инструкция')
  instructionSheet.columns = [
    { header: 'Раздел', key: 'section', width: 34 },
    { header: 'Пояснение', key: 'description', width: 100 },
  ]
  instructionSheet.addRows([
    ['Раздел классификатора', node.name],
    ['Что импортируется', entityType === 'equipment_model' ? 'Модели оборудования' : 'Карточки номенклатуры'],
    ['Обязательные поля', 'Отмечены звёздочкой. Не переименовывайте листы и заголовки.'],
    ['Проверка', 'После загрузки система сначала покажет предварительный результат. До подтверждения база не изменяется.'],
    ['Дубли', entityType === 'equipment_model'
      ? 'Модель определяется по паре «Производитель + Модель». Существующая запись будет обновлена.'
      : 'Позиция определяется по внутреннему коду, номеру производителя либо названию внутри выбранного раздела.'],
    ['Несколько значений', 'Для поля с несколькими значениями перечисляйте варианты через точку с запятой.'],
  ])
  applyHeaderStyle(instructionSheet.getRow(1))
  instructionSheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.eachCell((cell) => { cell.alignment = { vertical: 'top', wrapText: true } })
  })

  const metadataSheet = workbook.addWorksheet('Метаданные')
  metadataSheet.addRow(['template_version', TEMPLATE_VERSION])
  metadataSheet.addRow(['node_id', Number(node.id)])
  metadataSheet.addRow(['entity_type', entityType])
  metadataSheet.addRow(['schema_hash', schema.hash])
  metadataSheet.addRow([])
  metadataSheet.addRow(['column_index', 'key', 'attribute_id', 'attribute_code'])
  schema.columns.forEach((column, index) => {
    metadataSheet.addRow([index + 1, column.key, column.attribute_id || null, column.attribute_code || null])
  })
  referenceSheet.state = 'veryHidden'
  metadataSheet.state = 'veryHidden'
  return workbook
}

const readMetadata = (workbook) => {
  const sheet = workbook.getWorksheet('Метаданные')
  if (!sheet) return null
  const metadata = {}
  for (let row = 1; row <= 4; row += 1) {
    metadata[String(getCellValue(sheet.getCell(row, 1)) || '')] = getCellValue(sheet.getCell(row, 2))
  }
  const columns = []
  for (let row = 7; row <= sheet.rowCount; row += 1) {
    const index = Number(getCellValue(sheet.getCell(row, 1)))
    const key = textOrNull(getCellValue(sheet.getCell(row, 2)))
    if (!Number.isInteger(index) || !key) continue
    columns.push({
      index,
      key,
      attribute_id: toId(getCellValue(sheet.getCell(row, 3))),
      attribute_code: textOrNull(getCellValue(sheet.getCell(row, 4))),
    })
  }
  return { ...metadata, columns }
}

const normalizeAttributeImportValue = (attribute, rawValue) => {
  const empty = rawValue === undefined || rawValue === null || String(rawValue).trim() === ''
  if (empty) return { value: null }
  if (attribute.value_type === 'number') {
    const value = numberOrNull(rawValue)
    return value === null ? { error: `${attribute.label}: нужно число` } : { value }
  }
  if (attribute.value_type === 'boolean') {
    const key = normalizeKey(rawValue)
    if (['да', 'yes', 'true', '1'].includes(key)) return { value: true }
    if (['нет', 'no', 'false', '0'].includes(key)) return { value: false }
    return { error: `${attribute.label}: укажите «Да» или «Нет»` }
  }
  if (attribute.value_type === 'date') {
    if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
      return { value: rawValue.toISOString().slice(0, 10) }
    }
    const value = textOrNull(rawValue)
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '')
      ? { value }
      : { error: `${attribute.label}: дата должна быть в формате ГГГГ-ММ-ДД` }
  }
  if (['select', 'multiselect'].includes(attribute.value_type)) {
    const byCodeOrLabel = new Map()
    attribute.options.forEach((option) => {
      byCodeOrLabel.set(normalizeKey(option.value_code), option.value_code)
      byCodeOrLabel.set(normalizeKey(option.value_label), option.value_code)
    })
    const rawItems = attribute.value_type === 'multiselect'
      ? String(rawValue).split(/[;,]/).map((item) => item.trim()).filter(Boolean)
      : [String(rawValue).trim()]
    const values = []
    for (const item of rawItems) {
      const code = byCodeOrLabel.get(normalizeKey(item))
      if (!code) return { error: `${attribute.label}: неизвестное значение «${item}»` }
      if (!values.includes(code)) values.push(code)
    }
    return { value: attribute.value_type === 'multiselect' ? values : values[0] || null }
  }
  return { value: textOrNull(rawValue) }
}

const loadReferenceMaps = async (executor) => {
  const [manufacturers, units] = await Promise.all([
    executor.execute('SELECT id, name FROM equipment_manufacturers'),
    executor.execute('SELECT code FROM measurement_units WHERE is_active = 1'),
  ])
  return {
    manufacturers: new Map(manufacturers[0].map((row) => [normalizeKey(row.name), row])),
    units: new Set(units[0].map((row) => normalizeKey(row.code))),
  }
}

const parseWorkbookRows = async ({ workbook, schema, attributes, entityType, nodeId }) => {
  const sheet = workbook.getWorksheet('Данные')
  if (!sheet) throw Object.assign(new Error('В файле нет листа «Данные»'), { statusCode: 400 })
  const referenceMaps = await loadReferenceMaps(db)
  const attributesById = new Map(attributes.map((attribute) => [Number(attribute.id), attribute]))
  const [existingRows, existingAttributeRows] = await Promise.all([
    entityType === 'equipment_model'
      ? db.execute(
          `SELECT em.*, m.name AS manufacturer_name FROM equipment_models em JOIN equipment_manufacturers m ON m.id = em.manufacturer_id WHERE em.classifier_node_id = ?`,
          [nodeId]
        )
      : db.execute(
          `SELECT cp.*, m.name AS manufacturer_name FROM catalog_positions cp LEFT JOIN equipment_manufacturers m ON m.id = cp.manufacturer_id WHERE cp.is_active = 1`,
          []
        ),
    db.query(
      `SELECT * FROM equipment_attribute_values WHERE entity_type = ? AND attribute_id IN (?)`,
      [entityType, attributes.length ? attributes.map((attribute) => Number(attribute.id)) : [0]]
    ),
  ])
  const existingValues = new Map()
  existingAttributeRows[0].forEach((row) => {
    const key = Number(row.entity_id)
    if (!existingValues.has(key)) existingValues.set(key, new Map())
    existingValues.get(key).set(Number(row.attribute_id), row)
  })

  const identityAttributes = attributes.filter((attribute) => Number(attribute.is_identity || 0) === 1)
  const serializeIdentityValue = (attribute, value) => {
    if (value === undefined || value === null || value === '') return null
    if (attribute.value_type === 'number') return String(Number(value))
    if (attribute.value_type === 'boolean') return value ? '1' : '0'
    if (attribute.value_type === 'multiselect') {
      const items = Array.isArray(value) ? value : []
      return items.map(String).sort().join('|') || null
    }
    return normalizeKey(value)
  }
  const identityKeyFromImportedValues = (values) => {
    if (!identityAttributes.length) return null
    const parts = identityAttributes.map((attribute) => serializeIdentityValue(attribute, values[String(attribute.id)]))
    return parts.some((part) => part === null) ? null : `attributes:${nodeId}:${parts.join(':')}`
  }
  const identityKeyFromStoredValues = (entityId) => {
    if (!identityAttributes.length) return null
    const stored = existingValues.get(Number(entityId)) || new Map()
    const parts = identityAttributes.map((attribute) => {
      const row = stored.get(Number(attribute.id))
      if (!row) return null
      if (attribute.value_type === 'number') return serializeIdentityValue(attribute, row.value_number)
      if (attribute.value_type === 'boolean') return serializeIdentityValue(attribute, Number(row.value_boolean) === 1)
      if (attribute.value_type === 'multiselect') {
        let values = []
        try { values = Array.isArray(row.value_json) ? row.value_json : JSON.parse(row.value_json || '[]') } catch {}
        return serializeIdentityValue(attribute, values)
      }
      return serializeIdentityValue(attribute, row.value_date || row.value_text)
    })
    return parts.some((part) => part === null) ? null : `attributes:${nodeId}:${parts.join(':')}`
  }
  const storedAttributeValue = (attribute, row) => {
    if (!row) return null
    if (attribute.value_type === 'number') return row.value_number === null ? null : Number(row.value_number)
    if (attribute.value_type === 'boolean') return row.value_boolean === null ? null : Number(row.value_boolean) === 1
    if (attribute.value_type === 'multiselect') {
      try {
        const values = Array.isArray(row.value_json) ? row.value_json : JSON.parse(row.value_json || '[]')
        return values.map(String).sort()
      } catch {
        return []
      }
    }
    return textOrNull(row.value_date || row.value_text)
  }
  const attributeValuesAreEqual = (entityId, importedValues) => {
    const stored = existingValues.get(Number(entityId)) || new Map()
    return attributes.every((attribute) => {
      const imported = importedValues[String(attribute.id)]
      const normalizedImported = attribute.value_type === 'multiselect'
        ? (Array.isArray(imported) ? imported.map(String).sort() : [])
        : imported ?? null
      const normalizedStored = storedAttributeValue(attribute, stored.get(Number(attribute.id)))
      return JSON.stringify(normalizedImported) === JSON.stringify(normalizedStored)
    })
  }
  const baseValuesAreEqual = (existing, imported) => {
    const sameText = (left, right) => textOrNull(left) === textOrNull(right)
    if (entityType === 'equipment_model') {
      return Number(existing.manufacturer_id) === Number(imported.manufacturer_id) &&
        sameText(existing.model_name, imported.model_name) &&
        sameText(existing.model_code, imported.model_code) &&
        sameText(existing.storage_uom, imported.storage_uom) &&
        sameText(existing.notes, imported.notes)
    }
    return Number(existing.classifier_node_id) === Number(nodeId) &&
      Number(existing.manufacturer_id || 0) === Number(imported.manufacturer_id || 0) &&
      sameText(existing.display_name, imported.display_name) &&
      sameText(existing.display_name_en, imported.display_name_en) &&
      sameText(existing.display_name_ru, imported.display_name_ru) &&
      sameText(existing.position_code, imported.position_code) &&
      sameText(existing.manufacturer_part_number, imported.manufacturer_part_number) &&
      sameText(existing.description, imported.description) &&
      sameText(existing.uom, imported.uom)
  }

  const modelByKey = new Map()
  const positionByCode = new Map()
  const positionByManufacturerNumber = new Map()
  const positionByNodeName = new Map()
  const positionByAttributeIdentity = new Map()
  existingRows[0].forEach((row) => {
    if (entityType === 'equipment_model') {
      modelByKey.set(`${Number(row.manufacturer_id)}:${normalizeKey(row.model_name)}`, row)
      return
    }
    if (row.position_code) positionByCode.set(normalizeKey(row.position_code), row)
    if (row.manufacturer_id && row.manufacturer_part_number) {
      positionByManufacturerNumber.set(`${Number(row.manufacturer_id)}:${normalizeKey(row.manufacturer_part_number)}`, row)
    }
    if (Number(row.classifier_node_id) === Number(nodeId)) {
      positionByNodeName.set(normalizeKey(row.display_name), row)
      const attributeIdentityKey = identityKeyFromStoredValues(row.id)
      if (attributeIdentityKey) positionByAttributeIdentity.set(attributeIdentityKey, row)
    }
  })

  const rows = []
  const fileKeys = new Set()
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = {}
    let hasContent = false
    schema.columns.forEach((column, index) => {
      const value = getCellValue(sheet.getCell(rowNumber, index + 1))
      values[column.key] = value
      if (value !== undefined && value !== null && String(value).trim() !== '') hasContent = true
    })
    if (!hasContent) continue
    if (rows.length >= MAX_IMPORT_ROWS) {
      throw Object.assign(new Error(`За один раз можно импортировать не более ${MAX_IMPORT_ROWS} строк`), { statusCode: 400 })
    }

    const errors = []
    const warnings = []
    const normalized = { row_number: rowNumber, attribute_values: {} }
    schema.columns.filter((column) => !column.attribute_id).forEach((column) => {
      normalized[column.key] = textOrNull(values[column.key])
      if (column.required && !normalized[column.key]) errors.push(`Не заполнено поле «${column.label}»`)
    })
    const manufacturer = normalized.manufacturer_name
      ? referenceMaps.manufacturers.get(normalizeKey(normalized.manufacturer_name))
      : null
    if (normalized.manufacturer_name && !manufacturer) errors.push(`Производитель «${normalized.manufacturer_name}» не найден`)
    normalized.manufacturer_id = manufacturer?.id || null
    const uom = normalized.storage_uom || normalized.uom
    if (uom && !referenceMaps.units.has(normalizeKey(uom))) errors.push(`Единица «${uom}» не найдена в справочнике`)

    schema.columns.filter((column) => column.attribute_id).forEach((column) => {
      const attribute = attributesById.get(Number(column.attribute_id))
      if (!attribute) {
        errors.push(`Характеристика «${column.attribute_code || column.key}» больше не существует`)
        return
      }
      const result = normalizeAttributeImportValue(attribute, values[column.key])
      if (result.error) errors.push(result.error)
      if (Number(attribute.is_required || 0) === 1 && (result.value === null || result.value === undefined || result.value === '')) {
        errors.push(`Не заполнена обязательная характеристика «${attribute.label}»`)
      }
      normalized.attribute_values[String(attribute.id)] = result.value ?? null
    })
    if (entityType === 'catalog_position') {
      const bySemanticKey = new Map(attributes.map((attribute) => [attribute.semantic_key, attribute]))
      const unitWeight = bySemanticKey.get('weight_kg')
      const weightPerThousand = bySemanticKey.get('weight_per_1000_kg')
      if (unitWeight && weightPerThousand && normalized.attribute_values[String(unitWeight.id)] === null) {
        const sourceWeight = numberOrNull(normalized.attribute_values[String(weightPerThousand.id)])
        if (sourceWeight !== null) normalized.attribute_values[String(unitWeight.id)] = sourceWeight / 1000
      }
    }

    let existing = null
    let identityKey = null
    if (entityType === 'equipment_model') {
      identityKey = `${Number(normalized.manufacturer_id || 0)}:${normalizeKey(normalized.model_name)}`
      existing = modelByKey.get(identityKey) || null
    } else if (normalized.position_code) {
      identityKey = `code:${normalizeKey(normalized.position_code)}`
      existing = positionByCode.get(normalizeKey(normalized.position_code)) || null
      if (existing && Number(existing.classifier_node_id) !== Number(nodeId)) {
        errors.push(`Внутренний код «${normalized.position_code}» уже используется в другом разделе`)
      }
    } else if (normalized.manufacturer_id && normalized.manufacturer_part_number) {
      identityKey = `manufacturer:${normalized.manufacturer_id}:${normalizeKey(normalized.manufacturer_part_number)}`
      existing = positionByManufacturerNumber.get(`${normalized.manufacturer_id}:${normalizeKey(normalized.manufacturer_part_number)}`) || null
      if (existing && Number(existing.classifier_node_id) !== Number(nodeId)) {
        errors.push(`Номер производителя уже связан с позицией в другом разделе`)
      }
    } else if (identityKeyFromImportedValues(normalized.attribute_values)) {
      identityKey = identityKeyFromImportedValues(normalized.attribute_values)
      existing = positionByAttributeIdentity.get(identityKey) || null
    } else {
      identityKey = `name:${Number(nodeId)}:${normalizeKey(normalized.display_name)}`
      existing = positionByNodeName.get(normalizeKey(normalized.display_name)) || null
      warnings.push('Позиция определяется только по названию. Для надёжного повторного импорта заполните код, номер производителя или настройте признаки проверки дублей.')
    }
    if (identityKey && fileKeys.has(identityKey)) errors.push('Такая же позиция уже встречалась выше в этом файле')
    if (identityKey) fileKeys.add(identityKey)

    if (existing) {
      const optionalBaseFields = entityType === 'equipment_model'
        ? ['model_code', 'storage_uom', 'notes']
        : ['display_name_en', 'display_name_ru', 'position_code', 'manufacturer_part_number', 'uom', 'description']
      optionalBaseFields.forEach((field) => {
        if (normalized[field] === null) normalized[field] = textOrNull(existing[field])
      })
      if (entityType === 'catalog_position' && !normalized.manufacturer_id) {
        normalized.manufacturer_id = existing.manufacturer_id || null
        normalized.manufacturer_name = existing.manufacturer_name || null
      }
      attributes.forEach((attribute) => {
        if (normalized.attribute_values[String(attribute.id)] !== null) return
        const stored = existingValues.get(Number(existing.id))?.get(Number(attribute.id))
        normalized.attribute_values[String(attribute.id)] = storedAttributeValue(attribute, stored)
      })
    }
    normalized.existing_id = existing?.id || null
    const unchanged = existing && baseValuesAreEqual(existing, normalized) &&
      attributeValuesAreEqual(existing.id, normalized.attribute_values)
    normalized.action = errors.length ? 'error' : existing ? (unchanged ? 'skip' : 'update') : 'create'
    normalized.errors = errors
    normalized.warnings = warnings
    normalized.existing_attribute_values = existing ? Array.from((existingValues.get(Number(existing.id)) || new Map()).keys()) : []
    rows.push(normalized)
  }
  return rows
}

const saveAttributeValues = async (executor, entityType, entityId, attributes, values) => {
  for (const attribute of attributes) {
    const raw = values[String(attribute.id)]
    const normalized = normalizeAttributeImportValue(attribute, raw)
    if (normalized.error) throw new Error(normalized.error)
    const value = normalized.value
    const fields = {
      value_text: null,
      value_number: null,
      value_boolean: null,
      value_date: null,
      value_json: null,
    }
    if (attribute.value_type === 'number') fields.value_number = value
    else if (attribute.value_type === 'boolean') fields.value_boolean = value === null ? null : value ? 1 : 0
    else if (attribute.value_type === 'date') fields.value_date = value
    else if (attribute.value_type === 'multiselect') fields.value_json = value?.length ? JSON.stringify(value) : null
    else fields.value_text = value
    await executor.execute(
      `
      INSERT INTO equipment_attribute_values
        (attribute_id, entity_type, entity_id, value_text, value_number, value_boolean, value_date, value_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        value_text = VALUES(value_text), value_number = VALUES(value_number),
        value_boolean = VALUES(value_boolean), value_date = VALUES(value_date), value_json = VALUES(value_json)
      `,
      [attribute.id, entityType, entityId, fields.value_text, fields.value_number, fields.value_boolean, fields.value_date, fields.value_json]
    )
  }
}

const syncCanonicalCatalogMeta = async (executor, entityId, attributes, values) => {
  const supportedKeys = new Set(['weight_kg', 'length_mm', 'width_mm', 'height_mm'])
  const patch = {}
  attributes.forEach((attribute) => {
    if (!supportedKeys.has(attribute.semantic_key)) return
    const value = numberOrNull(values[String(attribute.id)])
    if (value !== null) patch[attribute.semantic_key] = value
  })
  if (!Object.keys(patch).length) return
  const [[position]] = await executor.execute('SELECT meta_json FROM catalog_positions WHERE id = ?', [entityId])
  await executor.execute(
    'UPDATE catalog_positions SET meta_json = ?, updated_at = NOW() WHERE id = ?',
    [JSON.stringify({ ...parseJsonObject(position?.meta_json), ...patch }), entityId]
  )
}

router.get('/template', async (req, res) => {
  try {
    const nodeId = toId(req.query.node_id)
    const entityType = textOrNull(req.query.entity_type)
    if (!nodeId || !ENTITY_TYPES.has(entityType)) return res.status(400).json({ message: 'Некорректные параметры шаблона' })
    const node = await getNodeContext(db, nodeId)
    const nodeError = assertNodeSupportsEntity(node, entityType)
    if (nodeError) return res.status(400).json({ message: nodeError })
    const attributes = await loadAttributes(db, nodeId, entityType, { importableOnly: true })
    const schema = buildSchema(node, entityType, attributes)
    const workbook = await buildTemplateWorkbook({ node, entityType, attributes, schema })
    const buffer = await workbook.xlsx.writeBuffer()
    const suffix = entityType === 'equipment_model' ? 'models' : 'positions'
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="classifier_${nodeId}_${suffix}.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (error) {
    console.error('GET /classifier-imports/template error:', error)
    res.status(500).json({ message: 'Не удалось сформировать шаблон Excel' })
  }
})

router.post('/preview', upload.single('file'), async (req, res) => {
  try {
    const nodeId = toId(req.body.node_id)
    const entityType = textOrNull(req.body.entity_type)
    if (!nodeId || !ENTITY_TYPES.has(entityType) || !req.file?.buffer) {
      return res.status(400).json({ message: 'Выберите корректный Excel-файл и раздел' })
    }
    const node = await getNodeContext(db, nodeId)
    const nodeError = assertNodeSupportsEntity(node, entityType)
    if (nodeError) return res.status(400).json({ message: nodeError })
    const attributes = await loadAttributes(db, nodeId, entityType, { importableOnly: true })
    const schema = buildSchema(node, entityType, attributes)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(req.file.buffer)
    const metadata = readMetadata(workbook)
    if (!metadata) return res.status(400).json({ message: 'Это не шаблон импорта классификатора: отсутствуют служебные метаданные' })
    if (Number(metadata.template_version) !== TEMPLATE_VERSION || Number(metadata.node_id) !== nodeId || metadata.entity_type !== entityType) {
      return res.status(400).json({ message: 'Шаблон создан для другого раздела или типа данных. Скачайте новый шаблон.' })
    }
    if (metadata.schema_hash !== schema.hash) {
      return res.status(409).json({ message: 'После скачивания шаблона настройки характеристик изменились. Скачайте новый шаблон.' })
    }
    const rows = await parseWorkbookRows({ workbook, schema, attributes, entityType, nodeId })
    if (!rows.length) return res.status(400).json({ message: 'В файле нет заполненных строк' })
    const counts = rows.reduce((acc, row) => {
      acc[row.action] = (acc[row.action] || 0) + 1
      return acc
    }, { create: 0, update: 0, skip: 0, error: 0 })
    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex')
    const [insert] = await db.execute(
      `
      INSERT INTO classifier_import_batches
        (classifier_node_id, entity_type, source_file_name, source_file_sha256, template_version,
         schema_hash, status, rows_total, rows_create, rows_update, rows_skip, rows_error,
         preview_json, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?)
      `,
      [nodeId, entityType, req.file.originalname || null, sha256, TEMPLATE_VERSION, schema.hash,
        rows.length, counts.create, counts.update, counts.skip, counts.error, JSON.stringify({ rows }), toId(req.user?.id)]
    )
    res.json({ batch_id: Number(insert.insertId), rows, counts, can_commit: counts.error === 0 })
  } catch (error) {
    console.error('POST /classifier-imports/preview error:', error)
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Не удалось проверить Excel-файл' })
  }
})

router.post('/:id/commit', async (req, res) => {
  const batchId = toId(req.params.id)
  if (!batchId) return res.status(400).json({ message: 'Некорректный импорт' })
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[batch]] = await conn.execute('SELECT * FROM classifier_import_batches WHERE id = ? FOR UPDATE', [batchId])
    if (!batch) {
      await conn.rollback()
      return res.status(404).json({ message: 'Предпросмотр импорта не найден' })
    }
    if (batch.status === 'committed') {
      await conn.rollback()
      return res.json({ batch_id: batchId, ...(typeof batch.result_json === 'string' ? JSON.parse(batch.result_json) : batch.result_json) })
    }
    if (batch.status !== 'previewed') {
      await conn.rollback()
      return res.status(409).json({ message: 'Этот импорт уже обрабатывается или был отменён' })
    }
    if (Number(batch.rows_error || 0) > 0) {
      await conn.rollback()
      return res.status(400).json({ message: 'В предпросмотре есть ошибки. Исправьте файл и загрузите его заново.' })
    }
    const node = await getNodeContext(conn, Number(batch.classifier_node_id))
    const nodeError = assertNodeSupportsEntity(node, batch.entity_type)
    if (nodeError) throw Object.assign(new Error(nodeError), { statusCode: 409 })
    const attributes = await loadAttributes(conn, Number(batch.classifier_node_id), batch.entity_type, { importableOnly: true })
    const schema = buildSchema(node, batch.entity_type, attributes)
    if (schema.hash !== batch.schema_hash) {
      throw Object.assign(new Error('Настройки характеристик изменились после предпросмотра. Загрузите файл заново.'), { statusCode: 409 })
    }
    await conn.execute("UPDATE classifier_import_batches SET status = 'committing' WHERE id = ?", [batchId])
    const preview = typeof batch.preview_json === 'string' ? JSON.parse(batch.preview_json) : batch.preview_json
    const rows = Array.isArray(preview?.rows) ? preview.rows : []
    const createdIds = []
    const updatedIds = []
    for (const row of rows) {
      if (row.action === 'error' || row.action === 'skip') continue
      let entityId = toId(row.existing_id)
      if (batch.entity_type === 'equipment_model') {
        if (entityId) {
          await conn.execute(
            `UPDATE equipment_models SET manufacturer_id = ?, model_name = ?, model_code = ?, storage_uom = ?, notes = ? WHERE id = ?`,
            [row.manufacturer_id, row.model_name, row.model_code, row.storage_uom, row.notes, entityId]
          )
          updatedIds.push(entityId)
        } else {
          const [insert] = await conn.execute(
            `INSERT INTO equipment_models (manufacturer_id, model_name, model_code, classifier_node_id, storage_uom, notes) VALUES (?, ?, ?, ?, ?, ?)`,
            [row.manufacturer_id, row.model_name, row.model_code, batch.classifier_node_id, row.storage_uom, row.notes]
          )
          entityId = Number(insert.insertId)
          createdIds.push(entityId)
        }
      } else {
        const positionKind = node.card_kind === 'service' ? 'service' : node.card_kind === 'material' ? 'material' : 'part'
        if (entityId) {
          await conn.execute(
            `
            UPDATE catalog_positions
            SET classifier_node_id = ?, manufacturer_id = ?, display_name = ?, display_name_en = ?, display_name_ru = ?,
                position_code = ?, manufacturer_part_number = ?, description = ?, uom = ?, position_kind = ?, source_kind = 'classifier'
            WHERE id = ?
            `,
            [batch.classifier_node_id, row.manufacturer_id, row.display_name, row.display_name_en, row.display_name_ru,
              row.position_code, row.manufacturer_part_number, row.description, row.uom, positionKind, entityId]
          )
          updatedIds.push(entityId)
        } else {
          const [insert] = await conn.execute(
            `
            INSERT INTO catalog_positions
              (classifier_node_id, manufacturer_id, position_kind, source_kind, display_name, display_name_en,
               display_name_ru, position_code, manufacturer_part_number, description, uom)
            VALUES (?, ?, ?, 'classifier', ?, ?, ?, ?, ?, ?, ?)
            `,
            [batch.classifier_node_id, row.manufacturer_id, positionKind, row.display_name, row.display_name_en,
              row.display_name_ru, row.position_code, row.manufacturer_part_number, row.description, row.uom]
          )
          entityId = Number(insert.insertId)
          createdIds.push(entityId)
        }
      }
      await saveAttributeValues(conn, batch.entity_type, entityId, attributes, row.attribute_values || {})
      if (batch.entity_type === 'catalog_position') {
        await syncCanonicalCatalogMeta(conn, entityId, attributes, row.attribute_values || {})
      }
    }
    const result = { imported: createdIds.length + updatedIds.length, created: createdIds.length, updated: updatedIds.length, created_ids: createdIds, updated_ids: updatedIds }
    await conn.execute(
      "UPDATE classifier_import_batches SET status = 'committed', result_json = ?, committed_at = NOW() WHERE id = ?",
      [JSON.stringify(result), batchId]
    )
    await conn.commit()
    await logActivity({
      req,
      action: 'create',
      entity_type: batch.entity_type === 'equipment_model' ? 'equipment_models' : 'catalog_positions',
      entity_id: batch.classifier_node_id,
      comment: `Импорт из классификатора #${batchId}: создано ${createdIds.length}, обновлено ${updatedIds.length}`,
    })
    res.json({ batch_id: batchId, ...result })
  } catch (error) {
    try { await conn.rollback() } catch {}
    try {
      await db.execute("UPDATE classifier_import_batches SET status = 'failed', result_json = ? WHERE id = ? AND status <> 'committed'", [JSON.stringify({ error: error.message }), batchId])
    } catch {}
    console.error('POST /classifier-imports/:id/commit error:', error)
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Не удалось выполнить импорт' })
  } finally {
    conn.release()
  }
})

module.exports = router
