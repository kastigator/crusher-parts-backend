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

const PRICING_MODELS = new Set([
  'fixed',
  'per_kg',
  'per_cbm',
  'per_kg_or_cbm_max',
])

const normPricingModel = (v) => {
  const s = nz(v).toLowerCase()
  return PRICING_MODELS.has(s) ? s : null
}

const normLegs = (arr) => {
  if (!Array.isArray(arr)) return []
  const legs = []
  arr.forEach((l, idx) => {
    const seq = toId(l.seq) || idx + 1
    legs.push({
      seq,
      name: nz(l.name) || null,
      type: nz(l.type) || null,
      from_country: nz(l.from_country) || null,
      to_country: nz(l.to_country) || null,
      incoterms: nz(l.incoterms) || null,
      eta_days: numOrNull(l.eta_days),
      cost: numOrNull(l.cost),
      currency: nz(l.currency) || null,
      surcharge_pct: numOrNull(l.surcharge_pct),
      surcharge_abs: numOrNull(l.surcharge_abs),
      comment: nz(l.comment) || null,
    })
  })
  // уникализируем seq по порядку
  return legs
    .sort((a, b) => a.seq - b.seq)
    .map((l, i) => ({ ...l, seq: i + 1 }))
}

const attachLegs = async (routes) => {
  if (!Array.isArray(routes) || routes.length === 0) return routes
  const ids = routes.map((r) => r.id).filter(Boolean)
  if (!ids.length) return routes
  const [rows] = await db.query(
    `SELECT * FROM logistics_route_legs WHERE route_id IN (?) ORDER BY route_id, seq`,
    [ids]
  )
  const byRoute = rows.reduce((acc, l) => {
    if (!acc[l.route_id]) acc[l.route_id] = []
    acc[l.route_id].push(l)
    return acc
  }, {})
  return routes.map((r) => ({ ...r, legs: byRoute[r.id] || [] }))
}

