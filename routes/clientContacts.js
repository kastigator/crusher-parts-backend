// routes/clientContacts.js
const express = require('express')
const db = require('../utils/db')
const router = express.Router()

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)
const isNum = (v) => {
  if (v === '' || v === undefined || v === null) return false
  const n = Number(v)
  return Number.isFinite(n)
}
const bool = (v) => (v ? 1 : 0)

router.get('/etag', async (req, res) => {
  try {
    const clientId =
      req.query.client_id !== undefined ? Number(req.query.client_id) : null
    if (clientId !== null && !Number.isFinite(clientId)) {
      return res.status(400).json({ message: 'client_id must be numeric' })
    }

    const base =
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(version),0) AS sum_ver FROM client_contacts'
    const sql = clientId === null ? base : `${base} WHERE client_id=?`
    const params = clientId === null ? [] : [clientId]

    const [rows] = await db.execute(sql, params)
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /client-contacts/etag error', e)
    res.status(500).json({ message: 'Ошибка получения etag' })
  }
})

router.get('/', async (req, res) => {
  try {
    const { client_id } = req.query
    const params = []
    let sql = 'SELECT * FROM client_contacts'

    if (client_id !== undefined) {
      if (!isNum(client_id)) {
        return res.status(400).json({ message: 'client_id must be numeric' })
      }
      sql += ' WHERE client_id=?'
      params.push(Number(client_id))
    }

    sql += ' ORDER BY is_primary DESC, created_at DESC, id DESC'
    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('GET /client-contacts error', e)
    res.status(500).json({ message: 'Ошибка получения контактов' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'id must be numeric' })
    }

    const [rows] = await db.execute('SELECT * FROM client_contacts WHERE id=?', [id])
    if (!rows.length) {
      return res.status(404).json({ message: 'Контакт не найден' })
    }
    res.json(rows[0])
  } catch (e) {
    console.error('GET /client-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка получения контакта' })
  }
})

router.post('/', async (req, res) => {
  const { client_id, name, role, email, phone, is_primary, notes } = req.body || {}

  if (!isNum(client_id)) {
    return res.status(400).json({ message: 'client_id must be numeric' })
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  const cid = Number(client_id)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO client_contacts
         (client_id,name,role,email,phone,is_primary,notes)
       VALUES (?,?,?,?,?,?,?)`,
      [cid, name.trim(), nz(role), nz(email), nz(phone), bool(is_primary), nz(notes)]
    )

    if (bool(is_primary)) {
      await conn.execute(
        `UPDATE client_contacts
           SET is_primary=0, version=version+1, updated_at=NOW()
         WHERE client_id=? AND id<>? AND is_primary=1`,
        [cid, ins.insertId]
      )
    }

    const [row] = await conn.execute(
      'SELECT * FROM client_contacts WHERE id=?',
      [ins.insertId]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'clients',
      entity_id: cid,
      comment: 'Добавлен контакт клиента',
    })

    await conn.commit()
    res.status(201).json(row[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /client-contacts error', e)
    res.status(500).json({ message: 'Ошибка добавления контакта' })
  } finally {
    conn.release()
  }
})

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { version } = req.body || {}

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  const fields = ['name', 'role', 'email', 'phone', 'is_primary', 'notes']
  const set = []
  const vals = []

  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      const v = f === 'is_primary' ? bool(req.body[f]) : nz(req.body[f])
      set.push(`\`${f}\`=?`)
      vals.push(v)
    }
  }

  if (!set.length) return res.json({ message: 'Нет изменений' })

  set.push('version = version + 1')
  set.push('updated_at = NOW()')

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM client_contacts WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Контакт не найден' })
    }

    const old = oldRows[0]
    if (Number(old.version) !== Number(version)) {
      await conn.rollback()
      return res.status(409).json({ message: 'Версия устарела', current: old })
    }

    const [upd] = await conn.execute(
      `UPDATE client_contacts SET ${set.join(', ')} WHERE id=?`,
      [...vals, id]
    )

    if (req.body.is_primary) {
      await conn.execute(
        `UPDATE client_contacts
           SET is_primary=0, version=version+1, updated_at=NOW()
         WHERE client_id=? AND id<>? AND is_primary=1`,
        [old.client_id, id]
      )
    }

    const [freshRows] = await conn.execute('SELECT * FROM client_contacts WHERE id=?', [id])
    const fresh = freshRows[0]

    await logFieldDiffs({
      req,
      entity_type: 'clients',
      entity_id: old.client_id,
      action: 'update',
      before: old,
      after: fresh,
    })

    await conn.commit()
    res.json(fresh)
  } catch (e) {
    await conn.rollback()
    console.error('PUT /client-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка обновления контакта' })
  } finally {
    conn.release()
  }
})

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { version } = req.query || {}

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM client_contacts WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Контакт не найден' })
    }

    const old = oldRows[0]
    if (version !== undefined && Number(old.version) !== Number(version)) {
      await conn.rollback()
      return res.status(409).json({ message: 'Версия устарела', current: old })
    }

    await conn.execute('DELETE FROM client_contacts WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'clients',
      entity_id: old.client_id,
      comment: `Удален контакт клиента: ${old.name}`,
    })

    await conn.commit()
    res.json({ success: true })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /client-contacts/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления контакта' })
  } finally {
    conn.release()
  }
})

module.exports = router
