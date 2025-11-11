// routes/publicAdmins.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

// Публичный маршрут: список администраторов (имя и email)
router.get('/admins', async (req, res) => {
  try {
    const [admins] = await db.execute(`
      SELECT u.full_name, u.email
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE LOWER(r.name) = 'admin'
        AND u.active = 1
      ORDER BY u.full_name ASC
    `)
    res.json(admins)
  } catch (err) {
    console.error('Ошибка при получении админов:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
