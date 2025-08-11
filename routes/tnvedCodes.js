const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');
const logActivity = require('../utils/logActivity');
const ExcelJS = require('exceljs');
const { validateImportRows } = require('../utils/importValidator');
const logFieldDiffs = require('../utils/logFieldDiffs');

// ----------------------------------------------
// helpers
// ----------------------------------------------
const toNull = (v) => (v === '' || v === undefined ? null : v);
const toNumberOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toMysqlDateTime = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${m}-${day} ${h}:${mi}:${s}`;
};

// ----------------------------------------------
// Получение всех кодов ТН ВЭД
// ----------------------------------------------
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [codes] = await db.execute('SELECT * FROM tnved_codes ORDER BY code');
    res.json(codes);
  } catch (err) {
    console.error('Ошибка при получении кодов ТН ВЭД:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ----------------------------------------------
// Лёгкий поллинг: новые записи после даты (по created_at)
// GET /tnved-codes/new?after=ISO|MySQL
// ----------------------------------------------
router.get('/new', authMiddleware, async (req, res) => {
  const { after } = req.query;
  if (!after) return res.status(400).json({ message: 'Missing "after" (ISO/MySQL date)' });

  let mysqlAfter = after;
  try {
    const d = new Date(after);
    if (!Number.isNaN(d.getTime())) mysqlAfter = toMysqlDateTime(d);
  } catch (_) {}

  try {
    const [rows] = await db.execute(
      `SELECT id, code, created_at
         FROM tnved_codes
        WHERE created_at > ?
        ORDER BY created_at DESC
        LIMIT 5`,
      [mysqlAfter]
    );
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter });
  } catch (e) {
    console.error('GET /tnved-codes/new error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------
// Универсальный маркер изменений таблицы (для add/edit/delete)
// GET /tnved-codes/etag
// Возвращает строку вида "COUNT:SUM(version)"
// ----------------------------------------------
router.get('/etag', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
         FROM tnved_codes`
    );
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 };
    const etag = `${cnt}:${sum_ver}`;
    res.json({ etag, cnt, sum_ver });
  } catch (e) {
    console.error('GET /tnved-codes/etag error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------
// Добавление ОДНОЙ записи вручную (без валидатора)
// ----------------------------------------------
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const code = (req.body?.code || '').trim();
    if (!code) {
      return res.status(400).json({ message: 'Поле "code" обязательно' });
    }

    const description = toNull(req.body?.description?.trim?.());
    const duty_rate   = toNumberOrNull(req.body?.duty_rate);
    const notes       = toNull(req.body?.notes?.trim?.());

    // Явный INSERT только нужных колонок; version и created_at по дефолту
    const [ins] = await db.execute(
      `INSERT INTO tnved_codes (code, description, duty_rate, notes)
       VALUES (?, ?, ?, ?)`,
      [code, description, duty_rate, notes]
    );

    // Вернём свежую запись
    const [rows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [ins.insertId]);

    await logActivity({
      req,
      action: 'create',
      entity_type: 'tnved_code',
      entity_id: ins.insertId,
      comment: `Создан код ТН ВЭД: ${code}`,
    });

    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ type: 'duplicate_key', message: 'Код уже существует' });
    }
    console.error('Ошибка при добавлении ТН ВЭД:', err);
    return res.status(500).json({ message: 'Ошибка сервера при добавлении' });
  }
});

