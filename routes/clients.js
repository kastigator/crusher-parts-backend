// routes/clients.js
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const logActivity = require('../utils/logActivity');
const logFieldDiffs = require('../utils/logFieldDiffs');

// ------------------------------
// helpers
// ------------------------------
const toNull = (v) => (v === '' || v === undefined ? null : v);
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

// ------------------------------
// Получение всех клиентов
// ------------------------------
router.get("/", authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM clients ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error("Ошибка при получении клиентов:", err);
    res.sendStatus(500);
  }
});

// ------------------------------
// Лёгкий поллинг — есть ли новые клиенты (по created_at)
// GET /clients/new?after=ISO|MySQL
// ------------------------------
router.get("/new", authMiddleware, async (req, res) => {
  const { after } = req.query;
  if (!after) return res.status(400).json({ message: 'Missing "after" param' });

  let mysqlAfter = after;
  try {
    const d = new Date(after);
    if (!Number.isNaN(d.getTime())) mysqlAfter = toMysqlDateTime(d);
  } catch (_) {}

  try {
    const [rows] = await db.execute(
      `SELECT id, company_name, created_at
         FROM clients
        WHERE created_at > ?
        ORDER BY created_at DESC
        LIMIT 5`,
      [mysqlAfter]
    );
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter });
  } catch (e) {
    console.error('GET /clients/new error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ------------------------------
// Универсальный маркер изменений (ловит add/edit/delete)
// GET /clients/etag -> { etag: "COUNT:SUM(version)" }
// ------------------------------
router.get("/etag", authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver FROM clients`
    );
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 };
    const etag = `${cnt}:${sum_ver}`;
    res.json({ etag, cnt, sum_ver });
  } catch (e) {
    console.error('GET /clients/etag error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// =========================================================
// ЛОГИ (комбинированные по клиенту + алиасы)
// =========================================================

// ВАЖНО: этот маршрут должен идти ПЕРЕД "/:id/logs",
// иначе Express воспримет "combined" как :id.
router.get("/:id/logs/combined", authMiddleware, async (req, res) => {
  const clientId = +req.params.id;
  try {
    // Берём ВСЁ, где в логе указан client_id — это включает:
    // 'clients', 'client_billing_addresses', 'client_shipping_addresses', 'client_bank_details'
    const [logs] = await db.query(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ?
      ORDER BY a.created_at DESC
    `, [clientId]);

    res.json(logs);
  } catch (err) {
    console.error("Ошибка при загрузке объединённых логов клиента:", err);
    res.sendStatus(500);
  }
});

// Старый маршрут "логи клиента" — теперь это алиас комбинированных логов
router.get("/:id/logs", authMiddleware, async (req, res) => {
  const clientId = +req.params.id;
  try {
    const [logs] = await db.query(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ?
      ORDER BY a.created_at DESC
    `, [clientId]);

    res.json(logs);
  } catch (err) {
    console.error("Ошибка при загрузке логов клиента:", err);
    res.sendStatus(500);
  }
});

// Удалённые записи по клиентам и связанным таблицам (все клиенты)
router.get("/logs/deleted", authMiddleware, async (req, res) => {
  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND a.entity_type IN (
          'clients',
          'client_billing_addresses',
          'client_shipping_addresses',
          'client_bank_details'
        )
      ORDER BY a.created_at DESC
    `);

    res.json(logs);
  } catch (err) {
    console.error("Ошибка при загрузке удалённых логов:", err);
    res.sendStatus(500);
  }
});

