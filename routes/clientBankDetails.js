const express = require("express")
const router = express.Router()
const db = require("../utils/db")
const authMiddleware = require("../middleware/authMiddleware")
const logActivity = require("../utils/logActivity")
const logFieldDiffs = require("../utils/logFieldDiffs")

// Получение банковских реквизитов клиента
router.get("/", authMiddleware, async (req, res) => {
  const { client_id } = req.query

  if (!client_id) {
    return res.status(400).json({ error: "client_id is required" })
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_bank_details WHERE client_id = ?",
      [client_id]
    )
    res.json(rows)
  } catch (err) {
    console.error("Ошибка при получении банковских реквизитов:", err)
    res.sendStatus(500)
  }
})

// Добавление новых реквизитов
router.post("/", authMiddleware, async (req, res) => {
  const {
    client_id,
    bank_name,
    bic,
    correspondent_account,
    account_number,
    currency
  } = req.body

  if (!client_id || !bank_name || !bic || !account_number) {
    return res.status(400).json({ error: "Missing data" })
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO client_bank_details 
        (client_id, bank_name, bic, correspondent_account, account_number, currency)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [client_id, bank_name, bic, correspondent_account, account_number, currency || "RUB"]
    )

    await logActivity({
      req,
      action: "create",
      entity_type: "client_bank_details",
      entity_id: result.insertId,
      comment: "Добавлены банковские реквизиты"
    })

    const [rows] = await db.execute("SELECT * FROM client_bank_details WHERE id = ?", [result.insertId])
    res.status(201).json(rows[0])
  } catch (err) {
    console.error("Ошибка при добавлении банковских реквизитов:", err)
    res.sendStatus(500)
  }
})

// Обновление реквизитов
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params
  const {
    bank_name,
    bic,
    correspondent_account,
    account_number,
    currency
  } = req.body

  try {
    const [rows] = await db.execute("SELECT * FROM client_bank_details WHERE id = ?", [id])
    if (!rows.length) return res.sendStatus(404)

    const oldData = rows[0]
    const newData = {
      bank_name,
      bic,
      correspondent_account,
      account_number,
      currency
    }

    await db.execute(
      `UPDATE client_bank_details
       SET bank_name = ?, bic = ?, correspondent_account = ?, account_number = ?, currency = ?
       WHERE id = ?`,
      [bank_name, bic, correspondent_account, account_number, currency, id]
    )

    await logFieldDiffs({
      req,
      entity_type: "client_bank_details",
      entity_id: +id,
      oldData,
      newData
    })

    res.sendStatus(200)
  } catch (err) {
    console.error("Ошибка при обновлении реквизитов:", err)
    res.sendStatus(500)
  }
})

// Удаление реквизита
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    await db.execute("DELETE FROM client_bank_details WHERE id = ?", [id])

    await logActivity({
      req,
      action: "delete",
      entity_type: "client_bank_details",
      entity_id: +id,
      comment: "Удалены банковские реквизиты"
    })

    res.sendStatus(204)
  } catch (err) {
    console.error("Ошибка при удалении банковских реквизитов:", err)
    res.sendStatus(500)
  }
})

module.exports = router
