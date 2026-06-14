// routes/equipmentModels.js
const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const XLSX = require('xlsx')
const db = require('../utils/db')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { createTrashEntry } = require('../utils/trashStore')
const { buildTrashPreview, MODE } = require('../utils/trashPreview')
const { bucket, bucketName } = require('../utils/gcsClient')

// ------------------------------
// helpers
// ------------------------------
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const sqlValue = (v) => (v === undefined ? null : v)
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/tiff',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
])

const formatBomQuantity = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return Number.isInteger(n) ? n : n
}

const cleanImportValue = (v) =>
  v === undefined || v === null ? '' : String(v).trim()

const normalizeBomImportType = (value) => {
  const raw = cleanImportValue(value).toLowerCase()
  if (['group', 'assembly', 'section', 'сборка', 'раздел', 'узел'].includes(raw)) return 'group'
  if (['catalog_position', 'catalog', 'classifier', 'классификатор', 'позиция классификатора'].includes(raw)) {
    return 'catalog_position'
  }
  if (['oem', 'oem_part', 'деталь производителя', 'деталь'].includes(raw)) return 'oem_part'
  return raw || 'group'
}

const parseBomImportRows = (rows) => {
  const sourceRows = Array.isArray(rows) ? rows : []
  return sourceRows
    .map((row, index) => {
      const level = Number(row.level ?? row['Уровень'] ?? 1)
      return {
        source_index: index,
        row_number: Number(row.row_number || row.__rowNumber || index + 2),
        level: Number.isInteger(level) && level > 0 ? level : null,
        item_key: cleanImportValue(row.item_key ?? row.key ?? row['Ключ']),
        parent_key: cleanImportValue(row.parent_key ?? row.parentKey ?? row['Родительский ключ']),
        item_type: normalizeBomImportType(row.item_type ?? row.type ?? row['Тип']),
        item_no: cleanImportValue(row.item_no ?? row['№ позиции'] ?? row['Позиция']),
        manufacturer_part_number: cleanImportValue(
          row.manufacturer_part_number ?? row.manufacturerPartNumber ?? row['Каталожный номер']
        ),
        manufacturer_part_name: cleanImportValue(
          row.manufacturer_part_name ?? row.manufacturerPartName ?? row['Название по каталогу']
        ),
        drawing_number: cleanImportValue(row.drawing_number ?? row['Чертеж']),
        oem_part_number: cleanImportValue(row.oem_part_number ?? row.part_number ?? row['Код OEM']),
        catalog_position_code: cleanImportValue(
          row.catalog_position_code ?? row.position_code ?? row['Код классификатора']
        ),
        title: cleanImportValue(row.title ?? row.name ?? row['Название']),
        quantity: numOrNull(row.quantity ?? row.qty ?? row['Количество']) || 1,
        sort_order: Number.isInteger(Number(row.sort_order ?? row['Порядок']))
          ? Number(row.sort_order ?? row['Порядок'])
          : index + 1,
        notes: nz(row.notes ?? row['Заметки']),
      }
    })
    .filter((row) =>
      [
        row.item_key,
        row.parent_key,
        row.item_type,
        row.item_no,
        row.manufacturer_part_number,
        row.manufacturer_part_name,
        row.drawing_number,
        row.oem_part_number,
        row.catalog_position_code,
        row.title,
      ].some(Boolean)
    )
}