// ----------------------------------------------
// Импорт из Excel (универсальный валидатор)
// ----------------------------------------------
router.post('/import', authMiddleware, adminOnly, async (req, res) => {
  try {
    const input = Array.isArray(req.body) ? req.body : [];
    if (!input.length) {
      return res.status(400).json({
        message: 'Нет данных для импорта',
        inserted: [],
        errors: ['Файл пустой или не содержит допустимых строк'],
      });
    }

    const normalized = input.map((r = {}) => ({
      code: r.code,
      description: toNull(r.description?.trim?.()),
      duty_rate: toNumberOrNull(r.duty_rate),
      notes: toNull(r.notes?.trim?.()),
    }));

    const { inserted, errors } = await validateImportRows(normalized, {
      table: 'tnved_codes',
      uniqueField: 'code',
      requiredFields: ['code'],
      req,
      logType: 'tnved_code',
    });

    return res.status(200).json({
      message:
        inserted.length > 0
          ? `Импортировано: ${inserted.length}`
          : 'Импорт не выполнен (все строки были отклонены)',
      inserted,
      errors,
    });
  } catch (err) {
    console.error('Ошибка при импорте ТН ВЭД:', err);
    return res.status(500).json({
      message: 'Ошибка сервера при импорте',
      inserted: [],
      errors: [err.message],
    });
  }
});

// ----------------------------------------------
// Обновление (оптимистическая блокировка по version)
// ----------------------------------------------
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = req.params.id;
  const { code, description, duty_rate, notes, version } = req.body;

  if (version === undefined) {
    return res.status(400).json({ message: 'Missing "version" in body' });
  }
  if (!code) {
    return res.status(400).json({ message: 'Поле "code" обязательно' });
  }

  const norm = {
    code,
    description: toNull(description?.trim?.()),
    duty_rate: toNumberOrNull(duty_rate),
    notes: toNull(notes?.trim?.()),
  };

  try {
    const [rows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Код не найден' });
    const old = rows[0];

    const [upd] = await db.execute(
      `UPDATE tnved_codes
         SET code = ?, description = ?, duty_rate = ?, notes = ?, version = version + 1
       WHERE id = ? AND version = ?`,
      [norm.code, norm.description, norm.duty_rate, norm.notes, id, version]
    );

    if (upd.affectedRows === 0) {
      const [freshRows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [id]);
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись изменена другим пользователем',
        current: freshRows[0] || null,
      });
    }

    const [fresh] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [id]);

    await logFieldDiffs({
      req,
      oldData: old,
      newData: fresh[0],
      entity_type: 'tnved_code',
      entity_id: id,
    });

    res.json(fresh[0]);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ type: 'duplicate_key', message: 'Код уже существует' });
    }
    console.error('Ошибка при обновлении:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ----------------------------------------------
// Удаление (с защитой по версии при наличии ?version=)
// ----------------------------------------------
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = req.params.id;
  const version = req.query.version !== undefined ? Number(req.query.version) : undefined;

  try {
    const [rows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Код не найден' });
    const record = rows[0];

    if (version === undefined) {
      await db.execute('DELETE FROM tnved_codes WHERE id = ?', [id]);
    } else {
      const [del] = await db.execute('DELETE FROM tnved_codes WHERE id = ? AND version = ?', [id, version]);
      if (del.affectedRows === 0) {
        const [freshRows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [id]);
        return res.status(409).json({
          type: 'version_conflict',
          message: 'Запись была изменена и не может быть удалена без обновления',
          current: freshRows[0] || null,
        });
      }
    }

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'tnved_code',
      entity_id: id,
      comment: `Удалён код ТН ВЭД: ${record.code}`,
    });

    res.json({ message: 'Код удалён' });
  } catch (err) {
    console.error('Ошибка при удалении:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ----------------------------------------------
// Скачивание шаблона Excel
// ----------------------------------------------
router.get('/template', authMiddleware, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Коды ТН ВЭД');

    sheet.columns = [
      { header: 'Код', key: 'code', width: 20 },
      { header: 'Описание', key: 'description', width: 40 },
      { header: 'Ставка пошлины (%)', key: 'duty_rate', width: 20 },
      { header: 'Примечания', key: 'notes', width: 40 },
    ];

    sheet.addRow({
      code: '1234567890',
      description: 'Пример описания',
      duty_rate: 5,
      notes: 'Тестовая строка',
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
