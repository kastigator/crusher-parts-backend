// routes/equipmentModels.js
const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
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
