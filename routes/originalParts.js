const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM original_parts ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении оригинальных деталей:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { cat_number, description, manufacturer_id, equipment_model_id, tnved_code, is_assembly } = req.body;
  try {
    await db.execute(
      'INSERT INTO original_parts (cat_number, description, manufacturer_id, equipment_model_id, tnved_code, is_assembly) VALUES (?, ?, ?, ?, ?, ?)',
      [cat_number, description, manufacturer_id, equipment_model_id, tnved_code, is_assembly ? 1 : 0]
    );
    res.status(201).json({ message: 'Деталь добавлена' });
  } catch (err) {
    console.error('Ошибка при добавлении оригинальной детали:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { cat_number, description, manufacturer_id, equipment_model_id, tnved_code, is_assembly } = req.body;
  try {
    await db.execute(
      'UPDATE original_parts SET cat_number=?, description=?, manufacturer_id=?, equipment_model_id=?, tnved_code=?, is_assembly=? WHERE id=?',
      [cat_number, description, manufacturer_id, equipment_model_id, tnved_code, is_assembly ? 1 : 0, req.params.id]
    );
    res.json({ message: 'Деталь обновлена' });
  } catch (err) {
    console.error('Ошибка при обновлении оригинальной детали:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM original_parts WHERE id = ?', [req.params.id]);
    res.json({ message: 'Деталь удалена' });
  } catch (err) {
    console.error('Ошибка при удалении оригинальной детали:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
