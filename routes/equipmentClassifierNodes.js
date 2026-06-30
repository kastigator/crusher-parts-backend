const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { createTrashEntry } = require('../utils/trashStore')
const { buildTrashPreview, MODE } = require('../utils/trashPreview')
const { normalizeCode: normalizeUnitCode } = require('../utils/uom')
const { bucket, bucketName } = require('../utils/gcsClient')

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const ALLOWED_NODE_TYPES = new Set([
  'ROOT',
  'CATEGORY',
  'SUBCATEGORY',
  'EQUIPMENT_TYPE',
  'MANUFACTURER_GROUP',
  'MODEL_GROUP',
])

const ATTRIBUTE_TYPES = new Set(['text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'date'])
const ATTRIBUTE_ENTITY_TYPES = new Set(['equipment_model', 'client_equipment_unit', 'catalog_position'])
const CARD_KINDS = new Set(['auto', 'mixed', 'equipment_model', 'catalog_position', 'service', 'material'])

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
}

const normalizeAttributeType = (value) => {
  const type = String(value || '').trim().toLowerCase()
  return ATTRIBUTE_TYPES.has(type) ? type : null
}

const normalizeCardKind = (value, fallback = 'auto') => {
  const kind = String(value || '').trim().toLowerCase()
  if (!kind) return fallback
  return CARD_KINDS.has(kind) ? kind : null
}

const buildAttributeCode = (value, fallback = 'attr') => {
  const raw = nz(value) || fallback
  const transliterated = raw
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
  const code = transliterated.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return code || `${fallback}_${Date.now()}`
}

const normalizeAttributeUnit = async (value) => {
  const raw = nz(value)
  if (!raw) return { unit: null, error: null }
  const code = normalizeUnitCode(raw)
  const [rows] = await db.execute(
    `
    SELECT code
    FROM measurement_units
    WHERE is_active = 1
      AND (
        LOWER(code) = LOWER(?)
        OR LOWER(symbol) = LOWER(?)
        OR LOWER(name_ru) = LOWER(?)
        OR LOWER(name_en) = LOWER(?)
      )
    LIMIT 1
    `,
    [code, raw, raw, raw]
  )
  if (!rows.length) {
    return { unit: null, error: `Единица измерения "${raw}" не найдена в справочнике единиц` }
  }
  return { unit: rows[0].code, error: null }
}

const getClassifierNodeUsage = async (nodeId) => {
  const [[children]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM equipment_classifier_nodes WHERE parent_id = ? AND is_active = 1',
    [nodeId]
  )
  const [[models]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM equipment_models WHERE classifier_node_id = ?',
    [nodeId]
  )
  const [[attributes]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM equipment_classifier_node_attributes WHERE classifier_node_id = ? AND is_active = 1',
    [nodeId]
  )
  return {
    children: Number(children?.cnt || 0),
    models: Number(models?.cnt || 0),
    attributes: Number(attributes?.cnt || 0),
  }
}

const requireLeafClassifierNode = async (nodeId, res) => {
  const usage = await getClassifierNodeUsage(nodeId)
  if (usage.children > 0) {
    res.status(400).json({
      message: 'Модели и характеристики можно задавать только в нижнем разделе без подразделов',
    })
    return false
  }
  return true
}

const requireCanAddChildNode = async (nodeId, res) => {
  const usage = await getClassifierNodeUsage(nodeId)
  if (usage.models > 0 || usage.attributes > 0) {
    res.status(400).json({
      message: 'В этом разделе уже есть модели или характеристики. Сначала перенесите модели/характеристики в нижний подраздел.',
    })
    return false
  }
  return true
}

const normalizeAttributeValue = (attribute, rawValue) => {
  const type = normalizeAttributeType(attribute?.value_type)
  if (!type) return { error: `Некорректный тип характеристики ${attribute?.label || ''}` }

  const empty = rawValue === undefined || rawValue === null || rawValue === ''
  if (type === 'text' || type === 'textarea' || type === 'select') {
    return { value_text: nz(rawValue), value_number: null, value_boolean: null, value_date: null, value_json: null }
  }
  if (type === 'number') {
    if (empty) return { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: null }
    const n = Number(String(rawValue).replace(',', '.'))
    if (!Number.isFinite(n)) return { error: `${attribute.label || attribute.code}: нужно число` }
    return { value_text: null, value_number: n, value_boolean: null, value_date: null, value_json: null }
  }
  if (type === 'boolean') {
    if (empty) return { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: null }
    return { value_text: null, value_number: null, value_boolean: toBool(rawValue) ? 1 : 0, value_date: null, value_json: null }
  }
  if (type === 'date') {
    if (empty) return { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: null }
    const value = nz(rawValue)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { error: `${attribute.label || attribute.code}: нужна дата YYYY-MM-DD` }
    return { value_text: null, value_number: null, value_boolean: null, value_date: value, value_json: null }
  }
  if (type === 'multiselect') {
    const values = Array.isArray(rawValue)
      ? rawValue.map((item) => nz(item)).filter(Boolean)
      : nz(rawValue)
      ? [nz(rawValue)]
      : []
    return {
      value_text: null,
      value_number: null,
      value_boolean: null,
      value_date: null,
      value_json: values.length ? JSON.stringify(values) : null,
    }
  }
  return { error: `Тип характеристики ${type} пока не поддержан` }
}

const extractAttributeDisplayValue = (attribute, valueRow, optionsByAttributeId = new Map()) => {
  if (!valueRow) return null
  const type = normalizeAttributeType(attribute?.value_type)
  const options = optionsByAttributeId.get(Number(attribute.id)) || new Map()

  if (type === 'number') {
    if (valueRow.value_number === null || valueRow.value_number === undefined) return null
    const n = Number(valueRow.value_number)
    const numberText = Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '').replace(/\.$/, '')
    return attribute.unit ? `${numberText} ${attribute.unit}` : numberText
  }
  if (type === 'boolean') {
    if (valueRow.value_boolean === null || valueRow.value_boolean === undefined) return null
    return Number(valueRow.value_boolean) === 1 ? 'Да' : 'Нет'
  }
  if (type === 'date') return valueRow.value_date || null
  if (type === 'multiselect') {
    let arr = []
    try {
      arr = Array.isArray(valueRow.value_json) ? valueRow.value_json : JSON.parse(valueRow.value_json || '[]')
    } catch {
      arr = []
    }
    return arr.length ? arr.map((item) => options.get(String(item)) || String(item)).join(', ') : null
  }
  const raw = nz(valueRow.value_text)
  if (!raw) return null
  return type === 'select' ? options.get(String(raw)) || raw : raw
}

