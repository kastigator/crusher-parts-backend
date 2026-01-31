// routes/userUiSettings.js
// Simple per-user UI settings storage (JSON).
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)
const parseJsonField = (v) => {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

// GET /user-ui-settings?scope=...&key=...
// Returns { scope, key, value_json } or null if not found.
router.get('/', async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ message: 'Не авторизован' })
    }

    const scope = nz(req.query.scope)
    const key = nz(req.query.key)
    if (!scope || !key) {
      return res.status(400).json({ message: 'scope и key обязательны' })
    }

    const [rows] = await db.execute(
      'SELECT scope, `key`, value_json FROM user_ui_settings WHERE user_id = ? AND scope = ? AND `key` = ?',
      [userId, scope, key]
    )
    if (!rows.length) return res.json(null)
    res.json({ ...rows[0], value_json: parseJsonField(rows[0].value_json) })
  } catch (err) {
    console.error('GET /user-ui-settings error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// PUT /user-ui-settings
// body: { scope, key, value_json }
router.put('/', async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ message: 'Не авторизован' })
    }

    const scope = nz(req.body?.scope)
    const key = nz(req.body?.key)
    const value_json = req.body?.value_json

    if (!scope || !key) {
      return res.status(400).json({ message: 'scope и key обязательны' })
    }
    if (value_json === undefined) {
      return res.status(400).json({ message: 'value_json обязателен' })
    }

    const valueStr = JSON.stringify(value_json)

    await db.execute(
      `
      INSERT INTO user_ui_settings (user_id, scope, \`key\`, value_json)
      VALUES (?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE value_json = CAST(VALUES(value_json) AS JSON)
      `,
      [userId, scope, key, valueStr]
    )

    const [rows] = await db.execute(
      'SELECT scope, `key`, value_json FROM user_ui_settings WHERE user_id = ? AND scope = ? AND `key` = ?',
      [userId, scope, key]
    )
    if (!rows.length) return res.json(null)
    res.json({ ...rows[0], value_json: parseJsonField(rows[0].value_json) })
  } catch (err) {
    console.error('PUT /user-ui-settings error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
