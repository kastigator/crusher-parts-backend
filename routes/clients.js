const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM clients');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении клиентов:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { name, inn, phone, email } = req.body;
  try {
    await db.execute(
      'INSERT INTO clients (name, inn, phone, email) VALUES (?, ?, ?, ?)',
      [name, inn, phone, email]
    );
    res.status(201).json({ message: 'Клиент добавлен' });
  } catch (err) {
    console.error('Ошибка при добавлении клиента:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name, inn, phone, email } = req.body;
  try {
    await db.execute(
      'UPDATE clients SET name=?, inn=?, phone=?, email=? WHERE id=?',
      [name, inn, phone, email, req.params.id]
    );
    res.json({ message: 'Клиент обновлён' });
  } catch (err) {
    console.error('Ошибка при обновлении клиента:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM clients WHERE id = ?', [req.params.id]);
    res.json({ message: 'Клиент удалён' });
  } catch (err) {
    console.error('Ошибка при удалении клиента:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
