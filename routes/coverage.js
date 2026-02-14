const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { buildRfqStructure } = require('../utils/rfqStructure')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const boolFromQuery = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'да'].includes(s)) return true
  if (['0', 'false', 'no', 'нет'].includes(s)) return false
  return fallback
}

router.get('/', async (req, res) => {
  try {
    const rfqId = toId(req.query.rfq_id)
    if (!rfqId) {
      return res.status(400).json({ message: 'Не выбран RFQ' })
    }

    const includeResponses = boolFromQuery(req.query.include_responses, true)
    const payload = await buildRfqStructure(db, rfqId, {
      includeSuppliers: true,
      includeResponses,
      includeSelf: true,
    })

    res.json(payload)
  } catch (e) {
    console.error('GET /coverage error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
