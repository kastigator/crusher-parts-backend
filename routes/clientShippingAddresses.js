// routes/clientShippingAddresses.js

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

// Добавление адреса доставки
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
    comment
  } = req.body

  if (!client_id || !formatted_address?.trim()) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO client_shipping_addresses 
        (client_id, formatted_address, place_id, lat, lng, postal_code,
         country, region, city, street, house, building, entrance, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client_id,
        formatted_address.trim(),
        place_id?.trim() || null,
        lat != null ? parseFloat(lat) : null,
        lng != null ? parseFloat(lng) : null,
        postal_code?.trim() || null,
        country?.trim() || null,
        region?.trim() || null,
        city?.trim() || null,
        street?.trim() || null,
        house?.trim() || null,
        building?.trim() || null,
        entrance?.trim() || null,
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

// Обновление адреса доставки
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params
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
    comment
  } = req.body

  try {
    const [rows] = await db.execute("SELECT * FROM client_shipping_addresses WHERE id = ?", [id])
    if (!rows.length) return res.sendStatus(404)

    const oldData = rows[0]
    const newData = {
      formatted_address: formatted_address?.trim() || null,
      place_id: place_id?.trim() || null,
      lat: lat != null ? parseFloat(lat) : null,
      lng: lng != null ? parseFloat(lng) : null,
      postal_code: postal_code?.trim() || null,
      country: country?.trim() || null,
      region: region?.trim() || null,
      city: city?.trim() || null,
      street: street?.trim() || null,
      house: house?.trim() || null,
      building: building?.trim() || null,
      entrance: entrance?.trim() || null,
      comment: comment?.trim() || null
    }

    await db.execute(
      `UPDATE client_shipping_addresses
       SET formatted_address = ?, place_id = ?, lat = ?, lng = ?, postal_code = ?,
           country = ?, region = ?, city = ?, street = ?, house = ?, building = ?, entrance = ?, comment = ?
       WHERE id = ?`,
      [
        newData.formatted_address,
        newData.place_id,
        newData.lat,
        newData.lng,
        newData.postal_code,
        newData.country,
        newData.region,
        newData.city,
        newData.street,
        newData.house,
        newData.building,
        newData.entrance,
        newData.comment,
        id
      ]
    )

    await logFieldDiffs({
      req,
      entity_type: "client_shipping_addresses",
      entity_id: +id,
      oldData,
      newData
    })

    res.sendStatus(200)
  } catch (err) {
    console.error("Ошибка при обновлении адреса доставки:", err)
    res.sendStatus(500)
  }
})

// Удаление адреса доставки
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
