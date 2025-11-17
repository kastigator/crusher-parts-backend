// routes/roles.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { slugify } = require('transliteration')

// маленький helper
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

// Получение всех ролей
// ВАЖНО: защита (auth/admin/tabAccess) теперь вешается в routerIndex
router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM roles ORDER BY id ASC')
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении ролей:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// Создание новой роли с генерацией slug
router.post('/', async (req, res) => {
  const { name } = req.body
  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Имя роли обязательно' })
  }

  const cleanName = name.trim()
  let slug = slugify(cleanName).toLowerCase().replace(/\s+/g, '_')

  // на всякий случай: если transliteration дала пустую строку
  if (!slug) {
    slug = cleanName.toLowerCase().replace(/\s+/g, '_')
  }

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

// Обновление имени роли
router.put('/:id', async (req, res) => {
  const { name } = req.body
  const id = toId(req.params.id)

  if (!id) {
    return res.status(400).json({ message: 'Некорректный id' })
  }
  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Имя обязательно' })
  }

  try {
    const [[role]] = await db.execute('SELECT * FROM roles WHERE id = ?', [id])
    if (!role) {
      return res.status(404).json({ message: 'Роль не найдена' })
    }

    // Запрещаем менять admin (по slug)
    if (role.slug === 'admin') {
      return res.status(400).json({ message: 'Нельзя изменять роль admin' })
    }

    const cleanName = name.trim()

    // Проверяем, что нет другой роли с таким именем
    const [exists] = await db.execute(
      'SELECT id FROM roles WHERE name = ? AND id <> ?',
      [cleanName, id]
    )
    if (exists.length) {
      return res.status(409).json({ message: 'Роль с таким именем уже существует' })
    }

    await db.execute('UPDATE roles SET name = ? WHERE id = ?', [cleanName, id])

    res.json({ message: 'Роль обновлена', id, name: cleanName, slug: role.slug })
  } catch (err) {
    console.error('Ошибка при обновлении роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// Удаление роли с удалением зависимостей
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) {
    return res.status(400).json({ message: 'Некорректный id' })
  }

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[role]] = await conn.execute('SELECT * FROM roles WHERE id = ?', [id])
    if (!role) {
      await conn.rollback()
      return res.status(404).json({ message: 'Роль не найдена' })
    }

    // Нельзя удалять admin
    if (role.slug === 'admin') {
      await conn.rollback()
      return res.status(400).json({ message: 'Нельзя удалить роль admin' })
    }

    // 1. Удаляем все права этой роли
    await conn.execute('DELETE FROM role_permissions WHERE role_id = ?', [id])

    // 2. Удаляем саму роль
    await conn.execute('DELETE FROM roles WHERE id = ?', [id])

    await conn.commit()

    res.json({ message: 'Роль удалена' })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch (_) {}
    }
    console.error('Ошибка при удалении роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) conn.release()
  }
})

module.exports = router
