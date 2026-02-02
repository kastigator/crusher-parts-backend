const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

const roleOf = (user) => String(user?.role || '').toLowerCase()
const isManager = (user) =>
  roleOf(user) === 'admin' || roleOf(user) === 'nachalnik-otdela-zakupok'

router.get('/summary', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    if (!userId) return res.status(401).json({ message: 'Нет пользователя' })
    const manager = isManager(req.user)

    const [assignedRequests] = await db.execute(
      `
      SELECT cr.id,
             cr.internal_number,
             cr.status,
             cr.created_at,
             cr.received_at,
             cr.processing_deadline,
             cr.client_reference,
             c.company_name AS client_name
        FROM client_requests cr
        JOIN clients c ON c.id = cr.client_id
       WHERE cr.assigned_to_user_id = ?
       ORDER BY cr.created_at DESC
       LIMIT 200
      `,
      [userId]
    )

    const [assignedRfqs] = await db.execute(
      `
      SELECT r.id,
             r.rfq_number,
             r.status,
             r.created_at,
             req.status AS client_request_status,
             req.internal_number AS client_request_number,
             req.processing_deadline,
             c.company_name AS client_name
        FROM rfqs r
        JOIN client_requests req ON req.id = r.client_request_id
        JOIN clients c ON c.id = req.client_id
       WHERE r.assigned_to_user_id = ?
       ORDER BY r.created_at DESC
       LIMIT 200
      `,
      [userId]
    )

    const [[counts]] = await db.execute(
      `
      SELECT
        (
          SELECT COUNT(*)
            FROM client_requests cr
           WHERE cr.assigned_to_user_id = ?
        ) AS assigned_requests,
        (SELECT COUNT(*) FROM rfqs WHERE assigned_to_user_id = ?) AS assigned_rfqs,
        (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0) AS unread_notifications,
        (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND type = 'assignment' AND is_read = 0) AS unread_assignments
      `,
      [userId, userId, userId, userId]
    )

    const [assignmentNotificationCounts] = await db.execute(
      `
      SELECT entity_type, entity_id, COUNT(*) AS cnt
        FROM notifications
       WHERE user_id = ?
         AND type = 'assignment'
         AND is_read = 0
       GROUP BY entity_type, entity_id
      `,
      [userId]
    )

    let releaseQueue = []
    let rfqAssignees = []
    let managerRfqs = []

    if (manager) {
      const [queueRows] = await db.execute(
        `
        SELECT cr.id,
               cr.internal_number,
               cr.status,
               cr.created_at,
               cr.received_at,
               cr.processing_deadline,
               cr.released_to_procurement_at,
               cr.released_to_procurement_by_user_id,
               c.company_name AS client_name,
               u.full_name AS released_by_name
          FROM client_requests cr
          JOIN clients c ON c.id = cr.client_id
          LEFT JOIN users u ON u.id = cr.released_to_procurement_by_user_id
          LEFT JOIN rfqs r ON r.client_request_id = cr.id
         WHERE cr.is_locked_after_release = 1
           AND cr.released_to_procurement_at IS NOT NULL
           AND r.id IS NULL
         ORDER BY cr.released_to_procurement_at DESC, cr.id DESC
         LIMIT 100
        `
      )
      releaseQueue = Array.isArray(queueRows) ? queueRows : []

      const [assigneeRows] = await db.execute(
        `
        SELECT u.id, u.full_name, u.username, r.name AS role_name, r.slug AS role_slug
          FROM users u
          JOIN roles r ON r.id = u.role_id
         WHERE u.is_active = 1
         ORDER BY u.full_name ASC, u.username ASC
        `
      )
      rfqAssignees = Array.isArray(assigneeRows) ? assigneeRows : []

      const [managerRfqRows] = await db.execute(
        `
        SELECT r.id,
               r.rfq_number,
               r.status,
               r.created_at,
               r.updated_at,
               r.assigned_to_user_id,
               req.internal_number AS client_request_number,
               req.processing_deadline,
               c.company_name AS client_name,
               au.full_name AS assigned_user_name,
               ru.full_name AS released_by_name,
               req.released_to_procurement_at
          FROM rfqs r
          JOIN client_requests req ON req.id = r.client_request_id
          JOIN clients c ON c.id = req.client_id
          LEFT JOIN users au ON au.id = r.assigned_to_user_id
          LEFT JOIN users ru ON ru.id = req.released_to_procurement_by_user_id
         ORDER BY COALESCE(req.processing_deadline, DATE('2999-12-31')) ASC, r.id DESC
         LIMIT 200
        `
      )
      managerRfqs = Array.isArray(managerRfqRows) ? managerRfqRows : []
    }

    res.json({
      user_id: userId,
      manager,
      counts: counts || {
        assigned_requests: 0,
        assigned_rfqs: 0,
        unread_notifications: 0,
        unread_assignments: 0,
      },
      assigned_requests: Array.isArray(assignedRequests) ? assignedRequests : [],
      assigned_rfqs: Array.isArray(assignedRfqs) ? assignedRfqs : [],
      assignment_notification_counts: Array.isArray(assignmentNotificationCounts)
        ? assignmentNotificationCounts
        : [],
      release_queue: releaseQueue,
      rfq_assignees: rfqAssignees,
      manager_rfqs: managerRfqs,
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
    const type = String(req.query.type || '').trim()

    const where = ['user_id = ?']
    const params = [userId]
    if (unreadOnly) where.push('is_read = 0')
    if (type) {
      where.push('type = ?')
      params.push(type)
    }

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

    const countWhere = ['user_id = ?', 'is_read = 0']
    const countParams = [userId]
    if (type) {
      countWhere.push('type = ?')
      countParams.push(type)
    }
    const [[countRow]] = await db.execute(
      `SELECT COUNT(*) AS unread_count FROM notifications WHERE ${countWhere.join(' AND ')}`,
      countParams
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

router.post('/notifications/mark-read', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    if (!userId) return res.status(401).json({ message: 'Нет пользователя' })

    const entityType = String(req.body?.entity_type || req.body?.entityType || '').trim()
    const entityId = toId(req.body?.entity_id ?? req.body?.entityId)
    const type = String(req.body?.type || '').trim()

    if (!entityType || !entityId) {
      return res.status(400).json({ message: 'entity_type и entity_id обязательны' })
    }

    const where = ['user_id = ?', 'entity_type = ?', 'entity_id = ?']
    const params = [userId, entityType, entityId]
    if (type) {
      where.push('type = ?')
      params.push(type)
    }

    await db.execute(`DELETE FROM notifications WHERE ${where.join(' AND ')}`, params)
    res.json({ ok: true })
  } catch (e) {
    console.error('POST /dashboard/notifications/mark-read error:', e)
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
