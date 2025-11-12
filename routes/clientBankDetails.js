// routes/clientBankDetails.js
const express = require("express")
const router = express.Router()
const db = require("../utils/db")
const auth = require("../middleware/authMiddleware")
const checkTabAccess = require("../middleware/checkTabAccess")
const logActivity = require("../utils/logActivity")
const logFieldDiffs = require("../utils/logFieldDiffs")

// Эта вкладка управляет клиентами и их реквизитами
const TAB_PATH = "/clients"
const tabGuard = checkTabAccess(TAB_PATH)

// ------------------------------
// helpers
// ------------------------------
const toNull = (v) => (v === "" || v === undefined ? null : v)
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
const normISO3 = (v) =>
  v == null || v === "" ? null : String(v).trim().toUpperCase().slice(0, 3)

// применяем авторизацию и доступ к вкладке ко всем ручкам
router.use(auth, tabGuard)

// ------------------------------
// Список реквизитов по клиенту
// GET /client-bank-details?client_id=123&limit=50&offset=0
// ------------------------------
router.get("/", async (req, res) => {
  const cid = Number(req.query.client_id)
  if (!Number.isFinite(cid)) {
    return res.status(400).json({ message: "client_id must be numeric" })
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  try {
    const [rows] = await db.execute(
      `SELECT *
         FROM client_bank_details
        WHERE client_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [cid, limit, offset]
    )
    res.json(rows)
  } catch (err) {
    console.error("GET /client-bank-details error:", err)
    res.status(500).json({ message: "Ошибка сервера при получении реквизитов" })
  }
})

// ------------------------------
// Лёгкий поллинг на появление новых (по created_at)
// GET /client-bank-details/new?client_id=123&after=ISO|MySQL
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
      `SELECT id, bank_name, created_at
         FROM client_bank_details
        WHERE client_id = ? AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 5`,
      [cid, mysqlAfter]
    )
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter })
  } catch (e) {
    console.error("GET /client-bank-details/new error:", e)
    res.status(500).json({ message: "Server error" })
  }
})

// ------------------------------
// Универсальный маркер изменений по клиенту (COUNT:SUM(version))
// GET /client-bank-details/etag?client_id=123
// ------------------------------
router.get("/etag", async (req, res) => {
  const cid = Number(req.query.client_id)
  if (!Number.isFinite(cid)) {
    return res.status(400).json({ message: "client_id must be numeric" })
  }

  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
         FROM client_bank_details
        WHERE client_id = ?`,
      [cid]
    )
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error("GET /client-bank-details/etag error:", e)
    res.status(500).json({ message: "Server error" })
  }
})

// ------------------------------
// Добавление реквизитов (возвращаем свежую запись)
// ------------------------------
router.post("/", async (req, res) => {
  const {
    client_id,
    bank_name,
    account_number,
    iban,
    bic,
    currency,
    correspondent_account,
    bank_address,
    additional_info,
  } = req.body || {}

  const cid = Number(client_id)
  if (!Number.isFinite(cid) || !bank_name?.trim() || !account_number?.trim()) {
    return res.status(400).json({
      message: "client_id (numeric), bank_name, account_number are required",
    })
  }

  try {
    const [ins] = await db.execute(
      `INSERT INTO client_bank_details
        (client_id, bank_name, account_number, iban, bic, currency,
         correspondent_account, bank_address, additional_info, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        cid,
        bank_name.trim(),
        account_number.trim(),
        toNull(iban?.trim?.()),
        toNull(bic?.trim?.()),
        normISO3(currency) || "RUB",
        toNull(correspondent_account?.trim?.()),
        toNull(bank_address?.trim?.()),
        toNull(additional_info?.trim?.()),
      ]
    )

    const [rows] = await db.execute(
      "SELECT * FROM client_bank_details WHERE id = ?",
      [ins.insertId]
    )

    await logActivity({
      req,
      action: "create",
      entity_type: "client_bank_details",
      entity_id: ins.insertId,
      comment: "Добавлены банковские реквизиты",
      client_id: cid,
    })

    res.status(201).json(rows[0])
  } catch (err) {
    console.error("POST /client-bank-details error:", err)
    res.status(500).json({ message: "Ошибка сервера при добавлении реквизитов" })
  }
})

// ------------------------------
// Обновление (оптимистическая блокировка по version)
// ------------------------------
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "id must be numeric" })
  }

  const {
    client_id, // игнорируем при апдейте
    bank_name,
    account_number,
    iban,
    bic,
    currency,
    correspondent_account,
    bank_address,
    additional_info,
    version,
  } = req.body || {}

  if (!Number.isFinite(Number(version))) {
    return res
      .status(400)
      .json({ message: 'Missing or invalid "version" in body' })
  }
  if (!bank_name?.trim() || !account_number?.trim()) {
    return res
      .status(400)
      .json({ message: "bank_name and account_number are required" })
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_bank_details WHERE id = ?",
      [id]
    )
    if (!rows.length) {
      return res.status(404).json({ message: "Реквизиты не найдены" })
    }
    const old = rows[0]

    const [upd] = await db.execute(
      `UPDATE client_bank_details
          SET bank_name = ?,
              account_number = ?,
              iban = ?,
              bic = ?,
              currency = ?,
              correspondent_account = ?,
              bank_address = ?,
              additional_info = ?,
              version = version + 1,
              updated_at = NOW()
        WHERE id = ? AND version = ?`,
      [
        bank_name.trim(),
        account_number.trim(),
        toNull(iban?.trim?.()),
        toNull(bic?.trim?.()),
        normISO3(currency),
        toNull(correspondent_account?.trim?.()),
        toNull(bank_address?.trim?.()),
        toNull(additional_info?.trim?.()),
        id,
        Number(version),
      ]
    )

    if (upd.affectedRows === 0) {
      const [freshRows] = await db.execute(
        "SELECT * FROM client_bank_details WHERE id = ?",
        [id]
      )
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись изменена другим пользователем",
        current: freshRows[0] || null,
      })
    }

    const [fresh] = await db.execute(
      "SELECT * FROM client_bank_details WHERE id = ?",
      [id]
    )

    await logFieldDiffs({
      req,
      entity_type: "client_bank_details",
      entity_id: id,
      oldData: old,
      newData: fresh[0],
      client_id: old.client_id,
    })

    res.json(fresh[0])
  } catch (err) {
    console.error("PUT /client-bank-details error:", err)
    res.status(500).json({ message: "Ошибка сервера при обновлении реквизитов" })
  }
})

// ------------------------------
// Удаление (с проверкой version, если передан ?version=)
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
      "SELECT * FROM client_bank_details WHERE id = ?",
      [id]
    )
    if (!rows.length) {
      return res.status(404).json({ message: "Реквизиты не найдены" })
    }

    const record = rows[0]

    if (version !== undefined && version !== record.version) {
      return res.status(409).json({
        type: "version_conflict",
        message: "Запись была изменена и не может быть удалена без обновления",
        current: record,
      })
    }

    await db.execute("DELETE FROM client_bank_details WHERE id = ?", [id])

    await logActivity({
      req,
      action: "delete",
      entity_type: "client_bank_details",
      entity_id: id,
      comment: "Удалены банковские реквизиты",
      client_id: Number(record.client_id),
    })

    res.json({ message: "Банковские реквизиты удалены" })
  } catch (err) {
    console.error("DELETE /client-bank-details error:", err)
    res.status(500).json({ message: "Ошибка сервера при удалении реквизитов" })
  }
})

module.exports = router