const resolveBomImportRows = async (modelId, inputRows) => {
  const rows = parseBomImportRows(inputRows)
  const errors = []
  const warnings = []
  const prepared = []
  const byKey = new Map()
  const levelStack = new Map()

  if (!rows.length) {
    errors.push({ row_number: 0, message: 'В файле нет строк BOM для импорта' })
  }

  for (const row of rows) {
    const itemKey = row.item_key || `row-${row.row_number}`
    if (byKey.has(itemKey)) {
      errors.push({ row_number: row.row_number, message: `Повторяется ключ строки: ${itemKey}` })
      continue
    }
    if (!row.level) {
      errors.push({ row_number: row.row_number, message: 'Уровень должен быть положительным целым числом' })
      continue
    }
    if (!['group', 'catalog_position', 'oem_part'].includes(row.item_type)) {
      errors.push({ row_number: row.row_number, message: `Неизвестный тип строки: ${row.item_type}` })
      continue
    }
    if (row.quantity <= 0) {
      errors.push({ row_number: row.row_number, message: 'Количество должно быть больше нуля' })
      continue
    }

    let parentKey = row.parent_key || null
    if (!parentKey && row.level > 1) {
      const parentFromLevel = levelStack.get(row.level - 1)
      if (!parentFromLevel) {
        errors.push({ row_number: row.row_number, message: 'Не найден родитель по уровню. Укажите родительский ключ.' })
        continue
      }
      parentKey = parentFromLevel.item_key
    }
    if (parentKey && !byKey.has(parentKey)) {
      errors.push({ row_number: row.row_number, message: `Родительский ключ не найден выше по файлу: ${parentKey}` })
      continue
    }

    let oemPartId = null
    let catalogPositionId = null
    let resolvedLabel = row.title
    let resolvedSubtitle = null

    if (row.item_type === 'group') {
      if (!row.title && !row.manufacturer_part_name && !row.manufacturer_part_number) {
        errors.push({ row_number: row.row_number, message: 'Для сборки/раздела нужно заполнить название или каталожный номер' })
        continue
      }
      resolvedLabel = row.manufacturer_part_number || row.title || row.manufacturer_part_name
      resolvedSubtitle = row.manufacturer_part_name || row.title || null
    }

    if (row.item_type === 'catalog_position') {
      if (!row.catalog_position_code && !row.title) {
        errors.push({ row_number: row.row_number, message: 'Для позиции классификатора нужен код или название' })
        continue
      }
      const params = []
      const where = []
      if (row.catalog_position_code) {
        where.push('position_code = ?')
        params.push(row.catalog_position_code)
      }
      if (row.title) {
        where.push('display_name = ?')
        params.push(row.title)
      }
      const [positions] = await db.execute(
        `
        SELECT cp.id, cp.display_name, cp.position_code, cp.uom, node.name AS classifier_node_name
        FROM catalog_positions cp
        LEFT JOIN equipment_classifier_nodes node ON node.id = cp.classifier_node_id
        WHERE cp.is_active = 1 AND (${where.join(' OR ')})
        ORDER BY cp.position_code = ? DESC, cp.id
        LIMIT 2
        `,
        [...params, row.catalog_position_code || '']
      )
      if (!positions.length) {
        errors.push({ row_number: row.row_number, message: 'Позиция классификатора не найдена' })
        continue
      }
      if (positions.length > 1) {
        warnings.push({ row_number: row.row_number, message: 'Найдено несколько позиций, взята первая по коду/названию' })
      }
      catalogPositionId = positions[0].id
      resolvedLabel = positions[0].display_name
      resolvedSubtitle = positions[0].classifier_node_name || positions[0].position_code || null
    }

    if (row.item_type === 'oem_part') {
      const partNumber = row.oem_part_number || row.manufacturer_part_number
      if (!partNumber) {
        errors.push({ row_number: row.row_number, message: 'Для OEM детали нужен код OEM' })
        continue
      }
      const [parts] = await db.execute(
        `
        SELECT p.id, p.part_number, p.description_ru, p.description_en, m.name AS manufacturer_name
        FROM oem_parts p
        JOIN oem_part_model_fitments fit ON fit.oem_part_id = p.id AND fit.equipment_model_id = ?
        LEFT JOIN equipment_manufacturers m ON m.id = p.manufacturer_id
        WHERE p.part_number = ?
        ORDER BY p.id
        LIMIT 2
        `,
        [modelId, partNumber]
      )
      if (!parts.length) {
        errors.push({ row_number: row.row_number, message: 'OEM деталь с таким номером не найдена в этой модели' })
        continue
      }
      if (parts.length > 1) {
        warnings.push({ row_number: row.row_number, message: 'Найдено несколько OEM деталей, взята первая' })
      }
      oemPartId = parts[0].id
      resolvedLabel = parts[0].part_number
      resolvedSubtitle = [parts[0].description_ru || parts[0].description_en, parts[0].manufacturer_name]
        .filter(Boolean)
        .join(' / ') || null
    }

    const preparedRow = {
      ...row,
      item_key: itemKey,
      parent_key: parentKey,
      oem_part_id: oemPartId,
      catalog_position_id: catalogPositionId,
      resolved_label: resolvedLabel,
      resolved_subtitle: resolvedSubtitle,
      status: 'ok',
    }
    prepared.push(preparedRow)
    byKey.set(itemKey, preparedRow)
    levelStack.set(row.level, preparedRow)
    ;[...levelStack.keys()].forEach((level) => {
      if (level > row.level) levelStack.delete(level)
    })
  }

  return { rows: prepared, errors, warnings }
}

const requireLeafClassifierNode = async (nodeId, res) => {
  const [[children]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM equipment_classifier_nodes WHERE parent_id = ? AND is_active = 1',
    [nodeId]
  )
  if (Number(children?.cnt || 0) > 0) {
    res.status(400).json({
      message: 'Модель оборудования можно создавать только в нижнем разделе классификатора без подразделов',
    })
    return false
  }
  return true
}

/**
 * LIST
 * GET /equipment-models?manufacturer_id=1&q=hp800
 *
 * Для пикапера моделей нам не критична пагинация, поэтому
 * убираем LIMIT/OFFSET, чтобы не ловить ошибок с плейсхолдерами.
 */
