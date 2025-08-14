const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)

/* ======================
   LIST
   ====================== */
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

/* ======================
   GET ONE
   ====================== */
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ message: 'Контакт не найден' })
    res.json(rows[0])
  } catch (e) {
    console.error('GET /supplier-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка получения контакта' })
  }
})

/* ======================
   CREATE
   ====================== */
router.post('/', auth, async (req, res) => {
  const { supplier_id, name, role, email, phone, is_primary, notes } = req.body
  if (!supplier_id) return res.status(400).json({ message: 'supplier_id обязателен' })
  if (!name || !name.trim()) return res.status(400).json({ message: 'name обязателен' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO supplier_contacts (supplier_id,name,role,email,phone,is_primary,notes)
       VALUES (?,?,?,?,?,?,?)`,
      [Number(supplier_id), name.trim(), nz(role), nz(email), nz(phone), is_primary ? 1 : 0, nz(notes)]
    )

    // если отмечен как основной — снимем флаг у остальных контактов этого поставщика
    if (is_primary) {
      await conn.execute(
        `UPDATE supplier_contacts SET is_primary=0 WHERE supplier_id=? AND id<>?`,
        [Number(supplier_id), ins.insertId]
      )
    }

    const [row] = await conn.execute('SELECT * FROM supplier_contacts WHERE id=?', [ins.insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: Number(supplier_id),
      comment: 'Добавлен контакт поставщика',
      diff: row[0],
    })

    await conn.commit()
    res.status(201).json(row[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-contacts error', e)
    res.status(500).json({ message: 'Ошибка добавления контакта' })
  } finally {
    conn.release()
  }
})

/* ======================
   UPDATE (optimistic by version)
   ====================== */
router.put('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  const { version } = req.body || {}

  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Некорректный id' })
  if (version == null) return res.status(400).json({ message: 'Отсутствует version для проверки конфликтов' })

  const fields = ['name','role','email','phone','is_primary','notes']
  const set = []
  const vals = []
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      const v = (f === 'is_primary') ? (req.body[f] ? 1 : 0) : nz(req.body[f])
      set.push(`\`${f}\`=?`)
      vals.push(v)
    }
  }

  // если нет пользовательских полей — нет изменений
  if (!set.length) return res.json({ message: 'Нет изменений' })

  // техполя
  set.push('version = version + 1')
  set.push('updated_at = NOW()')

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_contacts WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Контакт не найден' })
    }
    const oldData = oldRows[0]

    // optimistic по version
    const [upd] = await conn.execute(
      `UPDATE supplier_contacts SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, version]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [id])
      return res.status(409).json({
        message: 'Появились новые изменения. Обновите данные.',
        current: currentRows[0],
      })
    }

    // если после апдейта контакт стал "Основной" — снимем флаг у остальных
    const becamePrimary =
      Object.prototype.hasOwnProperty.call(req.body, 'is_primary')
        ? (req.body.is_primary ? 1 : 0)
        : oldData.is_primary
    if (becamePrimary) {
      await conn.execute(
        `UPDATE supplier_contacts SET is_primary=0 WHERE supplier_id=? AND id<>?`,
        [oldData.supplier_id, id]
      )
    }

    const [fresh] = await conn.execute('SELECT * FROM supplier_contacts WHERE id=?', [id])

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'suppliers',
      entity_id: Number(fresh[0].supplier_id)
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

/* ======================
   DELETE
   ====================== */
router.delete('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Некорректный id' })

  try {
    const [old] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [id])
    if (!old.length) return res.status(404).json({ message: 'Контакт не найден' })

    await db.execute('DELETE FROM supplier_contacts WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: Number(old[0].supplier_id),
      comment: 'Удалён контакт поставщика'
    })

    res.json({ message: 'Контакт удалён' })
  } catch (e) {
    console.error('DELETE /supplier-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления контакта' })
  }
})

module.exports = router
