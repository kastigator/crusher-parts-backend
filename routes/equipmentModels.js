// routes/equipmentModels.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { createTrashEntry } = require('../utils/trashStore')
const { buildTrashPreview, MODE } = require('../utils/trashPreview')

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
      'SELECT em.*, m.name AS manufacturer_name, ecn.name AS classifier_node_name ' +
      'FROM equipment_models em ' +
      'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
      'LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id'

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
      'SELECT em.*, m.name AS manufacturer_name, ecn.name AS classifier_node_name ' +
        'FROM equipment_models em ' +
        'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
        'LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id ' +
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

/**
 * CREATE
 * POST /equipment-models
 * body: { manufacturer_id, model_name, classifier_node_id?, model_code?, notes? }
 */
router.post('/', async (req, res) => {
  try {
    const manufacturer_id = toId(req.body.manufacturer_id)
    const model_name = nz(req.body.model_name)
    const classifier_node_id =
      req.body.classifier_node_id === undefined ? null : toId(req.body.classifier_node_id)
    const model_code = nz(req.body.model_code)
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

    if (req.body.classifier_node_id !== undefined && !classifier_node_id) {
      return res.status(400).json({ message: 'Некорректный классификатор оборудования' })
    }
    if (classifier_node_id) {
      const [classifier] = await db.execute(
        'SELECT id FROM equipment_classifier_nodes WHERE id = ?',
        [classifier_node_id]
      )
      if (!classifier.length) {
        return res.status(400).json({ message: 'Указанный узел классификатора не найден' })
      }
    }

    const [ins] = await db.execute(
      `INSERT INTO equipment_models
        (manufacturer_id, model_name, classifier_node_id, model_code, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [manufacturer_id, model_name, classifier_node_id, model_code, notes]
    )

    const [rows] = await db.execute(
      'SELECT em.*, m.name AS manufacturer_name, ecn.name AS classifier_node_name ' +
        'FROM equipment_models em ' +
        'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
        'LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id ' +
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
 * body: { manufacturer_id?, model_name?, classifier_node_id?, model_code?, notes? }
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
      req.body.classifier_node_id !== undefined
        ? (req.body.classifier_node_id === null || req.body.classifier_node_id === ''
            ? null
            : toId(req.body.classifier_node_id))
        : undefined
    const model_code = req.body.model_code !== undefined ? nz(req.body.model_code) : undefined
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : undefined

    if (manufacturer_id !== undefined && !manufacturer_id) {
      return res
        .status(400)
        .json({ message: 'Некорректный производитель' })
    }
    if (classifier_node_id !== undefined && req.body.classifier_node_id !== null && !classifier_node_id) {
      return res.status(400).json({ message: 'Некорректный классификатор оборудования' })
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
    if (classifier_node_id !== undefined && classifier_node_id !== null) {
      const [classifier] = await db.execute(
        'SELECT id FROM equipment_classifier_nodes WHERE id = ?',
        [classifier_node_id]
      )
      if (!classifier.length) {
        return res.status(400).json({ message: 'Указанный узел классификатора не найден' })
      }
    }

    await db.execute(
      `UPDATE equipment_models
          SET manufacturer_id = COALESCE(?, manufacturer_id),
              model_name      = COALESCE(?, model_name),
              classifier_node_id = ?,
              model_code      = COALESCE(?, model_code),
              notes           = COALESCE(?, notes)
        WHERE id = ?`,
      [
        sqlValue(manufacturer_id),
        sqlValue(model_name),
        classifier_node_id === undefined ? old.classifier_node_id : classifier_node_id,
        sqlValue(model_code),
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
