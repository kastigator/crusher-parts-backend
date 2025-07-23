const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

// 🔍 Группированный ответ (по slug) — используется в Sidebar или аналитике
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT r.slug, r.name as role, rp.tab_id
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.can_view = 1
      WHERE r.slug != 'admin'
      ORDER BY r.name
    `)

    const roleMap = {}
    for (const row of rows) {
      if (!roleMap[row.slug]) {
        roleMap[row.slug] = {
          role: row.role,
          slug: row.slug,
          tab_ids: []
        }
      }
      if (row.tab_id) {
        roleMap[row.slug].tab_ids.push(row.tab_id)
      }
    }

    const result = Object.values(roleMap)
    res.json(result)
  } catch (err) {
    console.error('Ошибка при получении прав доступа:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// 🔍 RAW-права: role_id, tab_id, can_view (используется в чекбоксах)
router.get('/raw', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT role_id, tab_id, can_view
      FROM role_permissions
    `)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении прав доступа (raw):', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// 🔁 Обновление всех прав сразу
router.put('/', authMiddleware, adminOnly, async (req, res) => {
  const permissions = req.body;

  if (!Array.isArray(permissions)) {
    return res.status(400).json({ message: 'Ожидается массив permissions' });
  }

  for (const perm of permissions) {
    if (
      typeof perm.role_id !== 'number' ||
      typeof perm.tab_id !== 'number' ||
      (perm.can_view !== 0 && perm.can_view !== 1)
    ) {
      return res.status(400).json({ message: 'Неверный формат данных в permissions' });
    }
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    for (const { role_id, tab_id, can_view } of permissions) {
      await connection.execute(
        'DELETE FROM role_permissions WHERE role_id = ? AND tab_id = ?',
        [role_id, tab_id]
      );

      if (can_view === 1) {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, tab_id, can_view) VALUES (?, ?, 1)',
          [role_id, tab_id]
        );
      }
    }

    await connection.commit();
    res.json({ message: 'Права успешно обновлены' });
  } catch (err) {
    await connection.rollback();
    console.error('Ошибка при обновлении прав ролей:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  } finally {
    connection.release();
  }
});

// 🔍 Получение вкладок по роли
router.get('/:roleName/permissions', authMiddleware, adminOnly, async (req, res) => {
  const { roleName } = req.params;
  try {
    const [[role]] = await db.execute('SELECT id, slug FROM roles WHERE LOWER(slug) = ?', [roleName.toLowerCase()]);
    if (!role) return res.status(404).json({ message: 'Роль не найдена' });

    let tabs;
    if (role.slug === 'admin') {
      [tabs] = await db.execute(`
        SELECT id as tab_id, name as tab_name, path, icon, is_active, 1 as can_view
        FROM tabs
        WHERE is_active = 1
        ORDER BY \`order\`, id
      `);
    } else {
      [tabs] = await db.execute(`
        SELECT t.id as tab_id, t.name as tab_name, t.path, t.icon, t.is_active, rp.can_view
        FROM tabs t
        INNER JOIN role_permissions rp ON rp.tab_id = t.id AND rp.role_id = ?
        WHERE t.is_active = 1 AND rp.can_view = 1
        ORDER BY t.\`order\`, t.id
      `, [role.id]);
    }

    res.json(tabs || []);
  } catch (err) {
    console.error('Ошибка при получении прав роли:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ⬇️ Добавление одной записи
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { role } = req.body;
  if (!role || typeof role !== 'string') {
    return res.status(400).json({ message: 'role (имя роли) обязательно' });
  }

  try {
    const slug = role.toLowerCase().replace(/\s+/g, '_');
    const [[exists]] = await db.execute('SELECT id FROM roles WHERE slug = ?', [slug]);
    if (exists) {
      return res.status(400).json({ message: 'Роль уже существует' });
    }

    const [result] = await db.execute(
      'INSERT INTO roles (name, slug) VALUES (?, ?)',
      [role, slug]
    );

    res.status(201).json({
      id: result.insertId,
      role,
      slug,
      tab_ids: []
    });
  } catch (err) {
    console.error('Ошибка при добавлении роли:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ✅ Обновление одного права
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { can_view } = req.body;

  if (typeof can_view !== 'number' || (can_view !== 0 && can_view !== 1)) {
    return res.status(400).json({ message: 'Некорректное значение can_view' });
  }

  try {
    await db.execute(
      'UPDATE role_permissions SET can_view = ? WHERE id = ?',
      [can_view, id]
    );
    res.json({ message: 'Право доступа обновлено' });
  } catch (err) {
    console.error('Ошибка при обновлении права:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ⬇️ Массовое обновление прав по имени роли
router.put('/by-role/:role', authMiddleware, adminOnly, async (req, res) => {
  const { role } = req.params;
  const permissions = req.body;

  if (!Array.isArray(permissions)) {
    return res.status(400).json({ message: 'Некорректные данные' });
  }

  try {
    const [[roleRow]] = await db.execute('SELECT id FROM roles WHERE slug = ?', [role]);
    if (!roleRow) return res.status(404).json({ message: 'Роль не найдена' });

    const roleId = roleRow.id;

    await db.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);

    for (const perm of permissions) {
      await db.execute(
        'INSERT INTO role_permissions (role_id, tab_id, can_view) VALUES (?, ?, ?)',
        [roleId, perm.tab_id, perm.can_view ? 1 : 0]
      );
    }

    res.json({ message: 'Права успешно сохранены' });
  } catch (err) {
    console.error('Ошибка при сохранении прав:', err);
    res.status(500).json({ message: 'Ошибка при сохранении прав' });
  }
});

module.exports = router;
