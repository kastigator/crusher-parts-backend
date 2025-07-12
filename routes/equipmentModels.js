const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM equipment_models ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении моделей:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { name, manufacturer_id } = req.body;
  try {
    await db.execute(
      'INSERT INTO equipment_models (name, manufacturer_id) VALUES (?, ?)',
      [name, manufacturer_id]
    );
    res.status(201).json({ message: 'Модель добавлена' });
  } catch (err) {
    console.error('Ошибка при добавлении модели:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
