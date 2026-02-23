const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const nz = (v) => (v === undefined || v === null ? '' : String(v).trim())
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const toIntOrNull = (v) => {
  const n = numOrNull(v)
  if (n === null) return null
  return Math.trunc(n)
}
const normCountry = (v) => {
  const s = nz(v).toUpperCase()
  return s ? s.slice(0, 2) : null
}

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical'])
const SANCTIONS = new Set(['none', 'watch', 'restricted', 'blocked'])
const normRiskLevel = (v) => {
  const s = nz(v).toLowerCase()
  return RISK_LEVELS.has(s) ? s : 'medium'
}
const normSanctions = (v) => {
  const s = nz(v).toLowerCase()
  return SANCTIONS.has(s) ? s : 'none'
}

router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT *
         FROM country_risk_profiles
        ORDER BY country_code ASC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /country-risk-profiles error:', e)
    res.status(500).json({ message: 'Ошибка загрузки риск-профилей стран' })
  }
})

router.post('/', async (req, res) => {
  try {
    const countryCode = normCountry(req.body?.country_code)
    if (!countryCode) return res.status(400).json({ message: 'Код страны обязателен' })

    await db.execute(
      `INSERT INTO country_risk_profiles
        (country_code, risk_level, risk_score, sanctions_status, logistics_risk_factor, customs_delay_days, payment_risk_days, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         risk_level = VALUES(risk_level),
         risk_score = VALUES(risk_score),
         sanctions_status = VALUES(sanctions_status),
         logistics_risk_factor = VALUES(logistics_risk_factor),
         customs_delay_days = VALUES(customs_delay_days),
         payment_risk_days = VALUES(payment_risk_days),
         notes = VALUES(notes)`,
      [
        countryCode,
        normRiskLevel(req.body?.risk_level),
        toIntOrNull(req.body?.risk_score),
        normSanctions(req.body?.sanctions_status),
        numOrNull(req.body?.logistics_risk_factor) ?? 1,
        toIntOrNull(req.body?.customs_delay_days) ?? 0,
        toIntOrNull(req.body?.payment_risk_days),
        nz(req.body?.notes) || null,
      ]
    )

    const [[saved]] = await db.execute(
      'SELECT * FROM country_risk_profiles WHERE country_code = ?',
      [countryCode]
    )
    res.status(201).json(saved)
  } catch (e) {
    console.error('POST /country-risk-profiles error:', e)
    res.status(500).json({ message: 'Ошибка сохранения риск-профиля' })
  }
})

router.put('/:countryCode', async (req, res) => {
  try {
    const countryCode = normCountry(req.params.countryCode)
    if (!countryCode) return res.status(400).json({ message: 'Некорректный код страны' })

    const [[existing]] = await db.execute(
      'SELECT * FROM country_risk_profiles WHERE country_code = ?',
      [countryCode]
    )
    if (!existing) return res.status(404).json({ message: 'Профиль страны не найден' })

    await db.execute(
      `UPDATE country_risk_profiles
          SET risk_level = ?,
              risk_score = ?,
              sanctions_status = ?,
              logistics_risk_factor = ?,
              customs_delay_days = ?,
              payment_risk_days = ?,
              notes = ?
        WHERE country_code = ?`,
      [
        normRiskLevel(req.body?.risk_level ?? existing.risk_level),
        toIntOrNull(req.body?.risk_score ?? existing.risk_score),
        normSanctions(req.body?.sanctions_status ?? existing.sanctions_status),
        numOrNull(req.body?.logistics_risk_factor ?? existing.logistics_risk_factor) ?? 1,
        toIntOrNull(req.body?.customs_delay_days ?? existing.customs_delay_days) ?? 0,
        toIntOrNull(req.body?.payment_risk_days ?? existing.payment_risk_days),
        nz(req.body?.notes ?? existing.notes) || null,
        countryCode,
      ]
    )

    const [[updated]] = await db.execute(
      'SELECT * FROM country_risk_profiles WHERE country_code = ?',
      [countryCode]
    )
    res.json(updated)
  } catch (e) {
    console.error('PUT /country-risk-profiles/:countryCode error:', e)
    res.status(500).json({ message: 'Ошибка обновления риск-профиля' })
  }
})

router.delete('/:countryCode', async (req, res) => {
  try {
    const countryCode = normCountry(req.params.countryCode)
    if (!countryCode) return res.status(400).json({ message: 'Некорректный код страны' })
    const [result] = await db.execute(
      'DELETE FROM country_risk_profiles WHERE country_code = ?',
      [countryCode]
    )
    if (!result.affectedRows) return res.status(404).json({ message: 'Профиль страны не найден' })
    res.status(204).send()
  } catch (e) {
    console.error('DELETE /country-risk-profiles/:countryCode error:', e)
    res.status(500).json({ message: 'Ошибка удаления риск-профиля' })
  }
})

module.exports = router
