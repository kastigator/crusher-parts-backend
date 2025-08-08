const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');
const logActivity = require('../utils/logActivity');
const ExcelJS = require('exceljs');
const { validateImportRows } = require('../utils/importValidator');
const logFieldDiffs = require('../utils/logFieldDiffs');

//----------------------------------------------
// Получение всех кодов ТН ВЭД
//----------------------------------------------
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [codes] = await db.execute('SELECT * FROM tnved_codes ORDER BY code');
    res.json(codes);
  } catch (err) {
    console.error('Ошибка при получении кодов ТН ВЭД:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

//----------------------------------------------
// Добавление одного или нескольких кодов вручную
//----------------------------------------------
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { inserted, errors } = await validateImportRows(
    Array.isArray(req.body) ? req.body : [req.body],
    {
      table: 'tnved_codes',
      uniqueField: 'code',
      requiredFields: ['code'],
      req,
      logType: 'tnved_code'
    }
  );

  res.status(inserted.length ? 201 : 400).json({
    message: inserted.length
      ? `Добавлено: ${inserted.length} кодов`
      : 'Ошибки при добавлении',
    inserted,
    errors
  });
});

//----------------------------------------------
// Импорт из Excel (универсальный)
//----------------------------------------------
router.post('/import', authMiddleware, adminOnly, async (req, res) => {
  try {
    const input = Array.isArray(req.body) ? req.body : [];

    if (!input.length) {
      return res.status(400).json({
        message: 'Нет данных для импорта',
        inserted: [],
        errors: ['Файл пустой или не содержит допустимых строк']
      });
    }

    const { inserted, errors } = await validateImportRows(input, {
      table: 'tnved_codes',
      uniqueField: 'code',
      requiredFields: ['code'],
      req,
      logType: 'tnved_code'
    });

    return res.status(200).json({
      message:
        inserted.length > 0
          ? `Импортировано: ${inserted.length}`
          : 'Импорт не выполнен (все строки были отклонены)',
      inserted,
      errors
    });
  } catch (err) {
    console.error('Ошибка при импорте ТН ВЭД:', err);
    return res.status(500).json({
      message: 'Ошибка сервера при импорте',
      inserted: [],
      errors: [err.message]
    });
  }
});

//----------------------------------------------
// Обновление кода ТН ВЭД
//----------------------------------------------
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { code, description, duty_rate, notes } = req.body;

  if (!code) {
    return res.status(400).json({ message: 'Поле "code" обязательно' });
  }

  try {
    const [rows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Код не найден' });
    }

    const old = rows[0];

    await db.execute(
      `UPDATE tnved_codes
       SET code = ?, description = ?, duty_rate = ?, notes = ?
       WHERE id = ?`,
      [code, description || null, duty_rate || null, notes || null, req.params.id]
    );

    await logFieldDiffs({
      req,
      oldData: old,
      newData: req.body,
      entity_type: 'tnved_code',
      entity_id: req.params.id
    });

    res.json({ message: 'Код обновлён' });
  } catch (err) {
    console.error('Ошибка при обновлении:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

//----------------------------------------------
// Удаление кода ТН ВЭД с логированием
//----------------------------------------------
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Код не найден' });
    }

    const record = rows[0];

    await db.execute('DELETE FROM tnved_codes WHERE id = ?', [req.params.id]);

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'tnved_code',
      entity_id: req.params.id,
      comment: `Удалён код ТН ВЭД: ${record.code}`
    });

    res.json({ message: 'Код удалён' });
  } catch (err) {
    console.error('Ошибка при удалении:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

//----------------------------------------------
// Скачивание шаблона Excel
//----------------------------------------------
router.get('/template', authMiddleware, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Коды ТН ВЭД');

    sheet.columns = [
      { header: 'Код', key: 'code', width: 20 },
      { header: 'Описание', key: 'description', width: 40 },
      { header: 'Ставка пошлины (%)', key: 'duty_rate', width: 20 },
      { header: 'Примечания', key: 'notes', width: 40 }
    ];

    sheet.addRow({
      code: '1234567890',
      description: 'Пример описания',
      duty_rate: 5,
      notes: 'Тестовая строка'
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=tnved_codes_template.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Ошибка при создании шаблона Excel:', err);
    res.status(500).json({ message: 'Ошибка при создании шаблона' });
  }
});

module.exports = router;
