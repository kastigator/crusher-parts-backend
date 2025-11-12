// routes/users.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const bcrypt = require('bcrypt')

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const checkTabAccess = require('../middleware/checkTabAccess')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const SALT_ROUNDS = 10
const TAB_PATH = '/users'

// ---------------- helpers ----------------
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)
const safe = (v) => (v === undefined ? null : v)

// ---------------- middleware: require auth globally ----------------
router.use(auth)

// ---------------- ETAG (для баннера изменений) ----------------
router.get('/etag', checkTabAccess(TAB_PATH), async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version),0) AS sum_ver FROM users`
    )
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /users/etag error', e)
    res.status(500).json({ message: 'Ошибка получения etag' })
  }
})

// ---------------- LIST ----------------
router.get('/', checkTabAccess(TAB_PATH), async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.position,
             u.role_id, r.name AS role_name, r.slug AS role_slug,
             u.version, u.created_at, u.updated_at
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      ORDER BY u.id DESC
    `)
    res.json(rows)
  } catch (err) {
    console.error('GET /users error', err)
    res.status(500).json({ message: 'Ошибка при получении пользователей' })
  }
})

// ---------------- GET ONE ----------------
router.get('/:id', checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.position,
             u.role_id, r.name AS role_name, r.slug AS role_slug,
             u.version, u.created_at, u.updated_at
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.id = ?
    `, [id])

    if (!rows.length) return res.status(404).json({ message: 'Пользователь не найден' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /users/:id error', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ---------------- CREATE ----------------
// Обязательные: username, password, role_slug
router.post('/', checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const { username, password, full_name, email, phone, position, role_slug } = req.body || {}

    if (!username || !password || !role_slug) {
      return res.status(400).json({ message: 'Обязательные поля: username, password, role_slug' })
    }

    // уникальность username
    const [[uDupe]] = await db.execute('SELECT id FROM users WHERE username = ?', [username])
    if (uDupe) return res.status(409).json({ type: 'duplicate', field: 'username', message: 'Такой username уже существует' })

    // при желании включите уникальность email
    // if (email) {
    //   const [[eDupe]] = await db.execute('SELECT id FROM users WHERE email = ?', [email])
    //   if (eDupe) return res.status(409).json({ type: 'duplicate', field: 'email', message: 'Такой email уже используется' })
    // }

    const [[role]] = await db.execute('SELECT id FROM roles WHERE slug = ?', [role_slug])
    if (!role) return res.status(400).json({ message: 'Роль не найдена' })

    const hashed = await bcrypt.hash(String(password), SALT_ROUNDS)

    const [ins] = await db.execute(
      `INSERT INTO users (username, password, full_name, email, phone, position, role_id)
       VALUES (?,?,?,?,?,?,?)`,
      [username, hashed, nz(full_name), nz(email), nz(phone), nz(position), role.id]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'users',
      entity_id: ins.insertId,
      comment: `Создан пользователь ${username}`
    })

    res.status(201).json({ id: ins.insertId, message: 'Пользователь создан' })
  } catch (err) {
    console.error('POST /users error', err)
    res.status(500).json({ message: 'Ошибка при создании пользователя' })
  }
})

// ---------------- UPDATE (optimistic by version) ----------------
// Пароль меняется только если передан (UI его НЕ показывает при редактировании — по вашей архитектуре)
router.put('/:id', checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный id' })

  const {
    username, password, full_name, email, phone, position, role_slug, version
  } = req.body || {}

  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM users WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Пользователь не найден' })
    }
    const oldData = oldRows[0]

    // Проверка уникальности username, если изменился
    if (username && username !== oldData.username) {
      const [[dupe]] = await conn.execute('SELECT id FROM users WHERE username=? AND id<>?', [username, id])
      if (dupe) {
        await conn.rollback()
        return res.status(409).json({ type: 'duplicate', field: 'username', message: 'Такой username уже существует' })
      }
    }

    // Уточняем роль
    let role_id = oldData.role_id
    if (role_slug !== undefined) {
      const [[role]] = await conn.execute('SELECT id FROM roles WHERE slug=?', [role_slug])
      if (!role) {
        await conn.rollback()
        return res.status(400).json({ message: 'Роль не найдена' })
      }
      role_id = role.id
    }

    const set = []
    const vals = []
    if (username !== undefined)  { set.push('username=?');  vals.push(nz(username)) }
    if (full_name !== undefined) { set.push('full_name=?'); vals.push(nz(full_name)) }
    if (email !== undefined)     { set.push('email=?');     vals.push(nz(email)) }
    if (phone !== undefined)     { set.push('phone=?');     vals.push(nz(phone)) }
    if (position !== undefined)  { set.push('position=?');  vals.push(nz(position)) }
    if (role_slug !== undefined) { set.push('role_id=?');   vals.push(role_id) }

    if (password) {
      const hashed = await bcrypt.hash(String(password), SALT_ROUNDS)
      set.push('password=?'); vals.push(hashed)
    }

    if (!set.length) {
      await conn.rollback()
      return res.json({ message: 'Нет изменений' })
    }

    // техполя + optimistic
    set.push('version=version+1')
    set.push('updated_at=NOW()')

    const [upd] = await conn.execute(
      `UPDATE users SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, Number(version)]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [[curr]] = await db.execute('SELECT * FROM users WHERE id=?', [id])
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Появились новые изменения. Обновите данные.',
        current: curr || null
      })
    }

    const [[fresh]] = await conn.execute('SELECT * FROM users WHERE id=?', [id])
    await conn.commit()

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh,
      entity_type: 'users',
      entity_id: id,
      // не логируем сам hash пароля
      exclude: ['password']
    })

    res.json({ message: 'Пользователь обновлён' })
  } catch (err) {
    await conn.rollback()
    console.error('PUT /users/:id error', err)
    res.status(500).json({ message: 'Ошибка при обновлении пользователя' })
  } finally {
    conn.release()
  }
})

