const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) => (v === undefined || v === null ? '' : String(v).trim())
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const normCountry = (v) => {
  const s = nz(v).toUpperCase()
  if (!s) return null
  return s.slice(0, 2)
}
const boolToTiny = (v, fallback = 1) => {
  if (v === undefined || v === null || v === '') return fallback
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'да'].includes(s)) return 1
  if (['0', 'false', 'no', 'n', 'нет'].includes(s)) return 0
  return fallback
}

const TRANSPORT_MODES = new Set(['SEA', 'RAIL', 'AIR', 'ROAD', 'MULTI'])
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical'])

const normTransportMode = (v) => {
  const s = nz(v).toUpperCase()
  return TRANSPORT_MODES.has(s) ? s : 'MULTI'
}
const normRiskLevel = (v) => {
  const s = nz(v).toLowerCase()
  return RISK_LEVELS.has(s) ? s : 'medium'
}

router.get('/', async (req, res) => {
  try {
    const onlyActive = String(req.query.only_active || '').trim() === '1'
    const whereSql = onlyActive ? 'WHERE is_active = 1' : ''
    const [rows] = await db.query(
      `SELECT *
         FROM logistics_corridors
         ${whereSql}
        ORDER BY is_active DESC, name ASC, id DESC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /logistics-corridors error:', e)
    res.status(500).json({ message: 'Ошибка загрузки коридоров' })
  }
})

router.post('/', async (req, res) => {
  try {
    const name = nz(req.body?.name)
    if (!name) return res.status(400).json({ message: 'Название коридора обязательно' })

    const payload = [
      name,
      normCountry(req.body?.origin_country),
      normCountry(req.body?.destination_country),
      normTransportMode(req.body?.transport_mode),
      normRiskLevel(req.body?.risk_level),
      toId(req.body?.eta_min_days),
      toId(req.body?.eta_max_days),
      nz(req.body?.notes) || null,
      boolToTiny(req.body?.is_active, 1),
    ]

    const [ins] = await db.execute(
      `INSERT INTO logistics_corridors
        (name, origin_country, destination_country, transport_mode, risk_level, eta_min_days, eta_max_days, notes, is_active)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      payload
    )
    const [[created]] = await db.execute('SELECT * FROM logistics_corridors WHERE id = ?', [ins.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /logistics-corridors error:', e)
    res.status(500).json({ message: 'Ошибка создания коридора' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[existing]] = await db.execute('SELECT * FROM logistics_corridors WHERE id = ?', [id])
    if (!existing) return res.status(404).json({ message: 'Коридор не найден' })

    const name = nz(req.body?.name) || existing.name

    await db.execute(
      `UPDATE logistics_corridors
          SET name = ?,
              origin_country = ?,
              destination_country = ?,
              transport_mode = ?,
              risk_level = ?,
              eta_min_days = ?,
              eta_max_days = ?,
              notes = ?,
              is_active = ?
        WHERE id = ?`,
      [
        name,
        normCountry(req.body?.origin_country ?? existing.origin_country),
        normCountry(req.body?.destination_country ?? existing.destination_country),
        normTransportMode(req.body?.transport_mode ?? existing.transport_mode),
        normRiskLevel(req.body?.risk_level ?? existing.risk_level),
        toId(req.body?.eta_min_days ?? existing.eta_min_days),
        toId(req.body?.eta_max_days ?? existing.eta_max_days),
        nz(req.body?.notes ?? existing.notes) || null,
        boolToTiny(req.body?.is_active ?? existing.is_active, Number(existing.is_active) ? 1 : 0),
        id,
      ]
    )

    const [[updated]] = await db.execute('SELECT * FROM logistics_corridors WHERE id = ?', [id])
    res.json(updated)
  } catch (e) {
    console.error('PUT /logistics-corridors/:id error:', e)
    res.status(500).json({ message: 'Ошибка обновления коридора' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [result] = await db.execute('DELETE FROM logistics_corridors WHERE id = ?', [id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Коридор не найден' })

    res.status(204).send()
  } catch (e) {
    console.error('DELETE /logistics-corridors/:id error:', e)
    res.status(500).json({ message: 'Ошибка удаления коридора' })
  }
})

module.exports = router
