const express = require('express')
const db = require('../utils/db')
const { hasCapability } = require('../services/authorizationService')

const router = express.Router()

const toId = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

router.get('/summary', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    if (!userId) return res.status(401).json({ message: 'Нет пользователя' })
    const manager = hasCapability(req.user, 'sourcing.cases.manage')

    const [assignedRequests] = await db.execute(
      `SELECT cr.id,cr.internal_number,cr.status,cr.created_at,cr.received_at,
              cr.processing_deadline,cr.client_reference,c.company_name AS client_name
         FROM client_requests cr
         JOIN clients c ON c.id=cr.client_id
        WHERE cr.assigned_to_user_id=?
        ORDER BY cr.created_at DESC LIMIT 200`,
      [userId]
    )
    const [assignedSourcingCases] = await db.execute(
      `SELECT sc.id,sc.case_number,sc.title,sc.status,sc.priority,sc.response_deadline,
              sc.created_at,COUNT(DISTINCT sd.id) AS demand_count
         FROM sourcing_cases sc
         LEFT JOIN sourcing_demands sd ON sd.sourcing_case_id=sc.id
        WHERE sc.owner_user_id=?
        GROUP BY sc.id
        ORDER BY sc.response_deadline IS NULL,sc.response_deadline,sc.updated_at DESC LIMIT 200`,
      [userId]
    )
    const [[counts]] = await db.execute(
      `SELECT
         (SELECT COUNT(*) FROM client_requests WHERE assigned_to_user_id=?) AS assigned_requests,
         (SELECT COUNT(*) FROM sourcing_cases WHERE owner_user_id=?) AS assigned_sourcing_cases,
         (SELECT COUNT(*) FROM notifications WHERE user_id=? AND is_read=0) AS unread_notifications`,
      [userId, userId, userId]
    )

    let releaseQueue = []
    let sourcingAssignees = []
    let managerSourcingCases = []
    if (manager) {
      ;[releaseQueue] = await db.execute(
        `SELECT pr.id,pr.release_key,pr.release_number,pr.title,pr.released_at,
                cr.id AS client_request_id,cr.internal_number,cr.processing_deadline,
                c.company_name AS client_name,u.full_name AS released_by_name,
                COUNT(pri.id) AS item_count
           FROM procurement_releases pr
           JOIN client_requests cr ON cr.id=pr.client_request_id
           JOIN clients c ON c.id=cr.client_id
           LEFT JOIN users u ON u.id=pr.released_by_user_id
           LEFT JOIN procurement_release_items pri ON pri.procurement_release_id=pr.id
           LEFT JOIN sourcing_case_release_links l ON l.procurement_release_id=pr.id
          WHERE pr.status='released' AND l.id IS NULL
          GROUP BY pr.id,cr.id,c.id,u.id
          ORDER BY pr.released_at DESC,pr.id DESC LIMIT 100`
      )
      ;[sourcingAssignees] = await db.execute(
        `SELECT u.id,u.full_name,u.username,
                GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ', ') AS role_names
           FROM users u
           JOIN user_roles ur ON ur.user_id=u.id
           JOIN roles r ON r.id=ur.role_id
           JOIN role_capabilities rc ON rc.role_id=r.id AND rc.is_allowed=1
           JOIN capabilities c ON c.id=rc.capability_id AND c.is_active=1
          WHERE u.is_active=1 AND c.capability_key='sourcing.cases.manage'
          GROUP BY u.id
          ORDER BY u.full_name,u.username`
      )
      ;[managerSourcingCases] = await db.execute(
        `SELECT sc.id,sc.case_number,sc.title,sc.status,sc.priority,sc.response_deadline,
                sc.created_at,sc.updated_at,u.full_name AS owner_name,
                COUNT(DISTINCT sd.id) AS demand_count
           FROM sourcing_cases sc
           LEFT JOIN users u ON u.id=sc.owner_user_id
           LEFT JOIN sourcing_demands sd ON sd.sourcing_case_id=sc.id
          WHERE sc.status NOT IN ('archived','cancelled','closed')
          GROUP BY sc.id,u.id
          ORDER BY FIELD(sc.priority,'urgent','high','normal','low'),
                   sc.response_deadline IS NULL,sc.response_deadline,sc.updated_at DESC LIMIT 200`
      )
    }

    res.json({
      user_id: userId,
      manager,
      counts: counts || { assigned_requests: 0, assigned_sourcing_cases: 0, unread_notifications: 0 },
      assigned_requests: assignedRequests || [],
      assigned_sourcing_cases: assignedSourcingCases || [],
      release_queue: releaseQueue || [],
      sourcing_assignees: sourcingAssignees || [],
      manager_sourcing_cases: managerSourcingCases || [],
    })
  } catch (error) {
    console.error('GET /dashboard/summary error:', error)
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
    if (type) { where.push('type = ?'); params.push(type) }
    const [rows] = await db.execute(
      `SELECT id,type,title,message,entity_type,entity_id,is_read,created_at
         FROM notifications WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT ${limit}`,
      params
    )
    const countWhere = ['user_id = ?', 'is_read = 0']
    const countParams = [userId]
    if (type) { countWhere.push('type = ?'); countParams.push(type) }
    const [[countRow]] = await db.execute(
      `SELECT COUNT(*) AS unread_count FROM notifications WHERE ${countWhere.join(' AND ')}`,
      countParams
    )
    res.json({ unread_count: countRow?.unread_count || 0, notifications: rows || [] })
  } catch (error) {
    console.error('GET /dashboard/notifications error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/notifications/mark-read', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    const entityType = String(req.body?.entity_type || req.body?.entityType || '').trim()
    const entityId = toId(req.body?.entity_id ?? req.body?.entityId)
    const type = String(req.body?.type || '').trim()
    if (!userId || !entityType || !entityId) return res.status(400).json({ message: 'Некорректный запрос' })
    const where = ['user_id = ?', 'entity_type = ?', 'entity_id = ?']
    const params = [userId, entityType, entityId]
    if (type) { where.push('type = ?'); params.push(type) }
    await db.execute(`DELETE FROM notifications WHERE ${where.join(' AND ')}`, params)
    res.json({ ok: true })
  } catch (error) {
    console.error('POST /dashboard/notifications/mark-read error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/notifications/:id/read', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    const id = toId(req.params.id)
    if (!userId || !id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    await db.execute('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, userId])
    res.json({ ok: true })
  } catch (error) {
    console.error('POST /dashboard/notifications/:id/read error:', error)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/events', (_req, res) => res.json([]))

module.exports = router
