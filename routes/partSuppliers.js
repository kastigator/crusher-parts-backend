const express = require('express');
const db = require('../utils/db');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');

// Для импорта CSV:
const csvParser = require('csv-parser');
const multer = require('multer');
const upload = multer();
const stream = require('stream');

// 🔓 Получить всех поставщиков
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM part_suppliers ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка сервера при получении поставщиков:', err);
    res.status(500).json({ message: 'Ошибка сервера при получении поставщиков' });
  }
});

// 🔓 Получить одного поставщика
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM part_suppliers WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Поставщик не найден' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Ошибка сервера при получении поставщика:', err);
    res.status(500).json({ message: 'Ошибка сервера при получении поставщика' });
  }
});

// 🔐 Добавить поставщика
router.post('/', authMiddleware, async (req, res) => {
  let {
    name, vat_number, country, website, contact_person, email, phone,
    address, payment_terms, preferred_currency, incoterms, default_lead_time_days,
    is_oem, quality_certified, active, notes
  } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Поле name обязательно' });
  }

  default_lead_time_days = default_lead_time_days === '' || default_lead_time_days === undefined ? null : Number(default_lead_time_days);
  is_oem = is_oem ? 1 : 0;
  quality_certified = quality_certified ? 1 : 0;
  active = active === undefined ? 1 : (active ? 1 : 0);

  try {
    const [result] = await db.execute(
      `INSERT INTO part_suppliers
      (name, vat_number, country, website, contact_person, email, phone, address, payment_terms, preferred_currency, incoterms, default_lead_time_days, is_oem, quality_certified, active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, vat_number, country, website, contact_person, email, phone, address, payment_terms, preferred_currency, incoterms, default_lead_time_days, is_oem, quality_certified, active, notes]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('Ошибка сервера при добавлении поставщика:', err);
    res.status(500).json({ message: 'Ошибка сервера при добавлении поставщика' });
  }
});

// 🔐 Обновить поставщика
router.put('/:id', authMiddleware, async (req, res) => {
  let {
    name, vat_number, country, website, contact_person, email, phone,
    address, payment_terms, preferred_currency, incoterms, default_lead_time_days,
    is_oem, quality_certified, active, notes
  } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Поле name обязательно' });
  }

  default_lead_time_days = default_lead_time_days === '' || default_lead_time_days === undefined ? null : Number(default_lead_time_days);
  is_oem = is_oem ? 1 : 0;
  quality_certified = quality_certified ? 1 : 0;
  active = active === undefined ? 1 : (active ? 1 : 0);

  try {
    const [result] = await db.execute(
      `UPDATE part_suppliers SET name=?, vat_number=?, country=?, website=?, contact_person=?, email=?, phone=?, address=?, payment_terms=?, preferred_currency=?, incoterms=?, default_lead_time_days=?, is_oem=?, quality_certified=?, active=?, notes=? WHERE id=?`,
      [name, vat_number, country, website, contact_person, email, phone, address, payment_terms, preferred_currency, incoterms, default_lead_time_days, is_oem, quality_certified, active, notes, req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Поставщик не найден' });
    }
    res.json({ message: 'Поставщик обновлен' });
  } catch (err) {
    console.error('Ошибка сервера при обновлении поставщика:', err);
    res.status(500).json({ message: 'Ошибка сервера при обновлении поставщика' });
  }
});

// 🔐 Удалить поставщика
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const [result] = await db.execute('DELETE FROM part_suppliers WHERE id=?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Поставщик не найден' });
    }
    res.json({ message: 'Поставщик удален' });
  } catch (err) {
    console.error('Ошибка сервера при удалении поставщика:', err);
    res.status(500).json({ message: 'Ошибка сервера при удалении поставщика' });
  }
});

// 🔐 Импорт поставщиков из CSV
router.post('/import', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Нет файла' });

  const results = [];
  const errors = [];
  let imported = 0;

  const readable = new stream.Readable();
  readable._read = () => {};
  readable.push(req.file.buffer);
  readable.push(null);

  readable
    .pipe(csvParser())
    .on('data', (row) => {
      results.push(row);
    })
    .on('end', async () => {
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.name || r.name.trim() === '') {
          errors.push(`Строка ${i + 2}: отсутствует обязательное поле name`);
          continue;
        }
        try {
          await db.execute(
            `INSERT INTO part_suppliers
            (name, vat_number, country, website, contact_person, email, phone, address, payment_terms, preferred_currency, incoterms, default_lead_time_days, is_oem, quality_certified, active, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              r.name || null,
              r.vat_number || null,
              r.country || null,
              r.website || null,
              r.contact_person || null,
              r.email || null,
              r.phone || null,
              r.address || null,
              r.payment_terms || null,
              r.preferred_currency || null,
              r.incoterms || null,
              r.default_lead_time_days === '' ? null : Number(r.default_lead_time_days),
              r.is_oem === '1' ? 1 : 0,
              r.quality_certified === '1' ? 1 : 0,
              r.active === '0' ? 0 : 1,
              r.notes || null
            ]
          );
          imported++;
        } catch (e) {
          errors.push(`Строка ${i + 2}: ошибка импорта: ${e.message}`);
        }
      }
      res.json({ imported, errors });
    })
    .on('error', (err) => {
      res.status(500).json({ message: 'Ошибка чтения CSV', error: err.message });
    });
});

module.exports = router;
