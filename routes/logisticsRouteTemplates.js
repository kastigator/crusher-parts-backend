const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const { createTrashEntry } = require('../utils/trashStore')

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
const boolToTiny = (v, fallback = 1) => {
  if (v === undefined || v === null || v === '') return fallback
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'да'].includes(s)) return 1
  if (['0', 'false', 'no', 'n', 'нет'].includes(s)) return 0
  return fallback
}

const PRICING_MODELS = new Set(['fixed', 'per_kg', 'per_cbm', 'per_kg_or_cbm_max', 'hybrid'])
const TRANSPORT_MODES = new Set(['SEA', 'RAIL', 'AIR', 'ROAD', 'MULTI'])
const normPricingModel = (v) => {
  const s = nz(v).toLowerCase()
  return PRICING_MODELS.has(s) ? s : 'fixed'
}
const normTransportMode = (v) => {
  const s = nz(v).toUpperCase()
  return TRANSPORT_MODES.has(s) ? s : 'MULTI'
}
const normCurrency = (v) => {
  const s = nz(v).toUpperCase()
  return s ? s.slice(0, 3) : 'USD'
}
const corridorNameFrom = (originCountry, destinationCountry, transportMode) =>
  [originCountry || '—', '→', destinationCountry || '—', transportMode || 'MULTI'].join(' ')

const resolveCorridorId = async (conn, source = {}, fallbackCorridorId = null) => {
  const explicitId = toId(source?.corridor_id) || toId(fallbackCorridorId)
  const originCountry = nz(source?.origin_country).toUpperCase() || null
  const destinationCountry = nz(source?.destination_country).toUpperCase() || null
  const transportMode = normTransportMode(source?.transport_mode)

  if (explicitId && !originCountry && !destinationCountry && !nz(source?.transport_mode)) {
    return explicitId
  }

  if (!originCountry || !destinationCountry) {
    return explicitId
  }

  const [existing] = await conn.execute(
    `SELECT id
       FROM logistics_corridors
      WHERE origin_country <=> ?
        AND destination_country <=> ?
        AND transport_mode = ?
      ORDER BY is_active DESC, id ASC
      LIMIT 1`,
    [originCountry, destinationCountry, transportMode]
  )

  if (existing?.[0]?.id) return Number(existing[0].id)

  const [inserted] = await conn.execute(
    `INSERT INTO logistics_corridors
      (name, origin_country, destination_country, transport_mode, risk_level, eta_min_days, eta_max_days, notes, is_active)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      corridorNameFrom(originCountry, destinationCountry, transportMode),
      originCountry,
      destinationCountry,
      transportMode,
      'medium',
      toId(source?.eta_min_days),
      toId(source?.eta_max_days),
      'Создано автоматически из шаблона доставки',
      1,
    ]
  )

  return Number(inserted.insertId)
}

router.get('/', async (req, res) => {
  try {
    const onlyActive = String(req.query.only_active || '').trim() === '1'
    const whereSql = onlyActive ? 'WHERE rt.is_active = 1' : ''
    const [rows] = await db.query(
      `SELECT rt.*,
              c.name AS corridor_name,
              c.origin_country,
              c.destination_country,
              c.transport_mode
         FROM logistics_route_templates rt
         LEFT JOIN logistics_corridors c ON c.id = rt.corridor_id
         ${whereSql}
        ORDER BY rt.is_active DESC, rt.name ASC, rt.id DESC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /logistics-route-templates error:', e)
    res.status(500).json({ message: 'Ошибка загрузки шаблонов доставки' })
  }
})

