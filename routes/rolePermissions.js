const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

// 🔍 Получение всех прав
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT rp.id, rp.role_id, rp.tab_id, rp.can_view, r.name as role_name
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      WHERE r.slug != 'admin'
    `);
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении прав доступа:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// 🔁 Универсальное обновление массива прав
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

// 🔍 Получение вкладок с правами по имени роли
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

// ⬇️ Ручное добавление одной записи
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { role_id, tab_id, can_view = 0 } = req.body;
  if (typeof role_id !== 'number' || typeof tab_id !== 'number') {
    return res.status(400).json({ message: 'role_id и tab_id обязательны и должны быть числами' });
  }
  try {
    const [result] = await db.execute(
      'INSERT INTO role_permissions (role_id, tab_id, can_view) VALUES (?, ?, ?)',
      [role_id, tab_id, can_view]
    );
    res.status(201).json({
      id: result.insertId,
      role_id,
      tab_id,
      can_view
    });
  } catch (err) {
    console.error('Ошибка при добавлении разрешения:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ✅ Обновление конкретной записи по ID (используется для togglePermission)
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

// ⬇️ Массовое обновление по имени роли (ранее конфликтовал путь)
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
