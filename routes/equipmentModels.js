// routes/equipmentModels.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const auth = require('../middleware/authMiddleware')
const checkTabAccess = require('../middleware/checkTabAccess')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// Вкладка оборудования (models + manufacturers): tabs.path
const TAB_PATH = '/equipment-models'
const tabGuard = checkTabAccess(TAB_PATH)

// ------------------------------
// helpers
// ------------------------------
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const normLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}
const normOffset = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

// Применяем авторизацию и доступ по вкладке ко всем ручкам
router.use(auth, tabGuard)

/**
 * LIST
 * GET /equipment-models?manufacturer_id=1&q=hp800&limit=200&offset=0
 */
router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const midRaw = req.query.manufacturer_id
    const limit = normLimit(req.query.limit, 200, 1000)
    const offset = normOffset(req.query.offset)

    const params = []
    const where = []

    let sql =
      'SELECT em.*, m.name AS manufacturer_name ' +
      'FROM equipment_models em ' +
      'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id'

    if (midRaw !== undefined) {
      const mid = toId(midRaw)
      if (!mid)
        return res
          .status(400)
          .json({ message: 'manufacturer_id должен быть числом' })
      where.push('em.manufacturer_id = ?')
      params.push(mid)
    }

    if (q) {
      where.push('em.model_name LIKE ?')
      params.push(`%${q}%`)
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY m.name, em.model_name LIMIT ? OFFSET ?'
    params.push(limit, offset)

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
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      'SELECT em.*, m.name AS manufacturer_name ' +
        'FROM equipment_models em ' +
        'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
        'WHERE em.id = ?',
      [id]
    )
    if (!rows.length)
      return res.status(404).json({ message: 'Модель не найдена' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /equipment-models/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/**
 * CREATE
 * POST /equipment-models
 * body: { manufacturer_id, model_name }
 */
router.post('/', async (req, res) => {
  try {
    const manufacturer_id = toId(req.body.manufacturer_id)
    const model_name = nz(req.body.model_name)

    if (!manufacturer_id) {
      return res.status(400).json({
        message: 'manufacturer_id обязателен и должен быть числом',
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
    if (!man.length)
      return res
        .status(400)
        .json({ message: 'Указанный производитель не найден' })

    const [ins] = await db.execute(
      'INSERT INTO equipment_models (manufacturer_id, model_name) VALUES (?, ?)',
      [manufacturer_id, model_name]
    )

    const [row] = await db.execute(
      'SELECT em.*, m.name AS manufacturer_name ' +
        'FROM equipment_models em ' +
        'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
        'WHERE em.id = ?',
      [ins.insertId]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_models',
      entity_id: ins.insertId,
      comment: 'Добавлена модель оборудования',
    })

    res.status(201).json(row[0])
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
 * body: { manufacturer_id?, model_name? }
 */
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [oldRows] = await db.execute(
      'SELECT * FROM equipment_models WHERE id = ?',
      [id]
    )
    if (!oldRows.length)
      return res.status(404).json({ message: 'Модель не найдена' })
    const old = oldRows[0]

    const manufacturer_id =
      req.body.manufacturer_id !== undefined
        ? toId(req.body.manufacturer_id)
        : undefined
    const model_name = nz(req.body.model_name)

    if (manufacturer_id !== undefined && !manufacturer_id) {
      return res
        .status(400)
        .json({ message: 'manufacturer_id должен быть числом' })
    }
    if (manufacturer_id !== undefined) {
      const [man] = await db.execute(
        'SELECT id FROM equipment_manufacturers WHERE id = ?',
        [manufacturer_id]
      )
      if (!man.length)
        return res
          .status(400)
          .json({ message: 'Указанный производитель не найден' })
    }

    await db.execute(
      `UPDATE equipment_models
          SET manufacturer_id = COALESCE(?, manufacturer_id),
              model_name      = COALESCE(?, model_name)
        WHERE id = ?`,
      [manufacturer_id, model_name, id]
    )

    const [freshRows] = await db.execute(
      'SELECT * FROM equipment_models WHERE id = ?',
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
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute(
      'SELECT * FROM equipment_models WHERE id = ?',
      [id]
    )
    if (!exists.length)
      return res.status(404).json({ message: 'Модель не найдена' })

    try {
      await db.execute('DELETE FROM equipment_models WHERE id = ?', [id])

      await logActivity({
        req,
        action: 'delete',
        entity_type: 'equipment_models',
        entity_id: id,
        comment: `Модель "${exists[0].model_name}" удалена`,
      })

      res.json({ message: 'Модель удалена' })
    } catch (fkErr) {
      // 1451 = ER_ROW_IS_REFERENCED_2
      if (fkErr && fkErr.errno === 1451) {
        return res.status(409).json({
          type: 'fk_constraint',
          message: 'Удаление невозможно: есть связанные записи',
        })
      }
      console.error('DELETE /equipment-models fk error:', fkErr)
      return res.status(500).json({ message: 'Ошибка при удалении' })
    }
  } catch (err) {
    console.error('DELETE /equipment-models/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
