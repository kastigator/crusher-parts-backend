const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM client_bank_details');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении реквизитов:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { client_id, bank_name, account_number } = req.body;
  try {
    await db.execute(
      'INSERT INTO client_bank_details (client_id, bank_name, account_number) VALUES (?, ?, ?)',
      [client_id, bank_name, account_number]
    );
    res.status(201).json({ message: 'Реквизиты добавлены' });
  } catch (err) {
    console.error('Ошибка при добавлении реквизитов:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
