const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

// утилита для безопасных значений
const safe = (v) => v === undefined ? null : v;

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
  const {
    client_id, bank_name, account_number, iban, bic,
    currency, correspondent_account, bank_address, additional_info
  } = req.body;

  if (!client_id || !bank_name || !account_number) {
    return res.status(400).json({ message: 'client_id, bank_name и account_number обязательны' });
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO client_bank_details (
        client_id, bank_name, account_number, iban, bic,
        currency, correspondent_account, bank_address, additional_info
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        safe(client_id), safe(bank_name), safe(account_number), safe(iban), safe(bic),
        safe(currency), safe(correspondent_account), safe(bank_address), safe(additional_info)
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('Ошибка при добавлении реквизитов:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const {
    bank_name, account_number, iban, bic,
    currency, correspondent_account, bank_address, additional_info
  } = req.body;

  try {
    await db.execute(
      `UPDATE client_bank_details
       SET bank_name=?, account_number=?, iban=?, bic=?, currency=?,
           correspondent_account=?, bank_address=?, additional_info=?
       WHERE id=?`,
      [
        safe(bank_name), safe(account_number), safe(iban), safe(bic),
        safe(currency), safe(correspondent_account), safe(bank_address), safe(additional_info),
        req.params.id
      ]
    );
    res.json({ message: 'Реквизиты обновлены' });
  } catch (err) {
    console.error('Ошибка при обновлении реквизитов:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM client_bank_details WHERE id = ?', [req.params.id]);
    res.json({ message: 'Реквизиты удалены' });
  } catch (err) {
    console.error('Ошибка при удалении реквизитов:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

module.exports = router;
