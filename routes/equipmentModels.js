// routes/equipmentModels.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// helpers
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * LIST
 * GET /equipment-models?manufacturer_id=1&q=hp800
 */
router.get('/', auth, async (req, res) => {
  try {
    const q = nz(req.query.q)
    const midRaw = req.query.manufacturer_id
    const params = []
    const where = []

    let sql =
      'SELECT em.*, m.name AS manufacturer_name ' +
      'FROM equipment_models em ' +
      'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id'

    if (midRaw !== undefined) {
      const mid = toId(midRaw)
      if (!mid) return res.status(400).json({ message: 'manufacturer_id должен быть числом' })
      where.push('em.manufacturer_id = ?')
      params.push(mid)
    }

    if (q) {
      where.push('em.model_name LIKE ?')
      params.push(`%${q}%`)
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
router.get('/:id', auth, async (req, res) => {
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
    if (!rows.length) return res.status(404).json({ message: 'Модель не найдена' })
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
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const manufacturer_id = toId(req.body.manufacturer_id)
    const model_name = nz(req.body.model_name)

    if (!manufacturer_id) {
      return res.status(400).json({ message: 'manufacturer_id обязателен и должен быть числом' })
    }
    if (!model_name) {
      return res.status(400).json({ message: 'model_name обязателен' })
    }

    // проверим, что производитель существует
    const [man] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id = ?', [manufacturer_id])
    if (!man.length) return res.status(400).json({ message: 'Указанный производитель не найден' })

    const [ins] = await db.execute(
      'INSERT INTO equipment_models (manufacturer_id, model_name) VALUES (?, ?)',
      [manufacturer_id, model_name]
    )

    const [row] = await db.execute('SELECT * FROM equipment_models WHERE id = ?', [ins.insertId])
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
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Модель не найдена' })

    const manufacturer_id =
      req.body.manufacturer_id !== undefined ? toId(req.body.manufacturer_id) : undefined
    const model_name = nz(req.body.model_name)

    if (manufacturer_id !== undefined && !manufacturer_id) {
      return res.status(400).json({ message: 'manufacturer_id должен быть числом' })
    }
    if (manufacturer_id !== undefined) {
      const [man] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id = ?', [manufacturer_id])
      if (!man.length) return res.status(400).json({ message: 'Указанный производитель не найден' })
    }

    await db.execute(
      `UPDATE equipment_models
          SET manufacturer_id = COALESCE(?, manufacturer_id),
              model_name      = COALESCE(?, model_name)
        WHERE id = ?`,
      [manufacturer_id, model_name, id]
    )

    const [row] = await db.execute('SELECT * FROM equipment_models WHERE id = ?', [id])
    res.json(row[0])
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
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Модель не найдена' })

    try {
      await db.execute('DELETE FROM equipment_models WHERE id = ?', [id])
      res.json({ message: 'Модель удалена' })
    } catch (fkErr) {
      // 1451 = ER_ROW_IS_REFERENCED_2
      if (fkErr && fkErr.errno === 1451) {
        return res.status(409).json({ type: 'fk_constraint', message: 'Удаление невозможно: есть связанные записи' })
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
