const express = require('express')
const db = require('../utils/db')

const router = express.Router()

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
  const targetUserId = Number(req.query.target_user_id)
  const eventType = String(req.query.event_type || '').trim()
  const filters = []
  const params = []
  if (Number.isInteger(targetUserId) && targetUserId > 0) {
    filters.push('e.target_user_id = ?')
    params.push(targetUserId)
  }
  if (eventType) {
    filters.push('e.event_type = ?')
    params.push(eventType)
  }

  try {
    const [rows] = await db.execute(
      `
      SELECT e.id, e.event_type, e.actor_user_id, e.target_user_id,
             e.entity_type, e.entity_id, e.before_json, e.after_json,
             e.metadata_json, e.created_at,
             actor.username AS actor_username,
             target.username AS target_username
      FROM security_audit_events e
      LEFT JOIN users actor ON actor.id = e.actor_user_id
      LEFT JOIN users target ON target.id = e.target_user_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?
      `,
      [...params, limit]
    )
    res.json(rows || [])
  } catch (error) {
    console.error('GET /security-audit error:', error)
    res.status(500).json({ message: 'Ошибка загрузки аудита безопасности' })
  }
})

module.exports = router
