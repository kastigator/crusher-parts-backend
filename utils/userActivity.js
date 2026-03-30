const db = require('./db')
const { canonicalizeEntityType } = require('./activityEntityTypes')

const ONLINE_MINUTES = Number(process.env.ONLINE_MINUTES || 10)
const ENGAGED_GAP_CAP_SECONDS = 5 * 60
const MEANINGFUL_EVENT_TYPES = new Set(['write_action', 'read_action', 'api_action'])
const TERMINAL_EVENT_TYPES = new Set(['blur', 'logout', 'session_end'])
const VALID_EVENT_TYPES = new Set([
  'login',
  'heartbeat',
  'route_change',
  'focus',
  'blur',
  'logout',
  'write_action',
  'read_action',
  'api_action',
])

function asDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function asMysqlDateTime(value) {
  const date = asDate(value)
  if (!date) return null
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function normalizePath(value) {
  if (value === undefined || value === null) return null
  const path = String(value).trim()
  return path ? path.slice(0, 255) : null
}

function normalizeMeta(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim()
  }
  return req?.socket?.remoteAddress || null
}

function getUserAgent(req) {
  return req?.headers?.['user-agent'] || null
}

function normalizeSessionId(value) {
  if (!value) return null
  const str = String(value).trim()
  return str.length ? str.slice(0, 64) : null
}

function normalizeEventType(value) {
  const eventType = String(value || '').trim().toLowerCase()
  return VALID_EVENT_TYPES.has(eventType) ? eventType : null
}

async function recordUserActivityEvent({
  conn = null,
  sessionId,
  userId,
  eventType,
  path = null,
  entityType = null,
  entityId = null,
  meta = null,
  ip = null,
  userAgent = null,
  eventTime = null,
}) {
  const sid = normalizeSessionId(sessionId)
  const uid = Number(userId)
  const type = normalizeEventType(eventType)

  if (!sid || !Number.isFinite(uid) || uid <= 0 || !type) return false

  const executeTarget = conn || db
  const eventTimeSql = asMysqlDateTime(eventTime)

  await executeTarget.execute(
    `
    INSERT INTO user_activity_events
      (session_id, user_id, event_type, event_time, path, entity_type, entity_id, meta_json, ip, user_agent)
    VALUES (?, ?, ?, COALESCE(?, NOW()), ?, ?, ?, ?, ?, ?)
    `,
    [
      sid,
      uid,
      type,
      eventTimeSql,
      normalizePath(path),
      canonicalizeEntityType(entityType)?.slice(0, 64) || null,
      entityId === undefined || entityId === null || entityId === '' ? null : Number(entityId),
      normalizeMeta(meta),
      ip || null,
      userAgent || null,
    ]
  )

  return true
}

function parseRange({ date = null, from = null, to = null } = {}) {
  if (date) {
    const start = new Date(`${date}T00:00:00`)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return { from: start, to: end }
  }

  const parsedFrom = asDate(from) || new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00')
  const parsedTo = asDate(to) || new Date(parsedFrom.getTime() + 24 * 60 * 60 * 1000)

  return parsedFrom <= parsedTo
    ? { from: parsedFrom, to: parsedTo }
    : { from: parsedTo, to: parsedFrom }
}

function clipSessionSeconds(sessionStart, sessionEnd, rangeStart, rangeEnd) {
  const start = Math.max(sessionStart.getTime(), rangeStart.getTime())
  const end = Math.min(sessionEnd.getTime(), rangeEnd.getTime())
  if (end <= start) return 0
  return Math.floor((end - start) / 1000)
}

function addRouteDuration(routeDurations, path, seconds) {
  if (!path || seconds <= 0) return
  routeDurations.set(path, (routeDurations.get(path) || 0) + seconds)
}

function buildEmptyUserSummary(user) {
  return {
    user_id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    role_name: user.role_name,
    is_active: Number(user.is_active || 0) === 1,
    online_now: false,
    last_seen_at: null,
    last_action_at: null,
    current_path: null,
    sessions_total: 0,
    sessions_in_range: 0,
    session_duration_sec: 0,
    engaged_duration_sec: 0,
    actions_count: 0,
    routes_count: 0,
    top_routes: [],
  }
}

function normalizeEventRow(row) {
  return {
    ...row,
    event_time: asDate(row.event_time),
    path: normalizePath(row.path),
    entity_type: canonicalizeEntityType(row.entity_type),
  }
}