// ---------------- DELETE (optional ?version=) ----------------
router.delete('/:id', checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный id' })

  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'version must be numeric' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[old]] = await conn.execute('SELECT * FROM users WHERE id=?', [id])
    if (!old) {
      await conn.rollback()
      return res.status(404).json({ message: 'Пользователь не найден' })
    }

    if (version !== undefined && version !== old.version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: old
      })
    }

    const [del] = await conn.execute('DELETE FROM users WHERE id=?', [id])
    if (!del.affectedRows) {
      await conn.rollback()
      return res.status(404).json({ message: 'Пользователь не найден' })
    }

    await conn.commit()

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'users',
      entity_id: id,
      comment: `Удалён пользователь ${old.username}`
    })

    res.json({ message: 'Пользователь удалён' })
  } catch (err) {
    await conn.rollback()
    console.error('DELETE /users/:id error', err)
    res.status(500).json({ message: 'Ошибка при удалении пользователя' })
  } finally {
    conn.release()
  }
})

// ---------------- RESET PASSWORD (admin) ----------------
router.post('/:id/reset-password', checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const provided = nz(req.body?.newPassword)
    const newPassword = provided || Math.random().toString(36).slice(-8)
    const hashed = await bcrypt.hash(String(newPassword), SALT_ROUNDS)

    const [upd] = await db.execute('UPDATE users SET password=?, version=version+1, updated_at=NOW() WHERE id=?', [hashed, id])
    if (!upd.affectedRows) return res.status(404).json({ message: 'Пользователь не найден' })

    await logActivity({
      req,
      action: 'update',
      entity_type: 'users',
      entity_id: id,
      field_changed: 'password_reset',
      old_value: '',
      new_value: '',
      comment: 'Пароль сброшен администратором'
    })

    // Возвращаем новый пароль ТОЛЬКО если он был сгенерирован на сервере
    res.json({ message: 'Пароль сброшен', generated: !provided, newPassword: provided ? undefined : newPassword })
  } catch (err) {
    console.error('POST /users/:id/reset-password error', err)
    res.status(500).json({ message: 'Ошибка при сбросе пароля' })
  }
})

module.exports = router
