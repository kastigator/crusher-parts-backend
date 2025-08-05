const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const authMiddleware = require('../middleware/authMiddleware')

/**
 * Получение истории логов по entity_type и entity_id
 */
router.get('/:entity/:id', authMiddleware, async (req, res) => {
  const { entity, id } = req.params

  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.entity_type = ? AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `, [entity, id])

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

  try {
    const user_id = req?.user?.id || null

    await db.execute(`
      INSERT INTO activity_logs
        (user_id, action, entity_type, entity_id, field_changed, old_value, new_value, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      user_id,
      action,
      entity_type,
      entity_id,
      field_changed,
      old_value,
      new_value,
      comment
    ])

    res.status(200).json({ success: true })
  } catch (err) {
    console.error('Ошибка при сохранении лога:', err)
    res.status(500).json({ message: 'Ошибка при логировании действия' })
  }
})

module.exports = router
