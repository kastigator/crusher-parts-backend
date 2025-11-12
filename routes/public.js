// routes/publicAdmins.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

/**
 * Публичный маршрут — список активных администраторов.
 * Возвращает только безопасные поля: full_name и email.
 * Доступ открыт без авторизации (для форм обратной связи, справки и т.п.)
 */
router.get('/admins', async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        u.full_name, 
        u.email
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE LOWER(r.name) = 'admin'
        AND u.active = 1
      ORDER BY u.full_name ASC
    `)

    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении администраторов:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
