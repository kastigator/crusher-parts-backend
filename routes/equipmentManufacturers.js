// routes/equipmentManufacturers.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const auth = require('../middleware/authMiddleware')
const checkTabAccess = require('../middleware/requireTabAccess')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// ВАЖНО: tabs.path для этой группы
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

const normCountry = (v) => {
  const s = nz(v)
  if (!s) return null
  const cc = s.toUpperCase()
  return cc.length <= 3 ? cc : cc.slice(0, 3) // допускаем 2–3 символа
}

const normWebsite = (v) => {
  const s = nz(v)
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) return 'https://' + s
  return s
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

//
// LIST (поиск q + пагинация)
// GET /equipment-manufacturers?q=metso&limit=200&offset=0
//
router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const limit = normLimit(req.query.limit, 200, 1000)
    const offset = normOffset(req.query.offset)

    let sql = 'SELECT * FROM equipment_manufacturers'
    const params = []

    if (q) {
      sql += ' WHERE name LIKE ? OR country LIKE ?'
      params.push(`%${q}%`, `%${q}%`)
    }

    sql += ' ORDER BY name LIMIT ? OFFSET ?'
    params.push(limit, offset)

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
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      'SELECT * FROM equipment_manufacturers WHERE id=?',
      [id]
    )
    if (!rows.length)
      return res.status(404).json({ message: 'Производитель не найден' })
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
router.post('/', async (req, res) => {
  try {
    const name = nz(req.body.name)
    if (!name)
      return res.status(400).json({ message: 'Поле "name" обязательно' })

    const country = normCountry(req.body.country)
    const website = normWebsite(req.body.website)
    const notes = nz(req.body.notes)

    const [ins] = await db.execute(
      `INSERT INTO equipment_manufacturers (name, country, website, notes)
       VALUES (?,?,?,?)`,
      [name, country, website, notes]
    )

    const [row] = await db.execute(
      'SELECT * FROM equipment_manufacturers WHERE id = ?',
      [ins.insertId]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_manufacturers',
      entity_id: ins.insertId,
      comment: 'Добавлен производитель оборудования',
    })

    res.status(201).json(row[0])
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate',
        field: 'name',
        message: 'Такой производитель уже существует',
      })
    }
    console.error('POST /equipment-manufacturers error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// UPDATE (без version, если столбца нет)
// PUT /equipment-manufacturers/:id
// body: { name?, country?, website?, notes? }
//
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [oldRows] = await db.execute(
      'SELECT * FROM equipment_manufacturers WHERE id=?',
      [id]
    )
    if (!oldRows.length)
      return res.status(404).json({ message: 'Производитель не найден' })
    const old = oldRows[0]

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

    const [freshRows] = await db.execute(
      'SELECT * FROM equipment_manufacturers WHERE id=?',
      [id]
    )
    const fresh = freshRows[0]

    await logFieldDiffs({
      req,
      entity_type: 'equipment_manufacturers',
      entity_id: id,
      oldData: old,
      newData: fresh,
    })

    res.json(fresh)
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate',
        field: 'name',
        message: 'Такой производитель уже существует',
      })
    }
    console.error('PUT /equipment-manufacturers/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

//
// DELETE
// DELETE /equipment-manufacturers/:id
//
router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute(
      'SELECT * FROM equipment_manufacturers WHERE id=?',
      [id]
    )
    if (!exists.length)
      return res.status(404).json({ message: 'Производитель не найден' })

    try {
      await db.execute('DELETE FROM equipment_manufacturers WHERE id=?', [id])

      await logActivity({
        req,
        action: 'delete',
        entity_type: 'equipment_manufacturers',
        entity_id: id,
        comment: `Производитель "${exists[0].name}" удалён`,
      })

      res.json({ message: 'Производитель удалён' })
    } catch (fkErr) {
      // 1451: ER_ROW_IS_REFERENCED_2 — запись используется FK
      if (fkErr && fkErr.errno === 1451) {
        return res.status(409).json({
          type: 'fk_constraint',
          message: 'Невозможно удалить: есть связанные записи',
        })
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
