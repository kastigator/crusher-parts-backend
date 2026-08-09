const crypto = require('node:crypto')
const express = require('express')
const bcrypt = require('bcrypt')
const db = require('../utils/db')
const { createTrashEntry } = require('../utils/trashStore')
const { buildTrashPreview, MODE } = require('../utils/trashPreview')
const { resolveEffectiveAccess } = require('../services/authorizationService')
const { recordSecurityEvent } = require('../services/securityAuditService')
const requireCapability = require('../middleware/requireCapability')

const router = express.Router()
const SALT_ROUNDS = 10
const ONLINE_MINUTES = Number(process.env.ONLINE_MINUTES || 10)

const toNull = (value) => (value === '' || value === undefined ? null : value)
const toId = (value) => {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function normalizeMinutes(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : ONLINE_MINUTES
}

function uniqueRoleIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(toId).filter(Boolean))]
}

async function resolveRequestedRoleIds(executor, body, fallback = []) {
  let roleIds = uniqueRoleIds(body?.role_ids)
  if (!roleIds.length && body?.role_id) roleIds = uniqueRoleIds(body.role_id)
  if (!roleIds.length && body?.role_slug) {
    const [[role]] = await executor.execute('SELECT id FROM roles WHERE slug = ?', [body.role_slug])
    if (!role) throw Object.assign(new Error(`Роль '${body.role_slug}' не найдена`), { status: 400 })
    roleIds = [Number(role.id)]
  }
  if (!roleIds.length) roleIds = uniqueRoleIds(fallback)
  if (!roleIds.length) throw Object.assign(new Error('Назначьте хотя бы одну роль'), { status: 400 })

  const placeholders = roleIds.map(() => '?').join(',')
  const [roles] = await executor.execute(
    `SELECT id FROM roles WHERE id IN (${placeholders})`,
    roleIds
  )
  if (roles.length !== roleIds.length) {
    throw Object.assign(new Error('Одна или несколько ролей не найдены'), { status: 400 })
  }
  return roleIds
}

async function replaceUserRoles(executor, userId, roleIds, primaryRoleId, actorUserId) {
  const placeholders = roleIds.map(() => '?').join(',')
  const [[nextSuperAdmin]] = await executor.execute(
    `SELECT COUNT(*) AS count FROM roles WHERE id IN (${placeholders}) AND is_super_admin = 1`,
    roleIds
  )
  if (Number(nextSuperAdmin.count) === 0) {
    const [[currentSuperAdmin]] = await executor.execute(
      `
      SELECT COUNT(*) AS count
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.is_super_admin = 1
      `,
      [userId]
    )
    if (Number(currentSuperAdmin.count) > 0) {
      const [[otherActiveSuperAdmins]] = await executor.execute(
        `
        SELECT COUNT(DISTINCT ur.user_id) AS count
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id AND r.is_super_admin = 1
        JOIN users u ON u.id = ur.user_id AND u.is_active = 1
        WHERE ur.user_id <> ?
        `,
        [userId]
      )
      if (Number(otherActiveSuperAdmins.count) === 0) {
        throw Object.assign(new Error('Нельзя снять роль у последнего активного Super Administrator'), { status: 409 })
      }
    }
  }

  const primary = roleIds.includes(toId(primaryRoleId)) ? toId(primaryRoleId) : roleIds[0]
  await executor.execute('DELETE FROM user_roles WHERE user_id = ?', [userId])
  for (const roleId of roleIds) {
    await executor.execute(
      'INSERT INTO user_roles (user_id, role_id, is_primary, assigned_by) VALUES (?, ?, ?, ?)',
      [userId, roleId, roleId === primary ? 1 : 0, actorUserId || null]
    )
  }
  // Compatibility write: legacy callers still read users.role_id until their domain wave migrates.
  await executor.execute('UPDATE users SET role_id = ? WHERE id = ?', [primary, userId])
  return primary
}

