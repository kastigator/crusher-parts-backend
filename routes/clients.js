const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const authMiddleware = require('../middleware/authMiddleware')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// Получение всех клиентов
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM clients ORDER BY id DESC")
    res.json(rows)
  } catch (err) {
    console.error("Ошибка при получении клиентов:", err)
    res.sendStatus(500)
  }
})

// Добавление клиента
router.post("/", async (req, res) => {
  const { company_name, contact_person, phone, email } = req.body

  if (!company_name?.trim()) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO clients (company_name, contact_person, phone, email)
       VALUES (?, ?, ?, ?)`,
      [company_name, contact_person || null, phone || null, email || null]
    )

    await logActivity({
      req,
      action: "create",
      entity_type: "clients",
      entity_id: result.insertId,
      comment: "Клиент добавлен"
    })

    res.status(201).json({ id: result.insertId })
  } catch (err) {
    console.error("Ошибка при добавлении клиента:", err)
    res.sendStatus(500)
  }
})

// Обновление клиента
router.put("/:id", async (req, res) => {
  const { id } = req.params
  const { company_name, contact_person, phone, email } = req.body

  try {
    const [rows] = await db.execute("SELECT * FROM clients WHERE id = ?", [id])
    const current = rows[0]
    if (!current) return res.sendStatus(404)

    await db.execute(
      `UPDATE clients SET company_name=?, contact_person=?, phone=?, email=? WHERE id=?`,
      [company_name, contact_person || null, phone || null, email || null, id]
    )

    await logFieldDiffs({
      req,
      oldData: current,
      newData: req.body,
      entity_type: "clients",
      entity_id: +id
    })

    res.sendStatus(200)
  } catch (err) {
    console.error("Ошибка при обновлении клиента:", err)
    res.sendStatus(500)
  }
})

// Удаление клиента и связанных записей
router.delete("/:id", async (req, res) => {
  const { id } = req.params

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    await conn.execute("DELETE FROM client_billing_addresses WHERE client_id = ?", [id])
    await conn.execute("DELETE FROM client_shipping_addresses WHERE client_id = ?", [id])
    await conn.execute("DELETE FROM client_bank_details WHERE client_id = ?", [id])
    await conn.execute("DELETE FROM clients WHERE id = ?", [id])

    await logActivity({
      req,
      action: "delete",
      entity_type: "clients",
      entity_id: +id,
      comment: "Клиент и связанные записи удалены"
    })

    await conn.commit()
    res.sendStatus(204)
  } catch (err) {
    await conn.rollback()
    console.error("Ошибка при удалении клиента:", err)
    res.sendStatus(500)
  } finally {
    conn.release()
  }
})

// Получение логов по клиенту и связанным сущностям
router.get("/:id/logs", authMiddleware, async (req, res) => {
  const clientId = req.params.id
  try {
    const [billing] = await db.execute("SELECT id FROM client_billing_addresses WHERE client_id = ?", [clientId])
    const [shipping] = await db.execute("SELECT id FROM client_shipping_addresses WHERE client_id = ?", [clientId])
    const [banks] = await db.execute("SELECT id FROM client_bank_details WHERE client_id = ?", [clientId])

    const billingIds = billing.map(r => r.id)
    const shippingIds = shipping.map(r => r.id)
    const bankIds = banks.map(r => r.id)

    let query = `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE (a.entity_type = 'clients' AND a.entity_id = ?)`
    const params = [clientId]

    if (billingIds.length) query += ` OR (a.entity_type = 'client_billing_addresses' AND a.entity_id IN (${billingIds.join(",")}))`
    if (shippingIds.length) query += ` OR (a.entity_type = 'client_shipping_addresses' AND a.entity_id IN (${shippingIds.join(",")}))`
    if (bankIds.length) query += ` OR (a.entity_type = 'client_bank_details' AND a.entity_id IN (${bankIds.join(",")}))`

    query += ` ORDER BY a.created_at DESC`
    const [logs] = await db.query(query, params)
    res.json(logs)
  } catch (err) {
    console.error("Ошибка при загрузке логов клиента:", err)
    res.sendStatus(500)
  }
})

module.exports = router