function computeSessionEngagement(session, events, rangeStart, rangeEnd) {
  const sessionStart = asDate(session.started_at) || rangeStart
  const rawSessionEnd = asDate(session.ended_at) || asDate(session.last_seen_at) || sessionStart
  const sessionEnd = rawSessionEnd < sessionStart ? sessionStart : rawSessionEnd
  const clippedStart = sessionStart > rangeStart ? sessionStart : rangeStart
  const clippedEnd = sessionEnd < rangeEnd ? sessionEnd : rangeEnd

  if (clippedEnd <= clippedStart) {
    return { engagedSeconds: 0, routeDurations: [], lastPath: session.last_path || null }
  }

  const routeDurations = new Map()
  const points = [
    {
      event_time: clippedStart,
      event_type: 'session_start',
      path: normalizePath(session.last_path),
    },
    ...events
      .map(normalizeEventRow)
      .filter((event) => event.event_time && event.event_time >= clippedStart && event.event_time <= clippedEnd),
    {
      event_time: clippedEnd,
      event_type: 'session_end',
      path: null,
    },
  ].sort((a, b) => a.event_time - b.event_time)

  let engagedSeconds = 0
  let currentPath = normalizePath(session.last_path)
  let lastPath = currentPath

  for (let i = 0; i < points.length - 1; i += 1) {
    const current = points[i]
    const next = points[i + 1]
    if (current.path) {
      currentPath = current.path
      lastPath = current.path
    }

    const rawGap = Math.floor((next.event_time - current.event_time) / 1000)
    if (rawGap <= 0) continue

    if (!TERMINAL_EVENT_TYPES.has(current.event_type)) {
      const countedGap = Math.min(rawGap, ENGAGED_GAP_CAP_SECONDS)
      engagedSeconds += countedGap
      addRouteDuration(routeDurations, currentPath, countedGap)
    }
  }

  return {
    engagedSeconds,
    routeDurations: Array.from(routeDurations.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([path, duration_sec]) => ({ path, duration_sec })),
    lastPath,
  }
}

async function fetchUsersBasic() {
  const [rows] = await db.execute(
    `
    SELECT
      u.id,
      u.username,
      u.full_name,
      u.is_active,
      r.slug AS role,
      r.name AS role_name
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    ORDER BY u.id
    `
  )
  return (rows || []).map((row) => ({
    ...row,
    entity_type: canonicalizeEntityType(row.entity_type),
  }))
}

async function fetchOnlineUserIds({ minutes = ONLINE_MINUTES, userId = null } = {}) {
  const params = [Number(minutes)]
  let userSql = ''
  if (userId) {
    userSql = ' AND user_id = ?'
    params.push(Number(userId))
  }

  const [rows] = await db.execute(
    `
    SELECT DISTINCT user_id
    FROM user_sessions
    WHERE status = 'active'
      AND last_seen_at >= NOW() - INTERVAL ? MINUTE
      ${userSql}
    `,
    params
  )

  return new Set((rows || []).map((row) => Number(row.user_id)).filter((value) => Number.isFinite(value)))
}

async function fetchSessionsInRange({ userId = null, from, to }) {
  const params = [asMysqlDateTime(to), asMysqlDateTime(from)]
  let whereUser = ''
  if (userId) {
    whereUser = ' AND s.user_id = ?'
    params.push(Number(userId))
  }

  const [rows] = await db.execute(
    `
    SELECT
      s.id,
      s.session_id,
      s.user_id,
      s.started_at,
      s.ended_at,
      s.last_seen_at,
      s.last_ping_at,
      s.last_action_at,
      s.last_path,
      s.status,
      s.closed_reason,
      s.ip,
      s.user_agent,
      s.is_visible
    FROM user_sessions s
    WHERE s.started_at < ?
      AND COALESCE(s.ended_at, s.last_seen_at, s.started_at) > ?
      ${whereUser}
    ORDER BY s.user_id ASC, s.started_at DESC
    `,
    params
  )

  return rows || []
}

async function fetchEventsInRange({ userId = null, from, to, limit = null }) {
  const params = [asMysqlDateTime(from), asMysqlDateTime(to)]
  let whereUser = ''
  let limitSql = ''
  if (userId) {
    whereUser = ' AND e.user_id = ?'
    params.push(Number(userId))
  }
  if (limit) {
    const safeLimit = Number(limit)
    if (Number.isFinite(safeLimit) && safeLimit > 0) {
      limitSql = ` LIMIT ${Math.trunc(safeLimit)}`
    }
  }

  const [rows] = await db.execute(
    `
    SELECT
      e.id,
      e.session_id,
      e.user_id,
      e.event_type,
      e.event_time,
      e.path,
      e.entity_type,
      e.entity_id,
      e.meta_json,
      e.ip,
      e.user_agent
    FROM user_activity_events e
    WHERE e.event_time >= ?
      AND e.event_time < ?
      ${whereUser}
    ORDER BY e.event_time DESC, e.id DESC
    ${limitSql}
    `,
    params
  )

  return rows || []
}

