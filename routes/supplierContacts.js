// routes/supplierContacts.js
const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)
const isNum = (v) => Number.isFinite(Number(v))

/* ======================
   ETAG (для баннера изменений)
   ====================== */
// ВАЖНО: этот маршрут должен быть ДО '/:id'
router.get('/etag', auth, async (req, res) => {
  try {
    const supplierId = req.query.supplier_id !== undefined ? Number(req.query.supplier_id) : null
    if (supplierId !== null && !Number.isFinite(supplierId)) {
      return res.status(400).json({ message: 'supplier_id must be numeric' })
    }
    const base = `SELECT COUNT(*) AS cnt, COALESCE(SUM(version),0) AS sum_ver FROM supplier_contacts`
    const sql = supplierId === null ? base : `${base} WHERE supplier_id=?`
    const params = supplierId === null ? [] : [supplierId]
    const [rows] = await db.execute(sql, params)
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /supplier-contacts/etag error', e)
    res.status(500).json({ message: 'Ошибка получения etag' })
  }
})

/* ======================
   LIST
   ====================== */
router.get('/', auth, async (req, res) => {
  try {
    const { supplier_id } = req.query
    const params = []
    let sql = 'SELECT * FROM supplier_contacts'

    if (supplier_id !== undefined) {
      if (!isNum(supplier_id)) {
        return res.status(400).json({ message: 'supplier_id must be numeric' })
      }
      sql += ' WHERE supplier_id=?'
      params.push(Number(supplier_id))
    }

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
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })

    const [rows] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [id])
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
  const { supplier_id, name, role, email, phone, is_primary, notes } = req.body || {}

  if (!isNum(supplier_id)) return res.status(400).json({ message: 'supplier_id must be numeric' })
  if (!name || !name.trim()) return res.status(400).json({ message: 'Поле name обязательно' })

  const sid = Number(supplier_id)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO supplier_contacts (supplier_id,name,role,email,phone,is_primary,notes)
       VALUES (?,?,?,?,?,?,?)`,
      [sid, name.trim(), nz(role), nz(email), nz(phone), is_primary ? 1 : 0, nz(notes)]
    )

    if (is_primary) {
      // снимаем флаг у остальных + поднимаем version/updated_at
      await conn.execute(
        `UPDATE supplier_contacts
         SET is_primary=0, version=version+1, updated_at=NOW()
         WHERE supplier_id=? AND id<>? AND is_primary=1`,
        [sid, ins.insertId]
      )
    }

    const [row] = await conn.execute('SELECT * FROM supplier_contacts WHERE id=?', [ins.insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',     // агрегируем историю на поставщика
      entity_id: sid,
      comment: 'Добавлен контакт поставщика'
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

  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  const fields = ['name', 'role', 'email', 'phone', 'is_primary', 'notes']
  const set = []
  const vals = []

  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      const v = f === 'is_primary' ? (req.body[f] ? 1 : 0) : nz(req.body[f])
      set.push(`\`${f}\`=?`)
      vals.push(v)
    }
  }

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

    // не даём сохранить пустое имя
    const nextName = Object.prototype.hasOwnProperty.call(req.body, 'name')
      ? (req.body.name || '').trim()
      : (oldData.name || '').trim()
    if (!nextName) {
      await conn.rollback()
      return res.status(400).json({ message: 'Поле name обязательно' })
    }

    const [upd] = await conn.execute(
      `UPDATE supplier_contacts SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, Number(version)]
    )
    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM supplier_contacts WHERE id=?', [id])
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Появились новые изменения. Обновите данные.',
        current: currentRows[0] || null
      })
    }

    // если стал "Основной" — снимаем флаг у остальных (и поднимем их техполя)
    const becamePrimary =
      Object.prototype.hasOwnProperty.call(req.body, 'is_primary') ? (req.body.is_primary ? 1 : 0) : oldData.is_primary
    if (becamePrimary) {
      await conn.execute(
        `UPDATE supplier_contacts
         SET is_primary=0, version=version+1, updated_at=NOW()
         WHERE supplier_id=? AND id<>? AND is_primary=1`,
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
   DELETE (optional ?version=)
   ====================== */
router.delete('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })

  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'version must be numeric' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_contacts WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Контакт не найден' })
    }
    const old = oldRows[0]

    if (version !== undefined && version !== old.version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: old
      })
    }

    await conn.execute('DELETE FROM supplier_contacts WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: Number(old.supplier_id),
      comment: 'Удалён контакт поставщика'
    })

    await conn.commit()
    res.json({ message: 'Контакт удалён' })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /supplier-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления контакта' })
  } finally {
    conn.release()
  }
})

module.exports = router
