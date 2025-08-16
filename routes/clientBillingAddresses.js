// routes/clientBillingAddresses.js
const express = require("express");
const router = express.Router();
const db = require("../utils/db");
const authMiddleware = require("../middleware/authMiddleware");
const logActivity = require("../utils/logActivity");
const logFieldDiffs = require("../utils/logFieldDiffs");

// ------------------------------
// helpers
// ------------------------------
const toNull = (v) => (v === "" || v === undefined ? null : v);
const toNumberOrNull = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toMysqlDateTime = (d) => {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${m}-${day} ${h}:${mi}:${s}`;
};

// ------------------------------
// Список юр. адресов по клиенту
// GET /client-billing-addresses?client_id=123
// ------------------------------
router.get("/", authMiddleware, async (req, res) => {
  const cid = Number(req.query.client_id);
  if (!Number.isFinite(cid)) {
    return res.status(400).json({ message: "client_id must be numeric" });
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_billing_addresses WHERE client_id = ? ORDER BY id DESC",
      [cid]
    );
    res.json(rows);
  } catch (err) {
    console.error("Ошибка при получении юр. адресов:", err);
    res.status(500).json({ message: "Ошибка сервера при получении адресов" });
  }
});

// ------------------------------
// Лёгкий поллинг на появление НОВЫХ (по created_at)
// GET /client-billing-addresses/new?client_id=123&after=ISO|MySQL
// ------------------------------
router.get("/new", authMiddleware, async (req, res) => {
  const cid = Number(req.query.client_id);
  const { after } = req.query;

  if (!Number.isFinite(cid) || !after) {
    return res.status(400).json({ message: "client_id (numeric) and after are required" });
  }

  let mysqlAfter = after;
  try {
    const d = new Date(after);
    if (!Number.isNaN(d.getTime())) mysqlAfter = toMysqlDateTime(d);
  } catch (_) {}

  try {
    const [rows] = await db.execute(
      `SELECT id, formatted_address, created_at
         FROM client_billing_addresses
        WHERE client_id = ? AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 5`,
      [cid, mysqlAfter]
    );
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter });
  } catch (e) {
    console.error("GET /client-billing-addresses/new error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------
// Универсальный маркер изменений по клиенту (COUNT:SUM(version))
// GET /client-billing-addresses/etag?client_id=123
// ------------------------------
router.get("/etag", authMiddleware, async (req, res) => {
  const cid = Number(req.query.client_id);
  if (!Number.isFinite(cid)) {
    return res.status(400).json({ message: "client_id must be numeric" });
  }

  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
         FROM client_billing_addresses
        WHERE client_id = ?`,
      [cid]
    );
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 };
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver });
  } catch (e) {
    console.error("GET /client-billing-addresses/etag error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------
// Добавление нового юр. адреса (возвращает свежую запись)
// ------------------------------
router.post("/", authMiddleware, async (req, res) => {
  const {
    client_id,
    label,
    formatted_address,
    place_id,
    lat,
    lng,
    postal_code,
    comment,
    country,
    region,
    city,
    street,
    house,
    building,
    entrance,
  } = req.body || {};

  const cid = Number(client_id);

  if (!Number.isFinite(cid) || !formatted_address?.trim()) {
    return res.status(400).json({ message: "client_id (numeric) and formatted_address are required" });
  }

  try {
    const [ins] = await db.execute(
      `INSERT INTO client_billing_addresses
        (client_id, label, formatted_address, place_id, lat, lng, postal_code, comment,
         country, region, city, street, house, building, entrance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid,
        toNull(label?.trim?.()),
        formatted_address.trim(),
        toNull(place_id?.trim?.()),
        toNumberOrNull(lat),
        toNumberOrNull(lng),
        toNull(postal_code?.trim?.()),
        toNull(comment?.trim?.()),
        toNull(country?.trim?.()),
        toNull(region?.trim?.()),
        toNull(city?.trim?.()),
        toNull(street?.trim?.()),
        toNull(house?.trim?.()),
        toNull(building?.trim?.()),
        toNull(entrance?.trim?.()),
      ]
    );

    const [rows] = await db.execute("SELECT * FROM client_billing_addresses WHERE id = ?", [ins.insertId]);

    await logActivity({
      req,
      action: "create",
      entity_type: "client_billing_addresses",
      entity_id: ins.insertId,
      comment: "Добавлен юр. адрес",
      client_id: cid,           // для объединённых логов по клиенту
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Ошибка при добавлении юр. адреса:", err);
    res.status(500).json({ message: "Ошибка сервера при добавлении адреса" });
  }
});

// ------------------------------
// Обновление (оптимистическая блокировка по version)
// ------------------------------
router.put("/:id", authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "id must be numeric" });
  }

  const {
    label,
    formatted_address,
    place_id,
    lat,
    lng,
    postal_code,
    comment,
    country,
    region,
    city,
    street,
    house,
    building,
    entrance,
    version,
  } = req.body || {};

  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Missing or invalid "version" in body' });
  }
  if (!formatted_address?.trim()) {
    return res.status(400).json({ message: "formatted_address is required" });
  }

  try {
    const [rows] = await db.execute("SELECT * FROM client_billing_addresses WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ message: "Адрес не найден" });
    const old = rows[0];

    const [upd] = await db.execute(
      `UPDATE client_billing_addresses
          SET label = ?,
              formatted_address = ?,
              place_id = ?,
              lat = ?,
              lng = ?,
              postal_code = ?,
              comment = ?,
              country = ?,
              region = ?,
              city = ?,
              street = ?,
              house = ?,
              building = ?,
              entrance = ?,
              version = version + 1
        WHERE id = ? AND version = ?`,
      [
        toNull(label?.trim?.()),
        formatted_address.trim(),
        toNull(place_id?.trim?.()),
        toNumberOrNull(lat),
        toNumberOrNull(lng),
        toNull(postal_code?.trim?.()),
        toNull(comment?.trim?.()),
        toNull(country?.trim?.()),
        toNull(region?.trim?.()),
        toNull(city?.trim?.()),
        toNull(street?.trim?.()),
        toNull(house?.trim?.()),
        toNull(building?.trim?.()),
        toNull(entrance?.trim?.()),
        id,
        Number(version),
      ]
    );

    if (upd.affectedRows === 0) {
      const [freshRows] = await db.execute("SELECT * FROM client_billing_addresses WHERE id = ?", [id]);
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись изменена другим пользователем",
        current: freshRows[0] || null,
      });
    }

    const [fresh] = await db.execute("SELECT * FROM client_billing_addresses WHERE id = ?", [id]);

    await logFieldDiffs({
      req,
      entity_type: "client_billing_addresses",
      entity_id: id,
      oldData: old,
      newData: fresh[0],
      // logFieldDiffs сам вытащит client_id из oldData, но это ок даже если передадим явно
      // client_id: old.client_id,
    });

    res.json(fresh[0]);
  } catch (err) {
    console.error("Ошибка при обновлении юр. адреса:", err);
    res.status(500).json({ message: "Ошибка сервера при обновлении адреса" });
  }
});

// ------------------------------
// Удаление (с проверкой version, если передан ?version=)
// ------------------------------
router.delete("/:id", authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "id must be numeric" });
  }
  const versionParam = req.query.version;
  const version = versionParam !== undefined ? Number(versionParam) : undefined;
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: "version must be numeric" });
  }

  try {
    const [rows] = await db.execute("SELECT * FROM client_billing_addresses WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ message: "Адрес не найден" });

    const record = rows[0];

    if (version !== undefined && version !== record.version) {
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись была изменена и не может быть удалена без обновления",
        current: record,
      });
    }

    await db.execute("DELETE FROM client_billing_addresses WHERE id = ?", [id]);

    await logActivity({
      req,
      action: "delete",
      entity_type: "client_billing_addresses",
      entity_id: id,
      comment: "Удалён юр. адрес",
      client_id: Number(record.client_id),
    });

    res.json({ message: "Юр. адрес удалён" });
  } catch (err) {
    console.error("Ошибка при удалении юр. адреса:", err);
    res.status(500).json({ message: "Ошибка сервера при удалении адреса" });
  }
});

module.exports = router;
