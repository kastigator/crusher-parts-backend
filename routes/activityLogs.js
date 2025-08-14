// routes/activityLogs.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const authMiddleware = require('../middleware/authMiddleware')

/**
 * Получение удалённых записей (onlyDeleted), с фильтрами
 * ВАЖНО: этот маршрут должен быть ПЕРЕД `/:entity/:id`
 *
 * Фильтры:
 *   - entity_type: string
 *   - entity_id: number (опционально)
 *   - limit: number (по умолчанию 100, максимум 500)
 */
router.get('/deleted', authMiddleware, async (req, res) => {
  const { entity_type, entity_id } = req.query
  const limit = Math.min(Number(req.query.limit) || 100, 500)

  let sql = `
    SELECT a.*, u.full_name AS user_name
    FROM activity_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.action = 'delete'
  `
  const values = []

  if (entity_type) {
    sql += ' AND a.entity_type = ?'
    values.push(String(entity_type).trim())
  }
  if (entity_id !== undefined) {
    const idNum = Number(entity_id)
    if (Number.isNaN(idNum)) return res.status(400).json({ message: 'entity_id must be numeric' })
    sql += ' AND a.entity_id = ?'
    values.push(idNum)
  }

  sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT ?'
  values.push(limit)

  try {
    const [rows] = await db.execute(sql, values)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении удалённых записей:', err)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

/**
 * Получение истории по entity_type и entity_id
 *
 * Доп. фильтры:
 *   - action: create|update|delete
 *   - field: имя поля (field_changed)
 *   - limit: число (по умолчанию 500, максимум 1000)
 */
router.get('/:entity/:id', authMiddleware, async (req, res) => {
  const { entity, id } = req.params
  const parsedId = Number(id)
  if (Number.isNaN(parsedId)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }

  const limit = Math.min(Number(req.query.limit) || 500, 1000)
  const action = req.query.action ? String(req.query.action).trim().toLowerCase() : null
  const field = req.query.field ? String(req.query.field).trim() : null
  const allowedActions = new Set(['create', 'update', 'delete'])

  let sql = `
    SELECT a.*, u.full_name AS user_name
    FROM activity_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.entity_type = ? AND a.entity_id = ?
  `
  const values = [String(entity).trim(), parsedId]

  if (action) {
    if (!allowedActions.has(action)) {
      return res.status(400).json({ message: 'invalid action filter' })
    }
    sql += ' AND a.action = ?'
    values.push(action)
  }

  if (field) {
    sql += ' AND a.field_changed = ?'
    values.push(field)
  }

  sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT ?'
  values.push(limit)

  try {
    const [logs] = await db.execute(sql, values)
    res.json(logs)
  } catch (err) {
    console.error('Ошибка при получении истории:', err)
    res.status(500).json({ message: 'Ошибка сервера при получении логов' })
  }
})

/**
 * Создание записи лога
 */
router.post('/', authMiddleware, async (req, res) => {
  const {
    action,
    entity_type,
    entity_id,
    field_changed,
    old_value,
    new_value,
    comment
  } = req.body

  const act = String(action || '').trim().toLowerCase()
  const allowed = new Set(['create', 'update', 'delete'])
  if (!allowed.has(act)) {
    return res.status(400).json({ message: `invalid action: ${action}` })
  }

  const idNum =
    entity_id === undefined || entity_id === null || entity_id === ''
      ? null
      : Number(entity_id)
  if (idNum !== null && Number.isNaN(idNum)) {
    return res.status(400).json({ message: 'entity_id must be numeric or null' })
  }

  try {
    const user_id = req?.user?.id || null

    await db.execute(
      `INSERT INTO activity_logs
        (user_id, action, entity_type, entity_id, field_changed, old_value, new_value, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        act,
        entity_type ? String(entity_type).trim() : null,
        idNum,
        field_changed ?? null,
        old_value ?? null,
        new_value ?? null,
        comment ?? null
      ]
    )

    res.status(201).json({ success: true })
  } catch (err) {
    console.error('Ошибка при сохранении лога:', err)
    res.status(500).json({ message: 'Ошибка при логировании действия' })
  }
})

module.exports = router
