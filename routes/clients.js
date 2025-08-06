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
router.post("/", authMiddleware, async (req, res) => {
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
      field_changed: "company_name",
      new_value: company_name?.trim(),
      comment: "Клиент добавлен"
    })

    res.status(201).json({ id: result.insertId })
  } catch (err) {
    console.error("Ошибка при добавлении клиента:", err)
    res.sendStatus(500)
  }
})

// Обновление клиента
router.put("/:id", authMiddleware, async (req, res) => {
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
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    // Получаем клиента до удаления
    const [clientRows] = await conn.execute("SELECT * FROM clients WHERE id = ?", [id])
    const client = clientRows[0]

    await conn.execute("DELETE FROM client_billing_addresses WHERE client_id = ?", [id])
    await conn.execute("DELETE FROM client_shipping_addresses WHERE client_id = ?", [id])
    await conn.execute("DELETE FROM client_bank_details WHERE client_id = ?", [id])
    await conn.execute("DELETE FROM clients WHERE id = ?", [id])

    await logActivity({
      req,
      action: "delete",
      entity_type: "clients",
      entity_id: +id,
      field_changed: "company_name",
      old_value: client?.company_name || null,
      new_value: null,
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

// Получение логов по конкретному клиенту (по client_id)
router.get("/:id/logs", authMiddleware, async (req, res) => {
  const clientId = +req.params.id
  try {
    const [logs] = await db.query(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.client_id = ?
      ORDER BY a.created_at DESC
    `, [clientId])

    res.json(logs)
  } catch (err) {
    console.error("Ошибка при загрузке логов клиента:", err)
    res.sendStatus(500)
  }
})

// 🔥 Все удалённые записи по клиентам и связанным таблицам
router.get("/logs/deleted", authMiddleware, async (req, res) => {
  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND a.entity_type IN (
          'clients',
          'client_billing_addresses',
          'client_shipping_addresses',
          'client_bank_details'
        )
      ORDER BY a.created_at DESC
    `)

    res.json(logs)
  } catch (err) {
    console.error("Ошибка при загрузке удалённых логов:", err)
    res.sendStatus(500)
  }
})

module.exports = router
