const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authenticateToken = require('../middleware/authMiddleware'); // Защита маршрутов с JWT

// Создание нового клиента
router.post('/', authenticateToken, async (req, res) => {
  const { company_name, vat_number, contact_person, email, phone, billing_address } = req.body;
  
  try {
    const [result] = await db.execute(
      'INSERT INTO clients (company_name, vat_number, contact_person, email, phone, billing_address) VALUES (?, ?, ?, ?, ?, ?)',
      [company_name, vat_number, contact_person, email, phone, billing_address]
    );
    res.status(201).json({ message: 'Клиент успешно создан', clientId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Ошибка на сервере' });
  }
});

// Получение списка всех клиентов
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [clients] = await db.execute('SELECT * FROM clients');
    res.status(200).json(clients);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Ошибка на сервере' });
  }
});

// Получение клиента по ID
router.get('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    const [client] = await db.execute('SELECT * FROM clients WHERE id = ?', [id]);
    if (client.length === 0) {
      return res.status(404).json({ message: 'Клиент не найден' });
    }
    res.status(200).json(client[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Ошибка на сервере' });
  }
});

// Обновление клиента по ID
router.put('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { company_name, vat_number, contact_person, email, phone, billing_address } = req.body;

  try {
    const [result] = await db.execute(
      'UPDATE clients SET company_name = ?, vat_number = ?, contact_person = ?, email = ?, phone = ?, billing_address = ? WHERE id = ?',
      [company_name, vat_number, contact_person, email, phone, billing_address, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Клиент не найден' });
    }
    res.status(200).json({ message: 'Данные клиента обновлены' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Ошибка на сервере' });
  }
});

// Удаление клиента по ID
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.execute('DELETE FROM clients WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Клиент не найден' });
    }
    res.status(200).json({ message: 'Клиент удалён' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Ошибка на сервере' });
  }
});

module.exports = router;
