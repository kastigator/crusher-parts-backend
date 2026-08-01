const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const { bucket, bucketName } = require('../utils/gcsClient')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const clampLimit = (v, def = 50, max = 200) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const parseJson = (value) => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const STOP_WORDS = new Set([
  'and',
  'assy',
  'assembly',
  'bom',
  'created',
  'part',
  'parts',
  'the',
  'для',
  'или',
  'из',
  'на',
  'под',
  'при',
  'узел',
  'сборка',
  'деталь',
  'позиция',
  'создано',
  'модели',
  'модель',
])

const tokenizeSuggestionText = (...values) => {
  const text = values.filter(Boolean).join(' ').toLowerCase()
  const tokens = text.match(/[a-zа-яё0-9]{3,}/giu) || []
  return Array.from(new Set(tokens.filter((token) => !STOP_WORDS.has(token)))).slice(0, 8)
}

const getMetaTnvedIdSql = (alias = 'cp') => `CAST(JSON_UNQUOTE(JSON_EXTRACT(${alias}.meta_json, '$.tnved_code_id')) AS UNSIGNED)`

const scoreSuggestion = (row, tokens, sameBom = false) => {
  const haystack = [
    row.display_name,
    row.display_name_en,
    row.display_name_ru,
    row.manufacturer_part_number,
    row.manufacturer_part_name,
    row.manufacturer_part_name_en,
    row.manufacturer_part_name_ru,
    row.description,
    row.materials_summary,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const matched = tokens.filter((token) => haystack.includes(token.toLowerCase()))
  let score = matched.length * 10
  if (sameBom) score += 8
  if (row.same_classifier_node) score += 4
  if (row.materials_summary) score += 2
  return { score, matched }
}

const groupTnvedSuggestions = (rows, tokens, source, sourceLabel, sameBom = false) => {
  const byCode = new Map()
  for (const row of rows) {
    if (!row.tnved_id || !row.tnved_code) continue
    const scored = scoreSuggestion(row, tokens, sameBom)
    if (!scored.score && tokens.length) continue
    const key = String(row.tnved_id)
    const existing = byCode.get(key)
    const example = {
      catalog_position_id: row.catalog_position_id,
      manufacturer_part_number: row.manufacturer_part_number,
      name: row.display_name || row.manufacturer_part_name || row.manufacturer_part_name_en || row.manufacturer_part_name_ru,
      model_name: row.model_name || null,
      matched_tokens: scored.matched,
    }
    if (!existing) {
      byCode.set(key, {
        source,
        source_label: sourceLabel,
        score: scored.score,
        id: row.tnved_id,
        code: row.tnved_code,
        description: row.tnved_description,
        duty_rate: row.duty_rate,
        notes: row.notes,
        usage_count: 1,
        examples: [example],
        matched_tokens: scored.matched,
      })
      continue
    }
    existing.score += scored.score
    existing.usage_count += 1
    existing.matched_tokens = Array.from(new Set([...existing.matched_tokens, ...scored.matched]))
    if (existing.examples.length < 3) existing.examples.push(example)
  }
  return Array.from(byCode.values()).sort((a, b) => b.score - a.score || b.usage_count - a.usage_count || String(a.code).localeCompare(String(b.code), 'ru')).slice(0, 5)
}

const normalizeCardMeta = (meta) => {
  const next = { ...parseJson(meta) }
  for (const key of ['length', 'width', 'height']) {
    const mmKey = `${key}_mm`
    const legacyCmKey = `${key}_cm`
    if (next[mmKey] === undefined && next[legacyCmKey] !== undefined) {
      const cmValue = numOrNull(next[legacyCmKey])
      if (cmValue !== null) next[mmKey] = cmValue * 10
    }
  }
  return next
}

const analogConflict = (message) => {
  const err = new Error(message)
  err.statusCode = 409
  return err
}

const fetchAnalogMembership = async (conn, catalogPositionId, { lock = false } = {}) => {
  const lockSql = lock ? ' FOR UPDATE' : ''
  const [incoming] = await conn.execute(
    `
    SELECT id, primary_catalog_position_id, related_catalog_position_id
    FROM catalog_position_relations
    WHERE related_catalog_position_id = ?
      AND relationship_type = 'analog'${lockSql}
    `,
    [catalogPositionId]
  )
  if (incoming.length > 1) {
    throw analogConflict('Карточка связана с несколькими основными позициями. Сначала исправьте группу аналогов.')
  }

  if (incoming.length) {
    const [nestedOutgoing] = await conn.execute(
      `
      SELECT id
      FROM catalog_position_relations
      WHERE primary_catalog_position_id = ?
        AND relationship_type = 'analog'${lockSql}
      `,
      [catalogPositionId]
    )
    if (nestedOutgoing.length) {
      throw analogConflict('Карточка одновременно является основной и аналогом. Сначала исправьте структуру группы.')
    }
  }

  const primaryId = incoming[0]?.primary_catalog_position_id || catalogPositionId
  const [primaryIncoming] = primaryId === catalogPositionId
    ? [incoming]
    : await conn.execute(
        `
        SELECT id, primary_catalog_position_id, related_catalog_position_id
        FROM catalog_position_relations
        WHERE related_catalog_position_id = ?
          AND relationship_type = 'analog'${lockSql}
        `,
        [primaryId]
      )
  if (primaryIncoming.length) {
    throw analogConflict('Группа аналогов имеет вложенную основную позицию. Сначала исправьте структуру группы.')
  }

  const [outgoing] = await conn.execute(
    `
    SELECT id, primary_catalog_position_id, related_catalog_position_id
    FROM catalog_position_relations
    WHERE primary_catalog_position_id = ?
      AND relationship_type = 'analog'${lockSql}
    ORDER BY id
    `,
    [primaryId]
  )
  const memberIds = new Set([primaryId, ...outgoing.map((row) => Number(row.related_catalog_position_id))])

  if (incoming.length && !memberIds.has(Number(catalogPositionId))) {
    throw analogConflict('Карточка не входит в найденную группу аналогов.')
  }

  return {
    primaryId: Number(primaryId),
    incoming,
    outgoing,
    memberIds,
  }
}

const ensureActiveCatalogPositions = async (conn, ids, { lock = false } = {}) => {
  const uniqueIds = Array.from(new Set(ids.map(toId).filter(Boolean)))
  if (!uniqueIds.length) return []
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const [rows] = await conn.execute(
    `
    SELECT id, manufacturer_part_number, position_code, display_name
    FROM catalog_positions
    WHERE id IN (${placeholders})
      AND is_active = 1
    ${lock ? 'FOR UPDATE' : ''}
    `,
    uniqueIds
  )
  if (rows.length !== uniqueIds.length) {
    const found = new Set(rows.map((row) => Number(row.id)))
    const missing = uniqueIds.filter((id) => !found.has(id))
    const err = new Error(`Карточки не найдены или архивированы: ${missing.join(', ')}`)
    err.statusCode = 400
    throw err
  }
  return rows
}

const buildCatalogPositionObjectPath = (id, file) => {
  const ext = path.extname(file.originalname || '') || '.jpg'
  const rawBase = path.basename(file.originalname || 'catalog-position-photo', ext)
  const safeBase = rawBase.replace(/[^\w-]+/g, '_').slice(0, 80) || 'catalog-position-photo'
  return ['catalog-positions', String(id), `${Date.now()}_${safeBase}${ext}`]
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

const normalizeClassifierAttributeValue = (attribute, rawValue) => {
  const empty = rawValue === undefined || rawValue === null || rawValue === ''
  const type = String(attribute.value_type || '')
  if (['text', 'textarea'].includes(type)) {
    return { value_text: nz(rawValue), value_number: null, value_boolean: null, value_date: null, value_json: null }
  }
  if (type === 'number') {
    if (empty) return { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: null }
    const value = numOrNull(rawValue)
    if (value === null) return { error: `${attribute.label}: нужно число` }
    return { value_text: null, value_number: value, value_boolean: null, value_date: null, value_json: null }
  }
  if (type === 'boolean') {
    if (empty) return { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: null }
    const normalized = String(rawValue).trim().toLowerCase()
    const truthy = rawValue === true || rawValue === 1 || ['1', 'true', 'да', 'yes'].includes(normalized)
    const falsy = rawValue === false || rawValue === 0 || ['0', 'false', 'нет', 'no'].includes(normalized)
    if (!truthy && !falsy) return { error: `${attribute.label}: укажите «Да» или «Нет»` }
    return { value_text: null, value_number: null, value_boolean: truthy ? 1 : 0, value_date: null, value_json: null }
  }
  if (type === 'date') {
    if (empty) return { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: null }
    const value = nz(rawValue)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return { error: `${attribute.label}: нужна дата ГГГГ-ММ-ДД` }
    return { value_text: null, value_number: null, value_boolean: null, value_date: value, value_json: null }
  }
  if (['select', 'multiselect'].includes(type)) {
    const rawItems = type === 'multiselect'
      ? (Array.isArray(rawValue) ? rawValue : String(rawValue || '').split(/[;,]/)).map((item) => nz(item)).filter(Boolean)
      : empty ? [] : [nz(rawValue)]
    const optionMap = new Map()
    ;(attribute.options || []).forEach((option) => {
      optionMap.set(String(option.value_code).trim().toLowerCase(), option.value_code)
      optionMap.set(String(option.value_label).trim().toLowerCase(), option.value_code)
    })
    const values = []
    for (const item of rawItems) {
      const code = optionMap.get(String(item).trim().toLowerCase())
      if (!code) return { error: `${attribute.label}: неизвестное значение «${item}»` }
      if (!values.includes(code)) values.push(code)
    }
    return type === 'multiselect'
      ? { value_text: null, value_number: null, value_boolean: null, value_date: null, value_json: values.length ? JSON.stringify(values) : null }
      : { value_text: values[0] || null, value_number: null, value_boolean: null, value_date: null, value_json: null }
  }
  return { error: `${attribute.label}: неподдерживаемый тип характеристики` }
}

const deriveCatalogAttributeValues = (items) => {
  const bySemanticKey = new Map(items.map((item) => [item.attribute.semantic_key, item]))
  const unitWeight = bySemanticKey.get('weight_kg')
  const weightPerThousand = bySemanticKey.get('weight_per_1000_kg')
  if (unitWeight && unitWeight.normalized.value_number === null && weightPerThousand?.normalized.value_number !== null) {
    unitWeight.normalized.value_number = Number(weightPerThousand.normalized.value_number) / 1000
  }
}

const canonicalCatalogMeta = (items) => {
  const supportedKeys = new Set(['weight_kg', 'length_mm', 'width_mm', 'height_mm'])
  return items.reduce((meta, item) => {
    const key = item.attribute.semantic_key
    if (supportedKeys.has(key) && item.normalized.value_number !== null) {
      meta[key] = Number(item.normalized.value_number)
    }
    return meta
  }, {})
}

const loadCatalogPositionAttributes = async (executor, nodeId) => {
  const [attributes] = await executor.execute(
    `
    SELECT a.*
    FROM equipment_classifier_node_attributes a
    JOIN equipment_classifier_attribute_scopes s
      ON s.attribute_id = a.id
     AND s.entity_type = 'catalog_position'
    WHERE a.classifier_node_id = ? AND a.is_active = 1
    ORDER BY a.sort_order, a.id
    `,
    [nodeId]
  )
  if (!attributes.length) return []
  const [options] = await executor.query(
    `SELECT * FROM equipment_classifier_attribute_options WHERE attribute_id IN (?) AND is_active = 1 ORDER BY sort_order, id`,
    [attributes.map((attribute) => Number(attribute.id))]
  )
  const optionsByAttribute = new Map()
  options.forEach((option) => {
    const id = Number(option.attribute_id)
    if (!optionsByAttribute.has(id)) optionsByAttribute.set(id, [])
    optionsByAttribute.get(id).push(option)
  })
  return attributes.map((attribute) => ({ ...attribute, options: optionsByAttribute.get(Number(attribute.id)) || [] }))
}

router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const classifierNodeId = toId(req.body.classifier_node_id)
    const displayName = nz(req.body.display_name)
    const manufacturerId = req.body.manufacturer_id ? toId(req.body.manufacturer_id) : null
    const positionCode = nz(req.body.position_code)
    const manufacturerPartNumber = nz(req.body.manufacturer_part_number)
    const uom = nz(req.body.uom)
    if (!classifierNodeId) return res.status(400).json({ message: 'Выберите раздел классификатора' })
    if (!displayName) return res.status(400).json({ message: 'Название позиции обязательно' })
    if (req.body.manufacturer_id && !manufacturerId) return res.status(400).json({ message: 'Некорректный производитель' })

    const [[node]] = await conn.execute(
      `
      SELECT n.*, (SELECT COUNT(*) FROM equipment_classifier_nodes c WHERE c.parent_id = n.id AND c.is_active = 1) AS children_count
      FROM equipment_classifier_nodes n
      WHERE n.id = ? AND n.is_active = 1
      `,
      [classifierNodeId]
    )
    if (!node) return res.status(404).json({ message: 'Раздел классификатора не найден' })
    if (Number(node.children_count || 0) > 0) return res.status(400).json({ message: 'Позиции создаются только в конечном разделе' })
    if (!['catalog_position', 'material', 'service'].includes(node.card_kind)) {
      return res.status(400).json({ message: 'Этот раздел не предназначен для карточек номенклатуры' })
    }
    if (manufacturerId) {
      const [[manufacturer]] = await conn.execute('SELECT id FROM equipment_manufacturers WHERE id = ?', [manufacturerId])
      if (!manufacturer) return res.status(400).json({ message: 'Производитель не найден' })
    }
    if (uom) {
      const [[unit]] = await conn.execute('SELECT code FROM measurement_units WHERE code = ? AND is_active = 1', [uom])
      if (!unit) return res.status(400).json({ message: 'Единица хранения не найдена' })
    }
    if (positionCode) {
      const [[duplicate]] = await conn.execute('SELECT id FROM catalog_positions WHERE position_code = ? LIMIT 1', [positionCode])
      if (duplicate) return res.status(409).json({ message: 'Внутренний код уже используется другой позицией' })
    }
    if (manufacturerId && manufacturerPartNumber) {
      const [[duplicate]] = await conn.execute(
        `SELECT id FROM catalog_positions WHERE manufacturer_id = ? AND LOWER(manufacturer_part_number) = LOWER(?) AND is_active = 1 LIMIT 1`,
        [manufacturerId, manufacturerPartNumber]
      )
      if (duplicate) return res.status(409).json({ message: 'У этого производителя уже есть позиция с таким номером' })
    }
    const attributes = await loadCatalogPositionAttributes(conn, classifierNodeId)
    const submittedValues = Array.isArray(req.body.attribute_values) ? req.body.attribute_values : []
    const valuesByAttributeId = new Map(submittedValues.map((item) => [Number(item.attribute_id), item.value]))
    const normalizedValues = []
    for (const attribute of attributes) {
      const rawValue = valuesByAttributeId.get(Number(attribute.id))
      if (Number(attribute.is_required || 0) === 1 && (rawValue === undefined || rawValue === null || rawValue === '')) {
        return res.status(400).json({ message: `Заполните обязательную характеристику «${attribute.label}»` })
      }
      const normalized = normalizeClassifierAttributeValue(attribute, rawValue)
      if (normalized.error) return res.status(400).json({ message: normalized.error })
      normalizedValues.push({ attribute, normalized })
    }
    deriveCatalogAttributeValues(normalizedValues)
    const meta = canonicalCatalogMeta(normalizedValues)

    await conn.beginTransaction()
    const positionKind = node.card_kind === 'service' ? 'service' : node.card_kind === 'material' ? 'material' : 'part'
    const [insert] = await conn.execute(
      `
      INSERT INTO catalog_positions
        (classifier_node_id, manufacturer_id, position_kind, source_kind, display_name, display_name_en,
         display_name_ru, position_code, manufacturer_part_number, description, drawing_number, uom, meta_json)
      VALUES (?, ?, ?, 'classifier', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [classifierNodeId, manufacturerId, positionKind, displayName, nz(req.body.display_name_en),
        nz(req.body.display_name_ru), positionCode, manufacturerPartNumber, nz(req.body.description),
        nz(req.body.drawing_number), uom, Object.keys(meta).length ? JSON.stringify(meta) : null]
    )
    const positionId = Number(insert.insertId)
    for (const { attribute, normalized } of normalizedValues) {
      await conn.execute(
        `
        INSERT INTO equipment_attribute_values
          (attribute_id, entity_type, entity_id, value_text, value_number, value_boolean, value_date, value_json)
        VALUES (?, 'catalog_position', ?, ?, ?, ?, ?, ?)
        `,
        [attribute.id, positionId, normalized.value_text, normalized.value_number, normalized.value_boolean,
          normalized.value_date, normalized.value_json]
      )
    }
    await conn.commit()
    await logActivity({
      req,
      action: 'create',
      entity_type: 'catalog_positions',
      entity_id: positionId,
      comment: `Создана карточка номенклатуры в разделе «${node.name}»`,
    })
    const [[created]] = await db.execute(
      `SELECT cp.*, n.name AS classifier_node_name, m.name AS manufacturer_name FROM catalog_positions cp JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id LEFT JOIN equipment_manufacturers m ON m.id = cp.manufacturer_id WHERE cp.id = ?`,
      [positionId]
    )
    res.status(201).json(created)
  } catch (error) {
    try { await conn.rollback() } catch {}
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Такая позиция уже существует' })
    console.error('POST /catalog-positions error:', error)
    res.status(500).json({ message: 'Не удалось создать карточку номенклатуры' })
  } finally {
    conn.release()
  }
})

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const nodeId = req.query.classifier_node_id !== undefined ? toId(req.query.classifier_node_id) : null
    const manufacturerId = req.query.manufacturer_id !== undefined ? toId(req.query.manufacturer_id) : null
    const equipmentModelId = req.query.equipment_model_id !== undefined ? toId(req.query.equipment_model_id) : null
    const modelBomModelId = req.query.model_bom_model_id !== undefined ? toId(req.query.model_bom_model_id) : null
    const excludeModelBom = String(req.query.exclude_model_bom || '').trim() === '1'
    const includeArchived = String(req.query.include_archived || '').trim() === '1'
    const onlyAssemblies = String(req.query.only_assemblies || '').trim() === '1'
    const onlyParts = String(req.query.only_parts || '').trim() === '1'
    const limit = clampLimit(req.query.limit)

    if (req.query.classifier_node_id !== undefined && !nodeId) {
      return res.status(400).json({ message: 'Некорректный раздел классификатора' })
    }
    if (req.query.manufacturer_id !== undefined && !manufacturerId) {
      return res.status(400).json({ message: 'Некорректный производитель' })
    }
    if (req.query.equipment_model_id !== undefined && !equipmentModelId) {
      return res.status(400).json({ message: 'Некорректная модель оборудования' })
    }
    if (req.query.model_bom_model_id !== undefined && !modelBomModelId) {
      return res.status(400).json({ message: 'Некорректная модель BOM' })
    }

    const params = []
    const where = ['cp.is_active = 1']
    if (!includeArchived) {
      where.push("(cp.status IS NULL OR cp.status <> 'archived')")
    }
    if (nodeId) {
      where.push('cp.classifier_node_id = ?')
      params.push(nodeId)
    }
    if (manufacturerId) {
      where.push('COALESCE(cp.manufacturer_id, em.manufacturer_id) = ?')
      params.push(manufacturerId)
    }
    if (equipmentModelId) {
      where.push('cp.equipment_model_id = ?')
      params.push(equipmentModelId)
    }
    if (excludeModelBom) {
      where.push("cp.source_kind <> 'model_bom'")
    } else if (modelBomModelId) {
      where.push("(cp.source_kind <> 'model_bom' OR cp.equipment_model_id = ?)")
      params.push(modelBomModelId)
    }
    if (onlyAssemblies && !onlyParts) {
      where.push("LOWER(cp.position_kind) IN ('assembly', 'node', 'unit')")
    }
    if (onlyParts && !onlyAssemblies) {
      where.push("LOWER(cp.position_kind) IN ('part', 'material', 'service', 'kit', 'document')")
    }
    if (q) {
      where.push('(cp.display_name LIKE ? OR cp.display_name_en LIKE ? OR cp.display_name_ru LIKE ? OR cp.position_code LIKE ? OR cp.manufacturer_part_number LIKE ? OR cp.description LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }
    params.push(limit)

    const [rows] = await db.query(
      `
      SELECT
        cp.*,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS source_bom_item_id,
        n.name AS classifier_node_name,
        em.model_name,
        mf.name AS manufacturer_name
      FROM catalog_positions cp
      JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      WHERE ${where.join(' AND ')}
      ORDER BY mf.name, em.model_name, cp.position_code, cp.display_name
      LIMIT ?
      `,
      params
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /catalog-positions error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/usage', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[position]] = await db.execute(
      `
      SELECT cp.*, n.name AS classifier_node_name
      FROM catalog_positions cp
      LEFT JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      WHERE cp.id = ?
        AND cp.is_active = 1
      `,
      [id]
    )
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    const [rows] = await db.execute(
      `
      SELECT
        item.id AS bom_item_id,
        item.equipment_model_id,
        item.parent_item_id,
        item.item_type,
        item.item_no,
        item.manufacturer_part_number,
        item.manufacturer_part_name,
        item.manufacturer_part_name_en,
        item.manufacturer_part_name_ru,
        item.drawing_number,
        item.title,
        item.quantity,
        item.notes,
        parent.item_no AS parent_item_no,
        parent.title AS parent_title,
        parent.manufacturer_part_name AS parent_manufacturer_part_name,
        parent_catalog.display_name AS parent_catalog_position_name,
        em.model_name,
        em.model_code,
        em.classifier_node_id AS model_classifier_node_id,
        model_node.name AS model_classifier_node_name,
        mf.id AS manufacturer_id,
        mf.name AS manufacturer_name,
        COUNT(DISTINCT ceu.id) AS client_units_count
      FROM equipment_model_bom_items item
      JOIN equipment_models em ON em.id = item.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
      LEFT JOIN equipment_classifier_nodes model_node ON model_node.id = em.classifier_node_id
      LEFT JOIN equipment_model_bom_items parent ON parent.id = item.parent_item_id
      LEFT JOIN catalog_positions parent_catalog ON parent_catalog.id = parent.catalog_position_id
      LEFT JOIN client_equipment_units ceu ON ceu.equipment_model_id = em.id
      WHERE item.catalog_position_id = ?
      GROUP BY
        item.id, item.equipment_model_id, item.parent_item_id, item.item_type,
        item.item_no, item.manufacturer_part_number, item.manufacturer_part_name,
        item.manufacturer_part_name_en, item.manufacturer_part_name_ru,
        item.drawing_number, item.title, item.quantity, item.notes,
        parent.item_no, parent.title, parent.manufacturer_part_name,
        parent_catalog.display_name,
        em.model_name, em.model_code, em.classifier_node_id, model_node.name,
        mf.id, mf.name
      ORDER BY mf.name, em.model_name, item.sort_order, item.id
      `,
      [id]
    )

    res.json({ position, rows })
  } catch (err) {
    console.error('GET /catalog-positions/:id/usage error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.patch('/:id/card', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[position]] = await db.execute(
      'SELECT id, description, meta_json FROM catalog_positions WHERE id = ? AND is_active = 1',
      [id]
    )
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    const meta = normalizeCardMeta(position.meta_json)
    const nextMeta = { ...meta }

    const numericFields = ['weight_kg', 'length_mm', 'width_mm', 'height_mm']
    for (const field of numericFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        const value = numOrNull(req.body[field])
        if (value === null) {
          delete nextMeta[field]
        } else {
          nextMeta[field] = value
        }
      }
    }
    for (const legacyField of ['length_cm', 'width_cm', 'height_cm']) {
      delete nextMeta[legacyField]
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'tnved_code_id')) {
      const value = toId(req.body.tnved_code_id)
      if (value) {
        const [[tnved]] = await db.execute('SELECT id, code, description FROM tnved_codes WHERE id = ?', [value])
        if (!tnved) return res.status(400).json({ message: 'Код ТН ВЭД не найден' })
        nextMeta.tnved_code_id = value
        nextMeta.tnved_code = tnved.code || null
        nextMeta.tnved_description = tnved.description || null
      } else {
        delete nextMeta.tnved_code_id
        delete nextMeta.tnved_code
        delete nextMeta.tnved_description
      }
    }

    const description = Object.prototype.hasOwnProperty.call(req.body, 'description')
      ? nz(req.body.description)
      : position.description

    await db.execute(
      'UPDATE catalog_positions SET description = ?, meta_json = ?, updated_at = NOW() WHERE id = ?',
      [description, Object.keys(nextMeta).length ? JSON.stringify(nextMeta) : null, id]
    )

    res.json({ message: 'Карточка обновлена' })
  } catch (err) {
    console.error('PATCH /catalog-positions/:id/card error:', err)
    res.status(500).json({ message: 'Ошибка сохранения карточки' })
  }
})

router.get('/:id/tnved-suggestions', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[position]] = await db.execute(
      `
      SELECT
        cp.id,
        cp.classifier_node_id,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.manufacturer_part_number,
        cp.description,
        cp.meta_json,
        GROUP_CONCAT(
          DISTINCT TRIM(CONCAT_WS(' ', NULLIF(m.name, ''), NULLIF(m.code, ''), NULLIF(m.standard, '')))
          SEPARATOR '; '
        ) AS materials_summary
      FROM catalog_positions cp
      LEFT JOIN catalog_position_materials cpm ON cpm.catalog_position_id = cp.id
      LEFT JOIN materials m ON m.id = cpm.material_id
      WHERE cp.id = ?
        AND cp.is_active = 1
      GROUP BY
        cp.id, cp.classifier_node_id, cp.display_name, cp.display_name_en,
        cp.display_name_ru, cp.manufacturer_part_number, cp.description, cp.meta_json
      `,
      [id]
    )
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    const meta = normalizeCardMeta(position.meta_json)
    const tokens = tokenizeSuggestionText(
      position.display_name,
      position.display_name_en,
      position.display_name_ru,
      position.manufacturer_part_number,
      position.materials_summary
    )

    const [usageRows] = await db.execute(
      `
      SELECT DISTINCT equipment_model_id
      FROM equipment_model_bom_items
      WHERE catalog_position_id = ?
        AND equipment_model_id IS NOT NULL
      `,
      [id]
    )
    const modelIds = usageRows.map((row) => toId(row.equipment_model_id)).filter(Boolean)

    let sameBom = []
    if (modelIds.length) {
      const placeholders = modelIds.map(() => '?').join(',')
      const likeWhere = tokens.length
        ? `AND (${tokens
            .map(
              () =>
                `(LOWER(CONCAT_WS(' ', cp.display_name, cp.display_name_en, cp.display_name_ru, cp.manufacturer_part_number, item.manufacturer_part_name, item.manufacturer_part_name_en, item.manufacturer_part_name_ru, cp.description, COALESCE(materials.materials_summary, ''))) LIKE ?)`
            )
            .join(' OR ')})`
        : ''
      const params = [
        id,
        ...modelIds,
        ...tokens.map((token) => `%${token.toLowerCase()}%`),
      ]
      const [rows] = await db.execute(
        `
        SELECT
          cp.id AS catalog_position_id,
          cp.display_name,
          cp.display_name_en,
          cp.display_name_ru,
          cp.manufacturer_part_number,
          cp.description,
          item.manufacturer_part_name,
          item.manufacturer_part_name_en,
          item.manufacturer_part_name_ru,
          em.model_name,
          (${position.classifier_node_id ? 'cp.classifier_node_id = ?' : '0'}) AS same_classifier_node,
          materials.materials_summary,
          tn.id AS tnved_id,
          tn.code AS tnved_code,
          tn.description AS tnved_description,
          tn.duty_rate,
          tn.notes
        FROM equipment_model_bom_items item
        JOIN catalog_positions cp ON cp.id = item.catalog_position_id
        JOIN tnved_codes tn ON tn.id = ${getMetaTnvedIdSql('cp')}
        JOIN equipment_models em ON em.id = item.equipment_model_id
        LEFT JOIN (
          SELECT
            cpm.catalog_position_id,
            GROUP_CONCAT(
              DISTINCT TRIM(CONCAT_WS(' ', NULLIF(m.name, ''), NULLIF(m.code, ''), NULLIF(m.standard, '')))
              SEPARATOR '; '
            ) AS materials_summary
          FROM catalog_position_materials cpm
          JOIN materials m ON m.id = cpm.material_id
          GROUP BY cpm.catalog_position_id
        ) materials ON materials.catalog_position_id = cp.id
        WHERE cp.id <> ?
          AND cp.is_active = 1
          AND item.equipment_model_id IN (${placeholders})
          ${likeWhere}
        ORDER BY em.model_name, item.sort_order, item.id
        LIMIT 80
        `,
        position.classifier_node_id ? [position.classifier_node_id, ...params] : params
      )
      sameBom = groupTnvedSuggestions(rows, tokens, 'same_bom', 'Похожие в этом BOM', true)
    }

    const likeWhere = tokens.length
      ? `AND (${tokens
          .map(
            () =>
              `(LOWER(CONCAT_WS(' ', cp.display_name, cp.display_name_en, cp.display_name_ru, cp.manufacturer_part_number, cp.description, COALESCE(materials.materials_summary, ''))) LIKE ?)`
          )
          .join(' OR ')})`
      : ''
    const [catalogRows] = await db.execute(
      `
      SELECT
        cp.id AS catalog_position_id,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.manufacturer_part_number,
        cp.description,
        NULL AS manufacturer_part_name,
        NULL AS manufacturer_part_name_en,
        NULL AS manufacturer_part_name_ru,
        em.model_name,
        (${position.classifier_node_id ? 'cp.classifier_node_id = ?' : '0'}) AS same_classifier_node,
        materials.materials_summary,
        tn.id AS tnved_id,
        tn.code AS tnved_code,
        tn.description AS tnved_description,
        tn.duty_rate,
        tn.notes
      FROM catalog_positions cp
      JOIN tnved_codes tn ON tn.id = ${getMetaTnvedIdSql('cp')}
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN (
        SELECT
          cpm.catalog_position_id,
          GROUP_CONCAT(
            DISTINCT TRIM(CONCAT_WS(' ', NULLIF(m.name, ''), NULLIF(m.code, ''), NULLIF(m.standard, '')))
            SEPARATOR '; '
          ) AS materials_summary
        FROM catalog_position_materials cpm
        JOIN materials m ON m.id = cpm.material_id
        GROUP BY cpm.catalog_position_id
      ) materials ON materials.catalog_position_id = cp.id
      WHERE cp.id <> ?
        AND cp.is_active = 1
        ${likeWhere}
      ORDER BY cp.updated_at DESC, cp.id DESC
      LIMIT 120
      `,
      position.classifier_node_id
        ? [position.classifier_node_id, id, ...tokens.map((token) => `%${token.toLowerCase()}%`)]
        : [id, ...tokens.map((token) => `%${token.toLowerCase()}%`)]
    )
    const catalog = groupTnvedSuggestions(catalogRows, tokens, 'catalog', 'Похожие в каталоге')
      .filter((item) => !sameBom.some((existing) => Number(existing.id) === Number(item.id)))
      .slice(0, 5)

    const [frequentRows] = await db.execute(
      `
      SELECT
        tn.id,
        tn.code,
        tn.description,
        tn.duty_rate,
        tn.notes,
        COUNT(*) AS usage_count
      FROM catalog_positions cp
      JOIN tnved_codes tn ON tn.id = ${getMetaTnvedIdSql('cp')}
      WHERE cp.is_active = 1
      GROUP BY tn.id, tn.code, tn.description, tn.duty_rate, tn.notes
      ORDER BY usage_count DESC, tn.code
      LIMIT 5
      `
    )
    const frequent = frequentRows
      .filter((item) => !sameBom.some((existing) => Number(existing.id) === Number(item.id)) && !catalog.some((existing) => Number(existing.id) === Number(item.id)))
      .map((row) => ({
        source: 'frequent',
        source_label: 'Часто используется',
        score: Number(row.usage_count || 0),
        id: row.id,
        code: row.code,
        description: row.description,
        duty_rate: row.duty_rate,
        notes: row.notes,
        usage_count: Number(row.usage_count || 0),
        examples: [],
        matched_tokens: [],
      }))

    res.json({
      tokens,
      suggestions: [...sameBom, ...catalog, ...frequent].slice(0, 10),
    })
  } catch (err) {
    console.error('GET /catalog-positions/:id/tnved-suggestions error:', err)
    res.status(500).json({ message: 'Ошибка подбора кода ТН ВЭД' })
  }
})

router.get('/:id/media', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[position]] = await db.execute('SELECT id FROM catalog_positions WHERE id = ? AND is_active = 1', [id])
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    const [rows] = await db.execute(
      `
      SELECT *
      FROM catalog_position_media
      WHERE catalog_position_id = ?
      ORDER BY is_primary DESC, sort_order, id
      `,
      [id]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /catalog-positions/:id/media error:', err)
    res.status(500).json({ message: 'Ошибка загрузки фото карточки' })
  }
})

router.post('/:id/media', upload.single('file'), async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    if (!bucket || !bucketName) return res.status(500).json({ message: 'GCS бакет не настроен на сервере' })

    const [[position]] = await db.execute('SELECT id FROM catalog_positions WHERE id = ? AND is_active = 1', [id])
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    const file = req.file
    if (!file) return res.status(400).json({ message: 'Файл не загружен' })
    if (!IMAGE_TYPES.has(file.mimetype)) {
      return res.status(415).json({ message: `Недопустимый тип изображения: ${file.mimetype}` })
    }

    const objectPath = buildCatalogPositionObjectPath(id, file)
    await bucket.file(objectPath).save(file.buffer, {
      resumable: false,
      metadata: { contentType: file.mimetype },
    })

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
    const [[existingPrimary]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM catalog_position_media WHERE catalog_position_id = ? AND is_primary = 1',
      [id]
    )
    const isPrimary = Number(existingPrimary?.cnt || 0) === 0 ? 1 : 0
    const caption = nz(req.body.caption)
    const uploadedBy = toId(req.user?.id)

    const [ins] = await db.execute(
      `
      INSERT INTO catalog_position_media
        (catalog_position_id, file_url, file_name, mime_type, file_size, caption, is_primary, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, publicUrl, file.originalname || null, file.mimetype, file.size, caption, isPrimary, uploadedBy]
    )

    const [[row]] = await db.execute('SELECT * FROM catalog_position_media WHERE id = ?', [ins.insertId])
    res.status(201).json(row)
  } catch (err) {
    console.error('POST /catalog-positions/:id/media error:', err)
    res.status(500).json({ message: 'Ошибка загрузки фото карточки' })
  }
})