const buildTree = (rows) => {
  const byId = new Map()
  const roots = []

  rows.forEach((row) => byId.set(row.id, { ...row, children: [] }))
  byId.forEach((node) => {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node)
    } else {
      roots.push(node)
    }
  })

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0)
      return String(a.name || '').localeCompare(String(b.name || ''), 'ru')
    })
    nodes.forEach((node) => sortNodes(node.children))
  }

  sortNodes(roots)
  return roots
}

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const parentIdRaw = req.query.parent_id
    const nodeType = nz(req.query.node_type)
    const isActiveRaw = req.query.is_active
    const asTree = toBool(req.query.tree)
    const limit = clampLimit(req.query.limit, asTree ? 5000 : 200)

    const where = []
    const params = []

    let sql = `
      SELECT n.*,
             p.name AS parent_name,
             (
               SELECT COUNT(*)
                 FROM equipment_classifier_nodes c
                WHERE c.parent_id = n.id
             ) AS children_count
        FROM equipment_classifier_nodes n
        LEFT JOIN equipment_classifier_nodes p ON p.id = n.parent_id
    `

    if (parentIdRaw !== undefined) {
      if (parentIdRaw === '' || parentIdRaw === 'null') {
        where.push('n.parent_id IS NULL')
      } else {
        const parentId = toId(parentIdRaw)
        if (!parentId) {
          return res.status(400).json({ message: 'Некорректный parent_id' })
        }
        where.push('n.parent_id = ?')
        params.push(parentId)
      }
    }

    if (nodeType) {
      if (!ALLOWED_NODE_TYPES.has(nodeType)) {
        return res.status(400).json({ message: 'Некорректный тип узла' })
      }
      where.push('n.node_type = ?')
      params.push(nodeType)
    }

    if (isActiveRaw !== undefined) {
      where.push('n.is_active = ?')
      params.push(toBool(isActiveRaw) ? 1 : 0)
    }

    if (q) {
      where.push('(n.name LIKE ? OR n.code LIKE ? OR n.notes LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY n.sort_order ASC, n.name ASC'
    if (!asTree) sql += ` LIMIT ${limit}`

    const [rows] = await db.execute(sql, params)
    res.json(asTree ? buildTree(rows) : rows)
  } catch (err) {
    console.error('GET /equipment-classifier-nodes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/search', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const limit = clampLimit(req.query.limit, 80, 200)

    if (!q || q.length < 2) {
      return res.json([])
    }

    const like = `%${q}%`
    const perTypeLimit = Math.max(10, Math.ceil(limit / 5))
    const params = [
      like, like,
      like, like, like, like,
      like, like, like,
      like, like, like, like, like,
      like, like, like, like, like,
    ]

    const [rows] = await db.execute(
      `
      SELECT
        entity_type COLLATE utf8mb4_unicode_ci AS entity_type,
        entity_id,
        title COLLATE utf8mb4_unicode_ci AS title,
        subtitle COLLATE utf8mb4_unicode_ci AS subtitle,
        detail COLLATE utf8mb4_unicode_ci AS detail,
        classifier_node_id,
        classifier_node_name COLLATE utf8mb4_unicode_ci AS classifier_node_name,
        client_id,
        sort_group
      FROM (
        SELECT
          'classifier_node' COLLATE utf8mb4_unicode_ci AS entity_type,
          n.id AS entity_id,
          CONVERT(n.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS title,
          CONCAT('Раздел классификатора', IF(n.code IS NULL OR n.code = '', '', CONCAT(' / ', n.code))) COLLATE utf8mb4_unicode_ci AS subtitle,
          CONVERT(COALESCE(n.notes, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci AS detail,
          n.id AS classifier_node_id,
          CONVERT(n.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS classifier_node_name,
          NULL AS client_id,
          10 AS sort_group
        FROM equipment_classifier_nodes n
        WHERE n.name LIKE ? OR n.code LIKE ?
        ORDER BY n.name
        LIMIT ${perTypeLimit}
      ) nodes

      UNION ALL

      SELECT
        entity_type COLLATE utf8mb4_unicode_ci AS entity_type,
        entity_id,
        title COLLATE utf8mb4_unicode_ci AS title,
        subtitle COLLATE utf8mb4_unicode_ci AS subtitle,
        detail COLLATE utf8mb4_unicode_ci AS detail,
        classifier_node_id,
        classifier_node_name COLLATE utf8mb4_unicode_ci AS classifier_node_name,
        client_id,
        sort_group
      FROM (
        SELECT
          'equipment_model' COLLATE utf8mb4_unicode_ci AS entity_type,
          em.id AS entity_id,
          CONCAT(mf.name, ' / ', em.model_name) COLLATE utf8mb4_unicode_ci AS title,
          'Модель оборудования' COLLATE utf8mb4_unicode_ci AS subtitle,
          CONVERT(COALESCE(em.notes, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci AS detail,
          em.classifier_node_id,
          CONVERT(ecn.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS classifier_node_name,
          NULL AS client_id,
          20 AS sort_group
        FROM equipment_models em
        JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
        LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id
        WHERE mf.name LIKE ? OR em.model_name LIKE ? OR em.model_code LIKE ? OR em.notes LIKE ?
        ORDER BY mf.name, em.model_name
        LIMIT ${perTypeLimit}
      ) models

      UNION ALL

      SELECT
        entity_type COLLATE utf8mb4_unicode_ci AS entity_type,
        entity_id,
        title COLLATE utf8mb4_unicode_ci AS title,
        subtitle COLLATE utf8mb4_unicode_ci AS subtitle,
        detail COLLATE utf8mb4_unicode_ci AS detail,
        classifier_node_id,
        classifier_node_name COLLATE utf8mb4_unicode_ci AS classifier_node_name,
        client_id,
        sort_group
      FROM (
        SELECT
          'catalog_position' COLLATE utf8mb4_unicode_ci AS entity_type,
          cp.id AS entity_id,
          cp.display_name COLLATE utf8mb4_unicode_ci AS title,
          'Карточка товара / номенклатурная позиция' COLLATE utf8mb4_unicode_ci AS subtitle,
          CONCAT_WS(' / ', cp.position_code, cp.description, cp.uom) COLLATE utf8mb4_unicode_ci AS detail,
          cp.classifier_node_id,
          CONVERT(ecn.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS classifier_node_name,
          NULL AS client_id,
          25 AS sort_group
        FROM catalog_positions cp
        LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = cp.classifier_node_id
        WHERE cp.is_active = 1
          AND (cp.display_name LIKE ? OR cp.position_code LIKE ? OR cp.description LIKE ?)
        ORDER BY cp.display_name
        LIMIT ${perTypeLimit}
      ) catalog_positions

      UNION ALL

      SELECT
        entity_type COLLATE utf8mb4_unicode_ci AS entity_type,
        entity_id,
        title COLLATE utf8mb4_unicode_ci AS title,
        subtitle COLLATE utf8mb4_unicode_ci AS subtitle,
        detail COLLATE utf8mb4_unicode_ci AS detail,
        classifier_node_id,
        classifier_node_name COLLATE utf8mb4_unicode_ci AS classifier_node_name,
        client_id,
        sort_group
      FROM (
        SELECT
          'client_equipment_unit' COLLATE utf8mb4_unicode_ci AS entity_type,
          ceu.id AS entity_id,
          CONCAT(c.company_name, ' / ', mf.name, ' ', em.model_name) COLLATE utf8mb4_unicode_ci AS title,
          CONCAT('Машина клиента', IF(ceu.serial_number IS NULL OR ceu.serial_number = '', '', CONCAT(' / SN ', ceu.serial_number))) COLLATE utf8mb4_unicode_ci AS subtitle,
          CONCAT_WS(' / ', ceu.internal_name, ceu.site_name, ceu.manufacture_year) COLLATE utf8mb4_unicode_ci AS detail,
          em.classifier_node_id,
          CONVERT(ecn.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS classifier_node_name,
          c.id AS client_id,
          40 AS sort_group
        FROM client_equipment_units ceu
        JOIN clients c ON c.id = ceu.client_id
        JOIN equipment_models em ON em.id = ceu.equipment_model_id
        JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
        LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id
        WHERE c.company_name LIKE ? OR mf.name LIKE ? OR em.model_name LIKE ? OR ceu.serial_number LIKE ? OR ceu.site_name LIKE ?
        ORDER BY c.company_name, mf.name, em.model_name, ceu.serial_number
        LIMIT ${perTypeLimit}
      ) units

      UNION ALL

      SELECT
        entity_type COLLATE utf8mb4_unicode_ci AS entity_type,
        entity_id,
        title COLLATE utf8mb4_unicode_ci AS title,
        subtitle COLLATE utf8mb4_unicode_ci AS subtitle,
        detail COLLATE utf8mb4_unicode_ci AS detail,
        classifier_node_id,
        classifier_node_name COLLATE utf8mb4_unicode_ci AS classifier_node_name,
        client_id,
        sort_group
      FROM (
        SELECT
          'client_part' COLLATE utf8mb4_unicode_ci AS entity_type,
          cp.id AS entity_id,
          CONCAT(c.company_name, ' / ', cp.display_name) COLLATE utf8mb4_unicode_ci AS title,
          CASE cp.relationship_type
            WHEN 'oem_variant' THEN 'Деталь клиента: отличается от OEM'
            WHEN 'oem_replacement' THEN 'Деталь клиента: замена OEM'
            WHEN 'unknown_oem' THEN 'Деталь клиента: OEM неизвестен'
            ELSE 'Деталь клиента по чертежу'
          END COLLATE utf8mb4_unicode_ci AS subtitle,
          CONCAT_WS(' / ', cp.client_part_number, cp.drawing_number, cp.difference_summary) COLLATE utf8mb4_unicode_ci AS detail,
          cp.classifier_node_id,
          CONVERT(ecn.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS classifier_node_name,
          c.id AS client_id,
          50 AS sort_group
        FROM client_parts cp
        JOIN clients c ON c.id = cp.client_id
        LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = cp.classifier_node_id
        WHERE
          c.company_name LIKE ?
          OR cp.display_name LIKE ?
          OR cp.client_part_number LIKE ?
          OR cp.drawing_number LIKE ?
          OR cp.difference_summary LIKE ?
        ORDER BY c.company_name, cp.display_name
        LIMIT ${perTypeLimit}
      ) client_parts

      ORDER BY sort_group, title
      LIMIT ${limit}
      `,
      params
    )

    res.json(rows)
  } catch (err) {
    console.error('GET /equipment-classifier-nodes/search error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

const fetchNodeAttributes = async (nodeId) => {
  const [rows] = await db.execute(
    `
    SELECT
      a.*,
      n.name AS source_node_name,
      0 AS source_depth
    FROM equipment_classifier_node_attributes a
    JOIN equipment_classifier_nodes n ON n.id = a.classifier_node_id
    WHERE a.classifier_node_id = ?
      AND a.is_active = 1
    ORDER BY a.sort_order ASC, a.id ASC
    `,
    [nodeId]
  )

  const attributes = rows.map((row) => ({ ...row, inherited: false }))

  if (!attributes.length) return []

  const attrIds = attributes.map((row) => Number(row.id))
  const [options] = await db.query(
    `
    SELECT *
    FROM equipment_classifier_attribute_options
    WHERE attribute_id IN (?)
      AND is_active = 1
    ORDER BY attribute_id, sort_order, value_label
    `,
    [attrIds]
  )
  const optionsByAttributeId = new Map()
  options.forEach((option) => {
    const key = Number(option.attribute_id)
    if (!optionsByAttributeId.has(key)) optionsByAttributeId.set(key, [])
    optionsByAttributeId.get(key).push(option)
  })

  return attributes.map((row) => ({
    ...row,
    options: optionsByAttributeId.get(Number(row.id)) || [],
  }))
}

const fetchAttributeValues = async ({ nodeId, entityType, entityId }) => {
  const attributes = await fetchNodeAttributes(nodeId)
  if (!attributes.length) return { attributes: [], values: [] }

  const attrIds = attributes.map((row) => Number(row.id))
  const [rows] = await db.query(
    `
    SELECT *
    FROM equipment_attribute_values
    WHERE attribute_id IN (?)
      AND entity_type = ?
      AND entity_id = ?
    `,
    [attrIds, entityType, entityId]
  )
  const valuesByAttributeId = new Map(rows.map((row) => [Number(row.attribute_id), row]))
  const optionsByAttributeId = new Map()
  attributes.forEach((attribute) => {
    const map = new Map()
    ;(attribute.options || []).forEach((option) => map.set(String(option.value_code), option.value_label))
    optionsByAttributeId.set(Number(attribute.id), map)
  })

  return {
    attributes,
    values: attributes.map((attribute) => {
      const valueRow = valuesByAttributeId.get(Number(attribute.id)) || null
      return {
        attribute_id: Number(attribute.id),
        value_text: valueRow?.value_text ?? null,
        value_number: valueRow?.value_number ?? null,
        value_boolean: valueRow?.value_boolean ?? null,
        value_date: valueRow?.value_date ?? null,
        value_json: valueRow?.value_json ?? null,
        display_value: extractAttributeDisplayValue(attribute, valueRow, optionsByAttributeId),
      }
    }),
  }
}

router.get('/:id/attributes', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [[node]] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [id])
    if (!node) return res.status(404).json({ message: 'Узел классификатора не найден' })
    const attributes = await fetchNodeAttributes(id)
    res.json(attributes)
  } catch (err) {
    console.error('GET /equipment-classifier-nodes/:id/attributes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/attributes', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [[node]] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [id])
    if (!node) return res.status(404).json({ message: 'Узел классификатора не найден' })
    if (!(await requireLeafClassifierNode(id, res))) return

    const label = nz(req.body.label)
    const valueType = normalizeAttributeType(req.body.value_type) || 'number'
    const code = buildAttributeCode(req.body.code || label)
    const normalizedUnit = await normalizeAttributeUnit(req.body.unit)
    if (normalizedUnit.error) return res.status(400).json({ message: normalizedUnit.error })
    const unit = normalizedUnit.unit
    const sortOrder = Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : 0
    const isRequired = toBool(req.body.is_required) ? 1 : 0
    const isFilterable = req.body.is_filterable === undefined ? 1 : (toBool(req.body.is_filterable) ? 1 : 0)
    const helpText = nz(req.body.help_text)
    const semanticKey = nz(req.body.semantic_key)

    if (!label) return res.status(400).json({ message: 'Название характеристики обязательно' })

    const [ins] = await db.execute(
      `
      INSERT INTO equipment_classifier_node_attributes
        (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, semantic_key, help_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, code, label, valueType, unit, sortOrder, isRequired, isFilterable, semanticKey, helpText]
    )

    const options = Array.isArray(req.body.options) ? req.body.options : []
    for (let idx = 0; idx < options.length; idx += 1) {
      const optionLabel = nz(options[idx]?.value_label || options[idx]?.label || options[idx])
      if (!optionLabel) continue
      const optionCode = buildAttributeCode(options[idx]?.value_code || options[idx]?.code || optionLabel, `option_${idx + 1}`)
      await db.execute(
        `
        INSERT IGNORE INTO equipment_classifier_attribute_options
          (attribute_id, value_code, value_label, sort_order, is_active)
        VALUES (?, ?, ?, ?, 1)
        `,
        [ins.insertId, optionCode, optionLabel, idx]
      )
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_classifier_node_attributes',
      entity_id: ins.insertId,
      comment: 'Добавлена характеристика узла НСИ',
    })

    const attributes = await fetchNodeAttributes(id)
    res.status(201).json(attributes.find((row) => Number(row.id) === Number(ins.insertId)) || null)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'В этом узле уже есть характеристика с таким кодом' })
    }
    console.error('POST /equipment-classifier-nodes/:id/attributes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/attributes/:attributeId', async (req, res) => {
  try {
    const attributeId = toId(req.params.attributeId)
    if (!attributeId) return res.status(400).json({ message: 'Некорректный идентификатор характеристики' })
    const [[before]] = await db.execute('SELECT * FROM equipment_classifier_node_attributes WHERE id = ?', [attributeId])
    if (!before) return res.status(404).json({ message: 'Характеристика не найдена' })

    const label = req.body.label !== undefined ? nz(req.body.label) : undefined
    const valueType = req.body.value_type !== undefined ? normalizeAttributeType(req.body.value_type) : undefined
    const normalizedUnit = req.body.unit !== undefined ? await normalizeAttributeUnit(req.body.unit) : null
    if (normalizedUnit?.error) return res.status(400).json({ message: normalizedUnit.error })
    const unit = normalizedUnit ? normalizedUnit.unit : undefined
    const sortOrder =
      req.body.sort_order !== undefined
        ? (Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : null)
        : undefined
    const isRequired = req.body.is_required !== undefined ? (toBool(req.body.is_required) ? 1 : 0) : undefined
    const isFilterable = req.body.is_filterable !== undefined ? (toBool(req.body.is_filterable) ? 1 : 0) : undefined
    const isActive = req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : undefined
    const helpText = req.body.help_text !== undefined ? nz(req.body.help_text) : undefined
    const semanticKey = req.body.semantic_key !== undefined ? nz(req.body.semantic_key) : undefined

    if (label !== undefined && !label) return res.status(400).json({ message: 'Название характеристики не может быть пустым' })
    if (req.body.value_type !== undefined && !valueType) return res.status(400).json({ message: 'Некорректный тип характеристики' })
    if (sortOrder === null) return res.status(400).json({ message: 'Некорректный порядок сортировки' })

    await db.execute(
      `
      UPDATE equipment_classifier_node_attributes
      SET
        label = COALESCE(?, label),
        value_type = COALESCE(?, value_type),
        unit = ?,
        sort_order = COALESCE(?, sort_order),
        is_required = COALESCE(?, is_required),
        is_filterable = COALESCE(?, is_filterable),
        is_active = COALESCE(?, is_active),
        semantic_key = ?,
        help_text = ?
      WHERE id = ?
      `,
      [
        sqlValue(label),
        sqlValue(valueType),
        unit === undefined ? before.unit : unit,
        sqlValue(sortOrder),
        sqlValue(isRequired),
        sqlValue(isFilterable),
        sqlValue(isActive),
        semanticKey === undefined ? before.semantic_key : semanticKey,
        helpText === undefined ? before.help_text : helpText,
        attributeId,
      ]
    )

    if (Array.isArray(req.body.options)) {
      await db.execute('DELETE FROM equipment_classifier_attribute_options WHERE attribute_id = ?', [attributeId])
      for (let idx = 0; idx < req.body.options.length; idx += 1) {
        const optionLabel = nz(req.body.options[idx]?.value_label || req.body.options[idx]?.label || req.body.options[idx])
        if (!optionLabel) continue
        const optionCode = buildAttributeCode(req.body.options[idx]?.value_code || req.body.options[idx]?.code || optionLabel, `option_${idx + 1}`)
        await db.execute(
          `
          INSERT INTO equipment_classifier_attribute_options
            (attribute_id, value_code, value_label, sort_order, is_active)
          VALUES (?, ?, ?, ?, 1)
          `,
          [attributeId, optionCode, optionLabel, idx]
        )
      }
    }

    const [[after]] = await db.execute('SELECT * FROM equipment_classifier_node_attributes WHERE id = ?', [attributeId])
    await logFieldDiffs({
      req,
      entity_type: 'equipment_classifier_node_attributes',
      entity_id: attributeId,
      before,
      after,
      comment: 'Изменена характеристика узла НСИ',
    })

    res.json(after)
  } catch (err) {
    console.error('PUT /equipment-classifier-nodes/attributes/:attributeId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/attributes/:attributeId', async (req, res) => {
  try {
    const attributeId = toId(req.params.attributeId)
    if (!attributeId) return res.status(400).json({ message: 'Некорректный идентификатор характеристики' })
    const [[before]] = await db.execute('SELECT * FROM equipment_classifier_node_attributes WHERE id = ?', [attributeId])
    if (!before) return res.status(404).json({ message: 'Характеристика не найдена' })
    await db.execute('UPDATE equipment_classifier_node_attributes SET is_active = 0 WHERE id = ?', [attributeId])
    await logActivity({
      req,
      action: 'delete',
      entity_type: 'equipment_classifier_node_attributes',
      entity_id: attributeId,
      comment: 'Характеристика узла НСИ отключена',
    })
    res.json({ message: 'Характеристика отключена' })
  } catch (err) {
    console.error('DELETE /equipment-classifier-nodes/attributes/:attributeId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/attribute-values', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const entityType = nz(req.query.entity_type) || 'equipment_model'
    const entityId = toId(req.query.entity_id)
    if (!id || !entityId || !ATTRIBUTE_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ message: 'Некорректные параметры характеристик' })
    }

    const table =
      entityType === 'client_equipment_unit'
        ? 'client_equipment_units'
        : entityType === 'catalog_position'
          ? 'catalog_positions'
          : 'equipment_models'
    const [[entity]] = await db.query(`SELECT id FROM ${table} WHERE id = ?`, [entityId])
    if (!entity) return res.status(404).json({ message: 'Объект для характеристик не найден' })

    res.json(await fetchAttributeValues({ nodeId: id, entityType, entityId }))
  } catch (err) {
    console.error('GET /equipment-classifier-nodes/:id/attribute-values error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/attribute-values', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    const entityType = nz(req.body.entity_type) || 'equipment_model'
    const entityId = toId(req.body.entity_id)
    if (!id || !entityId || !ATTRIBUTE_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ message: 'Некорректные параметры характеристик' })
    }
    const values = Array.isArray(req.body.values) ? req.body.values : []
    const table =
      entityType === 'client_equipment_unit'
        ? 'client_equipment_units'
        : entityType === 'catalog_position'
          ? 'catalog_positions'
          : 'equipment_models'
    const [[entity]] = await conn.query(`SELECT id FROM ${table} WHERE id = ?`, [entityId])
    if (!entity) return res.status(404).json({ message: 'Объект для характеристик не найден' })

    const attributes = await fetchNodeAttributes(id)
    const attributesById = new Map(attributes.map((row) => [Number(row.id), row]))

    await conn.beginTransaction()
    for (const entry of values) {
      const attributeId = toId(entry?.attribute_id)
      const attribute = attributeId ? attributesById.get(attributeId) : null
      if (!attribute) continue
      const normalized = normalizeAttributeValue(attribute, entry.value)
      if (normalized.error) {
        await conn.rollback()
        return res.status(400).json({ message: normalized.error })
      }

      await conn.execute(
        `
        INSERT INTO equipment_attribute_values
          (attribute_id, entity_type, entity_id, value_text, value_number, value_boolean, value_date, value_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          value_text = VALUES(value_text),
          value_number = VALUES(value_number),
          value_boolean = VALUES(value_boolean),
          value_date = VALUES(value_date),
          value_json = VALUES(value_json)
        `,
        [
          attributeId,
          entityType,
          entityId,
          normalized.value_text,
          normalized.value_number,
          normalized.value_boolean,
          normalized.value_date,
          normalized.value_json,
        ]
      )
    }
    await conn.commit()

    res.json(await fetchAttributeValues({ nodeId: id, entityType, entityId }))
  } catch (err) {
    try { await conn.rollback() } catch {}
    console.error('PUT /equipment-classifier-nodes/:id/attribute-values error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `
      SELECT n.*,
             p.name AS parent_name,
             (
               SELECT COUNT(*)
                 FROM equipment_classifier_nodes c
                WHERE c.parent_id = n.id
             ) AS children_count
        FROM equipment_classifier_nodes n
        LEFT JOIN equipment_classifier_nodes p ON p.id = n.parent_id
       WHERE n.id = ?
      `,
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Узел классификатора не найден' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /equipment-classifier-nodes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/workspace', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[node]] = await db.execute(
      `
      SELECT n.*,
             p.name AS parent_name,
             (
               SELECT COUNT(*)
                 FROM equipment_classifier_nodes c
                WHERE c.parent_id = n.id
             ) AS children_count
        FROM equipment_classifier_nodes n
        LEFT JOIN equipment_classifier_nodes p ON p.id = n.parent_id
       WHERE n.id = ?
      `,
      [id]
    )
    if (!node) return res.status(404).json({ message: 'Узел классификатора не найден' })

    const subtreeCte = `
      WITH RECURSIVE subtree AS (
        SELECT id, parent_id, name
        FROM equipment_classifier_nodes
        WHERE id = ?
        UNION ALL
        SELECT c.id, c.parent_id, c.name
        FROM equipment_classifier_nodes c
        JOIN subtree s ON s.id = c.parent_id
      )
    `

    const [subtreeNodes] = await db.execute(
      `
      ${subtreeCte}
      SELECT id, parent_id, name
      FROM subtree
      ORDER BY parent_id, name
      `,
      [id]
    )

    const [manufacturers] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        m.id,
        m.name,
        COUNT(DISTINCT em.id) AS models_count,
        COUNT(DISTINCT ceu.id) AS units_count,
        COUNT(DISTINCT cp.id) AS catalog_positions_count
      FROM equipment_manufacturers m
      JOIN equipment_models em
        ON em.manufacturer_id = m.id
      JOIN subtree s
        ON s.id = em.classifier_node_id
      LEFT JOIN client_equipment_units ceu
        ON ceu.equipment_model_id = em.id
      LEFT JOIN catalog_positions cp
        ON cp.equipment_model_id = em.id
       AND cp.is_active = 1
      GROUP BY m.id, m.name
      ORDER BY m.name
      `,
      [id]
    )

    const [models] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        em.id,
        em.model_name,
        em.model_code,
        em.notes,
        em.classifier_node_id,
        ecn.name AS classifier_node_name,
        m.id AS manufacturer_id,
        m.name AS manufacturer_name,
        media.file_url AS primary_photo_url,
        COUNT(DISTINCT ceu.id) AS units_count,
        COUNT(DISTINCT cp.id) AS catalog_positions_count
      FROM equipment_models em
      JOIN subtree s
        ON s.id = em.classifier_node_id
      JOIN equipment_manufacturers m
        ON m.id = em.manufacturer_id
      LEFT JOIN equipment_classifier_nodes ecn
        ON ecn.id = em.classifier_node_id
      LEFT JOIN equipment_model_media media
        ON media.id = (
          SELECT emm.id
          FROM equipment_model_media emm
          WHERE emm.equipment_model_id = em.id
          ORDER BY emm.is_primary DESC, emm.sort_order, emm.id
          LIMIT 1
        )
      LEFT JOIN client_equipment_units ceu
        ON ceu.equipment_model_id = em.id
      LEFT JOIN catalog_positions cp
        ON cp.equipment_model_id = em.id
       AND cp.is_active = 1
      GROUP BY
        em.id, em.model_name, em.model_code, em.notes, em.classifier_node_id,
        ecn.name, m.id, m.name, media.file_url
      ORDER BY m.name, em.model_name
      `,
      [id]
    )

    const [catalogPositions] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        cp.id,
        cp.classifier_node_id,
        cp.display_name,
        cp.position_code,
        cp.description,
        cp.uom,
        cp.created_at,
        cp.updated_at,
        n.name AS classifier_node_name
      FROM catalog_positions cp
      JOIN subtree s
        ON s.id = cp.classifier_node_id
      LEFT JOIN equipment_classifier_nodes n
        ON n.id = cp.classifier_node_id
      WHERE cp.is_active = 1
      ORDER BY cp.display_name, cp.id
      LIMIT 500
      `,
      [id]
    )

    const [units] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        ceu.id,
        ceu.client_id,
        ceu.equipment_model_id,
        ceu.serial_number,
        ceu.manufacture_year,
        ceu.site_name,
        ceu.internal_name,
        ceu.status,
        c.company_name AS client_name,
        em.model_name,
        em.model_code,
        m.id AS manufacturer_id,
        m.name AS manufacturer_name
      FROM client_equipment_units ceu
      JOIN equipment_models em
        ON em.id = ceu.equipment_model_id
      JOIN subtree s
        ON s.id = em.classifier_node_id
      JOIN clients c
        ON c.id = ceu.client_id
      JOIN equipment_manufacturers m
        ON m.id = em.manufacturer_id
      ORDER BY c.company_name, m.name, em.model_name, ceu.serial_number, ceu.id
      `,
      [id]
    )

    const [clientParts] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        cp.id,
        cp.client_id,
        cp.classifier_node_id,
        NULL AS base_oem_part_id,
        cp.relationship_type,
        cp.client_part_number,
        cp.drawing_number,
        cp.revision_code,
        cp.display_name,
        cp.description_ru,
        cp.difference_summary,
        cp.material_note,
        cp.status,
        cp.created_at,
        c.company_name AS client_name,
        ecn.name AS classifier_node_name,
        NULL AS base_oem_part_number,
        NULL AS base_oem_description_ru,
        NULL AS base_oem_manufacturer_name,
        COUNT(DISTINCT cpa.id) AS applications_count,
        GROUP_CONCAT(
          DISTINCT
          CASE
            WHEN cpa.equipment_model_id IS NOT NULL
            THEN CONCAT(COALESCE(app_mf.name, ''), ' ', COALESCE(app_em.model_name, ''), IF(app_em.model_code IS NULL OR app_em.model_code = '', '', CONCAT(' / ', app_em.model_code)))
            ELSE NULL
          END
          ORDER BY app_mf.name, app_em.model_name
          SEPARATOR ' | '
        ) AS application_model_refs,
        GROUP_CONCAT(
          DISTINCT cpa.equipment_model_id
          ORDER BY cpa.equipment_model_id
          SEPARATOR ','
        ) AS application_model_ids,
        GROUP_CONCAT(
          DISTINCT
          CASE
            WHEN cpa.client_equipment_unit_id IS NOT NULL
            THEN CONCAT(
              COALESCE(app_c.company_name, ''),
              ' / ',
              COALESCE(unit_mf.name, ''),
              ' ',
              COALESCE(unit_em.model_name, ''),
              IF(app_ceu.serial_number IS NULL OR app_ceu.serial_number = '', '', CONCAT(' / SN ', app_ceu.serial_number)),
              IF(app_ceu.site_name IS NULL OR app_ceu.site_name = '', '', CONCAT(' / ', app_ceu.site_name))
            )
            ELSE NULL
          END
          ORDER BY app_c.company_name, unit_mf.name, unit_em.model_name, app_ceu.serial_number
          SEPARATOR ' | '
        ) AS application_unit_refs
        ,
        GROUP_CONCAT(
          DISTINCT unit_em.id
          ORDER BY unit_em.id
          SEPARATOR ','
        ) AS application_unit_model_ids
      FROM client_parts cp
      JOIN clients c
        ON c.id = cp.client_id
      LEFT JOIN equipment_classifier_nodes ecn
        ON ecn.id = cp.classifier_node_id
      LEFT JOIN client_part_applications cpa
        ON cpa.client_part_id = cp.id
      LEFT JOIN equipment_models app_em
        ON app_em.id = cpa.equipment_model_id
      LEFT JOIN equipment_manufacturers app_mf
        ON app_mf.id = app_em.manufacturer_id
      LEFT JOIN client_equipment_units app_ceu
        ON app_ceu.id = cpa.client_equipment_unit_id
      LEFT JOIN clients app_c
        ON app_c.id = app_ceu.client_id
      LEFT JOIN equipment_models unit_em
        ON unit_em.id = app_ceu.equipment_model_id
      LEFT JOIN equipment_manufacturers unit_mf
        ON unit_mf.id = unit_em.manufacturer_id
      WHERE
        cp.classifier_node_id IN (SELECT id FROM subtree)
        OR EXISTS (
          SELECT 1
          FROM client_part_applications cpa_model
          JOIN equipment_models em ON em.id = cpa_model.equipment_model_id
          JOIN subtree s ON s.id = em.classifier_node_id
          WHERE cpa_model.client_part_id = cp.id
        )
        OR EXISTS (
          SELECT 1
          FROM client_part_applications cpa_unit
          JOIN client_equipment_units ceu ON ceu.id = cpa_unit.client_equipment_unit_id
          JOIN equipment_models em ON em.id = ceu.equipment_model_id
          JOIN subtree s ON s.id = em.classifier_node_id
          WHERE cpa_unit.client_part_id = cp.id
        )
      GROUP BY
        cp.id, cp.client_id, cp.classifier_node_id,
        cp.relationship_type, cp.client_part_number, cp.drawing_number,
        cp.revision_code, cp.display_name, cp.description_ru, cp.difference_summary,
        cp.material_note, cp.status, cp.created_at, c.company_name, ecn.name
      ORDER BY c.company_name, cp.display_name, cp.id
      `,
      [id]
    )

    const [[stats]] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        COUNT(DISTINCT s.id) AS subtree_nodes_count,
        COUNT(DISTINCT em.id) AS models_count,
        COUNT(DISTINCT em.manufacturer_id) AS manufacturers_count,
        COUNT(DISTINCT ceu.id) AS units_count,
        COUNT(DISTINCT cat.id) AS catalog_positions_count,
        (
          SELECT COUNT(DISTINCT cp.id)
          FROM client_parts cp
          WHERE
            cp.classifier_node_id IN (SELECT id FROM subtree)
            OR EXISTS (
              SELECT 1
              FROM client_part_applications cpa_model
              JOIN equipment_models em2 ON em2.id = cpa_model.equipment_model_id
              JOIN subtree s2 ON s2.id = em2.classifier_node_id
              WHERE cpa_model.client_part_id = cp.id
            )
            OR EXISTS (
              SELECT 1
              FROM client_part_applications cpa_unit
              JOIN client_equipment_units ceu2 ON ceu2.id = cpa_unit.client_equipment_unit_id
              JOIN equipment_models em3 ON em3.id = ceu2.equipment_model_id
              JOIN subtree s3 ON s3.id = em3.classifier_node_id
              WHERE cpa_unit.client_part_id = cp.id
            )
        ) AS client_parts_count
      FROM subtree s
      LEFT JOIN equipment_models em
        ON em.classifier_node_id = s.id
      LEFT JOIN client_equipment_units ceu
        ON ceu.equipment_model_id = em.id
      LEFT JOIN catalog_positions cat
        ON cat.classifier_node_id = s.id
       AND cat.is_active = 1
      `,
      [id]
    )

    let enrichedModels = models
    let enrichedCatalogPositions = catalogPositions
    const workspaceAttributes = await fetchNodeAttributes(id)
    const optionsByAttributeId = new Map()
    workspaceAttributes.forEach((attribute) => {
      const map = new Map()
      ;(attribute.options || []).forEach((option) => map.set(String(option.value_code), option.value_label))
      optionsByAttributeId.set(Number(attribute.id), map)
    })
    const attributesById = new Map(workspaceAttributes.map((attribute) => [Number(attribute.id), attribute]))
    const modelIds = models.map((row) => Number(row.id)).filter(Boolean)
    if (workspaceAttributes.length && modelIds.length) {
      const attrIds = workspaceAttributes.map((row) => Number(row.id)).filter(Boolean)
      const [modelAttributeRows] = await db.query(
        `
        SELECT *
        FROM equipment_attribute_values
        WHERE entity_type = 'equipment_model'
          AND entity_id IN (?)
          AND attribute_id IN (?)
        `,
        [modelIds, attrIds]
      )

      const valuesByModelId = new Map()
      modelAttributeRows.forEach((valueRow) => {
        const modelId = Number(valueRow.entity_id)
        const attribute = attributesById.get(Number(valueRow.attribute_id))
        if (!attribute) return
        if (!valuesByModelId.has(modelId)) valuesByModelId.set(modelId, [])
        valuesByModelId.get(modelId).push({
          attribute_id: Number(attribute.id),
          code: attribute.code,
          label: attribute.label,
          value_type: attribute.value_type,
          unit: attribute.unit,
          value_text: valueRow.value_text,
          value_number: valueRow.value_number,
          value_boolean: valueRow.value_boolean,
          value_date: valueRow.value_date,
          value_json: valueRow.value_json,
          display_value: extractAttributeDisplayValue(attribute, valueRow, optionsByAttributeId),
        })
      })

      enrichedModels = models.map((model) => ({
        ...model,
        attribute_values: valuesByModelId.get(Number(model.id)) || [],
      }))
    }

    const catalogPositionIds = catalogPositions.map((row) => Number(row.id)).filter(Boolean)
    if (workspaceAttributes.length && catalogPositionIds.length) {
      const attrIds = workspaceAttributes.map((row) => Number(row.id)).filter(Boolean)
      const [catalogAttributeRows] = await db.query(
        `
        SELECT *
        FROM equipment_attribute_values
        WHERE entity_type = 'catalog_position'
          AND entity_id IN (?)
          AND attribute_id IN (?)
        `,
        [catalogPositionIds, attrIds]
      )

      const valuesByPositionId = new Map()
      catalogAttributeRows.forEach((valueRow) => {
        const positionId = Number(valueRow.entity_id)
        const attribute = attributesById.get(Number(valueRow.attribute_id))
        if (!attribute) return
        if (!valuesByPositionId.has(positionId)) valuesByPositionId.set(positionId, [])
        valuesByPositionId.get(positionId).push({
          attribute_id: Number(attribute.id),
          code: attribute.code,
          label: attribute.label,
          value_type: attribute.value_type,
          unit: attribute.unit,
          value_text: valueRow.value_text,
          value_number: valueRow.value_number,
          value_boolean: valueRow.value_boolean,
          value_date: valueRow.value_date,
          value_json: valueRow.value_json,
          display_value: extractAttributeDisplayValue(attribute, valueRow, optionsByAttributeId),
        })
      })

      enrichedCatalogPositions = catalogPositions.map((position) => ({
        ...position,
        attribute_values: valuesByPositionId.get(Number(position.id)) || [],
      }))
    }

    res.json({
      node,
      subtree_nodes: subtreeNodes,
      manufacturers,
      models: enrichedModels,
      catalog_positions: enrichedCatalogPositions,
      client_equipment_units: units,
      client_parts: clientParts,
      stats: stats || {},
    })
  } catch (err) {
    console.error('GET /equipment-classifier-nodes/:id/workspace error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const parent_id =
      req.body.parent_id === undefined || req.body.parent_id === null || req.body.parent_id === ''
        ? null
        : toId(req.body.parent_id)
    const name = nz(req.body.name)
    const node_type = nz(req.body.node_type) || 'CATEGORY'
    const card_kind = normalizeCardKind(req.body.card_kind, 'auto')
    const code = nz(req.body.code)
    const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : 0
    const is_active = req.body.is_active === undefined ? 1 : (toBool(req.body.is_active) ? 1 : 0)
    const notes = nz(req.body.notes)
    const card_image_url = nz(req.body.card_image_url)

    if (!name) return res.status(400).json({ message: 'name обязателен' })
    if (!ALLOWED_NODE_TYPES.has(node_type)) {
      return res.status(400).json({ message: 'Некорректный тип узла' })
    }
    if (!card_kind) {
      return res.status(400).json({ message: 'Некорректный тип карточек раздела' })
    }
    if (req.body.parent_id !== undefined && req.body.parent_id !== null && req.body.parent_id !== '' && !parent_id) {
      return res.status(400).json({ message: 'Некорректный parent_id' })
    }
    if (parent_id) {
      const [parent] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [parent_id])
      if (!parent.length) {
        return res.status(400).json({ message: 'Родительский узел не найден' })
      }
      if (!(await requireCanAddChildNode(parent_id, res))) return
    }

    const [ins] = await db.execute(
      `
      INSERT INTO equipment_classifier_nodes
        (parent_id, name, node_type, card_kind, code, sort_order, is_active, notes, card_image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [parent_id, name, node_type, card_kind, code, sort_order, is_active, notes, card_image_url]
    )

    const [[created]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [
      ins.insertId,
    ])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_classifier_nodes',
      entity_id: ins.insertId,
      comment: 'Добавлен узел классификатора оборудования',
    })

    res.status(201).json(created)
  } catch (err) {
    console.error('POST /equipment-classifier-nodes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Узел классификатора не найден' })

    const parent_id =
      req.body.parent_id === undefined
        ? undefined
        : (req.body.parent_id === null || req.body.parent_id === '' ? null : toId(req.body.parent_id))
    const name = req.body.name !== undefined ? nz(req.body.name) : undefined
    const node_type = req.body.node_type !== undefined ? nz(req.body.node_type) : undefined
    const card_kind =
      req.body.card_kind !== undefined ? normalizeCardKind(req.body.card_kind, before.card_kind || 'auto') : undefined
    const code = req.body.code !== undefined ? nz(req.body.code) : undefined
    const sort_order =
      req.body.sort_order !== undefined
        ? (Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : null)
        : undefined
    const is_active = req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : undefined
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : undefined
    const card_image_url = req.body.card_image_url !== undefined ? nz(req.body.card_image_url) : undefined

    if (parent_id !== undefined && req.body.parent_id !== null && req.body.parent_id !== '' && !parent_id) {
      return res.status(400).json({ message: 'Некорректный parent_id' })
    }
    if (parent_id === id) return res.status(400).json({ message: 'Узел не может быть родителем самого себя' })
    if (name !== undefined && !name) return res.status(400).json({ message: 'name не может быть пустым' })
    if (node_type !== undefined && !ALLOWED_NODE_TYPES.has(node_type)) {
      return res.status(400).json({ message: 'Некорректный тип узла' })
    }
    if (card_kind !== undefined && !card_kind) {
      return res.status(400).json({ message: 'Некорректный тип карточек раздела' })
    }
    if (sort_order !== undefined && sort_order === null) {
      return res.status(400).json({ message: 'Некорректный sort_order' })
    }
    if (parent_id) {
      const [parent] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [parent_id])
      if (!parent.length) return res.status(400).json({ message: 'Родительский узел не найден' })
    }

    await db.execute(
      `
      UPDATE equipment_classifier_nodes
         SET parent_id = ?,
             name = COALESCE(?, name),
             node_type = COALESCE(?, node_type),
             card_kind = COALESCE(?, card_kind),
             code = COALESCE(?, code),
             sort_order = COALESCE(?, sort_order),
             is_active = COALESCE(?, is_active),
             notes = ?,
             card_image_url = ?
       WHERE id = ?
      `,
      [
        parent_id === undefined ? before.parent_id : parent_id,
        sqlValue(name),
        sqlValue(node_type),
        sqlValue(card_kind),
        sqlValue(code),
        sqlValue(sort_order),
        sqlValue(is_active),
        notes === undefined ? before.notes : notes,
        card_image_url === undefined ? before.card_image_url : card_image_url,
        id,
      ]
    )

    const [[after]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'equipment_classifier_nodes',
      entity_id: id,
      oldData: before,
      newData: after,
    })

    res.json(after)
  } catch (err) {
    console.error('PUT /equipment-classifier-nodes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/card-image', upload.single('file'), async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    if (!bucket || !bucketName) return res.status(500).json({ message: 'GCS бакет не настроен на сервере' })

    const [nodes] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [id])
    if (!nodes.length) return res.status(404).json({ message: 'Раздел классификатора не найден' })

    const file = req.file
    if (!file) return res.status(400).json({ message: 'Файл не загружен' })
    if (!IMAGE_TYPES.has(file.mimetype)) {
      return res.status(415).json({ message: `Недопустимый тип изображения: ${file.mimetype}` })
    }

    const ext = path.extname(file.originalname || '') || '.jpg'
    const rawBase = path.basename(file.originalname || 'classifier-card', ext)
    const safeBase = rawBase.replace(/[^\w-]+/g, '_').slice(0, 80) || 'classifier-card'
    const objectPath = ['equipment-classifier', String(id), `${Date.now()}_${safeBase}${ext}`]
      .map((seg) => encodeURIComponent(seg))
      .join('/')

    await bucket.file(objectPath).save(file.buffer, {
      resumable: false,
      metadata: { contentType: file.mimetype },
    })

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
    await db.execute('UPDATE equipment_classifier_nodes SET card_image_url = ? WHERE id = ?', [publicUrl, id])

    await logActivity({
      req,
      action: 'upload_card_image',
      entity_type: 'equipment_classifier_nodes',
      entity_id: id,
      comment: `Загружено фото карточки раздела "${file.originalname || ''}"`,
    })

    res.status(201).json({ card_image_url: publicUrl })
  } catch (err) {
    console.error('POST /equipment-classifier-nodes/:id/card-image error:', err)
    res.status(500).json({ message: 'Ошибка загрузки фото карточки' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Узел классификатора не найден' })

    const preview = await buildTrashPreview('equipment_classifier_nodes', id)
    if (!preview) return res.status(404).json({ message: 'Узел классификатора не найден' })
    if (preview.mode !== MODE.TRASH) {
      return res.status(409).json({
        message: preview.summary?.message || 'Удаление недоступно',
        preview,
      })
    }

    const conn = await db.getConnection()
    await conn.beginTransaction()
    try {
      const trashEntryId = await createTrashEntry({
        executor: conn,
        req,
        entityType: 'equipment_classifier_nodes',
        entityId: id,
        rootEntityType: 'equipment_classifier_nodes',
        rootEntityId: id,
        deleteMode: 'trash',
        title: before.name || `Узел #${id}`,
        subtitle: 'Классификатор оборудования',
        snapshot: before,
      })

      await conn.execute('DELETE FROM equipment_classifier_nodes WHERE id = ?', [id])

      await logActivity({
        req,
        action: 'delete',
        entity_type: 'equipment_classifier_nodes',
        entity_id: id,
        comment: `Удалён узел классификатора: ${before.name}`,
        new_value: { trash_entry_id: trashEntryId },
      })

      await conn.commit()
      res.json({ success: true, trash_entry_id: trashEntryId, message: 'Узел перемещён в корзину' })
    } catch (err) {
      try {
        await conn.rollback()
      } catch {}
      throw err
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('DELETE /equipment-classifier-nodes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
