const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)

router.get('/', async (req, res) => {
  try {
    const { supplier_id } = req.query
    const params = []
    let sql = 'SELECT * FROM supplier_contacts'
    if (supplier_id) { sql += ' WHERE supplier_id=?'; params.push(Number(supplier_id)) }
    sql += ' ORDER BY is_primary DESC, id DESC'
    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-contacts error', e)
    res.status(500).json({ message: 'Ошибка получения контактов' })
  }
})

router.get('/:id', async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [req.params.id])
  if (!rows.length) return res.status(404).json({ message: 'Контакт не найден' })
  res.json(rows[0])
})

router.post('/', auth, async (req, res) => {
  const { supplier_id, name, role, email, phone, is_primary, notes } = req.body
  if (!supplier_id) return res.status(400).json({ message: 'supplier_id обязателен' })
  if (!name || !name.trim()) return res.status(400).json({ message: 'name обязателен' })

  try {
    const [ins] = await db.execute(
      `INSERT INTO supplier_contacts (supplier_id,name,role,email,phone,is_primary,notes)
       VALUES (?,?,?,?,?,?,?)`,
      [Number(supplier_id), name.trim(), nz(role), nz(email), nz(phone), is_primary ? 1 : 0, nz(notes)]
    )
    await logActivity({ req, action: 'create', entity_type: 'supplier_contacts', entity_id: ins.insertId })
    const [row] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [ins.insertId])
    res.status(201).json(row[0])
  } catch (e) {
    console.error('POST /supplier-contacts error', e)
    res.status(500).json({ message: 'Ошибка добавления контакта' })
  }
})

router.put('/:id', auth, async (req, res) => {
  const { updated_at } = req.body
  if (!updated_at) return res.status(400).json({ message: 'Отсутствует updated_at' })

  const fields = ['name','role','email','phone','is_primary','notes']
  const set = []
  const vals = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      set.push(`\`${f}\`=?`)
      vals.push(f === 'is_primary' ? (req.body[f] ? 1 : 0) : nz(req.body[f]))
    }
  }
  if (!set.length) return res.json({ message: 'Нет изменений' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_contacts WHERE id=?', [req.params.id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Контакт не найден' })
    }
    const oldData = oldRows[0]

    const [upd] = await conn.execute(
      `UPDATE supplier_contacts SET ${set.join(', ')} WHERE id=? AND updated_at=?`,
      [...vals, req.params.id, updated_at]
    )
    if (!upd.affectedRows) {
      await conn.rollback()
      return res.status(409).json({ message: 'Появились новые изменения. Обновите данные.' })
    }

    const [fresh] = await conn.execute('SELECT * FROM supplier_contacts WHERE id=?', [req.params.id])

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'supplier_contacts',
      entity_id: Number(req.params.id)
    })

    await conn.commit()
    res.json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('PUT /supplier-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка обновления контакта' })
  } finally {
    conn.release()
  }
})

router.delete('/:id', auth, async (req, res) => {
  try {
    const [old] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [req.params.id])
    if (!old.length) return res.status(404).json({ message: 'Контакт не найден' })
    await db.execute('DELETE FROM supplier_contacts WHERE id=?', [req.params.id])
    await logActivity({ req, action: 'delete', entity_type: 'supplier_contacts', entity_id: Number(req.params.id) })
    res.json({ message: 'Контакт удалён' })
  } catch (e) {
    console.error('DELETE /supplier-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления контакта' })
  }
})

module.exports = router
