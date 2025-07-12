const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM supplier_part_prices');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении цен:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { supplier_part_id, price, date } = req.body;
  try {
    await db.execute(
      'INSERT INTO supplier_part_prices (supplier_part_id, price, date) VALUES (?, ?, ?)',
      [supplier_part_id, price, date]
    );
    res.status(201).json({ message: 'Цена добавлена' });
  } catch (err) {
    console.error('Ошибка при добавлении цены:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
