const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// helpers
const nz = (v) => (v === undefined || v === null ? null : String(v).trim() || null)

//
// LIST (с фильтром по поиску)
// GET /equipment-manufacturers?q=metso
//
router.get('/', auth, async (req, res) => {
  try {
    const { q } = req.query
    let sql = 'SELECT * FROM equipment_manufacturers'
    const params = []

    if (q && String(q).trim() !== '') {
      sql += ' WHERE name LIKE ? OR country LIKE ?'
      params.push(`%${q.trim()}%`, `%${q.trim()}%`)
    }

    sql += ' ORDER BY name'
    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении производителей:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// READ ONE
// GET /equipment-manufacturers/:id
//
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const [rows] = await db.execute('SELECT * FROM equipment_manufacturers WHERE id=?', [id])
    if (!rows.length) return res.status(404).json({ message: 'Производитель не найден' })
    res.json(rows[0])
  } catch (err) {
    console.error('Ошибка при получении производителя:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// CREATE
// POST /equipment-manufacturers
// body: { name, country?, website?, notes? }
//
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const name = nz(req.body.name)
    const country = nz(req.body.country)
    const website = nz(req.body.website)
    const notes = nz(req.body.notes)

    if (!name) return res.status(400).json({ message: 'Поле name обязательно' })

    await db.execute(
      'INSERT INTO equipment_manufacturers (name, country, website, notes) VALUES (?,?,?,?)',
      [name, country, website, notes]
    )

    // вернём созданную запись
    const [row] = await db.execute('SELECT * FROM equipment_manufacturers WHERE id = LAST_INSERT_ID()')
    res.status(201).json(row[0])
  } catch (err) {
    console.error('Ошибка при добавлении производителя:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// UPDATE
// PUT /equipment-manufacturers/:id
// body: { name?, country?, website?, notes? }
//
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const name = nz(req.body.name)
    const country = nz(req.body.country)
    const website = nz(req.body.website)
    const notes = nz(req.body.notes)

    const [exists] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Производитель не найден' })

    await db.execute(
      'UPDATE equipment_manufacturers SET name=COALESCE(?, name), country=COALESCE(?, country), website=COALESCE(?, website), notes=COALESCE(?, notes) WHERE id=?',
      [name, country, website, notes, id]
    )

    const [row] = await db.execute('SELECT * FROM equipment_manufacturers WHERE id=?', [id])
    res.json(row[0])
  } catch (err) {
    console.error('Ошибка при обновлении производителя:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// DELETE
// DELETE /equipment-manufacturers/:id
//
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)

    const [exists] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Производитель не найден' })

    // попытка удаления (модели удалятся каскадом, если в БД так задано; если FK на другие таблицы мешает — вернём 409)
    try {
      await db.execute('DELETE FROM equipment_manufacturers WHERE id=?', [id])
      res.json({ message: 'Производитель удалён' })
    } catch (fkErr) {
      console.error('FK error:', fkErr)
      return res.status(409).json({ message: 'Удаление невозможно: есть связанные записи' })
    }
  } catch (err) {
    console.error('Ошибка при удалении производителя:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
