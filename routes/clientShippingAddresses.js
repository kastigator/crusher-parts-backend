const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

const safe = (v) => v === undefined ? null : v;

// Получение всех адресов доставки
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT id, client_id, label, formatted_address, postal_code, comment
      FROM client_shipping_addresses
    `);
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении адресов доставки:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Добавление нового адреса доставки
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { client_id, label, formatted_address, postal_code, comment } = req.body;

  if (!client_id || !formatted_address) {
    return res.status(400).json({
      message: 'Обязательные поля: client_id и formatted_address'
    });
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO client_shipping_addresses (
        client_id, label, formatted_address, postal_code, comment
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        safe(client_id),
        safe(label),
        safe(formatted_address),
        safe(postal_code),
        safe(comment)
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('Ошибка при добавлении адреса доставки:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

// Обновление адреса доставки
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { label, formatted_address, postal_code, comment } = req.body;

  try {
    await db.execute(
      `UPDATE client_shipping_addresses
       SET label = ?, formatted_address = ?, postal_code = ?, comment = ?
       WHERE id = ?`,
      [
        safe(label),
        safe(formatted_address),
        safe(postal_code),
        safe(comment),
        req.params.id
      ]
    );
    res.json({ message: 'Адрес доставки обновлён' });
  } catch (err) {
    console.error('Ошибка при обновлении адреса доставки:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

// Удаление адреса доставки
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM client_shipping_addresses WHERE id = ?', [req.params.id]);
    res.json({ message: 'Адрес доставки удалён' });
  } catch (err) {
    console.error('Ошибка при удалении адреса доставки:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

module.exports = router;