async function loadUsers() {
  const [users] = await db.execute(
    `
    SELECT id, username, full_name, email, phone, role_id, is_active,
           must_change_password, disabled_at, created_at
    FROM users
    ORDER BY id
    `
  )
  const [roleRows] = await db.execute(
    `
    SELECT ur.user_id, ur.is_primary, r.id, r.name, r.slug,
           r.description, r.is_system, r.is_super_admin
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    ORDER BY ur.user_id, ur.is_primary DESC, r.name
    `
  )
  const rolesByUser = new Map()
  for (const role of roleRows) {
    const list = rolesByUser.get(role.user_id) || []
    list.push({
      id: Number(role.id),
      name: role.name,
      slug: role.slug,
      description: role.description,
      is_primary: Number(role.is_primary) === 1,
      is_system: Number(role.is_system) === 1,
      is_super_admin: Number(role.is_super_admin) === 1,
    })
    rolesByUser.set(role.user_id, list)
  }
  return users.map((user) => {
    const roles = rolesByUser.get(user.id) || []
    const primary = roles.find((role) => role.is_primary) || roles[0] || null
    return {
      ...user,
      is_active: Number(user.is_active) === 1,
      must_change_password: Number(user.must_change_password) === 1,
      role_id: primary?.id || user.role_id,
      role: primary?.slug || null,
      role_name: primary?.name || null,
      role_ids: roles.map((role) => role.id),
      roles,
    }
  })
}

