const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM client_billing_addresses');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении адресов:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { client_id, address } = req.body;
  try {
    await db.execute(
      'INSERT INTO client_billing_addresses (client_id, address) VALUES (?, ?)',
      [client_id, address]
    );
    res.status(201).json({ message: 'Адрес добавлен' });
  } catch (err) {
    console.error('Ошибка при добавлении адреса:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
