// routes/clientShippingAddresses.js
const express = require("express")
const router = express.Router()
const db = require("../utils/db")

const logActivity = require("../utils/logActivity")
const logFieldDiffs = require("../utils/logFieldDiffs")

// ------------------------------
// helpers
// ------------------------------
const toNull = (v) => (v === "" || v === undefined ? null : v)

const toNumberOrNull = (v) => {
  if (v === "" || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const toMysqlDateTime = (d) => {
  const pad = (n) => String(n).padStart(2, "0")
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  return `${y}-${m}-${day} ${h}:${mi}:${s}`
}

const toBool01 = (v) => (v === 1 || v === "1" || v === true ? 1 : 0)

const normalizeLimit = (v, def = 100, max = 500) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const normalizeOffset = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

// ------------------------------
// Список адресов доставки по клиенту
// GET /client-shipping-addresses?client_id=123&limit=50&offset=0
// ------------------------------
router.get("/", async (req, res) => {
  const cid = Number(req.query.client_id)
  if (!Number.isFinite(cid)) {
    return res.status(400).json({ message: "client_id must be numeric" })
  }

  const limit = normalizeLimit(req.query.limit, 100, 500)
  const offset = normalizeOffset(req.query.offset)

  try {
    const sql = `
      SELECT *
        FROM client_shipping_addresses
       WHERE client_id = ?
       ORDER BY id DESC
       LIMIT ${limit} OFFSET ${offset}
    `
    const [rows] = await db.execute(sql, [cid])
    res.json(rows)
  } catch (err) {
    console.error("Ошибка при получении адресов доставки:", err)
    res.status(500).json({ message: "Ошибка сервера при получении адресов" })
  }
})

// ------------------------------
// Лёгкий поллинг новых записей (по created_at)
// GET /client-shipping-addresses/new?client_id=123&after=ISO|MySQL
// ------------------------------
router.get("/new", async (req, res) => {
  const cid = Number(req.query.client_id)
  const { after } = req.query

  if (!Number.isFinite(cid) || !after) {
    return res
      .status(400)
      .json({ message: "client_id (numeric) and after are required" })
  }

  let mysqlAfter = after
  try {
    const d = new Date(after)
    if (!Number.isNaN(d.getTime())) mysqlAfter = toMysqlDateTime(d)
  } catch (_) {}

  try {
    const [rows] = await db.execute(
      `SELECT id, formatted_address, created_at
         FROM client_shipping_addresses
        WHERE client_id = ? AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 5`,
      [cid, mysqlAfter]
    )
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter })
  } catch (e) {
    console.error("GET /client-shipping-addresses/new error:", e)
    res.status(500).json({ message: "Server error" })
  }
})

// ------------------------------
// Универсальный маркер изменений (COUNT:SUM(version))
// GET /client-shipping-addresses/etag?client_id=123
// ------------------------------
router.get("/etag", async (req, res) => {
  const cid = Number(req.query.client_id)
  if (!Number.isFinite(cid)) {
    return res.status(400).json({ message: "client_id must be numeric" })
  }

  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
         FROM client_shipping_addresses
        WHERE client_id = ?`,
      [cid]
    )
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error("GET /client-shipping-addresses/etag error:", e)
    res.status(500).json({ message: "Server error" })
  }
})

// ------------------------------
// Добавление адреса доставки (возвращает свежую запись)
// ------------------------------
router.post("/", async (req, res) => {
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
    type,
    is_precise_location,
  } = req.body || {}

  const cid = Number(client_id)
  if (!Number.isFinite(cid) || !formatted_address?.trim()) {
    return res.status(400).json({
      message: "client_id (numeric) and formatted_address are required",
    })
  }

  try {
    const [ins] = await db.execute(
      `INSERT INTO client_shipping_addresses
        (client_id, formatted_address, place_id, lat, lng, postal_code,
         country, region, city, street, house, building, entrance, comment,
         \`type\`, is_precise_location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid,
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
        toBool01(is_precise_location),
      ]
    )

    const [rows] = await db.execute(
      "SELECT * FROM client_shipping_addresses WHERE id = ?",
      [ins.insertId]
    )

    await logActivity({
      req,
      action: "create",
      entity_type: "client_shipping_addresses",
      entity_id: ins.insertId,
      comment: "Добавлен адрес доставки",
      client_id: cid,
    })

    res.status(201).json(rows[0])
  } catch (err) {
    console.error("Ошибка при добавлении адреса доставки:", err)
    res.status(500).json({ message: "Ошибка сервера при добавлении адреса" })
  }
})

// ------------------------------
// Обновление адреса доставки
// ------------------------------
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "id must be numeric" })
  }

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
  } = req.body || {}

  if (!Number.isFinite(Number(version))) {
    return res
      .status(400)
      .json({ message: 'Missing or invalid "version" in body' })
  }
  if (!formatted_address?.trim()) {
    return res.status(400).json({ message: "formatted_address is required" })
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_shipping_addresses WHERE id = ?",
      [id]
    )
    if (!rows.length)
      return res.status(404).json({ message: "Адрес не найден" })
    const old = rows[0]

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
              \`type\` = ?,
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
        toBool01(is_precise_location),
        id,
        Number(version),
      ]
    )

    if (upd.affectedRows === 0) {
      const [freshRows] = await db.execute(
        "SELECT * FROM client_shipping_addresses WHERE id = ?",
        [id]
      )
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись изменена другим пользователем",
        current: freshRows[0] || null,
      })
    }

    const [fresh] = await db.execute(
      "SELECT * FROM client_shipping_addresses WHERE id = ?",
      [id]
    )

    await logFieldDiffs({
      req,
      entity_type: "client_shipping_addresses",
      entity_id: id,
      oldData: old,
      newData: fresh[0],
    })

    res.json(fresh[0])
  } catch (err) {
    console.error("Ошибка при обновлении адреса доставки:", err)
    res.status(500).json({ message: "Ошибка сервера при обновлении адреса" })
  }
})

// ------------------------------
// Удаление адреса доставки
// ------------------------------
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "id must be numeric" })
  }
  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: "version must be numeric" })
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_shipping_addresses WHERE id = ?",
      [id]
    )
    if (!rows.length)
      return res.status(404).json({ message: "Адрес не найден" })

    const record = rows[0]

    if (version !== undefined && version !== record.version) {
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись была изменена и не может быть удалена без обновления",
        current: record,
      })
    }

    await db.execute("DELETE FROM client_shipping_addresses WHERE id = ?", [
      id,
    ])

    await logActivity({
      req,
      action: "delete",
      entity_type: "client_shipping_addresses",
      entity_id: id,
      comment: "Удалён адрес доставки",
      client_id: Number(record.client_id),
    })

    res.json({ message: "Адрес доставки удалён" })
  } catch (err) {
    console.error("Ошибка при удалении адреса доставки:", err)
    res.status(500).json({ message: "Ошибка сервера при удалении адреса" })
  }
})

module.exports = router
