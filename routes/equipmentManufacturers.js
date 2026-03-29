// routes/equipmentManufacturers.js
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

// ------------------------------
// LIST (поиск q, без пагинации — возвращаем весь список)
// GET /equipment-manufacturers?q=metso
// ------------------------------
router.get('/', async (req, res) => {
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

// ------------------------------
// READ ONE
// GET /equipment-manufacturers/:id
// ------------------------------
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

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

// ------------------------------
// CREATE
// POST /equipment-manufacturers
// body: { name, country?, website?, notes? }
// ------------------------------
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

    const [rows] = await db.execute(
      'SELECT * FROM equipment_manufacturers WHERE id = ?',
      [ins.insertId]
    )
    const row = rows[0]

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_manufacturers',
      entity_id: ins.insertId,
      comment: 'Добавлен производитель оборудования',
    })

    res.status(201).json(row)
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

// ------------------------------
// UPDATE
// PUT /equipment-manufacturers/:id
// body: { name?, country?, website?, notes? }
// ------------------------------
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

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
          SET name    = COALESCE(?, name),
              country = COALESCE(?, country),
              website = COALESCE(?, website),
              notes   = COALESCE(?, notes)
        WHERE id = ?`,
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

// ------------------------------
// DELETE
// DELETE /equipment-manufacturers/:id
// ------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [exists] = await db.execute(
      'SELECT * FROM equipment_manufacturers WHERE id=?',
      [id]
    )
    if (!exists.length)
      return res.status(404).json({ message: 'Производитель не найден' })

    const preview = await buildTrashPreview('equipment_manufacturers', id)
    if (!preview) return res.status(404).json({ message: 'Производитель не найден' })
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
        entityType: 'equipment_manufacturers',
        entityId: id,
        rootEntityType: 'equipment_manufacturers',
        rootEntityId: id,
        deleteMode: 'trash',
        title: exists[0].name || `Производитель #${id}`,
        subtitle: 'Производитель оборудования',
        snapshot: exists[0],
      })

      await conn.execute('DELETE FROM equipment_manufacturers WHERE id=?', [id])

      await logActivity({
        req,
        action: 'delete',
        entity_type: 'equipment_manufacturers',
        entity_id: id,
        comment: `Производитель "${exists[0].name}" удалён`,
        new_value: { trash_entry_id: trashEntryId },
      })

      await conn.commit()
      res.json({ message: 'Производитель перемещён в корзину', trash_entry_id: trashEntryId })
    } catch (fkErr) {
      try {
        await conn.rollback()
      } catch {}
      console.error('DELETE /equipment-manufacturers fk error:', fkErr)
      return res.status(500).json({ message: 'Ошибка при удалении' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('DELETE /equipment-manufacturers/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
