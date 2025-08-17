// routes/equipmentModels.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// helpers
const nz = (v) => (v === undefined || v === null ? null : String(v).trim() || null)

//
// LIST (с фильтрами)
// GET /equipment-models?manufacturer_id=1&q=hp800
//
router.get('/', auth, async (req, res) => {
  try {
    const { manufacturer_id, q } = req.query
    const params = []
    const where = []
    let sql =
      'SELECT em.*, m.name AS manufacturer_name ' +
      'FROM equipment_models em ' +
      'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id'

    if (manufacturer_id !== undefined) {
      const mid = Number(manufacturer_id)
      if (!Number.isFinite(mid)) {
        return res.status(400).json({ message: 'manufacturer_id должен быть числом' })
      }
      where.push('em.manufacturer_id = ?')
      params.push(mid)
    }

    if (q && String(q).trim() !== '') {
      where.push('em.model_name LIKE ?')
      params.push(`%${q.trim()}%`)
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY m.name, em.model_name'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении моделей:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// READ ONE
// GET /equipment-models/:id
//
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      'SELECT em.*, m.name AS manufacturer_name ' +
      'FROM equipment_models em ' +
      'JOIN equipment_manufacturers m ON m.id = em.manufacturer_id ' +
      'WHERE em.id=?',
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Модель не найдена' })
    res.json(rows[0])
  } catch (err) {
    console.error('Ошибка при получении модели:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// CREATE
// POST /equipment-models
// body: { manufacturer_id, model_name }
//
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const manufacturer_id = Number(req.body.manufacturer_id)
    const model_name = nz(req.body.model_name)

    if (!Number.isFinite(manufacturer_id)) {
      return res.status(400).json({ message: 'manufacturer_id обязателен и должен быть числом' })
    }
    if (!model_name) {
      return res.status(400).json({ message: 'model_name обязателен' })
    }

    // проверим существование производителя
    const [man] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id=?', [manufacturer_id])
    if (!man.length) return res.status(400).json({ message: 'Указанный производитель не найден' })

    await db.execute(
      'INSERT INTO equipment_models (manufacturer_id, model_name) VALUES (?,?)',
      [manufacturer_id, model_name]
    )

    const [row] = await db.execute('SELECT * FROM equipment_models WHERE id = LAST_INSERT_ID()')
    res.status(201).json(row[0])
  } catch (err) {
    console.error('Ошибка при добавлении модели:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// UPDATE
// PUT /equipment-models/:id
// body: { manufacturer_id?, model_name? }
//
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const manufacturer_id =
      req.body.manufacturer_id !== undefined ? Number(req.body.manufacturer_id) : undefined
    const model_name = nz(req.body.model_name)

    const [exists] = await db.execute('SELECT id FROM equipment_models WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Модель не найдена' })

    if (manufacturer_id !== undefined) {
      if (!Number.isFinite(manufacturer_id)) {
        return res.status(400).json({ message: 'manufacturer_id должен быть числом' })
      }
      const [man] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id=?', [manufacturer_id])
      if (!man.length) return res.status(400).json({ message: 'Указанный производитель не найден' })
    }

    await db.execute(
      'UPDATE equipment_models ' +
      'SET manufacturer_id = COALESCE(?, manufacturer_id), ' +
      '    model_name      = COALESCE(?, model_name) ' +
      'WHERE id=?',
      [manufacturer_id, model_name, id]
    )

    const [row] = await db.execute('SELECT * FROM equipment_models WHERE id=?', [id])
    res.json(row[0])
  } catch (err) {
    console.error('Ошибка при обновлении модели:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// DELETE
// DELETE /equipment-models/:id
//
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT id FROM equipment_models WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Модель не найдена' })

    try {
      await db.execute('DELETE FROM equipment_models WHERE id=?', [id])
      res.json({ message: 'Модель удалена' })
    } catch (fkErr) {
      console.error('FK error:', fkErr)
      // если на модель ссылаются original_parts (или другие таблицы) — вернём конфликт
      return res.status(409).json({ message: 'Удаление невозможно: есть связанные записи' })
    }
  } catch (err) {
    console.error('Ошибка при удалении модели:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
