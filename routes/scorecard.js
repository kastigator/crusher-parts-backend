const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

router.get('/templates', async (_req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM scorecard_templates ORDER BY id DESC')
    res.json(rows)
  } catch (e) {
    console.error('GET /scorecard/templates error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/templates', async (req, res) => {
  try {
    const name = nz(req.body.name)
    if (!name) return res.status(400).json({ message: 'name обязателен' })

    const scope = nz(req.body.scope) || 'SUPPLIER'
    const is_active = req.body.is_active === undefined ? 1 : req.body.is_active ? 1 : 0

    const [result] = await db.execute(
      'INSERT INTO scorecard_templates (name, scope, is_active) VALUES (?,?,?)',
      [name, scope, is_active]
    )

    const [[created]] = await db.execute('SELECT * FROM scorecard_templates WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /scorecard/templates error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/templates/:id/criteria', async (req, res) => {
  try {
    const templateId = toId(req.params.id)
    if (!templateId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      'SELECT * FROM scorecard_criteria WHERE template_id = ? ORDER BY id ASC',
      [templateId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /scorecard/templates/:id/criteria error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/templates/:id/criteria', async (req, res) => {
  try {
    const templateId = toId(req.params.id)
    if (!templateId) return res.status(400).json({ message: 'Некорректный ID' })

    const code = nz(req.body.code)
    const name = nz(req.body.name)
    if (!code || !name) return res.status(400).json({ message: 'code и name обязательны' })

    const weight = numOrNull(req.body.weight) || 0

    const [result] = await db.execute(
      'INSERT INTO scorecard_criteria (template_id, code, name, weight) VALUES (?,?,?,?)',
      [templateId, code, name, weight]
    )

    const [[created]] = await db.execute('SELECT * FROM scorecard_criteria WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /scorecard/templates/:id/criteria error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
