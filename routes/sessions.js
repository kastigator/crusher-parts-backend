const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  ONLINE_MINUTES,
  getClientIp,
  getUserAgent,
  normalizePath,
  normalizeSessionId,
  recordUserActivityEvent,
} = require('../utils/userActivity')

const isAdmin = (user) =>
  user &&
  (user.role === 'admin' || user.role_id === 1 || user.is_admin)

// --------------------------------------------------
// POST /sessions/start
// --------------------------------------------------
router.post('/start', async (req, res) => {
  const sessionId = normalizeSessionId(req.body?.session_id)
  const userId = Number(req.user?.id)

  if (!sessionId || !userId) {
    return res.status(400).json({ message: 'Нужно указать сессию и пользователя' })
  }

  const ip = getClientIp(req)
  const userAgent = getUserAgent(req)
  const lastPath = normalizePath(req.body?.started_path || req.body?.last_path)
  const isVisible = req.body?.is_visible === undefined ? 1 : req.body?.is_visible ? 1 : 0

  try {
    const [[existing]] = await db.execute(
      `SELECT id FROM user_sessions WHERE session_id = ? LIMIT 1`,
      [sessionId]
    )

    if (!existing) {
      await db.execute(
        `
        INSERT INTO user_sessions
          (session_id, user_id, started_at, ip, user_agent, last_path, last_seen_at, ended_at, last_ping_at, last_action_at, is_visible, status, closed_reason)
        VALUES (?, ?, NOW(), ?, ?, ?, NOW(), NULL, NOW(), NOW(), ?, 'active', NULL)
        `,
        [sessionId, userId, ip, userAgent, lastPath, isVisible]
      )

      await recordUserActivityEvent({
        sessionId,
        userId,
        eventType: 'login',
        path: lastPath,
        meta: { source: 'session_start' },
        ip,
        userAgent,
      })
    } else {
      await db.execute(
        `
        UPDATE user_sessions
        SET user_id = ?,
            ip = ?,
            user_agent = ?,
            last_path = COALESCE(?, last_path),
            last_seen_at = NOW(),
            ended_at = NULL,
            last_ping_at = NOW(),
            is_visible = ?,
            status = 'active',
            closed_reason = NULL
        WHERE session_id = ?
        `,
        [userId, ip, userAgent, lastPath, isVisible, sessionId]
      )
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('POST /sessions/start error:', err)
    res.status(500).json({ message: 'Ошибка сервера при старте сессии' })
  }
})

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
  const userAgent = getUserAgent(req)
  const lastPath = normalizePath(req.body?.last_path)
  const isVisible = req.body?.is_visible === undefined ? 1 : req.body?.is_visible ? 1 : 0

  try {
    await db.execute(
      `
      INSERT INTO user_sessions
        (session_id, user_id, started_at, ip, user_agent, last_path, last_seen_at, ended_at, last_ping_at, is_visible, status, closed_reason)
      VALUES (?, ?, NOW(), ?, ?, ?, NOW(), NULL, NOW(), ?, 'active', NULL)
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        ip = VALUES(ip),
        user_agent = VALUES(user_agent),
        last_path = VALUES(last_path),
        last_seen_at = NOW(),
        ended_at = NULL,
        last_ping_at = NOW(),
        is_visible = VALUES(is_visible),
        status = 'active',
        closed_reason = NULL
      `,
      [sessionId, userId, ip, userAgent, lastPath, isVisible]
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
    await recordUserActivityEvent({
      sessionId,
      userId,
      eventType: 'logout',
      path: normalizePath(req.body?.last_path),
      meta: { source: 'explicit_logout' },
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    })

    await db.execute(
      `
      UPDATE user_sessions
      SET status = 'inactive',
          ended_at = NOW(),
          last_seen_at = NOW(),
          last_ping_at = NOW(),
          is_visible = 0,
          closed_reason = 'logout'
      WHERE session_id = ? AND user_id = ?
      `,
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
        s.started_at,
        s.last_seen_at AS last_active_at,
        s.last_path,
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