// (Необязательный удобный алиас) Удалённые записи ТОЛЬКО по конкретному клиенту
router.get("/:id/logs/deleted", authMiddleware, async (req, res) => {
  const clientId = +req.params.id;
  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND a.client_id = ?
        AND a.entity_type IN (
          'clients',
          'client_billing_addresses',
          'client_shipping_addresses',
          'client_bank_details'
        )
      ORDER BY a.created_at DESC
    `, [clientId]);

    res.json(logs);
  } catch (err) {
    console.error("Ошибка при загрузке удалённых логов клиента:", err);
    res.sendStatus(500);
  }
});

// =========================================================
// CRUD
// =========================================================

// Добавление клиента (возвращаем свежую запись)
router.post("/", authMiddleware, async (req, res) => {
  const {
    company_name,
    registration_number,
    tax_id,
    contact_person,
    phone,
    email,
    website,
    notes,
  } = req.body || {};

  if (!company_name?.trim()) {
    return res.status(400).json({ message: "Поле 'company_name' обязательно" });
  }

  try {
    const [ins] = await db.execute(
      `INSERT INTO clients
        (company_name, registration_number, tax_id, contact_person, phone, email, website, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        company_name.trim(),
        toNull(registration_number?.trim?.()),
        toNull(tax_id?.trim?.()),
        toNull(contact_person?.trim?.()),
        toNull(phone?.trim?.()),
        toNull(email?.trim?.()),
        toNull(website?.trim?.()),
        toNull(notes?.trim?.()),
      ]
    );

    const [fresh] = await db.execute("SELECT * FROM clients WHERE id = ?", [ins.insertId]);

    await logActivity({
      req,
      action: "create",
      entity_type: "clients",
      entity_id: ins.insertId,
      comment: "Клиент добавлен",
    });

    res.status(201).json(fresh[0]);
  } catch (err) {
    console.error("Ошибка при добавлении клиента:", err);
    res.sendStatus(500);
  }
});

// Обновление клиента (оптимистическая блокировка по version)
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const {
    company_name,
    registration_number,
    tax_id,
    contact_person,
    phone,
    email,
    website,
    notes,
    version,
  } = req.body || {};

  if (version === undefined) {
    return res.status(400).json({ message: 'Missing "version" in body' });
  }
  if (!company_name?.trim()) {
    return res.status(400).json({ message: "Поле 'company_name' обязательно" });
  }

  try {
    const [rows] = await db.execute("SELECT * FROM clients WHERE id = ?", [id]);
    if (rows.length === 0) return res.sendStatus(404);
    const old = rows[0];

    const [upd] = await db.execute(
      `UPDATE clients
          SET company_name = ?,
              registration_number = ?,
              tax_id = ?,
              contact_person = ?,
              phone = ?,
              email = ?,
              website = ?,
              notes = ?,
              version = version + 1
        WHERE id = ? AND version = ?`,
      [
        company_name.trim(),
        toNull(registration_number?.trim?.()),
        toNull(tax_id?.trim?.()),
        toNull(contact_person?.trim?.()),
        toNull(phone?.trim?.()),
        toNull(email?.trim?.()),
        toNull(website?.trim?.()),
        toNull(notes?.trim?.()),
        id,
        version,
      ]
    );

    if (upd.affectedRows === 0) {
      const [freshRows] = await db.execute("SELECT * FROM clients WHERE id = ?", [id]);
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись изменена другим пользователем',
        current: freshRows[0] || null,
      });
    }

    const [fresh] = await db.execute("SELECT * FROM clients WHERE id = ?", [id]);

    await logFieldDiffs({
      req,
      oldData: old,
      newData: fresh[0],
      entity_type: "clients",
      entity_id: +id,
    });

    res.json(fresh[0]);
  } catch (err) {
    console.error("Ошибка при обновлении клиента:", err);
    res.sendStatus(500);
  }
});

// Удаление клиента и связанных записей (с проверкой version)
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const version = req.query.version !== undefined ? Number(req.query.version) : undefined;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [clientRows] = await conn.execute("SELECT * FROM clients WHERE id = ?", [id]);
    if (clientRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Клиент не найден' });
    }
    const client = clientRows[0];

    if (version !== undefined && client.version !== version) {
      await conn.rollback();
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: client,
      });
    }

    // FK ON DELETE CASCADE уже чистит дочерние,
    // но явные удаления не вредят (можно убрать).
    await conn.execute("DELETE FROM client_billing_addresses  WHERE client_id = ?", [id]);
    await conn.execute("DELETE FROM client_shipping_addresses WHERE client_id = ?", [id]);
    await conn.execute("DELETE FROM client_bank_details      WHERE client_id = ?", [id]);

    await conn.execute("DELETE FROM clients WHERE id = ?", [id]);

    await logActivity({
      req,
      action: "delete",
      entity_type: "clients",
      entity_id: +id,
      comment: `Клиент "${client.company_name}" и связанные записи удалены`,
    });

    await conn.commit();
    res.json({ message: 'Клиент удалён' });
  } catch (err) {
    await conn.rollback();
    console.error("Ошибка при удалении клиента:", err);
    res.sendStatus(500);
  } finally {
    conn.release();
  }
});

module.exports = router;
