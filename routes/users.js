const express = require("express")
const router = express.Router()
const db = require("../utils/db")
const bcrypt = require("bcrypt")
const saltRounds = 10

// Утилита: заменить undefined на null
const safe = (v) => v === undefined ? null : v

// 🔹 Получить список всех пользователей с ролью
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT users.*, roles.name AS role_name, roles.slug AS role_slug
      FROM users
      LEFT JOIN roles ON users.role_id = roles.id
    `)
    res.json(rows)
  } catch (err) {
    console.error("GET /users error", err)
    res.status(500).json({ error: "Ошибка при получении пользователей" })
  }
})

// 🔹 Создание нового пользователя
router.post("/", async (req, res) => {
  try {
    const {
      username, password, full_name, email, phone, position, role_slug
    } = req.body

    if (!username || !password || !role_slug) {
      return res.status(400).json({ error: "Обязательные поля: username, password, role_slug" })
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds)

    const [[role]] = await db.execute("SELECT id FROM roles WHERE slug = ?", [role_slug])
    if (!role) {
      return res.status(400).json({ error: "Роль не найдена" })
    }

    await db.execute(`
      INSERT INTO users (username, password, full_name, email, phone, position, role_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      username,
      hashedPassword,
      safe(full_name),
      safe(email),
      safe(phone),
      safe(position),
      role.id
    ])

    res.json({ success: true })
  } catch (err) {
    console.error("POST /users error", err)
    res.status(500).json({ error: "Ошибка при создании пользователя" })
  }
})

// 🔹 Обновление существующего пользователя
router.put("/:id", async (req, res) => {
  try {
    const id = req.params.id
    const {
      username, password, full_name, email, phone, position, role_slug
    } = req.body

    const [[role]] = await db.execute("SELECT id FROM roles WHERE slug = ?", [role_slug])
    if (!role) {
      return res.status(400).json({ error: "Роль не найдена" })
    }

    const updates = {
      username,
      full_name,
      email,
      phone,
      position,
      role_id: role.id
    }

    if (password) {
      updates.password = await bcrypt.hash(password, saltRounds)
    }

    const fields = Object.keys(updates)
    const values = Object.values(updates).map(safe) // 👈 безопасное приведение

    const setClause = fields.map(field => `${field} = ?`).join(", ")

    await db.execute(
      `UPDATE users SET ${setClause} WHERE id = ?`,
      [...values, id]
    )

    res.json({ success: true })
  } catch (err) {
    console.error("PUT /users/:id error", err)
    res.status(500).json({ error: "Ошибка при обновлении пользователя" })
  }
})

// 🔹 Удаление пользователя
router.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id
    await db.execute("DELETE FROM users WHERE id = ?", [id])
    res.json({ success: true })
  } catch (err) {
    console.error("DELETE /users/:id error", err)
    res.status(500).json({ error: "Ошибка при удалении пользователя" })
  }
})

router.post("/:id/reset-password", async (req, res) => {
  try {
    const id = req.params.id
    const provided = req.body?.newPassword

    const newPassword = provided || Math.random().toString(36).slice(-8)
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds)

    await db.execute("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, id])

    res.json({ success: true, newPassword })
  } catch (err) {
    console.error("POST /users/:id/reset-password error", err)
    res.status(500).json({ error: "Ошибка при сбросе пароля" })
  }
})


module.exports = router
