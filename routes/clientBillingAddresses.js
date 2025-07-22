const express = require("express")
const router = express.Router()
const db = require("../utils/db")
const authMiddleware = require("../middleware/authMiddleware")
const logActivity = require("../utils/logActivity")
const logFieldDiffs = require("../utils/logFieldDiffs")

// Получение юр. адресов по client_id
router.get("/", async (req, res) => {
  const { client_id } = req.query
  if (!client_id) return res.status(400).json({ error: "client_id is required" })

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_billing_addresses WHERE client_id = ? ORDER BY id DESC",
      [client_id]
    )
    res.json(rows)
  } catch (err) {
    console.error("Ошибка при получении юр. адресов:", err)
    res.sendStatus(500)
  }
})

// Добавление нового юр. адреса
router.post("/", authMiddleware, async (req, res) => {
  const {
    client_id,
    label,
    formatted_address,
    place_id,
    lat,
    lng,
    postal_code,
    comment
  } = req.body

  if (!client_id || !formatted_address) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO client_billing_addresses 
        (client_id, label, formatted_address, place_id, lat, lng, postal_code, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [client_id, label || null, formatted_address, place_id || null, lat || null, lng || null, postal_code || null, comment || null]
    )

    await logActivity({
      req,
      action: "create",
      entity_type: "client_billing_addresses",
      entity_id: result.insertId,
      comment: "Добавлен юр. адрес"
    })

    res.status(201).json({ id: result.insertId })
  } catch (err) {
    console.error("Ошибка при добавлении юр. адреса:", err)
    res.sendStatus(500)
  }
})

// Обновление юр. адреса
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params
  const {
    label,
    formatted_address,
    place_id,
    lat,
    lng,
    postal_code,
    comment
  } = req.body

  try {
    const [rows] = await db.execute("SELECT * FROM client_billing_addresses WHERE id = ?", [id])
    if (!rows.length) return res.sendStatus(404)

    const oldData = rows[0]
    const newData = {
      label,
      formatted_address,
      place_id,
      lat,
      lng,
      postal_code,
      comment
    }

    await db.execute(
      `UPDATE client_billing_addresses
       SET label = ?, formatted_address = ?, place_id = ?, lat = ?, lng = ?, postal_code = ?, comment = ?
       WHERE id = ?`,
      [label || null, formatted_address, place_id || null, lat || null, lng || null, postal_code || null, comment || null, id]
    )

    await logFieldDiffs(req, {
      entity_type: "client_billing_addresses",
      entity_id: +id,
      oldData,
      newData
    })

    res.sendStatus(200)
  } catch (err) {
    console.error("Ошибка при обновлении юр. адреса:", err)
    res.sendStatus(500)
  }
})

// Удаление юр. адреса
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params
  try {
    await db.execute("DELETE FROM client_billing_addresses WHERE id = ?", [id])

    await logActivity({
      req,
      action: "delete",
      entity_type: "client_billing_addresses",
      entity_id: +id,
      comment: "Удалён юр. адрес"
    })

    res.sendStatus(204)
  } catch (err) {
    console.error("Ошибка при удалении юр. адреса:", err)
    res.sendStatus(500)
  }
})

module.exports = router
