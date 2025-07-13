const express = require('express')
const router = express.Router()
const pool = require('../utils/db') // ← правильно подключаем pool из utils/db.js
const authMiddleware = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// Получение всех вкладок
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM tabs ORDER BY `order` ASC')
    res.json(rows)
  } catch (err) {
    console.error('Ошибка получения вкладок:', err)
    res.status(500).send('Ошибка сервера')
  }
})

// Добавление новой вкладки
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, tab_name, path, icon } = req.body

    const [[{ maxOrder }]] = await pool.execute('SELECT MAX(`order`) AS maxOrder FROM tabs')
    const order = (maxOrder ?? 0) + 1

    await pool.execute(
      'INSERT INTO tabs (name, tab_name, path, icon, `order`) VALUES (?, ?, ?, ?, ?)',
      [name, tab_name, path, icon, order]
    )

    res.sendStatus(201)
  } catch (err) {
    console.error('Ошибка добавления вкладки:', err)
    res.status(500).send('Ошибка сервера')
  }
})

// Обновление вкладки
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, tab_name, path, icon } = req.body
    const { id } = req.params

    await pool.execute(
      'UPDATE tabs SET name = ?, tab_name = ?, path = ?, icon = ? WHERE id = ?',
      [name, tab_name, path, icon, id]
    )

    res.sendStatus(200)
  } catch (err) {
    console.error('Ошибка обновления вкладки:', err)
    res.status(500).send('Ошибка сервера')
  }
})

// Удаление вкладки
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params
    await pool.execute('DELETE FROM tabs WHERE id = ?', [id])
    res.sendStatus(200)
  } catch (err) {
    console.error('Ошибка удаления вкладки:', err)
    res.status(500).send('Ошибка сервера')
  }
})

// Обновление порядка вкладок
router.put('/order', authMiddleware, adminOnly, async (req, res) => {
  try {
    const updates = req.body // [{ id, order }]
    const promises = updates.map(({ id, order }) =>
      pool.execute('UPDATE tabs SET `order` = ? WHERE id = ?', [order, id])
    )
    await Promise.all(promises)
    res.sendStatus(200)
  } catch (err) {
    console.error('Ошибка обновления порядка вкладок:', err)
    res.status(500).send('Ошибка сервера')
  }
})

module.exports = router
