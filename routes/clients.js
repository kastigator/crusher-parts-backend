const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

// Утилита для безопасного значений: undefined → null
const safe = (v) => v === undefined ? null : v;

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
  const {
    company_name, registration_number, tax_id,
    contact_person, phone, email, website, notes
  } = req.body;

  if (!company_name) {
    return res.status(400).json({ message: 'company_name обязателен' });
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO clients (
        company_name, registration_number, tax_id,
        contact_person, phone, email, website, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        safe(company_name),
        safe(registration_number),
        safe(tax_id),
        safe(contact_person),
        safe(phone),
        safe(email),
        safe(website),
        safe(notes)
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('Ошибка при добавлении клиента:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const {
    company_name, registration_number, tax_id,
    contact_person, phone, email, website, notes
  } = req.body;

  try {
    await db.execute(
      `UPDATE clients SET
        company_name = ?, registration_number = ?, tax_id = ?,
        contact_person = ?, phone = ?, email = ?, website = ?, notes = ?
       WHERE id = ?`,
      [
        safe(company_name),
        safe(registration_number),
        safe(tax_id),
        safe(contact_person),
        safe(phone),
        safe(email),
        safe(website),
        safe(notes),
        req.params.id
      ]
    );
    res.json({ message: 'Клиент обновлён' });
  } catch (err) {
    console.error('Ошибка при обновлении клиента:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM clients WHERE id = ?', [req.params.id]);
    res.json({ message: 'Клиент удалён' });
  } catch (err) {
    console.error('Ошибка при удалении клиента:', err);
    res.status(500).json({ message: 'Ошибка сервера', error: err.message });
  }
});

module.exports = router;
