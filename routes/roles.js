// routes/roles.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { slugify } = require('transliteration')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')
const { buildTrashPreview, MODE } = require('../utils/trashPreview')

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
    return res.status(400).json({ message: 'Некорректный идентификатор' })
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
    return res.status(400).json({ message: 'Некорректный идентификатор' })
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

    const preview = await buildTrashPreview('roles', id)
    if (!preview) {
      await conn.rollback()
      return res.status(404).json({ message: 'Роль не найдена' })
    }
    if (preview.mode !== MODE.TRASH) {
      await conn.rollback()
      return res.status(409).json({
        message: preview.summary?.message || 'Удаление недоступно',
        preview,
      })
    }

    const [permissions] = await conn.execute('SELECT * FROM role_permissions WHERE role_id = ? ORDER BY id ASC', [id])
    const [capabilities] = await conn.execute('SELECT * FROM role_capabilities WHERE role_id = ? ORDER BY id ASC', [id])

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'roles',
      entityId: id,
      rootEntityType: 'roles',
      rootEntityId: id,
      deleteMode: 'trash',
      title: role.name || role.slug || `Роль #${id}`,
      subtitle: 'Роль',
      snapshot: role,
    })

    let sortOrder = 0
    for (const permission of permissions || []) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'role_permissions',
        itemId: permission.id,
        itemRole: 'role_permission',
        title: `Role permission #${permission.id}`,
        snapshot: permission,
        sortOrder: sortOrder++,
      })
    }
    for (const capability of capabilities || []) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'role_capabilities',
        itemId: capability.id,
        itemRole: 'role_capability',
        title: `Role capability #${capability.id}`,
        snapshot: capability,
        sortOrder: sortOrder++,
      })
    }

    await conn.execute('DELETE FROM role_permissions WHERE role_id = ?', [id])
    await conn.execute('DELETE FROM role_capabilities WHERE role_id = ?', [id])
    await conn.execute('DELETE FROM roles WHERE id = ?', [id])

    await conn.commit()

    res.json({ message: 'Роль перемещена в корзину', trash_entry_id: trashEntryId })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch (_) {
        // ignore rollback error and return primary failure
      }
    }
    console.error('Ошибка при удалении роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) conn.release()
  }
})

module.exports = router
