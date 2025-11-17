// routes/users.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const bcrypt = require('bcrypt')

// Здесь adminOnly уже навешан в routerIndex.js:
// router.use('/users', auth, adminOnly, require('./users'))

const SALT_ROUNDS = 10

// ----------------- helpers -----------------
const toNull = (v) => (v === '' || v === undefined ? null : v)

// Получить роль по slug, если нужно
async function resolveRoleId(role_id, role_slug) {
  if (role_id) return Number(role_id)

  if (role_slug) {
    const [[role]] = await db.execute('SELECT id FROM roles WHERE slug = ?', [role_slug])
    if (!role) {
      throw new Error(`role_slug '${role_slug}' not found`)
    }
    return role.id
  }

  return null
}

// ----------------- Список пользователей -----------------
// GET /users
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT u.id,
              u.username,
              u.full_name,
              u.email,
              u.phone,
              u.role_id,
              r.name  AS role_name,
              r.slug  AS role
         FROM users u
         JOIN roles r ON u.role_id = r.id
        ORDER BY u.id`
    )

    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении пользователей:', err)
    res.status(500).json({ message: 'Ошибка сервера при получении пользователей' })
  }
})

// ----------------- Создание пользователя -----------------
// POST /users
router.post('/', async (req, res) => {
  try {
    const {
      username,
      password,
      full_name,
      email,
      phone,
      role_id,
      role_slug,
    } = req.body || {}

    if (!username || !password) {
      return res.status(400).json({
        message: 'Логин и пароль обязательны',
      })
    }

    const roleId = await resolveRoleId(role_id, role_slug)
    if (!roleId) {
      return res.status(400).json({
        message: 'Не указана роль (role_id или role_slug)',
      })
    }

    // проверка на дубликат логина
    const [[exists]] = await db.execute('SELECT id FROM users WHERE username = ?', [username])
    if (exists) {
      return res
        .status(409)
        .json({ message: 'Пользователь с таким логином уже существует' })
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS)

    const [result] = await db.execute(
      `INSERT INTO users
         (username, password, full_name, email, phone, role_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [username, hashed, toNull(full_name), toNull(email), toNull(phone), roleId]
    )

    const newId = result.insertId

    const [[created]] = await db.execute(
      `SELECT u.id,
              u.username,
              u.full_name,
              u.email,
              u.phone,
              u.role_id,
              r.name AS role_name,
              r.slug AS role
         FROM users u
         JOIN roles r ON u.role_id = r.id
        WHERE u.id = ?`,
      [newId]
    )

    res.status(201).json(created)
  } catch (err) {
    console.error('Ошибка при создании пользователя:', err)
    res.status(500).json({ message: 'Ошибка сервера при создании пользователя' })
  }
})

// ----------------- Обновление пользователя -----------------
// PUT /users/:id
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный id пользователя' })
  }

  try {
    // Берём текущую запись, чтобы не было undefined
    const [[oldUser]] = await db.execute('SELECT * FROM users WHERE id = ?', [id])

    if (!oldUser) {
      return res.status(404).json({ message: 'Пользователь не найден' })
    }

    const {
      username,
      full_name,
      email,
      phone,
      role_id,
      role_slug,
    } = req.body || {}

    const finalRoleId = (await resolveRoleId(role_id, role_slug)) || oldUser.role_id

    const newUsername = username ?? oldUser.username
    const newFullName = full_name === '' ? null : full_name ?? oldUser.full_name
    const newEmail = email === '' ? null : email ?? oldUser.email
    const newPhone = phone === '' ? null : phone ?? oldUser.phone

    if (!newUsername) {
      return res.status(400).json({ message: 'Логин не может быть пустым' })
    }

    await db.execute(
      `UPDATE users
          SET username = ?,
              full_name = ?,
              email = ?,
              phone = ?,
              role_id = ?
        WHERE id = ?`,
      [newUsername, toNull(newFullName), toNull(newEmail), toNull(newPhone), finalRoleId, id]
    )

    const [[updated]] = await db.execute(
      `SELECT u.id,
              u.username,
              u.full_name,
              u.email,
              u.phone,
              u.role_id,
              r.name AS role_name,
              r.slug AS role
         FROM users u
         JOIN roles r ON u.role_id = r.id
        WHERE u.id = ?`,
      [id]
    )

    res.json(updated)
  } catch (err) {
    console.error('Ошибка при обновлении пользователя:', err)
    res.status(500).json({ message: 'Ошибка сервера при обновлении пользователя' })
  }
})

// ----------------- Удаление пользователя -----------------
// DELETE /users/:id
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный id пользователя' })
  }

  try {
    const [[user]] = await db.execute('SELECT * FROM users WHERE id = ?', [id])
    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' })
    }

    await db.execute('DELETE FROM users WHERE id = ?', [id])
    res.json({ message: 'Пользователь удалён' })
  } catch (err) {
    console.error('Ошибка при удалении пользователя:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении пользователя' })
  }
})

// ----------------- Сброс пароля -----------------
// POST /users/:id/reset-password
router.post('/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный id пользователя' })
  }

  try {
    const [[user]] = await db.execute('SELECT * FROM users WHERE id = ?', [id])
    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' })
    }

    const newPasswordPlain = Math.random().toString(36).slice(-8)
    const newHash = await bcrypt.hash(newPasswordPlain, SALT_ROUNDS)

    await db.execute('UPDATE users SET password = ? WHERE id = ?', [newHash, id])

    res.json({ newPassword: newPasswordPlain })
  } catch (err) {
    console.error('Ошибка при сбросе пароля:', err)
    res.status(500).json({ message: 'Ошибка сервера при сбросе пароля' })
  }
})

module.exports = router
