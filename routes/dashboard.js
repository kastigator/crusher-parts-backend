const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

router.get('/summary', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    if (!userId) return res.status(401).json({ message: 'Нет пользователя' })

    const [assignedRequests] = await db.execute(
      `
      SELECT cr.id,
             cr.internal_number,
             cr.status,
             cr.created_at,
             cr.client_reference,
             c.company_name AS client_name
        FROM client_requests cr
        JOIN clients c ON c.id = cr.client_id
       WHERE cr.assigned_to_user_id = ?
       ORDER BY cr.created_at DESC
       LIMIT 20
      `,
      [userId]
    )

    const [assignedRfqs] = await db.execute(
      `
      SELECT r.id,
             r.rfq_number,
             r.status,
             r.created_at,
             req.internal_number AS client_request_number,
             c.company_name AS client_name
        FROM rfqs r
        JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
        JOIN client_requests req ON req.id = cr.client_request_id
        JOIN clients c ON c.id = req.client_id
       WHERE r.assigned_to_user_id = ?
       ORDER BY r.created_at DESC
       LIMIT 20
      `,
      [userId]
    )

    const [[counts]] = await db.execute(
      `
      SELECT
        (SELECT COUNT(*) FROM client_requests WHERE assigned_to_user_id = ?) AS assigned_requests,
        (SELECT COUNT(*) FROM rfqs WHERE assigned_to_user_id = ?) AS assigned_rfqs,
        (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0) AS unread_notifications
      `,
      [userId, userId, userId]
    )

    res.json({
      user_id: userId,
      counts: counts || { assigned_requests: 0, assigned_rfqs: 0, unread_notifications: 0 },
      assigned_requests: Array.isArray(assignedRequests) ? assignedRequests : [],
      assigned_rfqs: Array.isArray(assignedRfqs) ? assignedRfqs : [],
    })
  } catch (e) {
    console.error('GET /dashboard/summary error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/notifications', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    if (!userId) return res.status(401).json({ message: 'Нет пользователя' })

    const limit = Math.min(Number(req.query.limit) || 20, 100)
    const unreadOnly = String(req.query.unread_only || '') === '1'

    const where = ['user_id = ?']
    const params = [userId]
    if (unreadOnly) where.push('is_read = 0')

    const [rows] = await db.execute(
      `
      SELECT id, type, title, message, entity_type, entity_id, is_read, created_at
        FROM notifications
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${limit}
      `,
      params
    )

    const [[countRow]] = await db.execute(
      'SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    )

    res.json({
      unread_count: countRow?.unread_count || 0,
      notifications: Array.isArray(rows) ? rows : [],
    })
  } catch (e) {
    console.error('GET /dashboard/notifications error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/notifications/:id/read', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    const id = toId(req.params.id)
    if (!userId || !id) return res.status(400).json({ message: 'Некорректный ID' })

    await db.execute('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, userId])
    res.json({ ok: true })
  } catch (e) {
    console.error('POST /dashboard/notifications/:id/read error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/events', (_req, res) => {
  res.json([])
})

module.exports = router