router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const name = nz(req.body?.name)
    if (!name) return res.status(400).json({ message: 'Название шаблона обязательно' })
    const corridorId = await resolveCorridorId(conn, req.body)
    if (!corridorId) {
      return res.status(400).json({ message: 'Нужно указать направление доставки и транспорт' })
    }

    const payload = [
      corridorId,
      name,
      nz(req.body?.code) || null,
      toId(req.body?.version_no) || 1,
      normPricingModel(req.body?.pricing_model),
      normCurrency(req.body?.currency),
      numOrNull(req.body?.fixed_cost),
      numOrNull(req.body?.rate_per_kg),
      numOrNull(req.body?.rate_per_cbm),
      numOrNull(req.body?.min_cost),
      numOrNull(req.body?.markup_pct) || 0,
      numOrNull(req.body?.markup_fixed) || 0,
      toId(req.body?.eta_min_days),
      toId(req.body?.eta_max_days),
      nz(req.body?.incoterms_baseline) || null,
      boolToTiny(req.body?.oversize_allowed, 1),
      boolToTiny(req.body?.overweight_allowed, 1),
      boolToTiny(req.body?.dangerous_goods_allowed, 0),
      boolToTiny(req.body?.is_active, 1),
      boolToTiny(req.body?.is_system, 0),
      nz(req.body?.note) || null,
      toId(req.user?.id),
      toId(req.user?.id),
    ]

    const [ins] = await conn.execute(
      `INSERT INTO logistics_route_templates
        (corridor_id, name, code, version_no, pricing_model, currency, fixed_cost, rate_per_kg, rate_per_cbm,
         min_cost, markup_pct, markup_fixed, eta_min_days, eta_max_days, incoterms_baseline,
         oversize_allowed, overweight_allowed, dangerous_goods_allowed, is_active, is_system, note,
         created_by_user_id, updated_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      payload
    )
    const [[created]] = await conn.execute(
      `SELECT rt.*, c.name AS corridor_name, c.origin_country, c.destination_country, c.transport_mode
         FROM logistics_route_templates rt
         LEFT JOIN logistics_corridors c ON c.id = rt.corridor_id
        WHERE rt.id = ?`,
      [ins.insertId]
    )
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /logistics-route-templates error:', e)
    res.status(500).json({ message: 'Ошибка создания шаблона доставки' })
  } finally {
    conn.release()
  }
})

router.put('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[existing]] = await conn.execute('SELECT * FROM logistics_route_templates WHERE id = ?', [id])
    if (!existing) return res.status(404).json({ message: 'Шаблон доставки не найден' })
    const corridorId = await resolveCorridorId(conn, req.body, existing.corridor_id)

    await conn.execute(
      `UPDATE logistics_route_templates
          SET corridor_id = ?,
              name = ?,
              code = ?,
              version_no = ?,
              pricing_model = ?,
              currency = ?,
              fixed_cost = ?,
              rate_per_kg = ?,
              rate_per_cbm = ?,
              min_cost = ?,
              markup_pct = ?,
              markup_fixed = ?,
              eta_min_days = ?,
              eta_max_days = ?,
              incoterms_baseline = ?,
              oversize_allowed = ?,
              overweight_allowed = ?,
              dangerous_goods_allowed = ?,
              is_active = ?,
              is_system = ?,
              note = ?,
              updated_by_user_id = ?
        WHERE id = ?`,
      [
        corridorId,
        nz(req.body?.name) || existing.name,
        nz(req.body?.code ?? existing.code) || null,
        toId(req.body?.version_no ?? existing.version_no) || existing.version_no || 1,
        normPricingModel(req.body?.pricing_model ?? existing.pricing_model),
        normCurrency(req.body?.currency ?? existing.currency),
        numOrNull(req.body?.fixed_cost ?? existing.fixed_cost),
        numOrNull(req.body?.rate_per_kg ?? existing.rate_per_kg),
        numOrNull(req.body?.rate_per_cbm ?? existing.rate_per_cbm),
        numOrNull(req.body?.min_cost ?? existing.min_cost),
        numOrNull(req.body?.markup_pct ?? existing.markup_pct) || 0,
        numOrNull(req.body?.markup_fixed ?? existing.markup_fixed) || 0,
        toId(req.body?.eta_min_days ?? existing.eta_min_days),
        toId(req.body?.eta_max_days ?? existing.eta_max_days),
        nz(req.body?.incoterms_baseline ?? existing.incoterms_baseline) || null,
        boolToTiny(req.body?.oversize_allowed ?? existing.oversize_allowed, Number(existing.oversize_allowed) ? 1 : 0),
        boolToTiny(req.body?.overweight_allowed ?? existing.overweight_allowed, Number(existing.overweight_allowed) ? 1 : 0),
        boolToTiny(req.body?.dangerous_goods_allowed ?? existing.dangerous_goods_allowed, Number(existing.dangerous_goods_allowed) ? 1 : 0),
        boolToTiny(req.body?.is_active ?? existing.is_active, Number(existing.is_active) ? 1 : 0),
        boolToTiny(req.body?.is_system ?? existing.is_system, Number(existing.is_system) ? 1 : 0),
        nz(req.body?.note ?? existing.note) || null,
        toId(req.user?.id),
        id,
      ]
    )

    const [[updated]] = await conn.execute(
      `SELECT rt.*, c.name AS corridor_name, c.origin_country, c.destination_country, c.transport_mode
         FROM logistics_route_templates rt
         LEFT JOIN logistics_corridors c ON c.id = rt.corridor_id
        WHERE rt.id = ?`,
      [id]
    )
    res.json(updated)
  } catch (e) {
    console.error('PUT /logistics-route-templates/:id error:', e)
    res.status(500).json({ message: 'Ошибка обновления шаблона доставки' })
  } finally {
    conn.release()
  }
})

router.delete('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    await conn.beginTransaction()
    const [[row]] = await conn.execute('SELECT * FROM logistics_route_templates WHERE id = ? FOR UPDATE', [id])
    if (!row) {
      await conn.rollback()
      return res.status(404).json({ message: 'Шаблон доставки не найден' })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'logistics_route_templates',
      entityId: id,
      rootEntityType: 'logistics_route_templates',
      rootEntityId: id,
      title: row.name || row.code || `Шаблон доставки #${id}`,
      subtitle: row.code || null,
      snapshot: row,
    })

    await conn.execute('DELETE FROM logistics_route_templates WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'logistics_route_templates',
      entity_id: id,
      old_value: String(trashEntryId),
      comment: `Шаблон доставки "${row.name || row.code || id}" перемещён в корзину`,
    })

    await conn.commit()
    res.json({ success: true, trash_entry_id: trashEntryId })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /logistics-route-templates/:id error:', e)
    res.status(500).json({ message: 'Ошибка удаления шаблона доставки' })
  } finally {
    conn.release()
  }
})

module.exports = router
