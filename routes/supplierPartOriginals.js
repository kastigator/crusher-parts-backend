const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM supplier_part_originals');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении связей деталей:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { supplier_part_id, original_part_id } = req.body;
  try {
    await db.execute(
      'INSERT INTO supplier_part_originals (supplier_part_id, original_part_id) VALUES (?, ?)',
      [supplier_part_id, original_part_id]
    );
    res.status(201).json({ message: 'Связь добавлена' });
  } catch (err) {
    console.error('Ошибка при добавлении связи:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/', authMiddleware, adminOnly, async (req, res) => {
  const { supplier_part_id, original_part_id } = req.body;
  try {
    await db.execute(
      'DELETE FROM supplier_part_originals WHERE supplier_part_id = ? AND original_part_id = ?',
      [supplier_part_id, original_part_id]
    );
    res.json({ message: 'Связь удалена' });
  } catch (err) {
    console.error('Ошибка при удалении связи:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