router.delete('/:id/media/:mediaId', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const mediaId = toId(req.params.mediaId)
    if (!id || !mediaId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[row]] = await db.execute(
      'SELECT id FROM catalog_position_media WHERE id = ? AND catalog_position_id = ?',
      [mediaId, id]
    )
    if (!row) return res.status(404).json({ message: 'Фото не найдено' })

    await db.execute('DELETE FROM catalog_position_media WHERE id = ?', [mediaId])
    res.json({ message: 'Фото удалено' })
  } catch (err) {
    console.error('DELETE /catalog-positions/:id/media/:mediaId error:', err)
    res.status(500).json({ message: 'Ошибка удаления фото карточки' })
  }
})

router.post('/:id/materials', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const materialId = toId(req.body.material_id)
    if (!id || !materialId) return res.status(400).json({ message: 'Некорректный материал' })

    const [[position]] = await db.execute('SELECT id FROM catalog_positions WHERE id = ? AND is_active = 1', [id])
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    const [[material]] = await db.execute('SELECT id FROM materials WHERE id = ?', [materialId])
    if (!material) return res.status(404).json({ message: 'Материал не найден' })

    const isDefault = req.body.is_default ? 1 : 0
    if (isDefault) {
      await db.execute('UPDATE catalog_position_materials SET is_default = 0 WHERE catalog_position_id = ?', [id])
    }

    const [ins] = await db.execute(
      `
      INSERT INTO catalog_position_materials
        (catalog_position_id, material_id, variant_name, is_default, note)
      VALUES (?, ?, ?, ?, ?)
      `,
      [id, materialId, nz(req.body.variant_name), isDefault, nz(req.body.note)]
    )

    const [[row]] = await db.execute(
      `
      SELECT cpm.*, m.name, m.code, m.standard, m.description
      FROM catalog_position_materials cpm
      JOIN materials m ON m.id = cpm.material_id
      WHERE cpm.id = ?
      `,
      [ins.insertId]
    )
    res.status(201).json(row)
  } catch (err) {
    console.error('POST /catalog-positions/:id/materials error:', err)
    res.status(500).json({ message: 'Ошибка добавления материала' })
  }
})

