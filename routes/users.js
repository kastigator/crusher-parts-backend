const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const bcrypt = require('bcrypt');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [users] = await db.execute(`
      SELECT 
        u.id, u.username, u.full_name, u.email, u.phone, u.position, 
        u.role_id, r.name AS role_name, u.created_at
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      ORDER BY u.id
    `);
    res.json(users);
  } catch (err) {
    console.error('Ошибка при получении пользователей:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { username, password, full_name, email, phone, position, role_id } = req.body;
  if (!username || !password || !full_name || !role_id) {
    return res.status(400).json({ message: 'Обязательные поля: username, password, full_name, role_id' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.execute(`
      INSERT INTO users (username, password, full_name, email, phone, position, role_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [username, hash, full_name, email, phone, position, role_id]);
    res.status(201).json({ message: 'Пользователь добавлен' });
  } catch (err) {
    console.error('Ошибка при добавлении пользователя:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { full_name, email, phone, position, role_id } = req.body;
  try {
    await db.execute(`
      UPDATE users
      SET full_name = ?, email = ?, phone = ?, position = ?, role_id = ?
      WHERE id = ?
    `, [full_name, email, phone, position, role_id, req.params.id]);
    res.json({ message: 'Пользователь обновлён' });
  } catch (err) {
    console.error('Ошибка при обновлении пользователя:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: 'Пользователь удалён' });
  } catch (err) {
    console.error('Ошибка при удалении пользователя:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/:id/reset-password', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const newPassword = Math.random().toString(36).slice(-8);
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute('UPDATE users SET password = ? WHERE id = ?', [hash, id]);
    res.json({ message: 'Пароль успешно сброшен', newPassword });
  } catch (err) {
    console.error('Ошибка при сбросе пароля:', err);
    res.status(500).json({ message: 'Ошибка сервера при сбросе пароля' });
  }
});

module.exports = router;
