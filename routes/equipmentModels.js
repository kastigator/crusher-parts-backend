// routes/equipmentModels.js
const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const XLSX = require('xlsx')
const db = require('../utils/db')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')
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
  if (['group', 'assembly', 'section', 'сборка', 'раздел', 'узел', 'строка производителя', 'без привязки'].includes(raw)) return 'group'
  if (['catalog_position', 'catalog', 'classifier', 'классификатор', 'позиция классификатора'].includes(raw)) {
    return 'catalog_position'
  }
  if (['oem', 'oem_part', 'деталь производителя', 'деталь'].includes(raw)) return 'unlinked'
  if (['client_part', 'client_drawing', 'чертеж клиента', 'деталь клиента'].includes(raw)) return 'client_part'
  if (['unlinked', 'manufacturer_line', 'manufacturer', 'строка каталога'].includes(raw)) return 'unlinked'
  return raw || 'group'
}

const normalizeBomRowKind = (value, fallback = 'assembly') => {
  const raw = cleanImportValue(value).toLowerCase()
  if (!raw) return fallback
  if (['assembly', 'group', 'section', 'subassembly', 'сборка', 'узел', 'подсборка', 'раздел'].includes(raw)) return 'assembly'
  if (['part', 'detail', 'деталь', 'позиция', 'номенклатура'].includes(raw)) return 'part'
  if (['kit', 'комплект', 'набор'].includes(raw)) return 'kit'
  if (['document', 'drawing', 'schematic', 'schema', 'документ', 'чертеж', 'схема'].includes(raw)) return 'document'
  if (['service', 'work', 'услуга', 'работа', 'операция'].includes(raw)) return 'service'
  if (['material', 'материал', 'сырье'].includes(raw)) return 'material'
  return 'unknown'
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
        row_kind: normalizeBomRowKind(row.row_kind ?? row.kind ?? row['Тип строки'] ?? row['Тип']),
        item_type: normalizeBomImportType(row.item_type ?? row.link_type ?? row['Тип связи'] ?? row['Связь']),
        item_no: cleanImportValue(row.item_no ?? row['№ позиции'] ?? row['Позиция']),
        manufacturer_part_number: cleanImportValue(
          row.manufacturer_part_number ?? row.manufacturerPartNumber ?? row['Каталожный номер']
        ),
        manufacturer_part_name: cleanImportValue(
          row.manufacturer_part_name ?? row.manufacturerPartName ?? row['Название по каталогу']
        ),
        manufacturer_part_name_en: cleanImportValue(
          row.manufacturer_part_name_en ?? row.manufacturerPartNameEn ?? row['Название EN'] ?? row['Name EN']
        ),
        manufacturer_part_name_ru: cleanImportValue(
          row.manufacturer_part_name_ru ?? row.manufacturerPartNameRu ?? row['Название RU'] ?? row['Название РУ']
        ),
        drawing_number: cleanImportValue(row.drawing_number ?? row['Чертеж']),
        oem_part_number: cleanImportValue(row.oem_part_number ?? row.part_number ?? row['Код OEM']),
        catalog_position_code: cleanImportValue(
          row.catalog_position_code ?? row.position_code ?? row['Код классификатора']
        ),
        catalog_position_name: cleanImportValue(
          row.catalog_position_name ?? row['Название позиции классификатора']
        ),
        client_part_id: toId(row.client_part_id ?? row['ID клиентской детали']),
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
        row.row_kind,
        row.item_no,
        row.manufacturer_part_number,
        row.manufacturer_part_name,
        row.manufacturer_part_name_en,
        row.manufacturer_part_name_ru,
        row.drawing_number,
        row.oem_part_number,
        row.catalog_position_code,
        row.catalog_position_name,
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
    if (!['group', 'catalog_position', 'client_part', 'unlinked'].includes(row.item_type)) {
      errors.push({ row_number: row.row_number, message: `Неизвестная связь строки: ${row.item_type}` })
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

    let catalogPositionId = null
    let clientPartId = null
    let resolvedLabel = row.title
    let resolvedSubtitle = null

    if (row.item_type === 'group' && row.row_kind === 'part') {
      row.item_type = 'unlinked'
    }

    if (row.item_type === 'group') {
      const rowDisplayName = row.manufacturer_part_name_en || row.manufacturer_part_name_ru || row.manufacturer_part_name
      if (!row.title && !rowDisplayName && !row.manufacturer_part_number) {
        errors.push({ row_number: row.row_number, message: 'Для сборки/раздела нужно заполнить название или каталожный номер' })
        continue
      }
      resolvedLabel = row.manufacturer_part_number || row.title || rowDisplayName
      resolvedSubtitle = rowDisplayName || row.title || null
    }

    if (row.item_type === 'catalog_position') {
      if (!row.catalog_position_code && !row.catalog_position_name && !row.title) {
        warnings.push({
          row_number: row.row_number,
          message: 'Связь с классификатором не заполнена, строка будет импортирована как строка каталога без привязки',
        })
        row.item_type = 'unlinked'
      }
    }

    if (row.item_type === 'catalog_position') {
      const lookupName = row.catalog_position_name || row.title
      const params = []
      const where = []
      if (row.catalog_position_code) {
        where.push('position_code = ?')
        params.push(row.catalog_position_code)
      }
      if (lookupName) {
        where.push('display_name = ?')
        params.push(lookupName)
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
        warnings.push({
          row_number: row.row_number,
          message: 'Позиция классификатора не найдена, строка будет импортирована без привязки',
        })
        row.item_type = 'unlinked'
      } else {
        if (positions.length > 1) {
          warnings.push({ row_number: row.row_number, message: 'Найдено несколько позиций, взята первая по коду/названию' })
        }
        catalogPositionId = positions[0].id
        resolvedLabel = positions[0].display_name
        resolvedSubtitle = positions[0].classifier_node_name || positions[0].position_code || null
      }
    }

    if (row.item_type === 'client_part') {
      if (!row.client_part_id) {
        errors.push({ row_number: row.row_number, message: 'Для клиентской детали нужен ID клиентской детали' })
        continue
      }
      const [clientParts] = await db.execute(
        `
        SELECT id, display_name, client_part_number, drawing_number
        FROM client_parts
        WHERE id = ?
        LIMIT 1
        `,
        [row.client_part_id]
      )
      if (!clientParts.length) {
        errors.push({ row_number: row.row_number, message: 'Клиентская деталь не найдена' })
        continue
      }
      clientPartId = clientParts[0].id
      resolvedLabel = clientParts[0].display_name
      resolvedSubtitle = [clientParts[0].client_part_number, clientParts[0].drawing_number].filter(Boolean).join(' / ') || null
    }

    if (row.item_type === 'unlinked') {
      const rowDisplayName = row.manufacturer_part_name_en || row.manufacturer_part_name_ru || row.manufacturer_part_name
      if (!row.manufacturer_part_number && !rowDisplayName && !row.title) {
        errors.push({ row_number: row.row_number, message: 'Для строки каталога без привязки нужно название или каталожный номер' })
        continue
      }
      resolvedLabel = row.manufacturer_part_number || rowDisplayName || row.title
      resolvedSubtitle = rowDisplayName || row.title || null
    }

    const preparedRow = {
      ...row,
      item_key: itemKey,
      parent_key: parentKey,
      oem_part_id: null,
      catalog_position_id: catalogPositionId,
      client_part_id: clientPartId,
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

const ensureBomItemCatalogPosition = async (conn, modelId, itemId) => {
  const [[item]] = await conn.execute(
    `
    SELECT
      item.*,
      em.manufacturer_id,
      em.model_name,
      em.classifier_node_id,
      mf.name AS manufacturer_name
    FROM equipment_model_bom_items item
    JOIN equipment_models em ON em.id = item.equipment_model_id
    JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
    WHERE item.id = ?
      AND item.equipment_model_id = ?
    LIMIT 1
    `,
    [itemId, modelId]
  )
  if (!item || item.catalog_position_id || item.client_part_id) return item?.catalog_position_id || null

  const displayName = (
    item.manufacturer_part_name_en ||
    item.manufacturer_part_name_ru ||
    item.manufacturer_part_name ||
    item.title ||
    item.manufacturer_part_number ||
    `BOM row ${item.id}`
  ).slice(0, 255)
  const positionKind = normalizeBomRowKind(item.row_kind, 'part')
  const positionCode = `MODEL-BOM-${modelId}-${item.id}-${String(item.manufacturer_part_number || `ROW-${item.id}`)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/]+/g, '-')
    .toUpperCase()}`.slice(0, 120)

  const [[existing]] = await conn.execute(
    `
    SELECT id
    FROM catalog_positions
    WHERE source_kind = 'model_bom'
      AND equipment_model_id = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(meta_json, '$.source_bom_item_id')) = ?
    LIMIT 1
    `,
    [modelId, String(item.id)]
  )

  if (existing?.id) {
    await conn.execute(
      `
      UPDATE catalog_positions
      SET classifier_node_id = ?,
          manufacturer_id = ?,
          equipment_model_id = ?,
          position_kind = ?,
          display_name = ?,
          display_name_en = ?,
          display_name_ru = ?,
          position_code = ?,
          manufacturer_part_number = ?,
          description = ?,
          is_active = 1,
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND source_kind = 'model_bom'
      `,
      [
        item.classifier_node_id,
        item.manufacturer_id,
        modelId,
        positionKind === 'unknown' ? 'part' : positionKind,
        displayName,
        item.manufacturer_part_name_en || item.manufacturer_part_name || null,
        item.manufacturer_part_name_ru || null,
        positionCode,
        item.manufacturer_part_number || null,
        [
          `Создано из BOM модели ${item.manufacturer_name} ${item.model_name}`,
          item.item_no ? `Позиция в BOM: ${item.item_no}` : null,
          item.notes || null,
        ].filter(Boolean).join('\n') || null,
        existing.id,
      ]
    )
    await conn.execute(
      `
      UPDATE equipment_model_bom_items
         SET catalog_position_id = ?,
             item_type = 'catalog_position',
             oem_part_id = NULL
       WHERE id = ?
         AND equipment_model_id = ?
      `,
      [existing.id, item.id, modelId]
    )
    return existing.id
  }

  const [ins] = await conn.execute(
    `
    INSERT INTO catalog_positions
      (classifier_node_id, manufacturer_id, equipment_model_id, position_kind, source_kind,
       display_name, display_name_en, display_name_ru, position_code, manufacturer_part_number,
       description, uom, is_active, status, meta_json)
    VALUES (?, ?, ?, ?, 'model_bom', ?, ?, ?, ?, ?, ?, 'шт', 1, 'active', ?)
    `,
    [
      item.classifier_node_id,
      item.manufacturer_id,
      modelId,
      positionKind === 'unknown' ? 'part' : positionKind,
      displayName,
      item.manufacturer_part_name_en || item.manufacturer_part_name || null,
      item.manufacturer_part_name_ru || null,
      positionCode,
      item.manufacturer_part_number || null,
      [
        `Создано из BOM модели ${item.manufacturer_name} ${item.model_name}`,
        item.item_no ? `Позиция в BOM: ${item.item_no}` : null,
        item.notes || null,
      ].filter(Boolean).join('\n') || null,
      JSON.stringify({
        source: 'equipment_model_bom_items',
        source_bom_item_id: item.id,
        equipment_model_id: modelId,
        manufacturer_id: item.manufacturer_id,
      }),
    ]
  )

  await conn.execute(
    `
    UPDATE equipment_model_bom_items
       SET catalog_position_id = ?,
           item_type = 'catalog_position',
           oem_part_id = NULL
     WHERE id = ?
       AND equipment_model_id = ?
    `,
    [ins.insertId, itemId, modelId]
  )

  return ins.insertId
}

const findCatalogPositionNumberConflicts = async ({
  manufacturerPartNumber,
  manufacturerId,
  excludeCatalogPositionId = null,
}) => {
  if (!manufacturerPartNumber) return { sameManufacturer: [], otherManufacturers: [] }
  const params = [manufacturerPartNumber]
  let excludeSql = ''
  if (excludeCatalogPositionId) {
    excludeSql = 'AND cp.id <> ?'
    params.push(excludeCatalogPositionId)
  }
  const [rows] = await db.execute(
    `
    SELECT
      cp.id,
      cp.manufacturer_id,
      cp.equipment_model_id,
      cp.position_code,
      cp.manufacturer_part_number,
      cp.display_name,
      cp.source_kind,
      mf.name AS manufacturer_name,
      em.model_name AS equipment_model_name
    FROM catalog_positions cp
    LEFT JOIN equipment_manufacturers mf ON mf.id = cp.manufacturer_id
    LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
    WHERE cp.is_active = 1
      AND cp.manufacturer_part_number = ?
      ${excludeSql}
    ORDER BY mf.name, cp.id
    LIMIT 20
    `,
    params
  )
  return {
    sameManufacturer: rows.filter((row) => Number(row.manufacturer_id) === Number(manufacturerId)),
    otherManufacturers: rows.filter((row) => Number(row.manufacturer_id) !== Number(manufacturerId)),
  }
}

const assertBomParentIsValid = async ({ modelId, parentItemId, itemId = null, catalogPositionId = null }) => {
  if (!parentItemId) return
  if (itemId && Number(parentItemId) === Number(itemId)) {
    const err = new Error('Строка BOM не может быть родителем самой себя')
    err.statusCode = 400
    throw err
  }
  const [[parent]] = await db.execute(
    `
    SELECT id, parent_item_id, catalog_position_id
    FROM equipment_model_bom_items
    WHERE id = ?
      AND equipment_model_id = ?
    LIMIT 1
    `,
    [parentItemId, modelId]
  )
  if (!parent) {
    const err = new Error('Родительская строка BOM не найдена в этой модели')
    err.statusCode = 400
    throw err
  }
  if (catalogPositionId && Number(parent.catalog_position_id) === Number(catalogPositionId)) {
    const err = new Error('Нельзя вложить позицию BOM саму в себя')
    err.statusCode = 400
    throw err
  }
  if (!itemId) return

  let cursor = parent
  const visited = new Set()
  while (cursor?.parent_item_id) {
    if (visited.has(Number(cursor.id))) break
    visited.add(Number(cursor.id))
    if (Number(cursor.parent_item_id) === Number(itemId)) {
      const err = new Error('Нельзя перенести строку BOM внутрь ее дочерней строки')
      err.statusCode = 400
      throw err
    }
    const [[nextParent]] = await db.execute(
      `
      SELECT id, parent_item_id, catalog_position_id
      FROM equipment_model_bom_items
      WHERE id = ?
        AND equipment_model_id = ?
      LIMIT 1
      `,
      [cursor.parent_item_id, modelId]
    )
    cursor = nextParent
  }
}

const assertBomCatalogPositionPlaceIsUnique = async ({
  modelId,
  parentItemId,
  catalogPositionId,
  itemId = null,
}) => {
  if (!catalogPositionId) return
  const params = [modelId, catalogPositionId]
  let parentSql = 'parent_item_id IS NULL'
  if (parentItemId) {
    parentSql = 'parent_item_id = ?'
    params.push(parentItemId)
  }
  let itemSql = ''
  if (itemId) {
    itemSql = 'AND id <> ?'
    params.push(itemId)
  }
  const [[duplicate]] = await db.execute(
    `
    SELECT id
    FROM equipment_model_bom_items
    WHERE equipment_model_id = ?
      AND catalog_position_id = ?
      AND ${parentSql}
      ${itemSql}
    LIMIT 1
    `,
    params
  )
  if (duplicate) {
    const err = new Error('Эта позиция уже есть в выбранном узле BOM. Измените количество в существующей строке или выберите другой узел.')
    err.statusCode = 409
    throw err
  }
}

const getSelectableCatalogPosition = async (catalogPositionId, modelId, itemId = null) => {
  if (!catalogPositionId) return null
  const [[position]] = await db.execute(
    `
    SELECT
      id,
      source_kind,
      equipment_model_id,
      JSON_UNQUOTE(JSON_EXTRACT(meta_json, '$.source_bom_item_id')) AS source_bom_item_id
    FROM catalog_positions
    WHERE id = ?
      AND is_active = 1
    LIMIT 1
    `,
    [catalogPositionId]
  )
  if (!position) return null

  return position
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
      item.row_kind,
      item.item_type,
      item.item_no,
      item.manufacturer_part_number,
      item.manufacturer_part_name,
      item.manufacturer_part_name_en,
      item.manufacturer_part_name_ru,
      item.drawing_number,
      NULL AS oem_part_id,
      item.catalog_position_id,
      item.client_part_id,
      item.title,
      item.quantity,
      item.sort_order,
      item.notes,
      catalog.manufacturer_part_number AS part_number,
      catalog.display_name_ru AS description_ru,
      catalog.display_name_en AS description_en,
      catalog.uom,
      catalog.manufacturer_id,
      catalog_manufacturer.name AS manufacturer_name,
      catalog.classifier_node_id AS catalog_position_classifier_node_id,
      catalog.display_name AS catalog_position_name,
      catalog.position_code AS catalog_position_code,
      catalog.source_kind AS catalog_position_source_kind,
      catalog.equipment_model_id AS catalog_position_equipment_model_id,
      JSON_UNQUOTE(JSON_EXTRACT(catalog.meta_json, '$.source_bom_item_id')) AS catalog_position_source_bom_item_id,
      catalog.description AS catalog_position_description,
      catalog.uom AS catalog_position_uom,
      catalog_node.name AS catalog_classifier_node_name,
      client_part.display_name AS client_part_name,
      client_part.client_part_number,
      client_part.drawing_number AS client_part_drawing_number,
      client_part.relationship_type AS client_part_relationship_type
    FROM equipment_model_bom_items item
    LEFT JOIN catalog_positions catalog ON catalog.id = item.catalog_position_id
    LEFT JOIN equipment_manufacturers catalog_manufacturer ON catalog_manufacturer.id = catalog.manufacturer_id
    LEFT JOIN equipment_classifier_nodes catalog_node ON catalog_node.id = catalog.classifier_node_id
    LEFT JOIN client_parts client_part ON client_part.id = item.client_part_id
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
 * группы и каталожные позиции. Legacy OEM-связи не используются в новом BOM.
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

router.get('/:id/client-executions', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор модели' })

    const [models] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
    if (!models.length) return res.status(404).json({ message: 'Модель не найдена' })

    const [rows] = await db.execute(
      `
      SELECT
        override_row.id AS override_id,
        override_row.status AS override_status,
        override_row.difference_summary,
        override_row.client_part_number AS override_client_part_number,
        override_row.client_drawing_number,
        override_row.client_revision,
        override_row.notes AS override_notes,
        unit.id AS client_equipment_unit_id,
        unit.internal_name AS unit_internal_name,
        unit.serial_number,
        unit.site_name,
        unit.manufacture_year,
        client.id AS client_id,
        client.company_name AS client_name,
        item.id AS equipment_model_bom_item_id,
        item.item_no,
        item.row_kind,
        item.item_type,
        item.manufacturer_part_number,
        item.manufacturer_part_name,
        item.manufacturer_part_name_en,
        item.manufacturer_part_name_ru,
        item.drawing_number AS bom_drawing_number,
        item.quantity,
        NULL AS oem_part_id,
        item.catalog_position_id,
        item.title,
        NULL AS oem_part_number,
        NULL AS oem_part_name,
        catalog.display_name AS catalog_position_name,
        catalog.position_code AS catalog_position_code,
        cp.id AS client_part_id,
        cp.client_id AS client_part_client_id,
        cp.classifier_node_id AS client_part_classifier_node_id,
        NULL AS base_oem_part_id,
        cp.relationship_type,
        cp.client_part_number,
        cp.revision_code,
        cp.drawing_number AS client_part_drawing_number,
        cp.display_name AS client_part_name,
        cp.description_ru AS client_part_description_ru,
        cp.difference_summary AS client_part_difference_summary,
        cp.uom AS client_part_uom,
        cp.material_note,
        cp.status AS client_part_status,
        cp.notes AS client_part_notes,
        cp.client_part_number_norm,
        cp.created_at AS client_part_created_at,
        cp.updated_at AS client_part_updated_at,
        classifier.name AS client_part_classifier_node_name,
        NULL AS base_oem_part_number,
        NULL AS base_oem_description_ru,
        NULL AS base_oem_manufacturer_name,
        COALESCE(doc_counts.documents_count, 0) AS client_part_documents_count
      FROM client_equipment_unit_bom_overrides override_row
      JOIN client_equipment_units unit ON unit.id = override_row.client_equipment_unit_id
      JOIN clients client ON client.id = unit.client_id
      JOIN equipment_model_bom_items item ON item.id = override_row.equipment_model_bom_item_id
      LEFT JOIN catalog_positions catalog ON catalog.id = item.catalog_position_id
      LEFT JOIN client_parts cp ON cp.id = override_row.client_part_id
      LEFT JOIN equipment_classifier_nodes classifier ON classifier.id = cp.classifier_node_id
      LEFT JOIN (
        SELECT client_part_id, COUNT(*) AS documents_count
        FROM client_part_documents
        GROUP BY client_part_id
      ) doc_counts ON doc_counts.client_part_id = cp.id
      WHERE unit.equipment_model_id = ?
        AND item.equipment_model_id = ?
        AND override_row.status <> 'as_original'
      ORDER BY client.company_name ASC, unit.id ASC, item.sort_order ASC, item.id ASC
      `,
      [id, id]
    )

    res.json({
      model_id: id,
      rows: rows.map((row) => ({
        ...row,
        quantity: formatBomQuantity(row.quantity),
      })),
    })
  } catch (err) {
    console.error('GET /equipment-models/:id/client-executions error:', err)
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
      'Тип строки',
      'Связь',
      '№ позиции',
      'Каталожный номер',
      'Название EN',
      'Название RU',
      'Чертеж',
      'Код классификатора',
      'Название позиции классификатора',
      'ID клиентской детали',
      'Название',
      'Количество',
      'Заметки',
    ]
    const exampleRows = [
      [1, 'adjustment-ring', '', 'сборка', '', 2, '1093080129', 'Adjustment Ring', 'Регулировочное кольцо', '', '', '', '', '', 1, ''],
      [2, 'clamping-cylinders', 'adjustment-ring', 'сборка', '', '', '1093070001', 'Clamping cylinders', 'Зажимные цилиндры', '', '', '', '', '', 1, ''],
      [2, 'metso-bolt-m20x80', 'adjustment-ring', 'деталь', 'классификатор', 14, 'METSO-HEX-M20X80', 'Hex bolt M20x80', 'Болт шестигранный M20x80', '', 'HEX-BOLT-M20X80-10.9-DIN931', '', '', '', 12, 'Metso дал свой номер обычному болту'],
      [1, 'power-unit', '', 'сборка', '', 36, 'MM0275088', 'Power Unit', 'Гидростанция', '', '', '', '', '', 1, ''],
      [2, 'wiring-schematic', 'power-unit', 'документ', '', '', '10P0806212', 'Wiring Schematic', 'Электрическая схема', '', '', '', '', '', 1, 'Не закупочная деталь, а документ в каталоге'],
      [1, 'client-drawing-part', '', 'деталь', 'client_part', '', '', '', 'Втулка по чертежу клиента', '', '', '', 123, '', 1, 'Если деталь уже создана по чертежу клиента'],
    ]

    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...exampleRows])
    sheet['!cols'] = [
      { wch: 10 },
      { wch: 26 },
      { wch: 26 },
      { wch: 18 },
      { wch: 18 },
      { wch: 12 },
      { wch: 24 },
      { wch: 34 },
      { wch: 34 },
      { wch: 20 },
      { wch: 22 },
      { wch: 34 },
      { wch: 18 },
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
      ['Тип строки', 'Что это по смыслу: сборка, деталь, комплект, документ, услуга, материал.'],
      ['Связь', 'Можно оставить пустой. Допустимо: классификатор, client_part. Если пусто, система создаст/использует карточку позиции из строки каталога производителя.'],
      ['№ позиции', 'Номер позиции на чертеже или в таблице BOM производителя: 1, 2, 3, 14A.'],
      ['Каталожный номер', 'Номер производителя в этой BOM-строке. Может быть номером сборки или номером детали.'],
      ['Название EN', 'Английское название из parts book производителя. Если источник только русский, можно оставить пустым.'],
      ['Название RU', 'Русское название или перевод для будущего переключателя языка. Можно заполнить позже.'],
      ['Чертеж', 'Номер чертежа или документа, если отличается от каталожного номера.'],
      ['Код классификатора', 'Если уже понятно, что это за позиция в классификаторе: например HEX-BOLT-M20X80-10.9-DIN931.'],
      ['Название позиции классификатора', 'Можно указать вместо кода классификатора, если название в системе совпадает точно.'],
      ['ID клиентской детали', 'Для детали по чертежу клиента, если она уже заведена в системе.'],
      ['Название', 'Системное название, если отличается от названия по каталогу.'],
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
            (equipment_model_id, parent_item_id, row_kind, item_type, item_no, manufacturer_part_number,
             manufacturer_part_name, manufacturer_part_name_en, manufacturer_part_name_ru, drawing_number,
             oem_part_id, catalog_position_id, client_part_id, title, quantity, sort_order, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            modelId,
            parentId,
            row.row_kind,
            row.item_type,
            row.item_no || null,
            row.manufacturer_part_number || row.oem_part_number || null,
            row.manufacturer_part_name || row.manufacturer_part_name_en || row.manufacturer_part_name_ru || null,
            row.manufacturer_part_name_en || row.manufacturer_part_name || null,
            row.manufacturer_part_name_ru || null,
            row.drawing_number || null,
            null,
            row.catalog_position_id || null,
            row.client_part_id || null,
            row.item_type === 'group'
              ? (row.title || row.manufacturer_part_name_en || row.manufacturer_part_name_ru || row.manufacturer_part_name || row.manufacturer_part_number)
              : null,
            row.quantity,
            row.sort_order,
            row.notes,
          ]
        )
        insertedIdsByKey.set(row.item_key, ins.insertId)
        if (!row.catalog_position_id && !row.client_part_id) {
          await ensureBomItemCatalogPosition(conn, modelId, ins.insertId)
        }
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
 * body: { parent_item_id?, row_kind?, item_type?, item_no?, manufacturer_part_number?,
 *         manufacturer_part_name?, manufacturer_part_name_en?, manufacturer_part_name_ru?, drawing_number?,
 *         catalog_position_id?, client_part_id?, title?, quantity?, notes? }
 */
router.post('/:id/bom/items', async (req, res) => {
  let conn
  try {
    const modelId = toId(req.params.id)
    if (!modelId) return res.status(400).json({ message: 'Некорректный идентификатор модели' })

    const parentItemId = toId(req.body.parent_item_id)
    const catalogPositionId = toId(req.body.catalog_position_id)
    const clientPartId = toId(req.body.client_part_id)
    const rowKind = normalizeBomRowKind(req.body.row_kind, 'assembly')
    const requestedItemType = normalizeBomImportType(req.body.item_type)
    const itemType = catalogPositionId
      ? 'catalog_position'
      : clientPartId
        ? 'client_part'
        : ['group', 'catalog_position', 'client_part', 'unlinked'].includes(requestedItemType)
          ? requestedItemType
          : rowKind === 'part'
            ? 'unlinked'
            : 'group'
    const itemNo = nz(req.body.item_no)
    const manufacturerPartNumber = nz(req.body.manufacturer_part_number)
    const manufacturerPartNameEn = nz(req.body.manufacturer_part_name_en)
    const manufacturerPartNameRu = nz(req.body.manufacturer_part_name_ru)
    const manufacturerPartName = nz(req.body.manufacturer_part_name) || manufacturerPartNameEn || manufacturerPartNameRu
    const drawingNumber = nz(req.body.drawing_number)
    const title = nz(req.body.title)
    const quantity = numOrNull(req.body.quantity) || 1
    const sortOrder = Number.isInteger(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0
    const notes = nz(req.body.notes)

    if (!catalogPositionId && !clientPartId && !title && !manufacturerPartName && !manufacturerPartNumber) {
      return res.status(400).json({ message: 'Нужно указать номер/название строки BOM или выбрать позицию' })
    }
    if ([catalogPositionId, clientPartId].filter(Boolean).length > 1) {
      return res.status(400).json({ message: 'В одной строке BOM можно выбрать только одну связанную карточку' })
    }
    if (quantity <= 0) {
      return res.status(400).json({ message: 'Количество должно быть больше нуля' })
    }

    const [[model]] = await db.execute('SELECT id, manufacturer_id FROM equipment_models WHERE id = ?', [modelId])
    if (!model) return res.status(404).json({ message: 'Модель не найдена' })

    if (catalogPositionId) {
      try {
        const position = await getSelectableCatalogPosition(catalogPositionId, modelId)
        if (!position) return res.status(400).json({ message: 'Позиция классификатора не найдена' })
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ message: err.message })
        throw err
      }
    }
    if (clientPartId) {
      const [clientParts] = await db.execute('SELECT id FROM client_parts WHERE id = ?', [clientPartId])
      if (!clientParts.length) return res.status(400).json({ message: 'Клиентская деталь не найдена' })
    }

    try {
      await assertBomParentIsValid({ modelId, parentItemId, catalogPositionId })
      await assertBomCatalogPositionPlaceIsUnique({ modelId, parentItemId, catalogPositionId })
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ message: err.message })
      throw err
    }

    if (!catalogPositionId && !clientPartId && manufacturerPartNumber) {
      const conflicts = await findCatalogPositionNumberConflicts({
        manufacturerPartNumber,
        manufacturerId: model.manufacturer_id,
      })
      if (conflicts.sameManufacturer.length) {
        return res.status(409).json({
          type: 'duplicate_part_number_same_manufacturer',
          message: `У производителя уже есть карточка с номером ${manufacturerPartNumber}. Выберите существующую карточку, а не создавайте дубль.`,
          duplicates: conflicts.sameManufacturer,
        })
      }
      if (conflicts.otherManufacturers.length && !req.body.confirm_duplicate_part_number) {
        return res.status(409).json({
          type: 'duplicate_part_number_other_manufacturer',
          message: `Номер ${manufacturerPartNumber} уже встречается у другого производителя. Подтвердите создание отдельной карточки для текущего производителя.`,
          duplicates: conflicts.otherManufacturers,
        })
      }
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `
      INSERT INTO equipment_model_bom_items
        (equipment_model_id, parent_item_id, row_kind, item_type, item_no, manufacturer_part_number,
         manufacturer_part_name, manufacturer_part_name_en, manufacturer_part_name_ru, drawing_number,
         oem_part_id, catalog_position_id, client_part_id, title, quantity, sort_order, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        modelId,
        parentItemId,
        rowKind,
        itemType,
        itemNo,
        manufacturerPartNumber,
        manufacturerPartName,
        manufacturerPartNameEn || manufacturerPartName,
        manufacturerPartNameRu,
        drawingNumber,
        null,
        catalogPositionId,
        clientPartId,
        title,
        quantity,
        sortOrder,
        notes,
      ]
    )

    if (!catalogPositionId && !clientPartId) {
      await ensureBomItemCatalogPosition(conn, modelId, ins.insertId)
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_model_bom_items',
      entity_id: ins.insertId,
      comment: 'Добавлена строка BOM модели',
    })

    await conn.commit()
    conn.release()
    conn = null

    const items = await fetchModelBomItems(modelId)
    res.status(201).json({ id: ins.insertId, model_id: modelId, items })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('POST /equipment-models/:id/bom/items error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) conn.release()
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
      `
      SELECT item.*, cp.source_kind AS old_catalog_source_kind
      FROM equipment_model_bom_items item
      LEFT JOIN catalog_positions cp ON cp.id = item.catalog_position_id
      WHERE item.id = ? AND item.equipment_model_id = ?
      `,
      [itemId, modelId]
    )
    if (!old) return res.status(404).json({ message: 'Строка BOM не найдена' })

    const parentItemId =
      req.body.parent_item_id !== undefined ? toId(req.body.parent_item_id) : old.parent_item_id
    const itemNo = req.body.item_no !== undefined ? nz(req.body.item_no) : old.item_no
    const rowKind =
      req.body.row_kind !== undefined ? normalizeBomRowKind(req.body.row_kind, old.row_kind || 'assembly') : old.row_kind
    const manufacturerPartNumber =
      req.body.manufacturer_part_number !== undefined ? nz(req.body.manufacturer_part_number) : old.manufacturer_part_number
    const manufacturerPartNameEn =
      req.body.manufacturer_part_name_en !== undefined ? nz(req.body.manufacturer_part_name_en) : old.manufacturer_part_name_en
    const manufacturerPartNameRu =
      req.body.manufacturer_part_name_ru !== undefined ? nz(req.body.manufacturer_part_name_ru) : old.manufacturer_part_name_ru
    const manufacturerPartName =
      req.body.manufacturer_part_name !== undefined ||
      req.body.manufacturer_part_name_en !== undefined ||
      req.body.manufacturer_part_name_ru !== undefined
        ? nz(req.body.manufacturer_part_name) || manufacturerPartNameEn || manufacturerPartNameRu
        : old.manufacturer_part_name
    const drawingNumber = req.body.drawing_number !== undefined ? nz(req.body.drawing_number) : old.drawing_number
    const title = req.body.title !== undefined ? nz(req.body.title) : old.title
    const quantity = req.body.quantity !== undefined ? numOrNull(req.body.quantity) : old.quantity
    const sortOrder =
      req.body.sort_order !== undefined && Number.isInteger(Number(req.body.sort_order))
        ? Number(req.body.sort_order)
        : old.sort_order
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : old.notes
    const catalogPositionId =
      req.body.catalog_position_id !== undefined ? toId(req.body.catalog_position_id) : old.catalog_position_id
    const requestedItemType = normalizeBomImportType(req.body.item_type)
    const itemType = catalogPositionId
      ? 'catalog_position'
      : old.client_part_id
        ? 'client_part'
        : ['group', 'catalog_position', 'client_part', 'unlinked'].includes(requestedItemType)
          ? requestedItemType
          : rowKind === 'part'
            ? 'unlinked'
            : 'group'

    if (!catalogPositionId && !old.client_part_id && !title && !manufacturerPartName && !manufacturerPartNumber) {
      return res.status(400).json({ message: 'Для строки BOM нужно название или каталожный номер' })
    }
    if (Number(quantity) <= 0) {
      return res.status(400).json({ message: 'Количество должно быть больше нуля' })
    }
    const [[model]] = await db.execute('SELECT id, manufacturer_id FROM equipment_models WHERE id = ?', [modelId])
    if (!model) return res.status(404).json({ message: 'Модель не найдена' })

    let selectedCatalogPosition = null
    if (catalogPositionId) {
      try {
        selectedCatalogPosition = await getSelectableCatalogPosition(catalogPositionId, modelId, itemId)
        if (!selectedCatalogPosition) return res.status(400).json({ message: 'Позиция классификатора не найдена' })
      } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ message: err.message })
        throw err
      }
    }

    try {
      await assertBomParentIsValid({ modelId, parentItemId, itemId, catalogPositionId })
      await assertBomCatalogPositionPlaceIsUnique({ modelId, parentItemId, catalogPositionId, itemId })
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ message: err.message })
      throw err
    }

    if (!catalogPositionId && !old.client_part_id && manufacturerPartNumber) {
      const conflicts = await findCatalogPositionNumberConflicts({
        manufacturerPartNumber,
        manufacturerId: model.manufacturer_id,
        excludeCatalogPositionId: old.catalog_position_id,
      })
      if (conflicts.sameManufacturer.length) {
        return res.status(409).json({
          type: 'duplicate_part_number_same_manufacturer',
          message: `У производителя уже есть карточка с номером ${manufacturerPartNumber}. Выберите существующую карточку, а не создавайте дубль.`,
          duplicates: conflicts.sameManufacturer,
        })
      }
      if (conflicts.otherManufacturers.length && !req.body.confirm_duplicate_part_number) {
        return res.status(409).json({
          type: 'duplicate_part_number_other_manufacturer',
          message: `Номер ${manufacturerPartNumber} уже встречается у другого производителя. Подтвердите создание отдельной карточки для текущего производителя.`,
          duplicates: conflicts.otherManufacturers,
        })
      }
    }

    await db.execute(
      `
      UPDATE equipment_model_bom_items
      SET parent_item_id = ?, row_kind = ?, item_type = ?, item_no = ?, manufacturer_part_number = ?,
          manufacturer_part_name = ?, manufacturer_part_name_en = ?, manufacturer_part_name_ru = ?,
          drawing_number = ?, catalog_position_id = ?, title = ?,
          quantity = ?, sort_order = ?, notes = ?
      WHERE id = ? AND equipment_model_id = ?
      `,
      [
        parentItemId || null,
        rowKind,
        itemType,
        itemNo,
        manufacturerPartNumber,
        manufacturerPartName,
        manufacturerPartNameEn,
        manufacturerPartNameRu,
        drawingNumber,
        catalogPositionId || null,
        title,
        quantity,
        sortOrder,
        notes,
        itemId,
        modelId,
      ]
    )

    if (!catalogPositionId && !old.client_part_id) {
      const conn = await db.getConnection()
      try {
        await conn.beginTransaction()
        await ensureBomItemCatalogPosition(conn, modelId, itemId)
        await conn.commit()
      } catch (err) {
        try {
          await conn.rollback()
        } catch {}
        throw err
      } finally {
        conn.release()
      }
    } else if (catalogPositionId && selectedCatalogPosition?.source_kind === 'model_bom' && !old.client_part_id) {
      await db.execute(
        `
        UPDATE catalog_positions
        SET manufacturer_part_number = COALESCE(?, manufacturer_part_number),
            display_name = COALESCE(?, display_name),
            display_name_en = COALESCE(?, display_name_en),
            display_name_ru = COALESCE(?, display_name_ru),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND source_kind = 'model_bom'
        `,
        [
          manufacturerPartNumber,
          manufacturerPartNameEn || manufacturerPartName || title,
          manufacturerPartNameEn || manufacturerPartName || title,
          manufacturerPartNameRu,
          catalogPositionId,
        ]
      )
    }

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
  let conn
  try {
    const modelId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!modelId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `
      SELECT item.*,
             em.model_name,
             man.name AS manufacturer_name
        FROM equipment_model_bom_items item
        JOIN equipment_models em ON em.id = item.equipment_model_id
        JOIN equipment_manufacturers man ON man.id = em.manufacturer_id
       WHERE item.id = ?
         AND item.equipment_model_id = ?
      `,
      [itemId, modelId]
    )
    if (!rows.length) return res.status(404).json({ message: 'Строка BOM не найдена' })

    const preview = await buildTrashPreview('equipment_model_bom_items', itemId)
    if (!preview) return res.status(404).json({ message: 'Строка BOM не найдена' })
    if (preview.mode !== MODE.RELATION_DELETE) {
      return res.status(409).json({
        message: preview.summary?.message || 'Удаление недоступно',
        preview,
      })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [subtreeRows] = await conn.execute(
      `
      WITH RECURSIVE bom_subtree AS (
        SELECT item.*, 0 AS depth
          FROM equipment_model_bom_items item
         WHERE item.id = ?
           AND item.equipment_model_id = ?
        UNION ALL
        SELECT child.*, parent.depth + 1 AS depth
          FROM equipment_model_bom_items child
          JOIN bom_subtree parent ON parent.id = child.parent_item_id
         WHERE child.equipment_model_id = ?
      )
      SELECT * FROM bom_subtree ORDER BY depth, sort_order, id
      `,
      [itemId, modelId, modelId]
    )

    const rootRow = rows[0]
    const modelTitle = `${rootRow.manufacturer_name || ''} ${rootRow.model_name || ''}`.trim()
    const rowTitle =
      rootRow.manufacturer_part_number ||
      rootRow.manufacturer_part_name ||
      rootRow.manufacturer_part_name_en ||
      rootRow.manufacturer_part_name_ru ||
      rootRow.title ||
      `BOM строка #${itemId}`

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'equipment_model_bom_items',
      entityId: itemId,
      rootEntityType: 'equipment_models',
      rootEntityId: modelId,
      deleteMode: 'relation_delete',
      title: rowTitle,
      subtitle: modelTitle || 'BOM модели',
      snapshot: {
        root: rootRow,
        subtree: subtreeRows,
      },
      context: {
        model_id: modelId,
        deleted_subtree_count: subtreeRows.length,
      },
    })

    let sortOrder = 0
    for (const subtreeRow of subtreeRows) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'equipment_model_bom_items',
        itemId: Number(subtreeRow.id),
        itemRole: Number(subtreeRow.id) === itemId ? 'deleted_root' : 'deleted_descendant',
        title:
          subtreeRow.manufacturer_part_number ||
          subtreeRow.manufacturer_part_name ||
          subtreeRow.manufacturer_part_name_en ||
          subtreeRow.manufacturer_part_name_ru ||
          subtreeRow.title ||
          `BOM строка #${subtreeRow.id}`,
        snapshot: subtreeRow,
        sortOrder: sortOrder++,
      })
    }

    await conn.execute('DELETE FROM equipment_model_bom_items WHERE id = ? AND equipment_model_id = ?', [
      itemId,
      modelId,
    ])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'equipment_model_bom_items',
      entity_id: itemId,
      old_value: String(trashEntryId),
      comment: 'Удалена строка BOM модели',
    })

    await conn.commit()
    const items = await fetchModelBomItems(modelId)
    res.json({ model_id: modelId, items, trash_entry_id: trashEntryId })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('DELETE /equipment-models/:id/bom/items/:itemId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) conn.release()
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