router.patch('/:id/materials/:linkId', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const linkId = toId(req.params.linkId)
    const materialId = toId(req.body.material_id)
    if (!id || !linkId || !materialId) return res.status(400).json({ message: 'Некорректный материал' })

    const [[link]] = await db.execute(
      'SELECT id FROM catalog_position_materials WHERE id = ? AND catalog_position_id = ?',
      [linkId, id]
    )
    if (!link) return res.status(404).json({ message: 'Материал в карточке не найден' })

    const [[material]] = await db.execute('SELECT id FROM materials WHERE id = ?', [materialId])
    if (!material) return res.status(404).json({ message: 'Материал не найден' })

    const isDefault = req.body.is_default ? 1 : 0
    if (isDefault) {
      await db.execute('UPDATE catalog_position_materials SET is_default = 0 WHERE catalog_position_id = ?', [id])
    }

    await db.execute(
      `
      UPDATE catalog_position_materials
      SET material_id = ?, variant_name = ?, is_default = ?, note = ?
      WHERE id = ? AND catalog_position_id = ?
      `,
      [materialId, nz(req.body.variant_name), isDefault, nz(req.body.note), linkId, id]
    )

    res.json({ message: 'Материал обновлен' })
  } catch (err) {
    console.error('PATCH /catalog-positions/:id/materials/:linkId error:', err)
    res.status(500).json({ message: 'Ошибка сохранения материала' })
  }
})