router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const midRaw = req.query.manufacturer_id
    const classifierNodeIdRaw = req.query.classifier_node_id

    const params = []
    const where = []

    let sql =
      `SELECT em.*, m.name AS manufacturer_name, ecn.name AS classifier_node_name,
              media.file_url AS primary_photo_url
       ` +
      'FROM equipment_models em ' +
      'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
      'LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id ' +
      `LEFT JOIN equipment_model_media media
         ON media.id = (
           SELECT emm.id
           FROM equipment_model_media emm
           WHERE emm.equipment_model_id = em.id
           ORDER BY emm.is_primary DESC, emm.sort_order, emm.id
           LIMIT 1
         )`

    if (midRaw !== undefined) {
      const mid = toId(midRaw)
      if (!mid) {
        return res
          .status(400)
          .json({ message: 'Некорректный производитель' })
      }
      where.push('em.manufacturer_id = ?')
      params.push(mid)
    }

    if (q) {
      // model_code is legacy/import metadata only; keep it searchable for old rows.
      where.push('(em.model_name LIKE ? OR em.model_code LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }

    if (classifierNodeIdRaw !== undefined) {
      const classifierNodeId = toId(classifierNodeIdRaw)
      if (!classifierNodeId) {
        return res.status(400).json({ message: 'Некорректный классификатор оборудования' })
      }
      where.push('em.classifier_node_id = ?')
      params.push(classifierNodeId)
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY m.name, em.model_name'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /equipment-models error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/**
 * READ ONE
 * GET /equipment-models/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `SELECT em.*, m.name AS manufacturer_name, ecn.name AS classifier_node_name,
              media.file_url AS primary_photo_url ` +
        'FROM equipment_models em ' +
        'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
        'LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id ' +
        `LEFT JOIN equipment_model_media media
           ON media.id = (
             SELECT emm.id
             FROM equipment_model_media emm
             WHERE emm.equipment_model_id = em.id
             ORDER BY emm.is_primary DESC, emm.sort_order, emm.id
             LIMIT 1
           ) ` +
        'WHERE em.id = ?',
      [id]
    )
    if (!rows.length) {
      return res.status(404).json({ message: 'Модель не найдена' })
    }
    res.json(rows[0])
  } catch (err) {
    console.error('GET /equipment-models/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/media', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const [rows] = await db.execute(
      `
      SELECT *
      FROM equipment_model_media
      WHERE equipment_model_id = ?
      ORDER BY is_primary DESC, sort_order, id
      `,
      [id]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /equipment-models/:id/media error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/media', upload.single('file'), async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    if (!bucket || !bucketName) return res.status(500).json({ message: 'GCS бакет не настроен на сервере' })

    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const file = req.file
    if (!file) return res.status(400).json({ message: 'Файл не загружен' })
    if (!IMAGE_TYPES.has(file.mimetype)) {
      return res.status(415).json({ message: `Недопустимый тип изображения: ${file.mimetype}` })
    }

    const ext = path.extname(file.originalname || '') || '.jpg'
    const rawBase = path.basename(file.originalname || 'model-photo', ext)
    const safeBase = rawBase.replace(/[^\w-]+/g, '_').slice(0, 80) || 'model-photo'
    const objectPath = ['equipment-models', String(id), `${Date.now()}_${safeBase}${ext}`]
      .map((seg) => encodeURIComponent(seg))
      .join('/')

    await bucket.file(objectPath).save(file.buffer, {
      resumable: false,
      metadata: { contentType: file.mimetype },
    })

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
    const [[existingPrimary]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM equipment_model_media WHERE equipment_model_id = ? AND is_primary = 1',
      [id]
    )
    const isPrimary = Number(existingPrimary?.cnt || 0) === 0 ? 1 : 0
    const caption = nz(req.body.caption)
    const uploadedBy = toId(req.user?.id)

    const [ins] = await db.execute(
      `
      INSERT INTO equipment_model_media
        (equipment_model_id, file_url, file_name, mime_type, file_size, caption, is_primary, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, publicUrl, file.originalname || null, file.mimetype, file.size, caption, isPrimary, uploadedBy]
    )

    const [[row]] = await db.execute('SELECT * FROM equipment_model_media WHERE id = ?', [ins.insertId])
    await logActivity({
      req,
      action: 'upload_media',
      entity_type: 'equipment_models',
      entity_id: id,
      comment: `Загружено фото модели "${file.originalname || ''}"`,
    })
    res.status(201).json(row)
  } catch (err) {
    console.error('POST /equipment-models/:id/media error:', err)
    res.status(500).json({ message: 'Ошибка загрузки фото модели' })
  }
})

router.delete('/:id/media/:mediaId', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const mediaId = toId(req.params.mediaId)
    if (!id || !mediaId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[row]] = await db.execute(
      'SELECT * FROM equipment_model_media WHERE id = ? AND equipment_model_id = ?',
      [mediaId, id]
    )
    if (!row) return res.status(404).json({ message: 'Фото не найдено' })

    await db.execute('DELETE FROM equipment_model_media WHERE id = ?', [mediaId])
    await logActivity({
      req,
      action: 'delete_media',
      entity_type: 'equipment_models',
      entity_id: id,
      comment: `Удалено фото модели "${row.file_name || mediaId}"`,
    })
    res.json({ message: 'Фото удалено' })
  } catch (err) {
    console.error('DELETE /equipment-models/:id/media/:mediaId error:', err)
    res.status(500).json({ message: 'Ошибка удаления фото модели' })
  }
})

router.get('/:id/documents', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const [rows] = await db.execute(
      `
      SELECT *
      FROM equipment_model_documents
      WHERE equipment_model_id = ?
      ORDER BY uploaded_at DESC, id DESC
      `,
      [id]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /equipment-models/:id/documents error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/documents', upload.single('file'), async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    if (!bucket || !bucketName) return res.status(500).json({ message: 'GCS бакет не настроен на сервере' })

    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const file = req.file
    if (!file) return res.status(400).json({ message: 'Файл не загружен' })
    if (!DOCUMENT_TYPES.has(file.mimetype)) {
      return res.status(415).json({ message: `Недопустимый тип файла: ${file.mimetype}` })
    }

    const ext = path.extname(file.originalname || '') || ''
    const rawBase = path.basename(file.originalname || 'model-document', ext)
    const safeBase = rawBase.replace(/[^\w-]+/g, '_').slice(0, 100) || 'model-document'
    const objectPath = ['equipment-models', String(id), 'documents', `${Date.now()}_${safeBase}${ext}`]
      .map((seg) => encodeURIComponent(seg))
      .join('/')

    await bucket.file(objectPath).save(file.buffer, {
      resumable: false,
      metadata: { contentType: file.mimetype },
    })

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
    const description = nz(req.body.description)
    const uploadedBy = toId(req.user?.id)

    const [ins] = await db.execute(
      `
      INSERT INTO equipment_model_documents
        (equipment_model_id, file_url, file_name, file_type, file_size, description, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, publicUrl, file.originalname || null, file.mimetype, file.size, description, uploadedBy]
    )
    const [[row]] = await db.execute('SELECT * FROM equipment_model_documents WHERE id = ?', [ins.insertId])
    await logActivity({
      req,
      action: 'upload_document',
      entity_type: 'equipment_models',
      entity_id: id,
      comment: `Загружен документ модели "${file.originalname || ''}"`,
    })
    res.status(201).json(row)
  } catch (err) {
    console.error('POST /equipment-models/:id/documents error:', err)
    res.status(500).json({ message: 'Ошибка загрузки документа модели' })
  }
})

router.delete('/:id/documents/:documentId', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const documentId = toId(req.params.documentId)
    if (!id || !documentId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[row]] = await db.execute(
      'SELECT * FROM equipment_model_documents WHERE id = ? AND equipment_model_id = ?',
      [documentId, id]
    )
    if (!row) return res.status(404).json({ message: 'Документ не найден' })

    await db.execute('DELETE FROM equipment_model_documents WHERE id = ?', [documentId])
    await logActivity({
      req,
      action: 'delete_document',
      entity_type: 'equipment_models',
      entity_id: id,
      comment: `Удален документ модели "${row.file_name || documentId}"`,
    })
    res.json({ message: 'Документ удален' })
  } catch (err) {
    console.error('DELETE /equipment-models/:id/documents/:documentId error:', err)
    res.status(500).json({ message: 'Ошибка удаления документа модели' })
  }
})

