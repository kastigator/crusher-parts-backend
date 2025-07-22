const express = require("express")
const router = express.Router()
const db = require("../utils/db")
const logActivity = require("../utils/logActivity")
const logFieldDiffs = require("../utils/logFieldDiffs")

// Получение адресов доставки
router.get("/", async (req, res) => {
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

// Добавление адреса с логированием
router.post("/", async (req, res) => {
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
      `INSERT INTO client_shipping_addresses 
        (client_id, label, formatted_address, place_id, lat, lng, postal_code, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [client_id, label || null, formatted_address, place_id || null, lat || null, lng || null, postal_code || null, comment || null]
    )

    await logActivity({
      req,
      action: "create",
      entity_type: "client_shipping_addresses",
      entity_id: result.insertId,
      comment: "Добавлен адрес доставки"
    })

    res.status(201).json({ id: result.insertId })
  } catch (err) {
    console.error("Ошибка при добавлении адреса доставки:", err)
    res.sendStatus(500)
  }
})

// Обновление с логированием
router.put("/:id", async (req, res) => {
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
    const current = rows[0]
    if (!current) return res.sendStatus(404)

    await db.execute(
      `UPDATE client_shipping_addresses
       SET label = ?, formatted_address = ?, place_id = ?, lat = ?, lng = ?, postal_code = ?, comment = ?
       WHERE id = ?`,
      [label || null, formatted_address, place_id || null, lat || null, lng || null, postal_code || null, comment || null, id]
    )

    await logFieldDiffs({
      req,
      oldData: current,
      newData: req.body,
      entity_type: "client_shipping_addresses",
      entity_id: +id
    })

    res.sendStatus(200)
  } catch (err) {
    console.error("Ошибка при обновлении адреса доставки:", err)
    res.sendStatus(500)
  }
})

// Удаление с логированием
router.delete("/:id", async (req, res) => {
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
