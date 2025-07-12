const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM equipment_manufacturers ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении производителей:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { name } = req.body;
  try {
    await db.execute('INSERT INTO equipment_manufacturers (name) VALUES (?)', [name]);
    res.status(201).json({ message: 'Производитель добавлен' });
  } catch (err) {
    console.error('Ошибка при добавлении производителя:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
