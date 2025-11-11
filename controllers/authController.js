const db = require('../utils/db')
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')

const SALT_ROUNDS = 10
const RESET_TOKEN_EXPIRATION = 3600000 // 1 час
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key'
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'refresh-secret-key'

const generateAccessToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' })

const generateRefreshToken = (payload) =>
  jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' })

// вспомогательная функция: какие вкладки доступны пользователю
async function getPermissionsForUser(user) {
  let permissions = []

  const isAdmin =
    user.role && typeof user.role === 'string'
      ? user.role.toLowerCase() === 'admin'
      : false

  if (isAdmin) {
    // Админ видит все активные вкладки
    const [tabs] = await db.execute(
      `SELECT id
         FROM tabs
        WHERE is_active = 1`
    )
    permissions = tabs.map((t) => t.id)
  } else {
    // Для остальных ролей берём только те вкладки, где есть право просмотра
    // (доступ к вкладке = полное CRUD на ней)
    const [tabs] = await db.execute(
      `SELECT t.id
         FROM tabs t
         JOIN role_permissions rp ON rp.tab_id = t.id
        WHERE rp.role_id = ?
          AND rp.can_view = 1
          AND t.is_active = 1`,
      [user.role_id]
    )
    permissions = tabs.map((t) => t.id)
  }

  return permissions
}

// 🔐 Вход
const login = async (req, res) => {
  const { username, password } = req.body

  try {
    const [[user]] = await db.execute(
      `SELECT u.id,
              u.username,
              u.full_name,
              u.position,
              u.password,
              u.role_id,
              r.slug AS role
         FROM users u
         JOIN roles r ON u.role_id = r.id
        WHERE u.username = ?`,
      [username]
    )

    if (!user) {
      return res.status(401).json({ message: 'Неверный логин или пароль' })
    }

    const passwordMatch = await bcrypt.compare(password, user.password)
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Неверный логин или пароль' })
    }

    const permissions = await getPermissionsForUser(user)

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      position: user.position,
      role: user.role, // slug роли (например, "admin")
      role_id: user.role_id,
      permissions, // массив id вкладок, с которыми можно работать
    }

    const accessToken = generateAccessToken(payload)
    const refreshToken = generateRefreshToken({ id: user.id })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: false, // true в проде с HTTPS
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })

    res.json({ token: accessToken, userData: payload })
  } catch (err) {
    console.error('Ошибка при логине:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
}

// 🔁 Обновление access-токена
const refreshToken = async (req, res) => {
  const token = req.cookies.refreshToken
  if (!token) {
    return res.status(401).json({ message: 'Нет refresh-токена' })
  }

  try {
    const decoded = jwt.verify(token, REFRESH_SECRET)

    const [[user]] = await db.execute(
      `SELECT u.id,
              u.username,
              u.full_name,
              u.position,
              u.role_id,
              r.slug AS role
         FROM users u
         JOIN roles r ON u.role_id = r.id
        WHERE u.id = ?`,
      [decoded.id]
    )

    if (!user) {
      return res.status(401).json({ message: 'Пользователь не найден' })
    }

    const permissions = await getPermissionsForUser(user)

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      position: user.position,
      role: user.role,
      role_id: user.role_id,
      permissions,
    }

    const newAccessToken = generateAccessToken(payload)
    res.json({ token: newAccessToken })
  } catch (err) {
    return res.status(403).json({ message: 'Недействительный refresh-токен' })
  }
}

const logout = (req, res) => {
  res.clearCookie('refreshToken')
  res.json({ message: 'Выход выполнен' })
}

// Остальное временно отключено
const register = (req, res) =>
  res.status(501).json({ message: 'Регистрация временно отключена' })

const forgotPassword = (req, res) =>
  res.status(501).json({ message: 'Сброс пароля временно отключен' })

const resetPassword = (req, res) =>
  res.status(501).json({ message: 'Сброс пароля временно отключен' })

module.exports = {
  login,
  refreshToken,
  logout,
  register,
  forgotPassword,
  resetPassword,
}