const fetchModelBomItems = async (modelId) => {
  const [rows] = await db.execute(
    `
    SELECT
      item.id,
      item.equipment_model_id,
      item.parent_item_id,
      item.item_type,
      item.item_no,
      item.manufacturer_part_number,
      item.manufacturer_part_name,
      item.drawing_number,
      item.oem_part_id,
      item.catalog_position_id,
      item.title,
      item.quantity,
      item.sort_order,
      item.notes,
      part.part_number,
      part.description_ru,
      part.description_en,
      part.uom,
      part.manufacturer_id,
      manufacturer.name AS manufacturer_name,
      catalog.display_name AS catalog_position_name,
      catalog.position_code AS catalog_position_code,
      catalog.description AS catalog_position_description,
      catalog.uom AS catalog_position_uom,
      catalog_node.name AS catalog_classifier_node_name
    FROM equipment_model_bom_items item
    LEFT JOIN oem_parts part ON part.id = item.oem_part_id
    LEFT JOIN equipment_manufacturers manufacturer ON manufacturer.id = part.manufacturer_id
    LEFT JOIN catalog_positions catalog ON catalog.id = item.catalog_position_id
    LEFT JOIN equipment_classifier_nodes catalog_node ON catalog_node.id = catalog.classifier_node_id
    WHERE item.equipment_model_id = ?
    ORDER BY
      COALESCE(item.parent_item_id, 0),
      item.sort_order,
      item.id
    `,
    [modelId]
  )
  return rows.map((row) => ({ ...row, quantity: formatBomQuantity(row.quantity) }))
}

/**
 * GET /equipment-models/:id/bom
 *
 * Новый BOM модели: корень всегда equipment_model, ниже идут сборки,
 * группы и OEM детали. Старый oem_part_model_bom пока оставлен для
 * совместимости с закупочным контуром.
 */
