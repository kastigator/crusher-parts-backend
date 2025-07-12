const express = require('express')
const router = express.Router()
const db = require('../utils/db')

// Публичный маршрут: контакты администраторов
router.get('/admins', async (req, res) => {
  try {
    const [admins] = await db.execute(`
      SELECT full_name, email, phone 
      FROM users 
      WHERE role_id = 1
    `)
    res.json(admins)
  } catch (err) {
    console.error('Ошибка при получении админов:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