// GET /logistics-routes (с вложенными звеньями)
router.get('/', async (req, res) => {
  try {
    const where = []
    const params = []
    if (req.query.type) {
      where.push('type = ?')
      params.push(req.query.type)
    }
    if (req.query.from_country) {
      where.push('from_country = ?')
      params.push(req.query.from_country)
    }
    if (req.query.to_country) {
      where.push('to_country = ?')
      params.push(req.query.to_country)
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const [rows] = await db.query(
      `SELECT * FROM logistics_routes ${whereSql} ORDER BY name ASC, id DESC`,
      params
    )
    const withLegs = await attachLegs(rows)
    res.json(withLegs)
  } catch (e) {
    console.error('GET /logistics-routes error', e)
    res.status(500).json({ message: 'Ошибка загрузки маршрутов' })
  }
})

// POST /logistics-routes
router.post('/', async (req, res) => {
  try {
    const {
      name,
      type,
      from_country,
      to_country,
      incoterms,
      eta_days,
      cost,
      currency,
      surcharge_pct,
      surcharge_abs,
      pricing_model,
      rate_per_kg,
      rate_per_cbm,
      min_cost,
      volumetric_kg_per_cbm,
      round_step_kg,
      round_step_cbm,
      comment,
      legs,
    } = req.body || {}

    if (!nz(name)) {
      return res.status(400).json({ message: 'Название обязательно' })
    }

    const pricingModel = normPricingModel(pricing_model)
    if (nz(pricing_model) && !pricingModel) {
      return res.status(400).json({ message: 'Некорректный тариф' })
    }
    const volumetricValue =
      numOrNull(volumetric_kg_per_cbm) != null
        ? numOrNull(volumetric_kg_per_cbm)
        : 167

    const legsNorm = normLegs(legs)

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      const [ins] = await conn.execute(
        `
      INSERT INTO logistics_routes
        (
          name,
          type,
          from_country,
          to_country,
          incoterms,
          eta_days,
          cost,
          currency,
          surcharge_pct,
          surcharge_abs,
          pricing_model,
          rate_per_kg,
          rate_per_cbm,
          min_cost,
          volumetric_kg_per_cbm,
          round_step_kg,
          round_step_cbm,
          comment
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        [
          nz(name),
          nz(type),
          nz(from_country) || null,
          nz(to_country) || null,
          nz(incoterms) || null,
          numOrNull(eta_days),
          numOrNull(cost),
          nz(currency) || null,
          numOrNull(surcharge_pct),
          numOrNull(surcharge_abs),
          pricingModel || 'fixed',
          numOrNull(rate_per_kg),
          numOrNull(rate_per_cbm),
          numOrNull(min_cost),
          volumetricValue,
          numOrNull(round_step_kg),
          numOrNull(round_step_cbm),
          nz(comment) || null,
        ],
      )

      if (legsNorm.length) {
        const values = legsNorm.map((l) => [
          ins.insertId,
          l.seq,
          l.name,
          l.type,
          l.from_country,
          l.to_country,
          l.incoterms,
          l.eta_days,
          l.cost,
          l.currency,
          l.surcharge_pct,
          l.surcharge_abs,
          l.comment,
        ])
        await conn.query(
          `
            INSERT INTO logistics_route_legs
              (route_id, seq, name, type, from_country, to_country, incoterms, eta_days, cost, currency, surcharge_pct, surcharge_abs, comment)
            VALUES ?
          `,
          [values]
        )
      }

      await conn.commit()
      const [[created]] = await conn.query(
        'SELECT * FROM logistics_routes WHERE id = ?',
        [ins.insertId]
      )
      const withLegs = await attachLegs([created])
      res.status(201).json(withLegs[0] || created)
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('POST /logistics-routes error', e)
    res.status(500).json({ message: 'Ошибка создания маршрута' })
  }
})

// PUT /logistics-routes/:id
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const {
      name,
      type,
      from_country,
      to_country,
      incoterms,
      eta_days,
      cost,
      currency,
      surcharge_pct,
      surcharge_abs,
      pricing_model,
      rate_per_kg,
      rate_per_cbm,
      min_cost,
      volumetric_kg_per_cbm,
      round_step_kg,
      round_step_cbm,
      comment,
      legs,
    } = req.body || {}

    const [beforeRows] = await db.execute(
      'SELECT * FROM logistics_routes WHERE id = ?',
      [id],
    )
    if (!beforeRows.length) {
      return res.status(404).json({ message: 'Маршрут не найден' })
    }

    const pricingModel = pricing_model !== undefined ? normPricingModel(pricing_model) : null
    if (pricing_model !== undefined && nz(pricing_model) && !pricingModel) {
      return res.status(400).json({ message: 'Некорректный тариф' })
    }

    const legsNorm = normLegs(legs)

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      await conn.execute(
        `
      UPDATE logistics_routes
      SET
        name = COALESCE(?, name),
        type = COALESCE(?, type),
        from_country = COALESCE(?, from_country),
        to_country = COALESCE(?, to_country),
        incoterms = COALESCE(?, incoterms),
        eta_days = COALESCE(?, eta_days),
        cost = COALESCE(?, cost),
        currency = COALESCE(?, currency),
        surcharge_pct = COALESCE(?, surcharge_pct),
        surcharge_abs = COALESCE(?, surcharge_abs),
        pricing_model = COALESCE(?, pricing_model),
        rate_per_kg = COALESCE(?, rate_per_kg),
        rate_per_cbm = COALESCE(?, rate_per_cbm),
        min_cost = COALESCE(?, min_cost),
        volumetric_kg_per_cbm = COALESCE(?, volumetric_kg_per_cbm),
        round_step_kg = COALESCE(?, round_step_kg),
        round_step_cbm = COALESCE(?, round_step_cbm),
        comment = COALESCE(?, comment)
      WHERE id = ?
    `,
        [
          nz(name) || null,
          nz(type) || null,
          nz(from_country) || null,
          nz(to_country) || null,
          nz(incoterms) || null,
          numOrNull(eta_days),
          numOrNull(cost),
          nz(currency) || null,
          numOrNull(surcharge_pct),
          numOrNull(surcharge_abs),
          pricingModel,
          numOrNull(rate_per_kg),
          numOrNull(rate_per_cbm),
          numOrNull(min_cost),
          numOrNull(volumetric_kg_per_cbm),
          numOrNull(round_step_kg),
          numOrNull(round_step_cbm),
          nz(comment) || null,
          id,
        ],
      )

    // если передан legs — полностью заменяем
      if (Array.isArray(legs)) {
        await conn.execute(
          'DELETE FROM logistics_route_legs WHERE route_id = ?',
          [id]
        )
        if (legsNorm.length) {
          const values = legsNorm.map((l) => [
            id,
            l.seq,
            l.name,
            l.type,
            l.from_country,
            l.to_country,
            l.incoterms,
            l.eta_days,
            l.cost,
            l.currency,
            l.surcharge_pct,
            l.surcharge_abs,
            l.comment,
          ])
          await conn.query(
            `
              INSERT INTO logistics_route_legs
                (route_id, seq, name, type, from_country, to_country, incoterms, eta_days, cost, currency, surcharge_pct, surcharge_abs, comment)
              VALUES ?
            `,
            [values]
          )
        }
      }

      await conn.commit()
      const [[updated]] = await conn.query(
        'SELECT * FROM logistics_routes WHERE id = ?',
        [id],
      )
      const withLegs = await attachLegs([updated])
      res.json(withLegs[0] || updated)
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('PUT /logistics-routes/:id error', e)
    res.status(500).json({ message: 'Ошибка обновления маршрута' })
  }
})

// DELETE /logistics-routes/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })
    await db.execute('DELETE FROM logistics_routes WHERE id = ?', [id])
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /logistics-routes/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления маршрута' })
  }
})

module.exports = router