router.get('/:id/bom', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор модели' })

    const [models] = await db.execute('SELECT id, model_name FROM equipment_models WHERE id = ?', [id])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const items = await fetchModelBomItems(id)
    res.json({ model_id: id, items })
  } catch (err) {
    console.error('GET /equipment-models/:id/bom error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/bom/template', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор модели' })

    const [models] = await db.execute(
      `
      SELECT em.id, em.model_name, m.name AS manufacturer_name
      FROM equipment_models em
      LEFT JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
      WHERE em.id = ?
      `,
      [id]
    )
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const headers = [
      'Уровень',
      'Ключ',
      'Родительский ключ',
      'Тип',
      '№ позиции',
      'Каталожный номер',
      'Название по каталогу',
      'Чертеж',
      'Код OEM',
      'Код классификатора',
      'Название',
      'Количество',
      'Заметки',
    ]
    const exampleRows = [
      [1, 'adjustment-ring', '', 'сборка', 2, '1093080129', 'Adjustment Ring', '1093080129', '', '', '', 1, ''],
      [2, 'clamping-cylinders', 'adjustment-ring', 'сборка', '', '1093070001', 'Clamping cylinders', '1093070001', '', '', '', 1, ''],
      [1, 'shaft-arm-liners', '', 'сборка', '', '17-403-100-801', 'Брони ребра вала-шестерни', '', '', '', '', 1, ''],
      [2, 'shaft-arm-liner-left', 'shaft-arm-liners', 'oem', 1, '17-403-100-801-L', 'Броня ребра вала-шестерни левая', '', '17-403-100-801-L', '', '', 1, ''],
      [2, 'shaft-arm-liner-right', 'shaft-arm-liners', 'oem', 2, '17-403-100-801-R', 'Броня ребра вала-шестерни правая', '', '17-403-100-801-R', '', '', 1, ''],
      [1, 'fasteners', '', 'сборка', '', '', 'Крепеж', '', '', '', 'Крепеж', 1, ''],
      [2, 'hex-bolt-m20x80', 'fasteners', 'позиция классификатора', 14, 'METSO-HEX-M20X80', 'Hex bolt M20x80', '', '', 'HEX-BOLT-M20X80-10.9-DIN931', '', 12, ''],
    ]

    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...exampleRows])
    sheet['!cols'] = [
      { wch: 10 },
      { wch: 26 },
      { wch: 26 },
      { wch: 26 },
      { wch: 12 },
      { wch: 24 },
      { wch: 34 },
      { wch: 20 },
      { wch: 22 },
      { wch: 34 },
      { wch: 42 },
      { wch: 14 },
      { wch: 40 },
    ]
    XLSX.utils.book_append_sheet(workbook, sheet, 'BOM')

    const readme = XLSX.utils.aoa_to_sheet([
      ['Модель', `${models[0].manufacturer_name || ''} ${models[0].model_name || ''}`.trim()],
      [],
      ['Как заполнять'],
      ['Уровень', '1 = строка под моделью, 2 = дочерняя строка, 3 = глубже и так далее.'],
      ['Ключ', 'Уникальный технический ключ строки внутри файла. Можно писать латиницей или любым коротким текстом.'],
      ['Родительский ключ', 'Можно не заполнять, если уровни идут строго сверху вниз. Для надежности лучше указывать.'],
      ['Тип', 'сборка, oem, позиция классификатора.'],
      ['№ позиции', 'Номер позиции на чертеже или в таблице BOM производителя: 1, 2, 3, 14A.'],
      ['Каталожный номер', 'Номер производителя в этой BOM-строке. Может быть номером сборки или номером детали.'],
      ['Название по каталогу', 'Как позиция названа в parts book производителя.'],
      ['Чертеж', 'Номер чертежа или документа, если отличается от каталожного номера.'],
      ['Код OEM', 'Для типа oem: каталожный номер детали производителя. Если пусто, берется значение из "Каталожный номер".'],
      ['Код классификатора', 'Для переиспользуемой позиции классификатора: например HEX-BOLT-M20X80-10.9-DIN931.'],
      ['Название', 'Для сборки обязательно. Для OEM/классификатора можно оставить пустым: система возьмет название из базы.'],
      ['Количество', 'Число больше нуля. Дробные значения допустимы.'],
    ])
    XLSX.utils.book_append_sheet(workbook, readme, 'README')

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="equipment_model_${id}_bom_template.xlsx"`)
    res.send(buffer)
  } catch (err) {
    console.error('GET /equipment-models/:id/bom/template error:', err)
    res.status(500).json({ message: 'Ошибка генерации шаблона BOM' })
  }
})

router.post('/:id/bom/import/preview', async (req, res) => {
  try {
    const modelId = toId(req.params.id)
    if (!modelId) return res.status(400).json({ message: 'Некорректный идентификатор модели' })

    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [modelId])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : Array.isArray(req.body) ? req.body : []
    const result = await resolveBomImportRows(modelId, rows)
    res.json({
      ok: result.errors.length === 0,
      rows: result.rows,
      errors: result.errors,
      warnings: result.warnings,
    })
  } catch (err) {
    console.error('POST /equipment-models/:id/bom/import/preview error:', err)
    res.status(500).json({ message: 'Ошибка проверки BOM' })
  }
})

router.post('/:id/bom/import/commit', async (req, res) => {
  try {
    const modelId = toId(req.params.id)
    if (!modelId) return res.status(400).json({ message: 'Некорректный идентификатор модели' })

    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [modelId])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : Array.isArray(req.body) ? req.body : []
    const replace = req.body?.mode === 'replace' || req.body?.replace === true
    const result = await resolveBomImportRows(modelId, rows)
    if (result.errors.length) {
      return res.status(400).json({
        message: 'В файле есть ошибки, импорт не выполнен',
        rows: result.rows,
        errors: result.errors,
        warnings: result.warnings,
      })
    }

    const conn = await db.getConnection()
    const insertedIdsByKey = new Map()
    try {
      await conn.beginTransaction()

      if (replace) {
        await conn.execute('DELETE FROM equipment_model_bom_items WHERE equipment_model_id = ?', [modelId])
      }

      for (const row of result.rows) {
        const parentId = row.parent_key ? insertedIdsByKey.get(row.parent_key) || null : null
        const [ins] = await conn.execute(
          `
          INSERT INTO equipment_model_bom_items
            (equipment_model_id, parent_item_id, item_type, item_no, manufacturer_part_number,
             manufacturer_part_name, drawing_number, oem_part_id, catalog_position_id, title,
             quantity, sort_order, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            modelId,
            parentId,
            row.item_type,
            row.item_no || null,
            row.manufacturer_part_number || row.oem_part_number || null,
            row.manufacturer_part_name || null,
            row.drawing_number || null,
            row.oem_part_id || null,
            row.catalog_position_id || null,
            row.item_type === 'group'
              ? (row.title || row.manufacturer_part_name || row.manufacturer_part_number)
              : null,
            row.quantity,
            row.sort_order,
            row.notes,
          ]
        )
        insertedIdsByKey.set(row.item_key, ins.insertId)
      }

      await logActivity({
        req,
        action: replace ? 'replace' : 'create',
        entity_type: 'equipment_model_bom_items',
        entity_id: modelId,
        comment: `Импорт BOM модели из Excel: ${result.rows.length} строк${replace ? ', с заменой текущего BOM' : ''}`,
      })

      await conn.commit()
    } catch (err) {
      try {
        await conn.rollback()
      } catch (_) {
        // ignore rollback error and keep primary error
      }
      throw err
    } finally {
      conn.release()
    }

    const items = await fetchModelBomItems(modelId)
    res.json({
      imported: result.rows.length,
      warnings: result.warnings,
      model_id: modelId,
      items,
    })
  } catch (err) {
    console.error('POST /equipment-models/:id/bom/import/commit error:', err)
    res.status(500).json({ message: 'Ошибка импорта BOM' })
  }
})

/**
 * POST /equipment-models/:id/bom/items
 * body: { parent_item_id?, item_type?, item_no?, manufacturer_part_number?,
 *         manufacturer_part_name?, drawing_number?, oem_part_id?,
 *         catalog_position_id?, title?, quantity?, notes? }
 */
