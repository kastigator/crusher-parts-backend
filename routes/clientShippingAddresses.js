const express = require("express")
const router = express.Router()
const db = require("../utils/db")
const authMiddleware = require("../middleware/authMiddleware")
const logActivity = require("../utils/logActivity")
const logFieldDiffs = require("../utils/logFieldDiffs")

// Получение адресов доставки
router.get("/", authMiddleware, async (req, res) => {
  const { client_id } = req.query
  if (!client_id) return res.status(400).json({ error: "client_id is required" })

  try {
    const [rows] = await db.execute(
      "SELECT * FROM client_shipping_addresses WHERE client_id = ? ORDER BY id DESC",
      [client_id]
    )
    res.json(rows)
  } catch (err) {
    console.error("Ошибка при получении адресов доставки:", err)
    res.sendStatus(500)
  }
})

// Добавление адреса
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

  if (!client_id || !formatted_address?.trim()) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO client_shipping_addresses 
        (client_id, label, formatted_address, place_id, lat, lng, postal_code, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client_id,
        label?.trim() || null,
        formatted_address.trim(),
        place_id?.trim() || null,
        lat || null,
        lng || null,
        postal_code?.trim() || null,
        comment?.trim() || null
      ]
    )

    await logActivity({
      req,
      action: "create",
      entity_type: "client_shipping_addresses",
      entity_id: result.insertId,
      comment: "Добавлен адрес доставки"
    })

    const [rows] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [result.insertId])
    res.status(201).json(rows[0])
  } catch (err) {
    console.error("Ошибка при добавлении адреса доставки:", err)
    res.sendStatus(500)
  }
})

// Обновление адреса
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
    const [rows] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [id])
    if (!rows.length) return res.sendStatus(404)

    const oldData = rows[0]
    const newData = {
      label: label?.trim() || null,
      formatted_address: formatted_address?.trim() || null,
      place_id: place_id?.trim() || null,
      lat: lat || null,
      lng: lng || null,
      postal_code: postal_code?.trim() || null,
      comment: comment?.trim() || null
    }

    await db.execute(
      `UPDATE client_shipping_addresses
       SET label = ?, formatted_address = ?, place_id = ?, lat = ?, lng = ?, postal_code = ?, comment = ?
       WHERE id = ?`,
      [
        newData.label,
        newData.formatted_address,
        newData.place_id,
        newData.lat,
        newData.lng,
        newData.postal_code,
        newData.comment,
        id
      ]
    )

    await logFieldDiffs({
      req,
      oldData,
      newData,
      entity_type: "client_shipping_addresses",
      entity_id: +id
    })

    res.sendStatus(200)
  } catch (err) {
    console.error("Ошибка при обновлении адреса доставки:", err)
    res.sendStatus(500)
  }
})

// Удаление адреса
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params

  try {
    await db.execute("DELETE FROM client_shipping_addresses WHERE id = ?", [id])

    await logActivity({
      req,
      action: "delete",
      entity_type: "client_shipping_addresses",
      entity_id: +id,
      comment: "Удалён адрес доставки"
    })

    res.sendStatus(204)
  } catch (err) {
    console.error("Ошибка при удалении адреса доставки:", err)
    res.sendStatus(500)
  }
})

module.exports = router
