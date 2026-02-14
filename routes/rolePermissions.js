// routes/rolePermissions.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

/**
 * ВНИМАНИЕ:
 * Все проверки доступа (auth/admin/requireTabAccess) должны
 * навешиваться снаружи в routerIndex.js
 */

// 🔍 Группированный ответ (по slug) — для Sidebar/аналитики
router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT r.slug, r.name AS role, rp.tab_id
      FROM roles r
      LEFT JOIN role_permissions rp 
        ON rp.role_id = r.id AND rp.can_view = 1
      WHERE r.slug <> 'admin'
      ORDER BY r.name
    `)

    const roleMap = {}
    for (const row of rows) {
      if (!roleMap[row.slug]) {
        roleMap[row.slug] = { role: row.role, slug: row.slug, tab_ids: [] }
      }
      if (row.tab_id) roleMap[row.slug].tab_ids.push(row.tab_id)
    }

    res.json(Object.values(roleMap))
  } catch (err) {
    console.error('Ошибка при получении прав доступа:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// 🔍 RAW-права: role_id, tab_id, can_view
router.get('/raw', async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT id, role_id, tab_id, can_view
      FROM role_permissions
    `)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении прав (raw):', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// 🔁 Обновление всех прав сразу (присутствие записи = доступ)
router.put('/', async (req, res) => {
  const permissions = req.body
  if (!Array.isArray(permissions)) {
    return res.status(400).json({ message: 'Ожидается массив permissions' })
  }

  for (const perm of permissions) {
    if (
      typeof perm.role_id !== 'number' ||
      typeof perm.tab_id !== 'number' ||
      (perm.can_view !== 0 && perm.can_view !== 1)
    ) {
      return res.status(400).json({ message: 'Неверный формат данных в permissions' })
    }
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    for (const { role_id, tab_id, can_view } of permissions) {
      await conn.execute(
        'DELETE FROM role_permissions WHERE role_id = ? AND tab_id = ?',
        [role_id, tab_id]
      )
      if (can_view === 1) {
        await conn.execute(
          'INSERT INTO role_permissions (role_id, tab_id, can_view) VALUES (?, ?, 1)',
          [role_id, tab_id]
        )
      }
    }

    await conn.commit()
    res.json({ message: 'Права успешно обновлены' })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при обновлении прав ролей:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

// 🔍 Получение вкладок по роли (учёт admin)
router.get('/:roleName/permissions', async (req, res) => {
  const roleName = String(req.params.roleName || '').toLowerCase()
  try {
    const [[role]] = await db.execute(
      'SELECT id, slug FROM roles WHERE LOWER(slug) = ?',
      [roleName]
    )
    if (!role) return res.status(404).json({ message: 'Роль не найдена' })

    let rows
    if (role.slug === 'admin') {
      ;[rows] = await db.execute(`
        SELECT id AS tab_id, name AS tab_name, path, icon, is_active, 1 AS can_view
        FROM tabs
        WHERE is_active = 1
        ORDER BY sort_order, id
      `)
    } else {
      ;[rows] = await db.execute(
        `
        SELECT t.id AS tab_id, t.name AS tab_name, t.path, t.icon, t.is_active, rp.can_view
        FROM tabs t
        INNER JOIN role_permissions rp ON rp.tab_id = t.id AND rp.role_id = ?
        WHERE t.is_active = 1 AND rp.can_view = 1
        ORDER BY t.sort_order, t.id
        `,
        [role.id]
      )
    }

    res.json(rows || [])
  } catch (err) {
    console.error('Ошибка при получении прав роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ➕ Добавление роли
router.post('/', async (req, res) => {
  const { role } = req.body || {}
  if (!role || typeof role !== 'string') {
    return res.status(400).json({ message: 'role (имя роли) обязательно' })
  }

  try {
    const slug = role.toLowerCase().replace(/\s+/g, '_')
    const [[exists]] = await db.execute('SELECT id FROM roles WHERE slug = ?', [slug])
    if (exists) return res.status(400).json({ message: 'Роль уже существует' })

    const [result] = await db.execute(
      'INSERT INTO roles (name, slug) VALUES (?, ?)',
      [role, slug]
    )
    res.status(201).json({ id: result.insertId, role, slug, tab_ids: [] })
  } catch (err) {
    console.error('Ошибка при добавлении роли:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ✅ Обновление одного права (по id записи role_permissions)
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { can_view } = req.body || {}

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор' })
  }
  if (typeof can_view !== 'number' || (can_view !== 0 && can_view !== 1)) {
    return res.status(400).json({ message: 'Некорректное значение can_view' })
  }

  try {
    if (can_view === 1) {
      await db.execute('UPDATE role_permissions SET can_view = 1 WHERE id = ?', [id])
    } else {
      await db.execute('DELETE FROM role_permissions WHERE id = ?', [id])
    }
    res.json({ message: 'Право доступа обновлено' })
  } catch (err) {
    console.error('Ошибка при обновлении права:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ⛳ Массовое обновление прав по роли (по slug роли)
router.put('/by-role/:role', async (req, res) => {
  const roleSlug = String(req.params.role || '').toLowerCase()
  const permissions = req.body

  if (!Array.isArray(permissions)) {
    return res.status(400).json({ message: 'Некорректные данные' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[roleRow]] = await conn.execute('SELECT id FROM roles WHERE slug = ?', [roleSlug])
    if (!roleRow) {
      await conn.rollback()
      return res.status(404).json({ message: 'Роль не найдена' })
    }

    const roleId = roleRow.id
    await conn.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId])

    for (const perm of permissions) {
      const tabId = Number(perm.tab_id)
      const canView = perm.can_view ? 1 : 0
      if (!Number.isFinite(tabId) || !canView) continue

      await conn.execute(
        'INSERT INTO role_permissions (role_id, tab_id, can_view) VALUES (?, ?, 1)',
        [roleId, tabId]
      )
    }

    await conn.commit()
    res.json({ message: 'Права успешно сохранены' })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при сохранении прав:', err)
    res.status(500).json({ message: 'Ошибка при сохранении прав' })
  } finally {
    conn.release()
  }
})

module.exports = router
