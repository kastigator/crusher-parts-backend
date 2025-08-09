// routes/activityLogs.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const authMiddleware = require('../middleware/authMiddleware')

/**
 * Получение удалённых записей (onlyDeleted), с фильтром по entity_type
 * ВАЖНО: этот маршрут должен быть ПЕРЕД `/:entity/:id`, иначе он не сработает
 */
router.get('/deleted', authMiddleware, async (req, res) => {
  const { entity_type } = req.query

  let query = `
    SELECT a.*, u.full_name AS user_name
    FROM activity_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.action = 'delete'
  `
  const values = []

  if (entity_type) {
    query += ' AND a.entity_type = ?'
    values.push(entity_type)
  }

  query += ' ORDER BY a.created_at DESC LIMIT 100'

  try {
    const [rows] = await db.execute(query, values)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении удалённых записей:', err)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

/**
 * Получение истории по entity_type и entity_id
 */
router.get('/:entity/:id', authMiddleware, async (req, res) => {
  const { entity, id } = req.params
  const parsedId = Number(id)

  if (Number.isNaN(parsedId)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }

  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.entity_type = ? AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `, [entity, parsedId])

    res.json(logs)
  } catch (err) {
    console.error('Ошибка при получении истории:', err)
    res.status(500).json({ message: 'Ошибка сервера при получении логов' })
  }
})

/**
 * Запись логов действия
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

  // 🔎 Диагностика входящего тела (можно отключить позже)
  console.log('📩 /activity-logs body =', req.body)

  // ✅ Валидация action
  const act = String(action || '').trim().toLowerCase()
  const allowed = new Set(['create', 'update', 'delete'])
  if (!allowed.has(act)) {
    return res.status(400).json({ message: `invalid action: ${action}` })
  }

  // ✅ Приведение entity_id к числу или null
  const idNum =
    entity_id === undefined || entity_id === null || entity_id === ''
      ? null
      : Number(entity_id)

  if (idNum !== null && Number.isNaN(idNum)) {
    return res.status(400).json({ message: 'entity_id must be numeric or null' })
  }

  try {
    const user_id = req?.user?.id || null

    await db.execute(`
      INSERT INTO activity_logs
        (user_id, action, entity_type, entity_id, field_changed, old_value, new_value, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      user_id,
      act,
      entity_type,
      idNum,
      field_changed ?? null,
      old_value ?? null,
      new_value ?? null,
      comment ?? null
    ])

    res.status(200).json({ success: true })
  } catch (err) {
    console.error('Ошибка при сохранении лога:', err)
    res.status(500).json({ message: 'Ошибка при логировании действия' })
  }
})

module.exports = router
