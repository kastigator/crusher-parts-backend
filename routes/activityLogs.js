// routes/activityLogs.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

// ---------- helpers ----------
const normalizeLimit = (v, def = 200, max = 500) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const mustNum = (val, name = 'value') => {
  const n = Number(val)
  if (!Number.isFinite(n)) {
    const e = new Error(`${name} must be numeric`)
    e.status = 400
    throw e
  }
  return Math.trunc(n)
}

// алиасы старых/кривых имён сущностей → каноническое имя
const ENTITY_ALIAS = {
  tnved_code: 'tnved_codes',
  part_suppliers: 'suppliers', // если где-то так прилетает
}

// нормализуем entity_type
const resolveEntityType = (raw) => {
  if (!raw) return null
  const clean = String(raw).trim()
  return ENTITY_ALIAS[clean] || clean
}

// ---------- /deleted ----------
// GET /activity-logs/deleted?entity_type=...&entity_id=...&limit=...
router.get('/deleted', async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query
    const limit = normalizeLimit(req.query.limit, 100, 500)

    let sql = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.action = 'delete'
    `
    const params = []

    if (entity_type && String(entity_type).trim()) {
      const entityType = resolveEntityType(entity_type)
      sql += ' AND a.entity_type = ?'
      params.push(entityType)
    }

    if (entity_id !== undefined) {
      sql += ' AND a.entity_id = ?'
      params.push(mustNum(entity_id, 'entity_id'))
    }

    sql += ` ORDER BY a.created_at DESC LIMIT ${limit}`

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    const code = err.status || 500
    if (code === 400) return res.status(400).json({ message: err.message })
    console.error('Ошибка при получении удалённых записей:', err)
    res
      .status(500)
      .json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

// ---------- /by-client/:clientId ----------
// GET /activity-logs/by-client/:clientId?limit=...
router.get('/by-client/:clientId', async (req, res) => {
  try {
    const clientId = mustNum(req.params.clientId, 'clientId')
    const limit = normalizeLimit(req.query.limit, 200, 500)

    const sql = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.client_id = ?
      ORDER BY a.created_at DESC
      LIMIT ${limit}
    `
    const [rows] = await db.execute(sql, [clientId])
    res.json(rows)
  } catch (err) {
    const code = err.status || 500
    if (code === 400) return res.status(400).json({ message: err.message })
    console.error('Ошибка при получении истории по клиенту:', err)
    res
      .status(500)
      .json({ message: 'Ошибка сервера при получении логов по клиенту' })
  }
})

// ---------- /:entity/:id ----------
// GET /activity-logs/:entity/:id?action=&field=&limit=...
router.get('/:entity/:id', async (req, res) => {
  try {
    const rawEntity = String(req.params.entity || '').trim()
    const entityType = resolveEntityType(rawEntity)
    const entityId = mustNum(req.params.id, 'id')

    const limit = normalizeLimit(req.query.limit, 500, 1000)

    let action = null
    if (req.query.action) {
      action = String(req.query.action).trim().toLowerCase()
      if (!['create', 'update', 'delete'].includes(action)) {
        return res.status(400).json({ message: 'invalid action filter' })
      }
    }

    const field = req.query.field ? String(req.query.field).trim() : null

    let sql = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.entity_type = ? AND a.entity_id = ?
    `
    const params = [entityType, entityId]

    if (action) {
      sql += ' AND a.action = ?'
      params.push(action)
    }
    if (field) {
      sql += ' AND a.field_changed = ?'
      params.push(field)
    }

    sql += ` ORDER BY a.created_at DESC LIMIT ${limit}`

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    const code = err.status || 500
    if (code === 400) return res.status(400).json({ message: err.message })
    console.error('Ошибка при получении истории:', err)
    res.status(500).json({ message: 'Ошибка сервера при получении логов' })
  }
})

// ---------- POST ----------
// Создание лога (вызывается logActivity / logFieldDiffs)
router.post('/', async (req, res) => {
  try {
    const {
      action,
      entity_type,
      entity_id,
      field_changed,
      old_value,
      new_value,
      comment,
      client_id,
    } = req.body || {}

    const act = String(action || '').trim().toLowerCase()
    if (!['create', 'update', 'delete'].includes(act)) {
      return res.status(400).json({ message: `invalid action: ${action}` })
    }

    const idNum =
      entity_id === undefined || entity_id === null || entity_id === ''
        ? null
        : mustNum(entity_id, 'entity_id')

    const clientIdNorm =
      client_id === undefined || client_id === null || client_id === ''
        ? null
        : mustNum(client_id, 'client_id')

    const user_id = req?.user?.id || null
    const entityType = resolveEntityType(entity_type)

    await db.execute(
      `INSERT INTO activity_logs
        (user_id, action, entity_type, entity_id, client_id, field_changed, old_value, new_value, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        act,
        entityType,
        idNum,
        clientIdNorm,
        field_changed ?? null,
        old_value ?? null,
        new_value ?? null,
        comment ?? null,
      ]
    )

    res.status(201).json({ success: true })
  } catch (err) {
    const code = err.status || 500
    if (code === 400) return res.status(400).json({ message: err.message })
    console.error('Ошибка при сохранении лога:', err)
    res.status(500).json({ message: 'Ошибка при логировании действия' })
  }
})

module.exports = router
