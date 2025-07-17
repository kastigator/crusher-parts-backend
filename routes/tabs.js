const express = require('express')
const router = express.Router()
const pool = require('../utils/db')
const authMiddleware = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// Получение всех вкладок
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM tabs ORDER BY sort_order ASC')
    res.json(rows)
  } catch (err) {
    console.error('Ошибка получения вкладок:', err)
    res.status(500).send('Ошибка сервера')
  }
})

// Обновление порядка вкладок — ВАЖНО: стоит выше чем `/:id`
router.put('/order', authMiddleware, adminOnly, async (req, res) => {
  try {
    const updates = req.body // ожидаем [{ id, sort_order }]
    console.log('📥 PUT /tabs/order payload:', JSON.stringify(updates, null, 2))

    if (!Array.isArray(updates)) {
      return res.status(400).json({ message: 'Ожидается массив' })
    }

    for (const item of updates) {
      if (
        typeof item.id !== 'number' ||
        typeof item.sort_order !== 'number'
      ) {
        console.warn('❌ Некорректный элемент в массиве:', item)
        return res.status(400).json({ message: 'Элементы должны содержать числовые поля id и sort_order' })
      }
    }

    const promises = updates.map(({ id, sort_order }) =>
      pool.execute('UPDATE tabs SET sort_order = ? WHERE id = ?', [sort_order, id])
    )

    await Promise.all(promises)

    console.log('✅ Порядок вкладок успешно обновлён')
    res.sendStatus(200)
  } catch (err) {
    console.error('❌ Ошибка обновления порядка вкладок:', err)
    res.status(500).send('Ошибка сервера')
  }
})

// Добавление новой вкладки
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, tab_name, path, icon } = req.body

    const [[{ maxOrder }]] = await pool.execute('SELECT MAX(sort_order) AS maxOrder FROM tabs')
    const sort_order = (maxOrder ?? 0) + 1

    await pool.execute(
      'INSERT INTO tabs (name, tab_name, path, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
      [name, tab_name, path, icon || null, sort_order]
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
    let { name, tab_name, path, icon, sort_order } = req.body
    const { id } = req.params

    if (typeof icon === 'undefined') icon = null
    if (typeof sort_order !== 'number') sort_order = 0

    console.log('📥 PUT /tabs/:id body:', req.body)

    await pool.execute(
      'UPDATE tabs SET name = ?, tab_name = ?, path = ?, icon = ?, sort_order = ? WHERE id = ?',
      [name, tab_name, path, icon, sort_order, id]
    )

    res.sendStatus(200)
  } catch (err) {
    console.error('❌ Ошибка обновления вкладки:', err)
    res.status(500).send('Ошибка сервера')
  }
})

// Удаление вкладки с удалением связанных прав
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params

    await pool.execute('DELETE FROM role_permissions WHERE tab_id = ?', [id])
    const [result] = await pool.execute('DELETE FROM tabs WHERE id = ?', [id])

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Вкладка не найдена' })
    }

    res.status(200).json({ message: 'Вкладка и связанные права удалены' })
  } catch (err) {
    console.error('Ошибка удаления вкладки:', err)
    res.status(500).send('Ошибка сервера')
  }
})

module.exports = router