router.get('/online', requireCapability('administration.sessions.manage'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT s.session_id, s.user_id, s.started_at, s.last_seen_at AS last_active_at,
             s.last_path, s.ip, s.status, u.username, u.full_name,
             GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ', ') AS role_names
      FROM user_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      WHERE s.last_seen_at >= NOW() - INTERVAL ? MINUTE AND s.status = 'active'
      GROUP BY s.id
      ORDER BY s.last_seen_at DESC
      `,
      [normalizeMinutes(req.query.minutes)]
    )
    res.json(rows || [])
  } catch (error) {
    console.error('GET /users/online error:', error)
    res.status(500).json({ message: 'Ошибка сервера при получении онлайн-пользователей' })
  }
})

router.get('/', async (_req, res) => {
  try {
    res.json(await loadUsers())
  } catch (error) {
    console.error('GET /users error:', error)
    res.status(500).json({ message: 'Ошибка сервера при получении пользователей' })
  }
})

router.get('/:id/effective-access', async (req, res) => {
  try {
    const access = await resolveEffectiveAccess(req.params.id)
    if (!access) return res.status(404).json({ message: 'Пользователь не найден' })
    res.json(access)
  } catch (error) {
    console.error('GET /users/:id/effective-access error:', error)
    res.status(500).json({ message: 'Ошибка расчета эффективных полномочий' })
  }
})

router.post('/', async (req, res) => {
  const { username, password, full_name, email, phone } = req.body || {}
  if (!username || !password) return res.status(400).json({ message: 'Логин и пароль обязательны' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[exists]] = await conn.execute('SELECT id FROM users WHERE username = ?', [username])
    if (exists) {
      await conn.rollback()
      return res.status(409).json({ message: 'Пользователь с таким логином уже существует' })
    }
    const roleIds = await resolveRequestedRoleIds(conn, req.body)
    const primaryRoleId = roleIds.includes(toId(req.body?.primary_role_id))
      ? toId(req.body.primary_role_id)
      : roleIds[0]
    const hashed = await bcrypt.hash(password, SALT_ROUNDS)
    const [result] = await conn.execute(
      `
      INSERT INTO users
        (username, password, full_name, email, phone, role_id, is_active, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
      `,
      [username, hashed, toNull(full_name), toNull(email), toNull(phone), primaryRoleId]
    )
    await replaceUserRoles(conn, result.insertId, roleIds, primaryRoleId, req.user.id)
    await recordSecurityEvent({
      executor: conn,
      eventType: 'administration.user_created',
      actorUserId: req.user.id,
      targetUserId: result.insertId,
      entityType: 'user',
      entityId: result.insertId,
      after: { username, role_ids: roleIds, is_active: true, must_change_password: true },
    })
    await conn.commit()
    const users = await loadUsers()
    res.status(201).json(users.find((user) => user.id === result.insertId))
  } catch (error) {
    try { await conn.rollback() } catch {}
    console.error('POST /users error:', error)
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Ошибка сервера при создании пользователя' })
  } finally {
    conn.release()
  }
})

router.put('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор пользователя' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[oldUser]] = await conn.execute('SELECT * FROM users WHERE id = ?', [id])
    if (!oldUser) {
      await conn.rollback()
      return res.status(404).json({ message: 'Пользователь не найден' })
    }
    const [oldRoleRows] = await conn.execute('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY is_primary DESC, role_id', [id])
    const oldRoleIds = oldRoleRows.map((row) => Number(row.role_id))
    const roleIds = await resolveRequestedRoleIds(conn, req.body, oldRoleIds.length ? oldRoleIds : [oldUser.role_id])
    const primaryRoleId = await replaceUserRoles(
      conn,
      id,
      roleIds,
      req.body?.primary_role_id || req.body?.role_id || oldUser.role_id,
      req.user.id
    )
    const username = req.body?.username ?? oldUser.username
    if (!username) throw Object.assign(new Error('Логин не может быть пустым'), { status: 400 })
    await conn.execute(
      `
      UPDATE users
      SET username = ?, full_name = ?, email = ?, phone = ?, role_id = ?
      WHERE id = ?
      `,
      [
        username,
        toNull(req.body?.full_name === '' ? null : req.body?.full_name ?? oldUser.full_name),
        toNull(req.body?.email === '' ? null : req.body?.email ?? oldUser.email),
        toNull(req.body?.phone === '' ? null : req.body?.phone ?? oldUser.phone),
        primaryRoleId,
        id,
      ]
    )
    await recordSecurityEvent({
      executor: conn,
      eventType: 'administration.user_updated',
      actorUserId: req.user.id,
      targetUserId: id,
      entityType: 'user',
      entityId: id,
      before: { username: oldUser.username, role_ids: oldRoleIds },
      after: { username, role_ids: roleIds, primary_role_id: primaryRoleId },
    })
    await conn.commit()
    const users = await loadUsers()
    res.json(users.find((user) => user.id === id))
  } catch (error) {
    try { await conn.rollback() } catch {}
    console.error('PUT /users/:id error:', error)
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Ошибка сервера при обновлении пользователя' })
  } finally {
    conn.release()
  }
})

router.patch('/:id/status', async (req, res) => {
  const id = toId(req.params.id)
  const isActive = req.body?.is_active === true || req.body?.is_active === 1
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор пользователя' })
  if (!isActive && id === Number(req.user.id)) {
    return res.status(409).json({ message: 'Нельзя отключить собственную учетную запись' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[user]] = await conn.execute('SELECT id, is_active FROM users WHERE id = ?', [id])
    if (!user) {
      await conn.rollback()
      return res.status(404).json({ message: 'Пользователь не найден' })
    }
    if (!isActive) {
      const [[targetSuperAdmin]] = await conn.execute(
        `SELECT COUNT(*) AS count FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ? AND r.is_super_admin = 1`,
        [id]
      )
      if (Number(targetSuperAdmin.count) > 0) {
        const [[others]] = await conn.execute(
          `SELECT COUNT(DISTINCT ur.user_id) AS count
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.is_super_admin = 1
           JOIN users u ON u.id = ur.user_id AND u.is_active = 1
           WHERE ur.user_id <> ?`,
          [id]
        )
        if (Number(others.count) === 0) {
          await conn.rollback()
          return res.status(409).json({ message: 'Нельзя отключить последнего активного Super Administrator' })
        }
      }
    }
    await conn.execute(
      'UPDATE users SET is_active = ?, disabled_at = ? WHERE id = ?',
      [isActive ? 1 : 0, isActive ? null : new Date(), id]
    )
    if (!isActive) {
      await conn.execute(
        `UPDATE user_sessions SET status = 'inactive', ended_at = NOW(), is_visible = 0,
          closed_reason = 'account_disabled' WHERE user_id = ? AND status = 'active'`,
        [id]
      )
    }
    await recordSecurityEvent({
      executor: conn,
      eventType: isActive ? 'administration.user_enabled' : 'administration.user_disabled',
      actorUserId: req.user.id,
      targetUserId: id,
      entityType: 'user',
      entityId: id,
      before: { is_active: Number(user.is_active) === 1 },
      after: { is_active: isActive },
    })
    await conn.commit()
    res.json({ id, is_active: isActive })
  } catch (error) {
    try { await conn.rollback() } catch {}
    console.error('PATCH /users/:id/status error:', error)
    res.status(500).json({ message: 'Ошибка изменения статуса пользователя' })
  } finally {
    conn.release()
  }
})

router.post('/:id/reset-password', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор пользователя' })

  const temporaryPassword = crypto.randomBytes(18).toString('base64url')
  const passwordHash = await bcrypt.hash(temporaryPassword, SALT_ROUNDS)
  const terminateSessions = req.body?.terminate_sessions !== false
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[user]] = await conn.execute('SELECT id FROM users WHERE id = ?', [id])
    if (!user) {
      await conn.rollback()
      return res.status(404).json({ message: 'Пользователь не найден' })
    }
    await conn.execute(
      'UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?',
      [passwordHash, id]
    )
    if (terminateSessions) {
      await conn.execute(
        `UPDATE user_sessions SET status = 'inactive', ended_at = NOW(), is_visible = 0,
          closed_reason = 'password_reset' WHERE user_id = ? AND status = 'active'`,
        [id]
      )
    }
    await recordSecurityEvent({
      executor: conn,
      eventType: 'administration.password_reset',
      actorUserId: req.user.id,
      targetUserId: id,
      entityType: 'user',
      entityId: id,
      after: { must_change_password: true, sessions_terminated: terminateSessions },
    })
    await conn.commit()
    res.json({ temporary_password: temporaryPassword, must_change_password: true })
  } catch (error) {
    try { await conn.rollback() } catch {}
    console.error('POST /users/:id/reset-password error:', error)
    res.status(500).json({ message: 'Ошибка сервера при сбросе пароля' })
  } finally {
    conn.release()
  }
})

router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор пользователя' })
  if (id === Number(req.user.id)) return res.status(409).json({ message: 'Нельзя удалить собственную учетную запись' })

  try {
    const access = await resolveEffectiveAccess(id)
    if (!access) return res.status(404).json({ message: 'Пользователь не найден' })
    if (access.is_super_admin) {
      return res.status(409).json({ message: 'Сначала снимите защищенную роль Super Administrator' })
    }
    const preview = await buildTrashPreview('users', id, { current_user_id: req.user.id })
    if (!preview) return res.status(404).json({ message: 'Пользователь не найден' })
    if (preview.mode !== MODE.TRASH) {
      return res.status(409).json({ message: preview.summary?.message || 'Удаление недоступно', preview })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()
      const [[user]] = await conn.execute('SELECT * FROM users WHERE id = ?', [id])
      const trashEntryId = await createTrashEntry({
        executor: conn,
        req,
        entityType: 'users',
        entityId: id,
        rootEntityType: 'users',
        rootEntityId: id,
        deleteMode: 'trash',
        title: user.username || `Пользователь #${id}`,
        subtitle: 'Пользователь',
        snapshot: user,
      })
      await recordSecurityEvent({
        executor: conn,
        eventType: 'administration.user_deleted',
        actorUserId: req.user.id,
        targetUserId: id,
        entityType: 'user',
        entityId: id,
        before: { username: user.username, role_ids: access.role_ids },
      })
      await conn.execute('DELETE FROM users WHERE id = ?', [id])
      await conn.commit()
      res.json({ message: 'Пользователь перемещён в корзину', trash_entry_id: trashEntryId })
    } catch (error) {
      try { await conn.rollback() } catch {}
      throw error
    } finally {
      conn.release()
    }
  } catch (error) {
    console.error('DELETE /users/:id error:', error)
    res.status(500).json({ message: 'Ошибка сервера при удалении пользователя' })
  }
})

module.exports = router
