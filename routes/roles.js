const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM roles');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении ролей:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { name } = req.body;
  try {
    await db.execute('INSERT INTO roles (name) VALUES (?)', [name]);
    res.status(201).json({ message: 'Роль добавлена' });
  } catch (err) {
    console.error('Ошибка при добавлении роли:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name } = req.body;
  try {
    await db.execute('UPDATE roles SET name = ? WHERE id = ?', [name, req.params.id]);
    res.json({ message: 'Роль обновлена' });
  } catch (err) {
    console.error('Ошибка при обновлении роли:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM roles WHERE id = ?', [req.params.id]);
    res.json({ message: 'Роль удалена' });
  } catch (err) {
    console.error('Ошибка при удалении роли:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
