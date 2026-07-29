const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const db = require('../utils/db')
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

const buildCatalogPositionObjectPath = (id, file) => {
  const ext = path.extname(file.originalname || '') || '.jpg'
  const rawBase = path.basename(file.originalname || 'catalog-position-photo', ext)
  const safeBase = rawBase.replace(/[^\w-]+/g, '_').slice(0, 80) || 'catalog-position-photo'
  return ['catalog-positions', String(id), `${Date.now()}_${safeBase}${ext}`]
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const nodeId = req.query.classifier_node_id !== undefined ? toId(req.query.classifier_node_id) : null
    const manufacturerId = req.query.manufacturer_id !== undefined ? toId(req.query.manufacturer_id) : null
    const equipmentModelId = req.query.equipment_model_id !== undefined ? toId(req.query.equipment_model_id) : null
    const modelBomModelId = req.query.model_bom_model_id !== undefined ? toId(req.query.model_bom_model_id) : null
    const excludeModelBom = String(req.query.exclude_model_bom || '').trim() === '1'
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
    })
  } catch (err) {
    console.error('GET /catalog-positions/:id/card error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
