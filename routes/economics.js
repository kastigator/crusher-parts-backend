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

router.get('/shipment-groups', async (_req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM shipment_groups ORDER BY id DESC')
    res.json(rows)
  } catch (e) {
    console.error('GET /economics/shipment-groups error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/shipment-groups', async (req, res) => {
  try {
    const rfq_id = toId(req.body.rfq_id)
    const name = nz(req.body.name)
    if (!rfq_id || !name) return res.status(400).json({ message: 'Нужно указать RFQ и название' })

    const [result] = await db.execute(
      `INSERT INTO shipment_groups
        (rfq_id, name, origin_country, origin_location, destination_country, destination_location, transport_mode, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        rfq_id,
        name,
        nz(req.body.origin_country),
        nz(req.body.origin_location),
        nz(req.body.destination_country),
        nz(req.body.destination_location),
        nz(req.body.transport_mode) || 'UNKNOWN',
        nz(req.body.note),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM shipment_groups WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /economics/shipment-groups error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/scenarios', async (_req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM economic_scenarios ORDER BY id DESC')
    res.json(rows)
  } catch (e) {
    console.error('GET /economics/scenarios error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/scenarios', async (req, res) => {
  try {
    const shipment_group_id = toId(req.body.shipment_group_id)
    const name = nz(req.body.name)
    const transport_mode = nz(req.body.transport_mode)
    if (!shipment_group_id || !name || !transport_mode) {
      return res.status(400).json({ message: 'Нужно указать группу отгрузки, название и тип транспорта' })
    }

    const [result] = await db.execute(
      `INSERT INTO economic_scenarios
        (shipment_group_id, name, transport_mode, eta_days, cost, currency, notes)
       VALUES (?,?,?,?,?,?,?)`,
      [
        shipment_group_id,
        name,
        transport_mode,
        toId(req.body.eta_days),
        numOrNull(req.body.cost),
        nz(req.body.currency),
        nz(req.body.notes),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM economic_scenarios WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /economics/scenarios error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/landed-costs', async (_req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM landed_cost_snapshots ORDER BY id DESC')
    res.json(rows)
  } catch (e) {
    console.error('GET /economics/landed-costs error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/landed-costs', async (req, res) => {
  try {
    const rfq_id = toId(req.body.rfq_id)
    const name = nz(req.body.name)
    if (!rfq_id || !name) return res.status(400).json({ message: 'Нужно указать RFQ и название' })

    const [result] = await db.execute(
      `INSERT INTO landed_cost_snapshots
        (rfq_id, name, goods_total, logistics_total, duty_total, warehouse_total, landed_total, currency, eta_days, note)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        rfq_id,
        name,
        numOrNull(req.body.goods_total),
        numOrNull(req.body.logistics_total),
        numOrNull(req.body.duty_total),
        numOrNull(req.body.warehouse_total),
        numOrNull(req.body.landed_total),
        nz(req.body.currency),
        toId(req.body.eta_days),
        nz(req.body.note),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM landed_cost_snapshots WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /economics/landed-costs error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
