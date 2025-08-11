// routes/clientShippingAddresses.js
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
// Список адресов доставки по клиенту
// GET /client-shipping-addresses?client_id=123
// ------------------------------
router.get("/", authMiddleware, async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ message: "client_id is required" });

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_shipping_addresses WHERE client_id = ? ORDER BY id DESC",
      [client_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Ошибка при получении адресов доставки:", err);
    res.sendStatus(500);
  }
});

// ------------------------------
// Лёгкий поллинг на появление НОВЫХ (по created_at)
// GET /client-shipping-addresses/new?client_id=123&after=ISO|MySQL
// ------------------------------
router.get("/new", authMiddleware, async (req, res) => {
  const { client_id, after } = req.query;
  if (!client_id || !after) {
    return res.status(400).json({ message: "client_id and after are required" });
  }

  let mysqlAfter = after;
  try {
    const d = new Date(after);
    if (!Number.isNaN(d.getTime())) mysqlAfter = toMysqlDateTime(d);
  } catch (_) {}

  try {
    const [rows] = await db.execute(
      `SELECT id, formatted_address, created_at
         FROM client_shipping_addresses
        WHERE client_id = ? AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 5`,
      [client_id, mysqlAfter]
    );
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter });
  } catch (e) {
    console.error("GET /client-shipping-addresses/new error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------
// Универсальный маркер изменений по клиенту
// Ловит add/edit/delete (COUNT:SUM(version))
// GET /client-shipping-addresses/etag?client_id=123
// ------------------------------
router.get("/etag", authMiddleware, async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ message: "client_id is required" });

  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
         FROM client_shipping_addresses
        WHERE client_id = ?`,
      [client_id]
    );
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 };
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver });
  } catch (e) {
    console.error("GET /client-shipping-addresses/etag error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------
// Добавление адреса доставки (возвращает свежую запись)
// ------------------------------
router.post("/", authMiddleware, async (req, res) => {
  const {
    client_id,
    formatted_address,
    place_id,
    lat,
    lng,
    postal_code,
    country,
    region,
    city,
    street,
    house,
    building,
    entrance,
    comment,
    // опционально (в таблице есть):
    type,
    is_precise_location,
  } = req.body || {};

  if (!client_id || !formatted_address?.trim()) {
    return res.status(400).json({ message: "client_id and formatted_address are required" });
  }

  try {
    const [ins] = await db.execute(
      `INSERT INTO client_shipping_addresses
        (client_id, formatted_address, place_id, lat, lng, postal_code,
         country, region, city, street, house, building, entrance, comment,
         type, is_precise_location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client_id,
        formatted_address.trim(),
        toNull(place_id?.trim?.()),
        toNumberOrNull(lat),
        toNumberOrNull(lng),
        toNull(postal_code?.trim?.()),
        toNull(country?.trim?.()),
        toNull(region?.trim?.()),
        toNull(city?.trim?.()),
        toNull(street?.trim?.()),
        toNull(house?.trim?.()),
        toNull(building?.trim?.()),
        toNull(entrance?.trim?.()),
        toNull(comment?.trim?.()),
        toNull(type?.trim?.()),
        is_precise_location === 0 || is_precise_location === "0" ? 0 : 1,
      ]
    );

    const [rows] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [ins.insertId]);

    await logActivity({
      req,
      action: "create",
      entity_type: "client_shipping_addresses",
      entity_id: ins.insertId,
      comment: "Добавлен адрес доставки",
      client_id: +client_id,
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Ошибка при добавлении адреса доставки:", err);
    res.sendStatus(500);
  }
});

// ------------------------------
// Обновление (оптимистическая блокировка по version)
// ------------------------------
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const {
    formatted_address,
    place_id,
    lat,
    lng,
    postal_code,
    country,
    region,
    city,
    street,
    house,
    building,
    entrance,
    comment,
    type,
    is_precise_location,
    version,
  } = req.body || {};

  if (version === undefined) {
    return res.status(400).json({ message: 'Missing "version" in body' });
  }
  if (!formatted_address?.trim()) {
    return res.status(400).json({ message: "formatted_address is required" });
  }

  try {
    const [rows] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [id]);
    if (!rows.length) return res.sendStatus(404);
    const old = rows[0];

    const [upd] = await db.execute(
      `UPDATE client_shipping_addresses
          SET formatted_address = ?,
              place_id = ?,
              lat = ?,
              lng = ?,
              postal_code = ?,
              country = ?,
              region = ?,
              city = ?,
              street = ?,
              house = ?,
              building = ?,
              entrance = ?,
              comment = ?,
              type = ?,
              is_precise_location = ?,
              version = version + 1
        WHERE id = ? AND version = ?`,
      [
        formatted_address.trim(),
        toNull(place_id?.trim?.()),
        toNumberOrNull(lat),
        toNumberOrNull(lng),
        toNull(postal_code?.trim?.()),
        toNull(country?.trim?.()),
        toNull(region?.trim?.()),
        toNull(city?.trim?.()),
        toNull(street?.trim?.()),
        toNull(house?.trim?.()),
        toNull(building?.trim?.()),
        toNull(entrance?.trim?.()),
        toNull(comment?.trim?.()),
        toNull(type?.trim?.()),
        is_precise_location === 0 || is_precise_location === "0" ? 0 : 1,
        id,
        version,
      ]
    );

    if (upd.affectedRows === 0) {
      const [freshRows] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [id]);
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись изменена другим пользователем",
        current: freshRows[0] || null,
      });
    }

    const [fresh] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [id]);

    await logFieldDiffs({
      req,
      entity_type: "client_shipping_addresses",
      entity_id: +id,
      oldData: old,
      newData: fresh[0],
      client_id: old.client_id,
    });

    res.json(fresh[0]);
  } catch (err) {
    console.error("Ошибка при обновлении адреса доставки:", err);
    res.sendStatus(500);
  }
});

// ------------------------------
// Удаление (с проверкой version, если передан ?version=)
// ------------------------------
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const version = req.query.version !== undefined ? Number(req.query.version) : undefined;

  try {
    const [rows] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [id]);
    if (!rows.length) return res.sendStatus(404);

    const record = rows[0];

    if (version !== undefined && version !== record.version) {
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись была изменена и не может быть удалена без обновления",
        current: record,
      });
    }

    await db.execute("DELETE FROM client_shipping_addresses WHERE id = ?", [id]);

    await logActivity({
      req,
      action: "delete",
      entity_type: "client_shipping_addresses",
      entity_id: +id,
      comment: "Удалён адрес доставки",
      client_id: +record.client_id,
    });

    res.json({ message: "Адрес доставки удалён" });
  } catch (err) {
    console.error("Ошибка при удалении адреса доставки:", err);
    res.sendStatus(500);
  }
});

module.exports = router;