router.delete('/:id/materials/:linkId', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const linkId = toId(req.params.linkId)
    if (!id || !linkId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[link]] = await db.execute(
      'SELECT id FROM catalog_position_materials WHERE id = ? AND catalog_position_id = ?',
      [linkId, id]
    )
    if (!link) return res.status(404).json({ message: 'Материал в карточке не найден' })

    await db.execute('DELETE FROM catalog_position_materials WHERE id = ?', [linkId])
    res.json({ message: 'Материал удален' })
  } catch (err) {
    console.error('DELETE /catalog-positions/:id/materials/:linkId error:', err)
    res.status(500).json({ message: 'Ошибка удаления материала' })
  }
})

router.put('/:id/analog-group', async (req, res) => {
  const id = toId(req.params.id)
  const primaryId = toId(req.body?.primary_catalog_position_id)
  const rawMemberIds = Array.isArray(req.body?.member_catalog_position_ids)
    ? req.body.member_catalog_position_ids
    : []
  const memberIds = Array.from(new Set(rawMemberIds.map(toId).filter(Boolean)))

  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор карточки' })
  if (!primaryId) return res.status(400).json({ message: 'Выберите основную позицию группы' })
  if (!memberIds.length) return res.status(400).json({ message: 'В группе должна остаться хотя бы одна позиция' })
  if (!memberIds.includes(primaryId)) {
    return res.status(400).json({ message: 'Основная позиция должна входить в группу' })
  }

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()
    await ensureActiveCatalogPositions(conn, [id, ...memberIds], { lock: true })

    const currentGroup = await fetchAnalogMembership(conn, id, { lock: true })
    for (const memberId of memberIds) {
      if (currentGroup.memberIds.has(memberId)) continue
      const targetGroup = await fetchAnalogMembership(conn, memberId, { lock: true })
      if (targetGroup.primaryId !== memberId || targetGroup.outgoing.length) {
        throw analogConflict(
          'Одна из выбранных карточек уже входит в другую группу аналогов. Сначала откройте её группу и исключите карточку.'
        )
      }
    }

    await conn.execute(
      `DELETE FROM catalog_position_relations
       WHERE primary_catalog_position_id = ? AND relationship_type = 'analog'`,
      [currentGroup.primaryId]
    )

    const analogIds = memberIds.filter((memberId) => memberId !== primaryId)
    for (const analogId of analogIds) {
      await conn.execute(
        `
        INSERT INTO catalog_position_relations
          (primary_catalog_position_id, related_catalog_position_id, relationship_type, note)
        VALUES (?, ?, 'analog', ?)
        `,
        [primaryId, analogId, 'Группа аналогов сохранена из карточки каталожной позиции']
      )
    }

    await conn.commit()
    res.json({
      message: 'Группа аналогов сохранена',
      primary_catalog_position_id: primaryId,
      member_catalog_position_ids: memberIds,
      analog_catalog_position_ids: analogIds,
    })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('PUT /catalog-positions/:id/analog-group error:', err)
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Не удалось сохранить группу аналогов' })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/:id/analogs', async (req, res) => {
  const id = toId(req.params.id)
  const rawIds = Array.isArray(req.body?.catalog_position_ids)
    ? req.body.catalog_position_ids
    : [req.body?.catalog_position_id]
  const analogIds = Array.from(new Set(rawIds.map(toId).filter(Boolean)))
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор карточки' })
  if (!analogIds.length) return res.status(400).json({ message: 'Выберите хотя бы одну карточку-аналог' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()
    await ensureActiveCatalogPositions(conn, [id, ...analogIds], { lock: true })

    const currentGroup = await fetchAnalogMembership(conn, id, { lock: true })
    const addedIds = []
    const skippedIds = []
    for (const analogId of analogIds) {
      if (currentGroup.memberIds.has(analogId)) {
        skippedIds.push(analogId)
        continue
      }
      const targetGroup = await fetchAnalogMembership(conn, analogId, { lock: true })
      if (targetGroup.primaryId !== analogId || targetGroup.outgoing.length) {
        throw analogConflict('Выбранная карточка уже входит в другую группу аналогов. Сначала отвяжите её от текущей группы.')
      }
      await conn.execute(
        `
        INSERT INTO catalog_position_relations
          (primary_catalog_position_id, related_catalog_position_id, relationship_type, note)
        VALUES (?, ?, 'analog', ?)
        `,
        [currentGroup.primaryId, analogId, 'Добавлено из карточки каталожной позиции']
      )
      currentGroup.memberIds.add(analogId)
      addedIds.push(analogId)
    }

    await conn.commit()
    res.status(201).json({
      message: addedIds.length ? 'Аналоги добавлены' : 'Все выбранные карточки уже входят в эту группу',
      primary_catalog_position_id: currentGroup.primaryId,
      added_catalog_position_ids: addedIds,
      skipped_catalog_position_ids: skippedIds,
    })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('POST /catalog-positions/:id/analogs error:', err)
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Не удалось добавить аналоги' })
  } finally {
    if (conn) conn.release()
  }
})

router.put('/:id/analog-primary', async (req, res) => {
  const id = toId(req.params.id)
  const requestedPrimaryId = toId(req.body?.primary_catalog_position_id)
  if (!id || !requestedPrimaryId) {
    return res.status(400).json({ message: 'Выберите корректную основную позицию' })
  }
  if (id === requestedPrimaryId) {
    return res.status(400).json({ message: 'Карточка не может быть аналогом самой себе' })
  }

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()
    await ensureActiveCatalogPositions(conn, [id, requestedPrimaryId], { lock: true })

    const currentGroup = await fetchAnalogMembership(conn, id, { lock: true })
    if (currentGroup.primaryId === id && currentGroup.outgoing.length) {
      throw analogConflict('Эта карточка является основной для группы. Сначала назначьте основным один из её аналогов.')
    }
    const targetGroup = await fetchAnalogMembership(conn, requestedPrimaryId, { lock: true })
    if (targetGroup.memberIds.has(id)) {
      await conn.commit()
      return res.json({
        message: 'Карточка уже входит в выбранную группу аналогов',
        primary_catalog_position_id: targetGroup.primaryId,
      })
    }

    await conn.execute(
      `DELETE FROM catalog_position_relations
       WHERE related_catalog_position_id = ? AND relationship_type = 'analog'`,
      [id]
    )
    await conn.execute(
      `
      INSERT INTO catalog_position_relations
        (primary_catalog_position_id, related_catalog_position_id, relationship_type, note)
      VALUES (?, ?, 'analog', ?)
      `,
      [targetGroup.primaryId, id, 'Основная позиция назначена из карточки каталожной позиции']
    )

    await conn.commit()
    res.json({
      message: 'Основная позиция назначена',
      primary_catalog_position_id: targetGroup.primaryId,
    })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('PUT /catalog-positions/:id/analog-primary error:', err)
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Не удалось назначить основную позицию' })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/:id/analogs/make-primary', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор карточки' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()
    await ensureActiveCatalogPositions(conn, [id], { lock: true })
    const group = await fetchAnalogMembership(conn, id, { lock: true })
    if (group.primaryId === id) {
      await conn.commit()
      return res.json({ message: 'Эта карточка уже является основной', primary_catalog_position_id: id })
    }

    const nextAnalogIds = [
      group.primaryId,
      ...group.outgoing
        .map((row) => Number(row.related_catalog_position_id))
        .filter((relatedId) => relatedId !== id),
    ]
    await conn.execute(
      `DELETE FROM catalog_position_relations
       WHERE primary_catalog_position_id = ? AND relationship_type = 'analog'`,
      [group.primaryId]
    )
    for (const analogId of nextAnalogIds) {
      await conn.execute(
        `
        INSERT INTO catalog_position_relations
          (primary_catalog_position_id, related_catalog_position_id, relationship_type, note)
        VALUES (?, ?, 'analog', ?)
        `,
        [id, analogId, 'Основная позиция группы изменена из карточки каталожной позиции']
      )
    }

    await conn.commit()
    res.json({
      message: 'Текущая карточка назначена основной',
      primary_catalog_position_id: id,
      analog_catalog_position_ids: nextAnalogIds,
    })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('POST /catalog-positions/:id/analogs/make-primary error:', err)
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Не удалось изменить основную позицию' })
  } finally {
    if (conn) conn.release()
  }
})

router.delete('/:id/analogs/:analogId', async (req, res) => {
  const id = toId(req.params.id)
  const analogId = toId(req.params.analogId)
  if (!id || !analogId) return res.status(400).json({ message: 'Некорректный идентификатор связи' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()
    await ensureActiveCatalogPositions(conn, [id, analogId], { lock: true })
    const group = await fetchAnalogMembership(conn, id, { lock: true })
    if (analogId === group.primaryId) {
      throw analogConflict('Основную позицию нельзя удалить из её группы. Сначала назначьте другую основную позицию.')
    }
    const [result] = await conn.execute(
      `DELETE FROM catalog_position_relations
       WHERE primary_catalog_position_id = ?
         AND related_catalog_position_id = ?
         AND relationship_type = 'analog'`,
      [group.primaryId, analogId]
    )
    if (!result.affectedRows) {
      const err = new Error('Связь аналогов не найдена')
      err.statusCode = 404
      throw err
    }
    await conn.commit()
    res.json({ message: 'Связь с аналогом удалена' })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('DELETE /catalog-positions/:id/analogs/:analogId error:', err)
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Не удалось удалить связь аналога' })
  } finally {
    if (conn) conn.release()
  }
})

router.get('/:id/card', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[position]] = await db.execute(
      `
      SELECT
        cp.*,
        n.name AS classifier_node_name,
        em.model_name,
        em.model_code,
        mf.name AS manufacturer_name
      FROM catalog_positions cp
      LEFT JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      WHERE cp.id = ?
        AND cp.is_active = 1
      `,
      [id]
    )
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    position.meta = normalizeCardMeta(position.meta_json)
    delete position.meta_json

    const [usage] = await db.execute(
      `
      SELECT
        item.id AS bom_item_id,
        item.equipment_model_id,
        item.parent_item_id,
        item.item_type,
        item.row_kind,
        item.item_no,
        item.manufacturer_part_number,
        item.manufacturer_part_name,
        item.manufacturer_part_name_en,
        item.manufacturer_part_name_ru,
        item.title,
        item.quantity,
        parent.manufacturer_part_number AS parent_manufacturer_part_number,
        parent.manufacturer_part_name AS parent_manufacturer_part_name,
        parent.title AS parent_title,
        em.model_name,
        em.classifier_node_id AS model_classifier_node_id,
        mf.name AS manufacturer_name
      FROM equipment_model_bom_items item
      JOIN equipment_models em ON em.id = item.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
      LEFT JOIN equipment_model_bom_items parent ON parent.id = item.parent_item_id
      WHERE item.catalog_position_id = ?
      ORDER BY mf.name, em.model_name, item.sort_order, item.id
      `,
      [id]
    )

    const [supplierParts] = await db.execute(
      `
      SELECT
        sp.id,
        sp.supplier_id,
        ps.name AS supplier_name,
        ps.country AS supplier_country,
        sp.supplier_part_number,
        sp.description_ru,
        sp.description_en,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        sp.uom,
        sp.part_type,
        sp.lead_time_days,
        sp.min_order_qty,
        sp.packaging,
        sp.weight_kg,
        sp.length_cm,
        sp.width_cm,
        sp.height_cm,
        sp.is_overweight,
        sp.is_oversize,
        spcp.relationship_type,
        spcp.is_preferred,
        spcp.notes AS link_notes,
        dm.id AS default_material_id,
        dm.name AS default_material_name,
        dm.code AS default_material_code,
        dm.standard AS default_material_standard,
        lp.price,
        lp.currency,
        lp.date AS price_date,
        COALESCE(lp.lead_time_days, sp.lead_time_days) AS effective_lead_time_days,
        COALESCE(lp.min_order_qty, sp.min_order_qty) AS effective_min_order_qty,
        COALESCE(lp.packaging, sp.packaging) AS effective_packaging,
        COALESCE(lp.offer_type, sp.part_type) AS effective_part_type
      FROM supplier_part_catalog_positions spcp
      JOIN supplier_parts sp ON sp.id = spcp.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN materials dm ON dm.id = sp.default_material_id
      LEFT JOIN (
        SELECT spp1.*
        FROM supplier_part_prices spp1
        JOIN (
          SELECT supplier_part_id, MAX(id) AS max_id
          FROM supplier_part_prices
          GROUP BY supplier_part_id
        ) latest
          ON latest.supplier_part_id = spp1.supplier_part_id
         AND latest.max_id = spp1.id
      ) lp ON lp.supplier_part_id = sp.id
      WHERE spcp.catalog_position_id = ?
      ORDER BY spcp.is_preferred DESC, ps.name, sp.supplier_part_number
      `,
      [id]
    )

    const [materials] = await db.execute(
      `
      SELECT
        cpm.id,
        cpm.catalog_position_id,
        cpm.material_id,
        cpm.variant_name,
        cpm.is_default,
        cpm.note,
        m.name,
        m.code,
        m.standard,
        m.description
      FROM catalog_position_materials cpm
      JOIN materials m ON m.id = cpm.material_id
      WHERE cpm.catalog_position_id = ?
      ORDER BY cpm.is_default DESC, cpm.id
      `,
      [id]
    )

    const [supplierMaterials] = await db.execute(
      `
      SELECT DISTINCT
        m.id,
        m.name,
        m.code,
        m.standard,
        m.description,
        spm.is_default,
        spm.note,
        sp.id AS supplier_part_id,
        sp.supplier_part_number,
        ps.name AS supplier_name
      FROM supplier_part_catalog_positions spcp
      JOIN supplier_parts sp ON sp.id = spcp.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      JOIN supplier_part_materials spm ON spm.supplier_part_id = sp.id
      JOIN materials m ON m.id = spm.material_id
      WHERE spcp.catalog_position_id = ?
      ORDER BY spm.is_default DESC, m.name, ps.name
      `,
      [id]
    )

    const [media] = await db.execute(
      `
      SELECT *
      FROM catalog_position_media
      WHERE catalog_position_id = ?
      ORDER BY is_primary DESC, sort_order, id
      `,
      [id]
    )

    const [analogPositions] = await db.execute(
      `
      SELECT
        rel.id AS relation_id,
        rel.relationship_type,
        rel.note,
        rel.created_at,
        cp.id,
        cp.position_code,
        cp.manufacturer_part_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.source_kind,
        cp.position_kind,
        cp.classifier_node_id,
        cp.equipment_model_id,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS source_bom_item_id,
        mf.name AS manufacturer_name,
        em.model_name,
        em.classifier_node_id AS model_classifier_node_id
      FROM catalog_position_relations rel
      JOIN catalog_positions cp ON cp.id = rel.related_catalog_position_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = cp.manufacturer_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      WHERE rel.primary_catalog_position_id = ?
        AND rel.relationship_type = 'analog'
        AND cp.is_active = 1
      ORDER BY mf.name, em.model_name, cp.manufacturer_part_number, cp.display_name
      `,
      [id]
    )

    const [primaryPositions] = await db.execute(
      `
      SELECT
        rel.id AS relation_id,
        rel.relationship_type,
        rel.note,
        rel.created_at,
        cp.id,
        cp.position_code,
        cp.manufacturer_part_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.source_kind,
        cp.position_kind,
        cp.classifier_node_id,
        cp.equipment_model_id,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS source_bom_item_id,
        mf.name AS manufacturer_name,
        em.model_name,
        em.classifier_node_id AS model_classifier_node_id
      FROM catalog_position_relations rel
      JOIN catalog_positions cp ON cp.id = rel.primary_catalog_position_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = cp.manufacturer_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      WHERE rel.related_catalog_position_id = ?
        AND rel.relationship_type = 'analog'
        AND cp.is_active = 1
      ORDER BY mf.name, em.model_name, cp.manufacturer_part_number, cp.display_name
      `,
      [id]
    )

    let analogGroupPositions = analogPositions
    if (primaryPositions[0]?.id) {
      const [rows] = await db.execute(
        `
        SELECT
          rel.id AS relation_id,
          rel.relationship_type,
          rel.note,
          rel.created_at,
          cp.id,
          cp.position_code,
          cp.manufacturer_part_number,
          cp.display_name,
          cp.display_name_en,
          cp.display_name_ru,
          cp.source_kind,
          cp.position_kind,
          cp.classifier_node_id,
          cp.equipment_model_id,
          JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS source_bom_item_id,
          mf.name AS manufacturer_name,
          em.model_name,
          em.classifier_node_id AS model_classifier_node_id
        FROM catalog_position_relations rel
        JOIN catalog_positions cp ON cp.id = rel.related_catalog_position_id
        LEFT JOIN equipment_manufacturers mf ON mf.id = cp.manufacturer_id
        LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
        WHERE rel.primary_catalog_position_id = ?
          AND rel.relationship_type = 'analog'
          AND cp.is_active = 1
        ORDER BY mf.name, em.model_name, cp.manufacturer_part_number, cp.display_name
        `,
        [primaryPositions[0].id]
      )
      analogGroupPositions = rows
    }

    const meta = position.meta || {}
    const tnvedCodeId = toId(meta.tnved_code_id)
    let tnved = null
    if (tnvedCodeId) {
      const [[code]] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [tnvedCodeId])
      tnved = code || null
    } else if (nz(meta.tnved_code)) {
      const [[code]] = await db.execute('SELECT * FROM tnved_codes WHERE code = ? LIMIT 1', [nz(meta.tnved_code)])
      tnved = code || { code: nz(meta.tnved_code), description: meta.tnved_description || null }
    }

    res.json({
      position,
      usage,
      supplier_parts: supplierParts,
      materials,
      supplier_materials: supplierMaterials,
      media,
      tnved,
      analog_positions: analogPositions,
      primary_positions: primaryPositions,
      analog_group: primaryPositions[0] || analogPositions.length
        ? {
            primary_position: primaryPositions[0] || position,
            analog_positions: analogGroupPositions,
          }
        : null,
    })
  } catch (err) {
    console.error('GET /catalog-positions/:id/card error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
