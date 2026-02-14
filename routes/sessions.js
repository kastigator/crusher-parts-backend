const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const ONLINE_MINUTES = Number(process.env.ONLINE_MINUTES || 10)

const isAdmin = (user) =>
  user &&
  (user.role === 'admin' || user.role_id === 1 || user.is_admin)

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || null
}

const normalizeSessionId = (value) => {
  if (!value) return null
  const str = String(value).trim()
  return str.length ? str : null
}

// --------------------------------------------------
// POST /sessions/ping
// --------------------------------------------------
router.post('/ping', async (req, res) => {
  const sessionId = normalizeSessionId(req.body?.session_id)
  const bodyUserId = req.body?.user_id
  const userId = Number(req.user?.id)

  if (!sessionId || !userId) {
    return res.status(400).json({ message: 'Нужно указать сессию и пользователя' })
  }

  if (bodyUserId && Number(bodyUserId) !== userId) {
    return res.status(403).json({ message: 'Пользователь не соответствует сессии' })
  }

  const ip = getClientIp(req)
  const userAgent = req.headers['user-agent'] || null

  try {
    await db.execute(
      `
      INSERT INTO user_sessions
        (session_id, user_id, ip, user_agent, last_seen_at, status)
      VALUES (?, ?, ?, ?, NOW(), 'active')
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        ip = VALUES(ip),
        user_agent = VALUES(user_agent),
        last_seen_at = NOW(),
        status = 'active'
      `,
      [sessionId, userId, ip, userAgent]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('POST /sessions/ping error:', err)
    res.status(500).json({ message: 'Ошибка сервера при обновлении сессии' })
  }
})

// --------------------------------------------------
// POST /sessions/logout
// --------------------------------------------------
router.post('/logout', async (req, res) => {
  const sessionId = normalizeSessionId(req.body?.session_id)
  const userId = Number(req.user?.id)
  if (!sessionId) {
    return res.status(400).json({ message: 'Нужно указать сессию' })
  }
  if (!userId) {
    return res.status(401).json({ message: 'Не авторизован' })
  }

  try {
    await db.execute(
      `UPDATE user_sessions SET status = 'inactive' WHERE session_id = ? AND user_id = ?`,
      [sessionId, userId]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('POST /sessions/logout error:', err)
    res.status(500).json({ message: 'Ошибка сервера при выходе' })
  }
})

// --------------------------------------------------
// GET /sessions/online
// --------------------------------------------------
router.get('/online', async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Нет доступа' })
  }

  const minutes = Number(req.query.minutes || ONLINE_MINUTES)
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : ONLINE_MINUTES

  try {
    const [rows] = await db.execute(
      `
      SELECT
        s.session_id,
        s.user_id,
        s.last_seen_at AS last_active_at,
        s.ip,
        s.status,
        u.username,
        u.full_name,
        r.slug AS role,
        r.name AS role_name
      FROM user_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE s.last_seen_at >= NOW() - INTERVAL ? MINUTE
        AND s.status = 'active'
      ORDER BY s.last_seen_at DESC
      `,
      [safeMinutes]
    )
    res.json(rows || [])
  } catch (err) {
    console.error('GET /sessions/online error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке активных пользователей' })
  }
})

module.exports = router
