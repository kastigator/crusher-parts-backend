// routes/equipmentManufacturers.js
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
const normCountry = (v) => {
  const s = nz(v)
  if (!s) return null
  const cc = s.toUpperCase()
  // допускаем 2–3 символа, чтобы не мешать "EU"/"FIN"; при желании ограничь до 2
  return cc.length <= 3 ? cc : cc.slice(0, 3)
}
const normWebsite = (v) => {
  const s = nz(v)
  if (!s) return null
  // простая нормализация: если нет протокола — добавим https://
  if (!/^https?:\/\//i.test(s)) return 'https://' + s
  return s
}

//
// LIST (поиск q)
// GET /equipment-manufacturers?q=metso
//
router.get('/', auth, async (req, res) => {
  try {
    const q = nz(req.query.q)
    let sql = 'SELECT * FROM equipment_manufacturers'
    const params = []

    if (q) {
      sql += ' WHERE name LIKE ? OR country LIKE ?'
      params.push(`%${q}%`, `%${q}%`)
    }

    sql += ' ORDER BY name'
    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /equipment-manufacturers error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// READ ONE
// GET /equipment-manufacturers/:id
//
router.get('/:id', auth, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute('SELECT * FROM equipment_manufacturers WHERE id=?', [id])
    if (!rows.length) return res.status(404).json({ message: 'Производитель не найден' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /equipment-manufacturers/:id error:', err)
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
    if (!name) return res.status(400).json({ message: 'Поле "name" обязательно' })

    const country = normCountry(req.body.country)
    const website = normWebsite(req.body.website)
    const notes = nz(req.body.notes)

    const [ins] = await db.execute(
      `INSERT INTO equipment_manufacturers (name, country, website, notes)
       VALUES (?,?,?,?)`,
      [name, country, website, notes]
    )

    const [row] = await db.execute('SELECT * FROM equipment_manufacturers WHERE id = ?', [ins.insertId])
    res.status(201).json(row[0])
  } catch (err) {
    // аккуратный ответ при дубле имени (если в БД стоит UNIQUE(name) — рекомендую)
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ type: 'duplicate', field: 'name', message: 'Такой производитель уже существует' })
    }
    console.error('POST /equipment-manufacturers error:', err)
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
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Производитель не найден' })

    const name = nz(req.body.name)
    const country = normCountry(req.body.country)
    const website = normWebsite(req.body.website)
    const notes = nz(req.body.notes)

    await db.execute(
      `UPDATE equipment_manufacturers
          SET name=COALESCE(?, name),
              country=COALESCE(?, country),
              website=COALESCE(?, website),
              notes=COALESCE(?, notes)
        WHERE id=?`,
      [name, country, website, notes, id]
    )

    const [row] = await db.execute('SELECT * FROM equipment_manufacturers WHERE id=?', [id])
    res.json(row[0])
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ type: 'duplicate', field: 'name', message: 'Такой производитель уже существует' })
    }
    console.error('PUT /equipment-manufacturers/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// DELETE
// DELETE /equipment-manufacturers/:id
//
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Производитель не найден' })

    try {
      await db.execute('DELETE FROM equipment_manufacturers WHERE id=?', [id])
      res.json({ message: 'Производитель удалён' })
    } catch (fkErr) {
      // 1451: ER_ROW_IS_REFERENCED_2 — ссылка FK мешает удалить
      if (fkErr && fkErr.errno === 1451) {
        return res.status(409).json({ type: 'fk_constraint', message: 'Невозможно удалить: есть связанные записи' })
      }
      console.error('DELETE /equipment-manufacturers fk error:', fkErr)
      return res.status(500).json({ message: 'Ошибка при удалении' })
    }
  } catch (err) {
    console.error('DELETE /equipment-manufacturers/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
