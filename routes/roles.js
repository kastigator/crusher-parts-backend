const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const authMiddleware = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const { slugify } = require('transliteration') // npm i transliteration

// Получение всех ролей
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM roles ORDER BY id ASC')
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении ролей:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// Создание новой роли с генерацией slug
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { name } = req.body
  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Имя роли обязательно' })
  }

  const cleanName = name.trim()
  const slug = slugify(cleanName).toLowerCase()

  try {
    const [existing] = await db.execute(
      'SELECT * FROM roles WHERE name = ? OR slug = ?',
      [cleanName, slug]
    )
    if (existing.length > 0) {
      return res.status(409).json({ message: 'Такая роль уже существует' })
    }

    const [result] = await db.execute(
      'INSERT INTO roles (name, slug) VALUES (?, ?)',
      [cleanName, slug]
    )

    res.status(201).json({ id: result.insertId, name: cleanName, slug })
  } catch (err) {
    console.error('Ошибка при добавлении роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// Обновление имени роли (slug не меняется)
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name } = req.body
  const { id } = req.params

  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Имя обязательно' })
  }

  try {
    await db.execute('UPDATE roles SET name = ? WHERE id = ?', [name.trim(), id])
    res.json({ message: 'Роль обновлена' })
  } catch (err) {
    console.error('Ошибка при обновлении роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// Удаление роли
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM roles WHERE id = ?', [req.params.id])
    res.json({ message: 'Роль удалена' })
  } catch (err) {
    console.error('Ошибка при удалении роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