async function buildUserActivitySummary({ date = null, from = null, to = null, userId = null } = {}) {
  const range = parseRange({ date, from, to })
  const [users, sessions, events, onlineUserIds] = await Promise.all([
    fetchUsersBasic(),
    fetchSessionsInRange({ userId, ...range }),
    fetchEventsInRange({ userId, ...range }),
    fetchOnlineUserIds({ userId }),
  ])

  const summaryMap = new Map()
  for (const user of users) {
    if (userId && Number(user.id) !== Number(userId)) continue
    summaryMap.set(user.id, buildEmptyUserSummary(user))
  }

  const eventsBySession = new Map()
  for (const event of events) {
    const list = eventsBySession.get(event.session_id) || []
    list.push(event)
    eventsBySession.set(event.session_id, list)

    const summary = summaryMap.get(event.user_id)
    if (!summary) continue

    const eventTime = asDate(event.event_time)
    if (MEANINGFUL_EVENT_TYPES.has(String(event.event_type || '').toLowerCase())) {
      summary.actions_count += 1
    }

    if (!summary.last_action_at || (eventTime && eventTime > asDate(summary.last_action_at))) {
      if (String(event.event_type || '').toLowerCase() !== 'heartbeat') {
        summary.last_action_at = event.event_time
      }
    }
  }

  for (const session of sessions) {
    const summary = summaryMap.get(session.user_id)
    if (!summary) continue

    summary.sessions_total += 1

    const startedAt = asDate(session.started_at)
    const endedAt = asDate(session.ended_at) || asDate(session.last_seen_at) || startedAt
    const lastSeenAt = asDate(session.last_seen_at)
    const lastActionAt = asDate(session.last_action_at)

    if (startedAt && startedAt >= range.from && startedAt < range.to) {
      summary.sessions_in_range += 1
    }

    if (startedAt && endedAt) {
      summary.session_duration_sec += clipSessionSeconds(startedAt, endedAt, range.from, range.to)
    }

    if (!summary.last_seen_at || (lastSeenAt && lastSeenAt > asDate(summary.last_seen_at))) {
      summary.last_seen_at = session.last_seen_at
      summary.current_path = session.last_path || summary.current_path
    }

    if (!summary.last_action_at || (lastActionAt && lastActionAt > asDate(summary.last_action_at))) {
      summary.last_action_at = session.last_action_at || summary.last_action_at
    }

    if (onlineUserIds.has(Number(session.user_id))) {
      summary.online_now = true
      summary.current_path = session.last_path || summary.current_path
    }

    const sessionEvents = (eventsBySession.get(session.session_id) || []).slice().reverse()
    const engagement = computeSessionEngagement(session, sessionEvents, range.from, range.to)
    summary.engaged_duration_sec += engagement.engagedSeconds

    const routesCombined = new Map(summary.top_routes.map((item) => [item.path, item.duration_sec]))
    for (const route of engagement.routeDurations) {
      routesCombined.set(route.path, (routesCombined.get(route.path) || 0) + route.duration_sec)
    }
    summary.top_routes = Array.from(routesCombined.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, duration_sec]) => ({ path, duration_sec }))
    summary.routes_count = summary.top_routes.length

    if (!summary.current_path && engagement.lastPath) {
      summary.current_path = engagement.lastPath
    }
  }

  return {
    range: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
    users: Array.from(summaryMap.values()).sort((a, b) => {
      const aOnline = a.online_now ? 1 : 0
      const bOnline = b.online_now ? 1 : 0
      if (aOnline !== bOnline) return bOnline - aOnline
      return new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0)
    }),
  }
}

module.exports = {
  ENGAGED_GAP_CAP_SECONDS,
  ONLINE_MINUTES,
  VALID_EVENT_TYPES,
  asDate,
  asMysqlDateTime,
  buildUserActivitySummary,
  getClientIp,
  getUserAgent,
  normalizeEventType,
  normalizePath,
  normalizeSessionId,
  parseRange,
  recordUserActivityEvent,
}
