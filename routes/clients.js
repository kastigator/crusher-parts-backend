// routes/clients.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const authMiddleware = require('../middleware/authMiddleware')
const checkTabAccess = require('../middleware/checkTabAccess') // ✅ добавлено
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// Доступ по вкладке /clients
const tabGuard = checkTabAccess('/clients') // ✅ все операции с клиентами защищаем этой вкладкой

// ------------------------------
// helpers
// ------------------------------
const toNull = (v) => (v === '' || v === undefined ? null : v)
const toMysqlDateTime = (d) => {
  const pad = (n) => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  return `${y}-${m}-${day} ${h}:${mi}:${s}`
}
const normLimit = (v, def = 500, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}
const mustNum = (v, name = 'value') => {
  const n = Number(v)
  if (!Number.isFinite(n)) {
    const e = new Error(`${name} must be numeric`)
    e.status = 400
    throw e
  }
  return Math.trunc(n)
}

// =========================================================
// ЛОГИ (ЭТИ РОУТЫ ДОЛЖНЫ ИДТИ ПЕРЕД '/:id' И ДРУГИМИ)
// =========================================================

// Все удалённые записи по семейству клиентов (всем клиентам)
router.get('/logs/deleted', authMiddleware, tabGuard, async (req, res) => {
  const limit = normLimit(req.query.limit, 100, 500)
  try {
    const sql = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND (
          a.entity_type IN (
            'clients',
            'client_billing_addresses',
            'client_shipping_addresses',
            'client_bank_details'
          )
          OR a.client_id IS NOT NULL
        )
      ORDER BY a.created_at DESC
      LIMIT ${limit}
    `
    const [logs] = await db.execute(sql)
    console.log(`[clients/logs/deleted] rows: ${logs.length}`)
    res.json(logs)
  } catch (err) {
    console.error('Ошибка при загрузке удалённых логов (clients family):', err)
    res
      .status(500)
      .json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

// Объединённая история по одному клиенту: сам клиент + все дочерние
router.get('/:id/logs/combined', authMiddleware, tabGuard, async (req, res) => {
  try {
    const clientId = mustNum(req.params.id, 'id')
    const limit = normLimit(req.query.limit, 500, 1000)

    const sql = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ?
         OR (a.entity_type = 'clients' AND a.entity_id = ?)
      ORDER BY a.created_at DESC
      LIMIT ${limit}
    `
    const [logs] = await db.execute(sql, [clientId, clientId])
    console.log(`[clients/:id/logs/combined id=${clientId}] rows: ${logs.length}`)
    res.json(logs)
  } catch (err) {
    const code = err.status || 500
    if (code === 400) return res.status(400).json({ message: err.message })
    console.error('Ошибка при загрузке объединённых логов клиента:', err)
    res
      .status(500)
      .json({ message: 'Ошибка сервера при получении логов' })
  }
})

// Только удалённые по конкретному клиенту
router.get('/:id/logs/deleted', authMiddleware, tabGuard, async (req, res) => {
  try {
    const clientId = mustNum(req.params.id, 'id')
    const limit = normLimit(req.query.limit, 100, 500)

    const sql = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND (
              a.client_id = ?
           OR (a.entity_type = 'clients' AND a.entity_id = ?)
        )
      ORDER BY a.created_at DESC
      LIMIT ${limit}
    `
    const [logs] = await db.execute(sql, [clientId, clientId])
    console.log(`[clients/:id/logs/deleted id=${clientId}] rows: ${logs.length}`)
    res.json(logs)
  } catch (err) {
    const code = err.status || 500
    if (code === 400) return res.status(400).json({ message: err.message })
    console.error('Ошибка при загрузке удалённых логов клиента:', err)
    res
      .status(500)
      .json({ message: 'Ошибка сервера при получении логов' })
  }
})

// Старый маршрут — только по самой сущности clients
router.get('/:id/logs', authMiddleware, tabGuard, async (req, res) => {
  try {
    const clientId = mustNum(req.params.id, 'id')
    const action = req.query.action
      ? String(req.query.action).trim().toLowerCase()
      : null
    const field = req.query.field ? String(req.query.field).trim() : null
    const limit = normLimit(req.query.limit, 500, 1000)

    const allowed = new Set(['create', 'update', 'delete'])

    let sql = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'clients' AND a.entity_id = ?
    `
    const vals = [clientId]

    if (action) {
      if (!allowed.has(action)) {
        return res.status(400).json({ message: 'invalid action filter' })
      }
      sql += ' AND a.action = ?'
      vals.push(action)
    }
    if (field) {
      sql += ' AND a.field_changed = ?'
      vals.push(field)
    }

    sql += ` ORDER BY a.created_at DESC LIMIT ${limit}`

    const [rows] = await db.execute(sql, vals)
    console.log(`[clients/:id/logs id=${clientId}] rows: ${rows.length}`)
    res.json(rows)
  } catch (err) {
    const code = err.status || 500
    if (code === 400) return res.status(400).json({ message: err.message })
    console.error('Ошибка при получении логов клиента:', err)
    res.status(500).json({ message: 'Ошибка сервера при получении логов' })
  }
})

// =========================================================
// ПОЛУЧЕНИЕ СПИСКА / ПОЛЛИНГ / ETAG
// =========================================================