router.post('/:id/bom/items', async (req, res) => {
  try {
    const modelId = toId(req.params.id)
    if (!modelId) return res.status(400).json({ message: 'Некорректный идентификатор модели' })

    const parentItemId = toId(req.body.parent_item_id)
    const oemPartId = toId(req.body.oem_part_id)
    const catalogPositionId = toId(req.body.catalog_position_id)
    const itemType = ['group', 'oem_part', 'catalog_position'].includes(nz(req.body.item_type))
      ? nz(req.body.item_type)
      : oemPartId
        ? 'oem_part'
        : catalogPositionId
          ? 'catalog_position'
          : 'group'
    const itemNo = nz(req.body.item_no)
    const manufacturerPartNumber = nz(req.body.manufacturer_part_number)
    const manufacturerPartName = nz(req.body.manufacturer_part_name)
    const drawingNumber = nz(req.body.drawing_number)
    const title = nz(req.body.title)
    const quantity = numOrNull(req.body.quantity) || 1
    const sortOrder = Number.isInteger(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0
    const notes = nz(req.body.notes)

    if (!oemPartId && !catalogPositionId && !title && !manufacturerPartName && !manufacturerPartNumber) {
      return res.status(400).json({ message: 'Нужно указать номер/название строки BOM или выбрать позицию' })
    }
    if (oemPartId && catalogPositionId) {
      return res.status(400).json({ message: 'В одной строке BOM нельзя одновременно выбрать OEM деталь и позицию классификатора' })
    }
    if (quantity <= 0) {
      return res.status(400).json({ message: 'Количество должно быть больше нуля' })
    }

    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [modelId])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    if (parentItemId) {
      const [parents] = await db.execute(
        'SELECT id FROM equipment_model_bom_items WHERE id = ? AND equipment_model_id = ?',
        [parentItemId, modelId]
      )
      if (!parents.length) {
        return res.status(400).json({ message: 'Родительская строка BOM не найдена в этой модели' })
      }
    }

    if (oemPartId) {
      const [parts] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [oemPartId])
      if (!parts.length) return res.status(400).json({ message: 'OEM деталь не найдена' })
    }
    if (catalogPositionId) {
      const [positions] = await db.execute('SELECT id FROM catalog_positions WHERE id = ? AND is_active = 1', [
        catalogPositionId,
      ])
      if (!positions.length) return res.status(400).json({ message: 'Позиция классификатора не найдена' })
    }

    const [ins] = await db.execute(
      `
      INSERT INTO equipment_model_bom_items
        (equipment_model_id, parent_item_id, item_type, item_no, manufacturer_part_number,
         manufacturer_part_name, drawing_number, oem_part_id, catalog_position_id, title,
         quantity, sort_order, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        modelId,
        parentItemId,
        itemType,
        itemNo,
        manufacturerPartNumber,
        manufacturerPartName,
        drawingNumber,
        oemPartId,
        catalogPositionId,
        itemType === 'group' ? (title || manufacturerPartName || manufacturerPartNumber) : title,
        quantity,
        sortOrder,
        notes,
      ]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_model_bom_items',
      entity_id: ins.insertId,
      comment: 'Добавлена строка BOM модели',
    })

    const items = await fetchModelBomItems(modelId)
    res.status(201).json({ id: ins.insertId, model_id: modelId, items })
  } catch (err) {
    console.error('POST /equipment-models/:id/bom/items error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/**
 * PUT /equipment-models/:id/bom/items/:itemId
 */
router.put('/:id/bom/items/:itemId', async (req, res) => {
  try {
    const modelId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!modelId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[old]] = await db.execute(
      'SELECT * FROM equipment_model_bom_items WHERE id = ? AND equipment_model_id = ?',
      [itemId, modelId]
    )
    if (!old) return res.status(404).json({ message: 'Строка BOM не найдена' })

    const parentItemId =
      req.body.parent_item_id !== undefined ? toId(req.body.parent_item_id) : old.parent_item_id
    const itemNo = req.body.item_no !== undefined ? nz(req.body.item_no) : old.item_no
    const manufacturerPartNumber =
      req.body.manufacturer_part_number !== undefined ? nz(req.body.manufacturer_part_number) : old.manufacturer_part_number
    const manufacturerPartName =
      req.body.manufacturer_part_name !== undefined ? nz(req.body.manufacturer_part_name) : old.manufacturer_part_name
    const drawingNumber = req.body.drawing_number !== undefined ? nz(req.body.drawing_number) : old.drawing_number
    const title = req.body.title !== undefined ? nz(req.body.title) : old.title
    const quantity = req.body.quantity !== undefined ? numOrNull(req.body.quantity) : old.quantity
    const sortOrder =
      req.body.sort_order !== undefined && Number.isInteger(Number(req.body.sort_order))
        ? Number(req.body.sort_order)
        : old.sort_order
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : old.notes

    if (Number(parentItemId) === Number(itemId)) {
      return res.status(400).json({ message: 'Строка BOM не может быть родителем самой себя' })
    }
    if (!old.oem_part_id && !old.catalog_position_id && !title && !manufacturerPartName && !manufacturerPartNumber) {
      return res.status(400).json({ message: 'Для строки BOM нужно название или каталожный номер' })
    }
    if (Number(quantity) <= 0) {
      return res.status(400).json({ message: 'Количество должно быть больше нуля' })
    }
    if (parentItemId) {
      const [parents] = await db.execute(
        'SELECT id FROM equipment_model_bom_items WHERE id = ? AND equipment_model_id = ?',
        [parentItemId, modelId]
      )
      if (!parents.length) {
        return res.status(400).json({ message: 'Родительская строка BOM не найдена в этой модели' })
      }
    }

    await db.execute(
      `
      UPDATE equipment_model_bom_items
      SET parent_item_id = ?, item_no = ?, manufacturer_part_number = ?,
          manufacturer_part_name = ?, drawing_number = ?, title = ?,
          quantity = ?, sort_order = ?, notes = ?
      WHERE id = ? AND equipment_model_id = ?
      `,
      [
        parentItemId || null,
        itemNo,
        manufacturerPartNumber,
        manufacturerPartName,
        drawingNumber,
        title,
        quantity,
        sortOrder,
        notes,
        itemId,
        modelId,
      ]
    )

    await logActivity({
      req,
      action: 'update',
      entity_type: 'equipment_model_bom_items',
      entity_id: itemId,
      comment: 'Изменена строка BOM модели',
    })

    const items = await fetchModelBomItems(modelId)
    res.json({ model_id: modelId, items })
  } catch (err) {
    console.error('PUT /equipment-models/:id/bom/items/:itemId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/bom/items/:itemId', async (req, res) => {
  try {
    const modelId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!modelId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      'SELECT id FROM equipment_model_bom_items WHERE id = ? AND equipment_model_id = ?',
      [itemId, modelId]
    )
    if (!rows.length) return res.status(404).json({ message: 'Строка BOM не найдена' })

    await db.execute('DELETE FROM equipment_model_bom_items WHERE id = ? AND equipment_model_id = ?', [
      itemId,
      modelId,
    ])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'equipment_model_bom_items',
      entity_id: itemId,
      comment: 'Удалена строка BOM модели',
    })

    const items = await fetchModelBomItems(modelId)
    res.json({ model_id: modelId, items })
  } catch (err) {
    console.error('DELETE /equipment-models/:id/bom/items/:itemId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/**
 * CREATE
 * POST /equipment-models
 * body: { manufacturer_id, model_name, classifier_node_id, storage_uom?, weight_kg?, length_mm?, width_mm?, height_mm?, notes? }
 */
router.post('/', async (req, res) => {
  try {
    if (nz(req.body.source) !== 'classifier') {
      return res.status(403).json({
        message: 'Модели оборудования создаются только из классификатора',
      })
    }

    const manufacturer_id = toId(req.body.manufacturer_id)
    const model_name = nz(req.body.model_name)
    const classifier_node_id = toId(req.body.classifier_node_id)
    const storage_uom = nz(req.body.storage_uom)
    const weight_kg = numOrNull(req.body.weight_kg)
    const length_mm = numOrNull(req.body.length_mm)
    const width_mm = numOrNull(req.body.width_mm)
    const height_mm = numOrNull(req.body.height_mm)
    const notes = nz(req.body.notes)

    if (!manufacturer_id) {
      return res.status(400).json({
        message: 'Нужно выбрать производителя',
      })
    }
    if (!model_name) {
      return res.status(400).json({ message: 'model_name обязателен' })
    }

    // проверим, что производитель существует
    const [man] = await db.execute(
      'SELECT id FROM equipment_manufacturers WHERE id = ?',
      [manufacturer_id]
    )
    if (!man.length) {
      return res
        .status(400)
        .json({ message: 'Указанный производитель не найден' })
    }

    if (!classifier_node_id) {
      return res.status(400).json({
        message: 'Модель оборудования нужно создавать через НСИ/классификатор с обязательной привязкой к узлу',
      })
    }
    const [classifier] = await db.execute(
      'SELECT id FROM equipment_classifier_nodes WHERE id = ?',
      [classifier_node_id]
    )
    if (!classifier.length) {
      return res.status(400).json({ message: 'Указанный узел классификатора не найден' })
    }
    if (!(await requireLeafClassifierNode(classifier_node_id, res))) return
    if (storage_uom) {
      const [units] = await db.execute('SELECT code FROM measurement_units WHERE code = ? AND is_active = 1', [storage_uom])
      if (!units.length) return res.status(400).json({ message: 'Единица хранения не найдена в справочнике единиц' })
    }

    const [ins] = await db.execute(
      `INSERT INTO equipment_models
        (manufacturer_id, model_name, classifier_node_id, storage_uom, weight_kg, length_mm, width_mm, height_mm, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [manufacturer_id, model_name, classifier_node_id, storage_uom, weight_kg, length_mm, width_mm, height_mm, notes]
    )

    const [rows] = await db.execute(
      `SELECT em.*, m.name AS manufacturer_name, ecn.name AS classifier_node_name,
              media.file_url AS primary_photo_url ` +
        'FROM equipment_models em ' +
        'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
        'LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id ' +
        `LEFT JOIN equipment_model_media media
           ON media.id = (
             SELECT emm.id
             FROM equipment_model_media emm
             WHERE emm.equipment_model_id = em.id
             ORDER BY emm.is_primary DESC, emm.sort_order, emm.id
             LIMIT 1
           ) ` +
        'WHERE em.id = ?',
      [ins.insertId]
    )
    const fresh = rows[0]

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_models',
      entity_id: ins.insertId,
      comment: 'Добавлена модель оборудования',
    })

    res.status(201).json(fresh)
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      // работает, если в БД есть UNIQUE(manufacturer_id, model_name)
      return res.status(409).json({
        type: 'duplicate',
        fields: ['manufacturer_id', 'model_name'],
        message: 'Такая модель у этого производителя уже существует',
      })
    }
    console.error('POST /equipment-models error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/**
 * UPDATE
 * PUT /equipment-models/:id
 * body: { manufacturer_id?, model_name?, classifier_node_id?, storage_uom?, weight_kg?, length_mm?, width_mm?, height_mm?, notes? }
 */
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [oldRows] = await db.execute(
      'SELECT * FROM equipment_models WHERE id = ?',
      [id]
    )
    if (!oldRows.length) {
      return res.status(404).json({ message: 'Модель не найдена' })
    }
    const old = oldRows[0]

    const manufacturer_id =
      req.body.manufacturer_id !== undefined
        ? toId(req.body.manufacturer_id)
        : undefined
    const model_name = req.body.model_name !== undefined ? nz(req.body.model_name) : undefined
    const classifier_node_id =
      req.body.classifier_node_id !== undefined ? toId(req.body.classifier_node_id) : undefined
    const storage_uom = req.body.storage_uom !== undefined ? nz(req.body.storage_uom) : undefined
    const weight_kg = req.body.weight_kg !== undefined ? numOrNull(req.body.weight_kg) : undefined
    const length_mm = req.body.length_mm !== undefined ? numOrNull(req.body.length_mm) : undefined
    const width_mm = req.body.width_mm !== undefined ? numOrNull(req.body.width_mm) : undefined
    const height_mm = req.body.height_mm !== undefined ? numOrNull(req.body.height_mm) : undefined
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : undefined

    if (manufacturer_id !== undefined && !manufacturer_id) {
      return res
        .status(400)
        .json({ message: 'Некорректный производитель' })
    }
    if (classifier_node_id !== undefined && !classifier_node_id) {
      return res.status(400).json({
        message: 'Модель оборудования должна быть привязана к узлу НСИ/классификатора',
      })
    }
    if (manufacturer_id !== undefined) {
      const [man] = await db.execute(
        'SELECT id FROM equipment_manufacturers WHERE id = ?',
        [manufacturer_id]
      )
      if (!man.length) {
        return res
          .status(400)
          .json({ message: 'Указанный производитель не найден' })
      }
    }
    if (classifier_node_id !== undefined) {
      const [classifier] = await db.execute(
        'SELECT id FROM equipment_classifier_nodes WHERE id = ?',
        [classifier_node_id]
      )
      if (!classifier.length) {
        return res.status(400).json({ message: 'Указанный узел классификатора не найден' })
      }
      if (!(await requireLeafClassifierNode(classifier_node_id, res))) return
    }
    if (storage_uom !== undefined && storage_uom) {
      const [units] = await db.execute('SELECT code FROM measurement_units WHERE code = ? AND is_active = 1', [storage_uom])
      if (!units.length) return res.status(400).json({ message: 'Единица хранения не найдена в справочнике единиц' })
    }

    await db.execute(
      `UPDATE equipment_models
          SET manufacturer_id = COALESCE(?, manufacturer_id),
              model_name      = COALESCE(?, model_name),
              classifier_node_id = ?,
              storage_uom     = ?,
              weight_kg       = ?,
              length_mm       = ?,
              width_mm        = ?,
              height_mm       = ?,
              notes           = COALESCE(?, notes)
        WHERE id = ?`,
      [
        sqlValue(manufacturer_id),
        sqlValue(model_name),
        classifier_node_id === undefined ? old.classifier_node_id : classifier_node_id,
        storage_uom === undefined ? old.storage_uom : storage_uom,
        weight_kg === undefined ? old.weight_kg : weight_kg,
        length_mm === undefined ? old.length_mm : length_mm,
        width_mm === undefined ? old.width_mm : width_mm,
        height_mm === undefined ? old.height_mm : height_mm,
        sqlValue(notes),
        id,
      ]
    )

    const [freshRows] = await db.execute(
      `SELECT em.*, m.name AS manufacturer_name, ecn.name AS classifier_node_name
         FROM equipment_models em
         JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
         LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id
        WHERE em.id = ?`,
      [id]
    )
    const fresh = freshRows[0]

    await logFieldDiffs({
      req,
      entity_type: 'equipment_models',
      entity_id: id,
      oldData: old,
      newData: fresh,
    })

    res.json(fresh)
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate',
        fields: ['manufacturer_id', 'model_name'],
        message: 'Такая модель у этого производителя уже существует',
      })
    }
    console.error('PUT /equipment-models/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/**
 * DELETE
 * DELETE /equipment-models/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [exists] = await db.execute(
      'SELECT * FROM equipment_models WHERE id = ?',
      [id]
    )
    if (!exists.length) {
      return res.status(404).json({ message: 'Модель не найдена' })
    }

    const preview = await buildTrashPreview('equipment_models', id)
    if (!preview) return res.status(404).json({ message: 'Модель не найдена' })
    if (preview.mode !== MODE.TRASH) {
      return res.status(409).json({
        message: preview.summary?.message || 'Удаление недоступно',
        preview,
      })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      const trashEntryId = await createTrashEntry({
        executor: conn,
        req,
        entityType: 'equipment_models',
        entityId: id,
        rootEntityType: 'equipment_models',
        rootEntityId: id,
        deleteMode: 'trash',
        title: exists[0].model_name || `Модель #${id}`,
        subtitle: 'Модель оборудования',
        snapshot: exists[0],
      })

      await conn.execute('DELETE FROM equipment_models WHERE id = ?', [id])

      await logActivity({
        req,
        action: 'delete',
        entity_type: 'equipment_models',
        entity_id: id,
        comment: `Модель "${exists[0].model_name}" удалена`,
        new_value: { trash_entry_id: trashEntryId },
      })

      await conn.commit()
      res.json({ message: 'Модель перемещена в корзину', trash_entry_id: trashEntryId })
    } catch (fkErr) {
      try {
        await conn.rollback()
      } catch {}
      console.error('DELETE /equipment-models fk error:', fkErr)
      return res.status(500).json({ message: 'Ошибка при удалении' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('DELETE /equipment-models/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