router.get('/', authMiddleware, tabGuard, async (_req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM clients ORDER BY id DESC')
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении клиентов:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/new', authMiddleware, tabGuard, async (req, res) => {
  const { after } = req.query
  if (!after) return res.status(400).json({ message: 'Missing "after" param' })

  let mysqlAfter = after
  try {
    const d = new Date(after)
    if (!Number.isNaN(d.getTime())) mysqlAfter = toMysqlDateTime(d)
  } catch (_) {}

  try {
    const [rows] = await db.execute(
      `
      SELECT id, company_name, created_at
      FROM clients
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 5
      `,
      [mysqlAfter]
    )
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter })
  } catch (e) {
    console.error('GET /clients/new error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

router.get('/etag', authMiddleware, tabGuard, async (_req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver FROM clients'
    )
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /clients/etag error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

// =========================================================
// CRUD
// =========================================================

router.post('/', authMiddleware, tabGuard, async (req, res) => {
  const {
    company_name,
    registration_number,
    tax_id,
    contact_person,
    phone,
    email,
    website,
    notes,
  } = req.body || {}

  if (!company_name?.trim()) {
    return res.status(400).json({ message: "Поле 'company_name' обязательно" })
  }

  try {
    const [ins] = await db.execute(
      `
      INSERT INTO clients
        (company_name, registration_number, tax_id, contact_person, phone, email, website, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        company_name.trim(),
        toNull(registration_number?.trim?.()),
        toNull(tax_id?.trim?.()),
        toNull(contact_person?.trim?.()),
        toNull(phone?.trim?.()),
        toNull(email?.trim?.()),
        toNull(website?.trim?.()),
        toNull(notes?.trim?.()),
      ]
    )

    const [fresh] = await db.execute('SELECT * FROM clients WHERE id = ?', [
      ins.insertId,
    ])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'clients',
      entity_id: ins.insertId,
      comment: 'Клиент добавлен',
    })

    res.status(201).json(fresh[0])
  } catch (err) {
    console.error('Ошибка при добавлении клиента:', err)
    res.status(500).json({ message: 'Ошибка сервера при добавлении клиента' })
  }
})

router.put('/:id', authMiddleware, tabGuard, async (req, res) => {
  const id = Number(req.params.id)
  const {
    company_name,
    registration_number,
    tax_id,
    contact_person,
    phone,
    email,
    website,
    notes,
    version,
  } = req.body || {}

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }
  if (version === undefined) {
    return res.status(400).json({ message: 'Missing "version" in body' })
  }
  if (!company_name?.trim()) {
    return res.status(400).json({ message: "Поле 'company_name' обязательно" })
  }

  try {
    const [rows] = await db.execute('SELECT * FROM clients WHERE id = ?', [id])
    if (rows.length === 0)
      return res.status(404).json({ message: 'Клиент не найден' })
    const old = rows[0]

    const [upd] = await db.execute(
      `
      UPDATE clients
      SET company_name = ?,
          registration_number = ?,
          tax_id = ?,
          contact_person = ?,
          phone = ?,
          email = ?,
          website = ?,
          notes = ?,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ? AND version = ?
      `,
      [
        company_name.trim(),
        toNull(registration_number?.trim?.()),
        toNull(tax_id?.trim?.()),
        toNull(contact_person?.trim?.()),
        toNull(phone?.trim?.()),
        toNull(email?.trim?.()),
        toNull(website?.trim?.()),
        toNull(notes?.trim?.()),
        id,
        version,
      ]
    )

    if (!upd.affectedRows) {
      const [freshRows] = await db.execute('SELECT * FROM clients WHERE id = ?', [id])
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись изменена другим пользователем',
        current: freshRows[0] || null,
      })
    }

    const [fresh] = await db.execute('SELECT * FROM clients WHERE id = ?', [id])

    await logFieldDiffs({
      req,
      oldData: old,
      newData: fresh[0],
      entity_type: 'clients',
      entity_id: id,
    })

    res.json(fresh[0])
  } catch (err) {
    console.error('Ошибка при обновлении клиента:', err)
    res.status(500).json({ message: 'Ошибка сервера при обновлении клиента' })
  }
})

router.delete('/:id', authMiddleware, tabGuard, async (req, res) => {
  const id = Number(req.params.id)
  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'version must be numeric' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [clientRows] = await conn.execute('SELECT * FROM clients WHERE id = ?', [id])
    if (clientRows.length === 0) {
      await conn.rollback()
      return res.status(404).json({ message: 'Клиент не найден' })
    }
    const client = clientRows[0]

    if (version !== undefined && client.version !== version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: client,
      })
    }

    // Удаляем дочерние таблицы (это безопасно даже при CASCADE)
    await conn.execute('DELETE FROM client_billing_addresses  WHERE client_id = ?', [id])
    await conn.execute('DELETE FROM client_shipping_addresses WHERE client_id = ?', [id])
    await conn.execute('DELETE FROM client_bank_details      WHERE client_id = ?', [id])

    await conn.execute('DELETE FROM clients WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'clients',
      entity_id: id,
      comment: `Клиент "${client.company_name}" и связанные записи удалены`,
    })

    await conn.commit()
    res.json({ message: 'Клиент удалён' })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при удалении клиента:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении клиента' })
  } finally {
    conn.release()
  }
})

module.exports = router
