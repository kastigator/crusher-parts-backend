const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { getRate } = require('../utils/fxRatesService')

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
const normCurrency = (v) => {
  const s = String(v || '').trim().toUpperCase()
  return s ? s.slice(0, 3) : null
}
const safeIdentifier = (value) => {
  const s = String(value || '')
  return /^[a-zA-Z0-9_]+$/.test(s) ? s : null
}
const hasDbObjectError = (e) => {
  const code = String(e?.code || '')
  if (['ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR', 'ER_VIEW_INVALID'].includes(code)) return true
  return /doesn't exist|unknown table|view/i.test(String(e?.message || ''))
}
const viewExists = async (name) => {
  const [rows] = await db.execute(
    `SELECT 1
       FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
    [name]
  )
  return rows.length > 0
}
const tableExists = async (name) => {
  const [rows] = await db.execute(
    `SELECT 1
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
    [name]
  )
  return rows.length > 0
}
const getTableColumns = async (tableName) => {
  const safe = safeIdentifier(tableName)
  if (!safe) return []
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${safe}\``)
  return rows
}
const pickEconomicsViews = async () => {
  const hasNormLines = await viewExists('vw_rfq_economics_line_options_norm')
  const hasBaseLines = await viewExists('vw_rfq_economics_line_options')
  const hasNormSupplier = await viewExists('vw_rfq_economics_supplier_summary_norm')
  const hasBaseSupplier = await viewExists('vw_rfq_economics_supplier_summary')

  const lineView = hasNormLines
    ? 'vw_rfq_economics_line_options_norm'
    : hasBaseLines
      ? 'vw_rfq_economics_line_options'
      : null
  const supplierView = hasNormSupplier
    ? 'vw_rfq_economics_supplier_summary_norm'
    : hasBaseSupplier
      ? 'vw_rfq_economics_supplier_summary'
      : null

  return {
    lineView,
    supplierView,
    isNorm: lineView === 'vw_rfq_economics_line_options_norm',
  }
}
const sortByLandedAndEta = (a, b) => {
  const la = numOrNull(a.landed_total)
  const lb = numOrNull(b.landed_total)
  if (la !== null && lb !== null && la !== lb) return la - lb
  if (la !== null && lb === null) return -1
  if (la === null && lb !== null) return 1

  const ea = numOrNull(a.eta_days_worst)
  const eb = numOrNull(b.eta_days_worst)
  if (ea !== null && eb !== null && ea !== eb) return ea - eb
  if (ea !== null && eb === null) return -1
  if (ea === null && eb !== null) return 1

  return String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''))
}

const safeJsonStringify = (value) => {
  try {
    return JSON.stringify(value ?? null)
  } catch (_e) {
    return JSON.stringify({ error: 'serialize_failed' })
  }
}

const parseComboStatus = (status) => {
  const s = String(status || '').trim().toLowerCase()
  if (!s) return 'draft'
  if (s.includes('готов')) return 'selected_for_economics'
  if (s.includes('кандид')) return 'candidate'
  return 'candidate'
}

const parseConsolidationPotential = (value) => {
  const s = String(value || '').trim().toLowerCase()
  if (['high', 'medium', 'low', 'unknown'].includes(s)) return s
  if (s.includes('выс')) return 'high'
  if (s.includes('сред')) return 'medium'
  if (s.includes('низ')) return 'low'
  return 'unknown'
}

const parseSlotStatus = (value) => {
  const s = String(value || '').trim().toUpperCase()
  if (s === 'Q+P' || s === 'Q+OEM') return 'covered_priced'
  if (s === 'Q+' || s === 'Q?' || s === 'Q-' || s === 'Q!') return 'partial'
  if (s === 'NQ' || s === 'NS' || !s) return 'empty'
  return 'partial'
}

const safeJsonParse = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch (_e) {
    return fallback
  }
}

const roundMoney = (value, scale = 4) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const p = 10 ** scale
  return Math.round(n * p) / p
}

const clampEnum = (value, allowed, fallback) => {
  const s = String(value || '').trim()
  return allowed.includes(s) ? s : fallback
}

const pricingModelNeedsWeight = (model) => ['per_kg', 'per_kg_or_cbm_max', 'hybrid'].includes(model)
const pricingModelNeedsVolume = (model) => ['per_cbm', 'per_kg_or_cbm_max', 'hybrid'].includes(model)

const calcRouteAmount = ({
  pricingModel,
  fixedCost,
  ratePerKg,
  ratePerCbm,
  minCost,
  markupPct,
  markupFixed,
  weightKg,
  volumeCbm,
}) => {
  const model = clampEnum(pricingModel, ['fixed', 'per_kg', 'per_cbm', 'per_kg_or_cbm_max', 'hybrid'], 'fixed')
  const fixed = numOrNull(fixedCost) ?? 0
  const perKg = numOrNull(ratePerKg)
  const perCbm = numOrNull(ratePerCbm)
  const min = numOrNull(minCost) ?? 0
  const markupP = numOrNull(markupPct) ?? 0
  const markupF = numOrNull(markupFixed) ?? 0
  const w = numOrNull(weightKg)
  const v = numOrNull(volumeCbm)

  let base = null
  let warning = null
  let error = null

  if (model === 'fixed') {
    base = fixed
  } else if (model === 'per_kg') {
    if (w === null || perKg === null) error = 'Нужны weight_kg и rate_per_kg'
    else base = Math.max(w * perKg, min)
  } else if (model === 'per_cbm') {
    if (v === null || perCbm === null) error = 'Нужны volume_cbm и rate_per_cbm'
    else base = Math.max(v * perCbm, min)
  } else if (model === 'per_kg_or_cbm_max') {
    if (w === null && v === null) error = 'Нужны weight_kg или volume_cbm'
    else {
      const costKg = w !== null && perKg !== null ? w * perKg : null
      const costCbm = v !== null && perCbm !== null ? v * perCbm : null
      if (costKg === null && costCbm === null) error = 'Нужен rate_per_kg или rate_per_cbm'
      else base = Math.max(costKg ?? 0, costCbm ?? 0, min)
      if ((costKg === null && w !== null) || (costCbm === null && v !== null)) {
        warning = 'Часть параметров тарифа отсутствует, расчет по доступным данным'
      }
    }
  } else if (model === 'hybrid') {
    if (w === null && v === null && fixed === 0) error = 'Недостаточно данных для hybrid'
    else {
      const costKg = w !== null && perKg !== null ? w * perKg : null
      const costCbm = v !== null && perCbm !== null ? v * perCbm : null
      const variable = Math.max(costKg ?? 0, costCbm ?? 0, min)
      base = fixed + variable
      if ((w !== null && perKg === null) || (v !== null && perCbm === null)) {
        warning = 'Hybrid рассчитан по частично доступным параметрам'
      }
    }
  }

  if (error) return { ok: false, status: 'error', message: error, amount: null }

  const withMarkup = (base ?? 0) * (1 + markupP / 100) + markupF
  return {
    ok: true,
    status: warning ? 'warning' : 'ok',
    message: warning,
    amount: roundMoney(withMarkup),
  }
}

const convertCurrencyAmount = async (amount, fromCurrency, toCurrency) => {
  const amt = numOrNull(amount)
  const from = normCurrency(fromCurrency)
  const to = normCurrency(toCurrency)
  if (amt === null) return { value: null, converted: false, warning: 'amount_missing' }
  if (!from || !to) return { value: null, converted: false, warning: 'currency_missing' }
  if (from === to) return { value: amt, converted: true, rate: 1, source: 'same' }
  try {
    const rateObj = await getRate(from, to)
    return {
      value: roundMoney(amt * Number(rateObj.rate)),
      converted: true,
      rate: Number(rateObj.rate),
      source: rateObj.source,
    }
  } catch (e) {
    return {
      value: null,
      converted: false,
      warning: `fx_failed:${from}->${to}`,
      message: String(e?.message || e),
    }
  }
}

const getScenarioGroupBaseData = async (scenarioId, shipmentGroupId) => {
  const [[row]] = await db.execute(
    `SELECT
        sgr.id AS scenario_group_route_id,
        sgr.scenario_id,
        sgr.shipment_group_id,
        g.rfq_id,
        g.candidate_set_id,
        g.name AS group_name,
        g.from_country,
        g.to_country,
        g.weight_kg,
        g.volume_cbm,
        g.status AS group_status,
        s.calc_currency,
        s.rfq_id AS scenario_rfq_id
      FROM rfq_econ2_scenario_group_routes sgr
      JOIN rfq_econ2_scenarios s
        ON s.id = sgr.scenario_id
      JOIN rfq_econ2_shipment_groups g
        ON g.id = sgr.shipment_group_id
     WHERE sgr.scenario_id = ?
       AND sgr.shipment_group_id = ?
     LIMIT 1`,
    [scenarioId, shipmentGroupId]
  )
  return row || null
}

const logRouteUsageEvent = async ({
  routeTemplateId = null,
  corridorId = null,
  rfqId = null,
  sourceId = null,
  scenarioId = null,
  shipmentGroupId = null,
  routeNameSnapshot = null,
  routePayload = null,
  note = null,
}) => {
  await db.execute(
    `INSERT INTO logistics_route_usage_events
      (route_template_id, corridor_id, rfq_id, event_type, source_type, source_id, scenario_id, shipment_group_id,
       route_name_snapshot, route_payload_json, note)
     VALUES (?, ?, ?, 'used_in_scenario', 'RFQ_ECONOMICS', ?, ?, ?, ?, ?, ?)`,
    [
      toId(routeTemplateId),
      toId(corridorId),
      toId(rfqId),
      sourceId ? Number(sourceId) : null,
      scenarioId ? Number(scenarioId) : null,
      shipmentGroupId ? Number(shipmentGroupId) : null,
      nz(routeNameSnapshot),
      safeJsonStringify(routePayload),
      nz(note),
    ]
  )
}

const mapLineOption = (row, idx = 0) => {
  const lineNumber = numOrNull(row.rfq_line_number ?? row.line_number)
  const partNumber = nz(row.original_cat_number || row.component_cat_number) || ''
  const partDescription =
    nz(row.original_description_ru || row.component_description_ru || row.item_description || row.description) ||
    ''
  const selectionKeyRaw =
    nz(row.selection_key_norm) || nz(row.selection_key) || `ITEM:${row.rfq_item_id || idx + 1}`
  const selectionKeyNorm = lineNumber ? nz(row.selection_key_norm) || nz(row.selection_key) || `Строка ${lineNumber}` : selectionKeyRaw

  const goodsAmount = numOrNull(row.goods_amount_norm ?? row.goods_amount)
  const logisticsAmount = numOrNull(row.logistics_amount_norm ?? row.logistics_amount)
  const dutyAmount = numOrNull(row.duty_amount_norm ?? row.duty_amount)
  const landedAmount = numOrNull(row.landed_amount_norm ?? row.landed_amount)

  let landedCurrency =
    normCurrency(row.landed_currency_norm) ||
    normCurrency(row.landed_currency) ||
    normCurrency(row.target_currency)
  let fxMissing = Number(row.fx_missing ?? row.lines_with_currency_mismatch ?? 0) > 0
  if (!fxMissing && String(row.landed_currency || '').includes('/')) fxMissing = true
  if (!landedCurrency && !fxMissing && landedAmount !== null) {
    landedCurrency = normCurrency(row.goods_currency || row.logistics_currency) || null
  }

  return {
    row_key:
      nz(row.selection_key_norm) ||
      nz(row.selection_key) ||
      `${row.rfq_item_id || 'item'}:${row.response_line_id || 'resp'}:${idx}`,
    rfq_item_id: toId(row.rfq_item_id) || null,
    response_line_id: toId(row.response_line_id) || null,
    rfq_supplier_id: toId(row.rfq_supplier_id) || null,
    supplier_id: toId(row.supplier_id) || null,
    route_id: toId(row.route_id) || null,
    line_number: lineNumber,
    selection_key_norm: selectionKeyNorm,
    selection_key_raw: selectionKeyRaw,
    supplier_name: nz(row.supplier_name) || 'Поставщик не указан',
    route_name: nz(row.route_name) || 'Маршрут не указан',
    part_number: partNumber || '—',
    part_description: partDescription || '—',
    goods_amount: goodsAmount,
    goods_currency: normCurrency(row.goods_currency),
    logistics_amount: logisticsAmount,
    logistics_currency: normCurrency(row.logistics_currency),
    duty_amount: dutyAmount,
    landed_amount: landedAmount,
    landed_currency: landedCurrency,
    eta_total_days: numOrNull(row.eta_total_days),
    supplier_score: numOrNull(row.supplier_score),
    fx_missing: fxMissing ? 1 : 0,
  }
}

router.get('/v2/logistics/corridors', async (req, res) => {
  try {
    const onlyActive = String(req.query.active || '1') !== '0'
    const hasView = await viewExists('vw_logistics_corridor_usage_stats')
    const hasIsActive = hasView ? false : (await getTableColumns('logistics_corridors')).some((c) => c.Field === 'is_active')

    const where = []
    const params = []
    if (onlyActive && hasIsActive) where.push('is_active = 1')
    if (nz(req.query.transport_mode)) {
      where.push('transport_mode = ?')
      params.push(String(req.query.transport_mode).toUpperCase())
    }
    const sql = hasView
      ? `SELECT * FROM vw_logistics_corridor_usage_stats${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY corridor_name ASC, corridor_id ASC`
      : `SELECT * FROM logistics_corridors${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name ASC, id ASC`

    const [rows] = await db.query(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('GET /economics/v2/logistics/corridors error:', e)
    res.status(500).json({ message: 'Ошибка сервера при загрузке коридоров' })
  }
})

router.get('/v2/logistics/route-templates', async (req, res) => {
  try {
    const corridorId = toId(req.query.corridor_id)
    const onlyActive = String(req.query.active || '1') !== '0'
    const hasView = await viewExists('vw_logistics_route_template_stats')
    const source = hasView ? 'vw_logistics_route_template_stats' : 'logistics_route_templates'

    const where = []
    const params = []
    if (corridorId) {
      where.push('corridor_id = ?')
      params.push(corridorId)
    }
    if (onlyActive) {
      where.push('is_active = 1')
    }
    const orderExpr = hasView ? 'route_template_name ASC, route_template_id ASC' : 'name ASC, id ASC'
    const [rows] = await db.query(
      `SELECT * FROM ${source}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderExpr}`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /economics/v2/logistics/route-templates error:', e)
    res.status(500).json({ message: 'Ошибка сервера при загрузке шаблонов маршрутов' })
  }
})
const loadLineOptions = async (rfqId, lineView) => {
  if (!lineView) return []
  const safe = safeIdentifier(lineView)
  if (!safe) return []
  try {
    const [rows] = await db.query(`SELECT * FROM \`${safe}\` WHERE rfq_id = ?`, [rfqId])
    const mapped = rows.map((r, idx) => mapLineOption(r, idx))
    mapped.sort((a, b) => {
      const la = numOrNull(a.line_number)
      const lb = numOrNull(b.line_number)
      if (la !== null && lb !== null && la !== lb) return la - lb
      if (la !== null && lb === null) return -1
      if (la === null && lb !== null) return 1
      const sa = numOrNull(a.landed_amount)
      const sb = numOrNull(b.landed_amount)
      if (sa !== null && sb !== null && sa !== sb) return sa - sb
      if (sa !== null && sb === null) return -1
      if (sa === null && sb !== null) return 1
      return String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''))
    })
    return mapped
  } catch (e) {
    if (hasDbObjectError(e)) return []
    throw e
  }
}
const loadSupplierSummary = async (rfqId, supplierView, lineOptions = []) => {
  if (!supplierView) {
    const grouped = new Map()
    lineOptions.forEach((row) => {
      const key = `${row.supplier_name}::${row.route_name}`
      if (!grouped.has(key)) {
        grouped.set(key, {
          supplier_name: row.supplier_name,
          route_name: row.route_name,
          lines_count: 0,
          goods_total: 0,
          logistics_total: 0,
          duty_total: 0,
          landed_total: 0,
          lines_with_currency_gap: 0,
          calc_currency: row.landed_currency || null,
          eta_days_worst: null,
          eta_days_avg: null,
          avg_supplier_score: null,
        })
      }
      const item = grouped.get(key)
      item.lines_count += 1
      item.goods_total += numOrNull(row.goods_amount) || 0
      item.logistics_total += numOrNull(row.logistics_amount) || 0
      item.duty_total += numOrNull(row.duty_amount) || 0
      item.landed_total += numOrNull(row.landed_amount) || 0
      item.lines_with_currency_gap += Number(row.fx_missing) ? 1 : 0
      if (row.eta_total_days !== null) {
        item.eta_days_worst = Math.max(item.eta_days_worst ?? 0, row.eta_total_days)
      }
    })
    return Array.from(grouped.values()).sort(sortByLandedAndEta)
  }

  const safe = safeIdentifier(supplierView)
  if (!safe) return []
  try {
    const [rows] = await db.query(`SELECT * FROM \`${safe}\` WHERE rfq_id = ?`, [rfqId])
    const mapped = rows.map((row) => ({
      supplier_name: nz(row.supplier_name) || 'Поставщик не указан',
      route_name: nz(row.route_name) || 'Маршрут не указан',
      lines_count: Number(row.lines_count || 0),
      goods_total: numOrNull(row.goods_total_norm ?? row.goods_total),
      logistics_total: numOrNull(row.logistics_total_norm ?? row.logistics_total),
      duty_total: numOrNull(row.duty_total_norm ?? row.duty_total),
      landed_total: numOrNull(
        row.landed_total_norm ?? row.landed_total_known_currency ?? row.landed_total
      ),
      lines_with_currency_gap: Number(
        row.lines_with_fx_missing ?? row.lines_with_currency_mismatch ?? 0
      ),
      calc_currency:
        normCurrency(row.calc_currency ?? row.landed_currency_norm ?? row.currency_hint) || null,
      eta_days_worst: numOrNull(row.eta_days_worst),
      eta_days_avg: numOrNull(row.eta_days_avg),
      avg_supplier_score: numOrNull(row.avg_supplier_score),
    }))
    mapped.sort(sortByLandedAndEta)
    return mapped
  } catch (e) {
    if (hasDbObjectError(e)) return []
    throw e
  }
}
const loadScenarioSummary = async (rfqId) => {
  if (!(await viewExists('vw_rfq_econ_scenario_summary'))) return []
  const [rows] = await db.execute(
    `SELECT *
       FROM vw_rfq_econ_scenario_summary
      WHERE rfq_id = ?
      ORDER BY scenario_id DESC`,
    [rfqId]
  )
  return rows.map((row) => ({
    scenario_id: toId(row.scenario_id) || null,
    name: nz(row.name) || 'Сценарий',
    strategy: nz(row.strategy) || '—',
    picked_lines: Number(row.picked_lines || 0),
    goods_total: numOrNull(row.goods_total),
    logistics_total: numOrNull(row.logistics_total),
    duty_total: numOrNull(row.duty_total),
    landed_total: numOrNull(row.landed_total_known_currency ?? row.landed_total),
    currency_hint: nz(row.currency_hint),
    avg_supplier_score: numOrNull(row.avg_supplier_score),
    eta_days_worst: numOrNull(row.eta_days_worst),
    eta_days_avg: numOrNull(row.eta_days_avg),
  }))
}
const loadLatestScenarioLines = async (rfqId) => {
  if (!(await tableExists('rfq_econ_scenarios')) || !(await tableExists('rfq_econ_scenario_lines'))) {
    return { latest_scenario_id: null, latest_scenario_name: null, lines: [] }
  }
  const [[latest]] = await db.execute(
    `SELECT id, name
       FROM rfq_econ_scenarios
      WHERE rfq_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    [rfqId]
  )
  if (!latest?.id) {
    return { latest_scenario_id: null, latest_scenario_name: null, lines: [] }
  }
  const [rows] = await db.execute(
    `SELECT
        l.scenario_id,
        ri.line_number AS line_number,
        l.selection_key_norm,
        COALESCE(op.cat_number, '') AS part_number,
        COALESCE(op.description_ru, op.description_en, '') AS part_description,
        COALESCE(ps.name, '') AS supplier_name,
        l.goods_amount,
        l.logistics_amount,
        l.duty_amount,
        l.landed_amount,
        l.landed_currency,
        l.eta_total_days
      FROM rfq_econ_scenario_lines l
      LEFT JOIN rfq_items ri ON ri.id = l.rfq_item_id
      LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
      LEFT JOIN original_parts op ON op.id = cri.original_part_id
      LEFT JOIN rfq_response_lines rl ON rl.id = l.response_line_id
      LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
      LEFT JOIN part_suppliers ps ON ps.id = COALESCE(sp.supplier_id, l.supplier_id)
      WHERE l.scenario_id = ?
      ORDER BY ri.line_number ASC, l.selection_key_norm ASC`,
    [latest.id]
  )

  return {
    latest_scenario_id: toId(latest.id) || null,
    latest_scenario_name: nz(latest.name) || null,
    lines: rows.map((row, idx) => ({
      row_key: `${latest.id}:${row.line_number || 'line'}:${idx}`,
      line_number: numOrNull(row.line_number),
      selection_key_norm: nz(row.selection_key_norm) || '—',
      part_number: nz(row.part_number) || '—',
      part_description: nz(row.part_description) || '—',
      supplier_name: nz(row.supplier_name) || 'Поставщик не указан',
      goods_amount: numOrNull(row.goods_amount),
      logistics_amount: numOrNull(row.logistics_amount),
      duty_amount: numOrNull(row.duty_amount),
      landed_amount: numOrNull(row.landed_amount),
      landed_currency: normCurrency(row.landed_currency),
      eta_total_days: numOrNull(row.eta_total_days),
    })),
  }
}
const getTargetCurrency = async (rfqId) => {
  if (!(await tableExists('rfq_econ_settings'))) return null
  const [[row]] = await db.execute(
    `SELECT target_currency
       FROM rfq_econ_settings
      WHERE rfq_id = ?
      LIMIT 1`,
    [rfqId]
  )
  return normCurrency(row?.target_currency)
}
const ensureFxRatesForRfq = async (rfqId, lineView, targetCurrencyHint = null) => {
  const safe = safeIdentifier(lineView)
  if (!safe) return

  let targetCurrency = normCurrency(targetCurrencyHint)
  if (!targetCurrency) {
    targetCurrency = (await getTargetCurrency(rfqId)) || null
  }
  if (!targetCurrency) {
    const [rows] = await db.query(
      `SELECT target_currency
         FROM \`${safe}\`
        WHERE rfq_id = ?
          AND target_currency IS NOT NULL
          AND TRIM(target_currency) <> ''
        LIMIT 1`,
      [rfqId]
    )
    targetCurrency = normCurrency(rows?.[0]?.target_currency)
  }
  if (!targetCurrency) return

  const [rows] = await db.query(
    `SELECT DISTINCT
        UPPER(TRIM(goods_currency)) AS goods_currency,
        UPPER(TRIM(logistics_currency)) AS logistics_currency
      FROM \`${safe}\`
      WHERE rfq_id = ?`,
    [rfqId]
  )

  const needed = new Set()
  rows.forEach((row) => {
    const goods = normCurrency(row?.goods_currency)
    const logistics = normCurrency(row?.logistics_currency)
    if (goods && goods !== targetCurrency) needed.add(goods)
    if (logistics && logistics !== targetCurrency) needed.add(logistics)
  })

  for (const baseCurrency of needed) {
    try {
      await getRate(baseCurrency, targetCurrency, { forceRefresh: false })
    } catch (e) {
      console.warn(
        `economics: fx preload failed ${baseCurrency}->${targetCurrency}:`,
        e?.message || e
      )
    }
  }
}

router.get('/rfq/:rfqId/dashboard', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })

    const views = await pickEconomicsViews()
    if (views.lineView === 'vw_rfq_economics_line_options_norm') {
      await ensureFxRatesForRfq(rfqId, views.lineView)
    }
    const lineOptions = await loadLineOptions(rfqId, views.lineView)
    const supplierSummary = await loadSupplierSummary(rfqId, views.supplierView, lineOptions)
    const scenarios = await loadScenarioSummary(rfqId)
    const latestScenario = await loadLatestScenarioLines(rfqId)
    const targetCurrency = (await getTargetCurrency(rfqId)) || null

    res.json({
      rfq_id: rfqId,
      target_currency: targetCurrency,
      source: {
        line_view: views.lineView,
        supplier_view: views.supplierView,
      },
      suppliers: supplierSummary,
      lines: lineOptions,
      scenarios,
      latest_scenario_id: latestScenario.latest_scenario_id,
      latest_scenario_name: latestScenario.latest_scenario_name,
      latest_scenario_lines: latestScenario.lines,
    })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/dashboard error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ---------------------------------------------------------------------------
// Economics v2: read imported candidates / groups / scenarios (new workflow)
// ---------------------------------------------------------------------------
router.get('/v2/rfq/:rfqId/candidates', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    const rfqItemId = toId(req.query?.rfq_item_id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })

    const hasView = await viewExists('vw_rfq_econ2_candidate_sets_summary')
    if (!hasView) {
      return res.status(400).json({ message: 'Представление кандидатов Экономики v2 не найдено' })
    }

    const params = [rfqId]
    const where = ['rfq_id = ?']
    if (rfqItemId) {
      where.push('rfq_item_id = ?')
      params.push(rfqItemId)
    }

    const [rows] = await db.execute(
      `SELECT *
         FROM vw_rfq_econ2_candidate_sets_summary
        WHERE ${where.join(' AND ')}
        ORDER BY
          is_active DESC,
          FIELD(status, 'selected_for_economics', 'candidate', 'draft', 'archived'),
          COALESCE(score_total, -999999) DESC,
          candidate_set_id DESC`,
      params
    )

    res.json({
      rfq_id: rfqId,
      rfq_item_id: rfqItemId || null,
      count: rows.length,
      rows,
    })
  } catch (e) {
    console.error('GET /economics/v2/rfq/:rfqId/candidates error:', e)
    res.status(500).json({ message: 'Ошибка сервера при загрузке кандидатов Экономики v2' })
  }
})

router.get('/v2/rfq/:rfqId/shipment-groups', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    const candidateSetId = toId(req.query?.candidate_set_id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })

    const hasView = await viewExists('vw_rfq_econ2_shipment_groups_summary')
    if (!hasView) {
      return res.status(400).json({ message: 'Представление групп консолидации Экономики v2 не найдено' })
    }

    const params = [rfqId]
    const where = ['rfq_id = ?']
    if (candidateSetId) {
      where.push('candidate_set_id = ?')
      params.push(candidateSetId)
    }

    const [rows] = await db.execute(
      `SELECT *
         FROM vw_rfq_econ2_shipment_groups_summary
        WHERE ${where.join(' AND ')}
        ORDER BY candidate_set_id ASC, sort_order ASC, shipment_group_id ASC`,
      params
    )

    res.json({
      rfq_id: rfqId,
      candidate_set_id: candidateSetId || null,
      count: rows.length,
      rows,
    })
  } catch (e) {
    console.error('GET /economics/v2/rfq/:rfqId/shipment-groups error:', e)
    res.status(500).json({ message: 'Ошибка сервера при загрузке групп консолидации Экономики v2' })
  }
})

router.get('/v2/rfq/:rfqId/scenarios', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    const candidateSetId = toId(req.query?.candidate_set_id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })

    const hasView = await viewExists('vw_rfq_econ2_scenarios_summary')
    if (!hasView) {
      return res.status(400).json({ message: 'Представление сценариев Экономики v2 не найдено' })
    }

    const params = [rfqId]
    const where = ['rfq_id = ?']
    if (candidateSetId) {
      where.push('candidate_set_id = ?')
      params.push(candidateSetId)
    }

    const [rows] = await db.execute(
      `SELECT *
         FROM vw_rfq_econ2_scenarios_summary
        WHERE ${where.join(' AND ')}
        ORDER BY
          FIELD(status, 'selected', 'calculated', 'draft', 'archived'),
          COALESCE(landed_total, 999999999) ASC,
          scenario_id DESC`,
      params
    )

    res.json({
      rfq_id: rfqId,
      candidate_set_id: candidateSetId || null,
      count: rows.length,
      rows,
    })
  } catch (e) {
    console.error('GET /economics/v2/rfq/:rfqId/scenarios error:', e)
    res.status(500).json({ message: 'Ошибка сервера при загрузке сценариев Экономики v2' })
  }
})

// ---------------------------------------------------------------------------
// Economics v2: import candidate combinations from Coverage tab
// ---------------------------------------------------------------------------
router.post('/v2/rfq/:rfqId/candidates/import-from-coverage', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const rfqItemId = toId(req.body?.rfq_item_id)
  const combos = Array.isArray(req.body?.combos) ? req.body.combos : []

  if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })
  if (!rfqItemId) return res.status(400).json({ message: 'Нужно указать позицию RFQ (rfq_item_id)' })
  if (!combos.length) return res.status(400).json({ message: 'Нет комбинаций для импорта' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    // Validate RFQ item belongs to RFQ
    const [[rfqItemRow]] = await conn.execute(
      'SELECT id FROM rfq_items WHERE id = ? AND rfq_id = ? LIMIT 1',
      [rfqItemId, rfqId]
    )
    if (!rfqItemRow) {
      await conn.rollback()
      return res.status(404).json({ message: 'Позиция RFQ не найдена в указанном RFQ' })
    }

    const imported = []
    let updatedCount = 0
    let insertedCount = 0

    for (const combo of combos) {
      const supplierIds = Array.isArray(combo?.supplier_ids)
        ? combo.supplier_ids.map(toId).filter(Boolean)
        : []
      const comboHash = nz(combo?.key) || comboKeyFallback(supplierIds)
      const comboName = nz(combo?.supplier_names) || `Комбинация (${supplierIds.join('+') || 'manual'})`
      const status = parseComboStatus(combo?.status)
      const consolidationPotential = parseConsolidationPotential(combo?.consolidation_hint)
      const payloadJson = safeJsonStringify(combo)

      let candidateSetId = null

      if (comboHash) {
        const [[existing]] = await conn.execute(
          `SELECT id
             FROM rfq_econ2_candidate_sets
            WHERE rfq_id = ?
              AND rfq_item_id = ?
              AND combo_hash = ?
              AND is_active = 1
            ORDER BY id DESC
            LIMIT 1`,
          [rfqId, rfqItemId, comboHash]
        )
        if (existing?.id) candidateSetId = Number(existing.id)
      }

      if (candidateSetId) {
        await conn.execute(
          `UPDATE rfq_econ2_candidate_sets
              SET source_type = 'COVERAGE',
                  source_ref = ?,
                  name = ?,
                  progress_structure_pct = ?,
                  progress_priced_pct = ?,
                  oem_ok = ?,
                  supplier_count = ?,
                  country_count = ?,
                  consolidation_potential = ?,
                  score_total = ?,
                  status = ?,
                  payload_json = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          [
            nz(combo?.key),
            comboName,
            numOrNull(combo?.structure_coverage_pct) ?? 0,
            numOrNull(combo?.priced_coverage_pct) ?? 0,
            combo?.oem_ok ? 1 : 0,
            supplierIds.length,
            toId(combo?.countries_count) || (Array.isArray(combo?.countries) ? new Set(combo.countries.filter(Boolean)).size : 0),
            consolidationPotential,
            numOrNull(combo?.score),
            status,
            payloadJson,
            candidateSetId,
          ]
        )
        updatedCount += 1

        await conn.execute('DELETE FROM rfq_econ2_candidate_suppliers WHERE candidate_set_id = ?', [candidateSetId])
        await conn.execute('DELETE FROM rfq_econ2_candidate_slots WHERE candidate_set_id = ?', [candidateSetId])
        await conn.execute('DELETE FROM rfq_econ2_candidate_items WHERE candidate_set_id = ?', [candidateSetId])
      } else {
        const [insertRes] = await conn.execute(
          `INSERT INTO rfq_econ2_candidate_sets
            (rfq_id, rfq_item_id, source_type, source_ref, name, combo_hash,
             progress_structure_pct, progress_priced_pct, oem_ok,
             supplier_count, country_count, consolidation_potential, score_total,
             status, is_active, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
          [
            rfqId,
            rfqItemId,
            'COVERAGE',
            nz(combo?.key),
            comboName,
            comboHash,
            numOrNull(combo?.structure_coverage_pct) ?? 0,
            numOrNull(combo?.priced_coverage_pct) ?? 0,
            combo?.oem_ok ? 1 : 0,
            supplierIds.length,
            toId(combo?.countries_count) || (Array.isArray(combo?.countries) ? new Set(combo.countries.filter(Boolean)).size : 0),
            consolidationPotential,
            numOrNull(combo?.score),
            status,
            payloadJson,
          ]
        )
        candidateSetId = Number(insertRes.insertId)
        insertedCount += 1
      }

      // Candidate suppliers
      const supplierNamesById = new Map()
      const fullName = String(combo?.supplier_names || '')
      if (fullName && supplierIds.length === 1) supplierNamesById.set(supplierIds[0], fullName)

      const countries = Array.isArray(combo?.countries) ? combo.countries : []
      for (let i = 0; i < supplierIds.length; i += 1) {
        const supplierId = supplierIds[i]
        await conn.execute(
          `INSERT INTO rfq_econ2_candidate_suppliers
            (candidate_set_id, supplier_id, supplier_name_snapshot, supplier_country_snapshot, sort_order)
           VALUES (?,?,?,?,?)`,
          [
            candidateSetId,
            supplierId,
            supplierNamesById.get(supplierId) || null,
            nz(countries[i]) ? String(countries[i]).toUpperCase().slice(0, 2) : null,
            i,
          ]
        )
      }

      // Candidate slots + minimal candidate items from assignment preview (only where supplier selected)
      const assignmentPreview = Array.isArray(combo?.assignment_preview) ? combo.assignment_preview : []
      for (let idx = 0; idx < assignmentPreview.length; idx += 1) {
        const slot = assignmentPreview[idx] || {}
        const slotKey = nz(slot?.element_key) || `slot_${idx + 1}`
        const slotName = nz(slot?.element_label) || `Слот ${idx + 1}`
        const variantKey = nz(slot?.variant_key) || nz(slot?.variant_label) || null
        const variantName = nz(slot?.variant_label) || null
        const slotStatus = parseSlotStatus(slot?.status)

        await conn.execute(
          `INSERT INTO rfq_econ2_candidate_slots
            (candidate_set_id, slot_key, slot_name, chosen_variant_key, chosen_variant_name,
             variant_progress_pct, variant_priced_progress_pct, is_oem_critical, oem_ok, status, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            candidateSetId,
            slotKey,
            slotName,
            variantKey,
            variantName,
            numOrNull(slot?.progress_pct) ?? 0,
            numOrNull(slot?.priced_progress_pct) ?? 0,
            slot?.is_oem_required ? 1 : 0,
            slot?.oem_ok ? 1 : 0,
            slotStatus,
            safeJsonStringify(slot),
          ]
        )

        const chosenSupplierId = toId(slot?.chosen_supplier_id)
        if (!chosenSupplierId) continue

        await conn.execute(
          `INSERT INTO rfq_econ2_candidate_items
            (candidate_set_id, rfq_item_id, slot_key, slot_name, variant_key, variant_name,
             atom_key, atom_kind, atom_name, supplier_id, supplier_name_snapshot,
             qty, goods_amount, goods_currency, lead_time_days, moq, lot_size, packaging,
             has_price, is_oem_offer, status, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            candidateSetId,
            rfqItemId,
            slotKey,
            slotName,
            variantKey || slotKey,
            variantName,
            `${slotKey}:${chosenSupplierId}`,
            'manual',
            slotName,
            chosenSupplierId,
            nz(slot?.chosen_supplier_name),
            numOrNull(slot?.qty),
            numOrNull(slot?.price),
            normCurrency(slot?.currency),
            toId(slot?.lead_time_days),
            numOrNull(slot?.moq),
            numOrNull(slot?.lot_size),
            nz(slot?.packaging),
            (numOrNull(slot?.price) != null && normCurrency(slot?.currency)) ? 1 : 0,
            slot?.is_oem_offer ? 1 : 0,
            (numOrNull(slot?.price) != null && normCurrency(slot?.currency)) ? 'candidate' : 'no_price',
            safeJsonStringify(slot),
          ]
        )
      }

      imported.push({
        candidate_set_id: candidateSetId,
        combo_key: combo?.key || null,
        name: comboName,
      })
    }

    await conn.commit()
    res.json({
      message: 'Кандидаты покрытия импортированы в Экономику v2',
      imported_count: imported.length,
      inserted_count: insertedCount,
      updated_count: updatedCount,
      rows: imported,
    })
  } catch (e) {
    if (conn) {
      try { await conn.rollback() } catch (_e) {}
    }
    console.error('POST /economics/v2/rfq/:rfqId/candidates/import-from-coverage error:', e)
    res.status(500).json({ message: 'Ошибка сервера при импорте кандидатов покрытия' })
  } finally {
    if (conn) conn.release()
  }
})

function comboKeyFallback(ids) {
  return Array.isArray(ids) && ids.length ? ids.slice().sort((a, b) => a - b).join('+') : null
}

// ---------------------------------------------------------------------------
// Economics v2: create shipment groups and draft scenarios (new workflow)
// ---------------------------------------------------------------------------
router.post('/v2/rfq/:rfqId/shipment-groups/auto-from-candidate', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const candidateSetId = toId(req.body?.candidate_set_id)
  const toCountry = nz(req.body?.to_country) ? String(req.body.to_country).toUpperCase().slice(0, 2) : null
  const replaceExisting = req.body?.replace_existing !== false

  if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })
  if (!candidateSetId) return res.status(400).json({ message: 'Нужно указать candidate_set_id' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[candidate]] = await conn.execute(
      `SELECT id, rfq_id, name
         FROM rfq_econ2_candidate_sets
        WHERE id = ? AND rfq_id = ? AND is_active = 1
        LIMIT 1`,
      [candidateSetId, rfqId]
    )
    if (!candidate) {
      await conn.rollback()
      return res.status(404).json({ message: 'Кандидат Экономики v2 не найден' })
    }

    const [candidateItems] = await conn.execute(
      `SELECT
          ci.id AS candidate_item_id,
          ci.supplier_id,
          COALESCE(NULLIF(TRIM(ci.supplier_country_snapshot), ''), NULLIF(TRIM(ps.country), ''), 'UN') AS from_country,
          ci.has_price,
          ci.goods_amount,
          ci.goods_currency
        FROM rfq_econ2_candidate_items ci
        LEFT JOIN part_suppliers ps ON ps.id = ci.supplier_id
       WHERE ci.candidate_set_id = ?
         AND ci.status <> 'blocked'`,
      [candidateSetId]
    )

    if (!candidateItems.length) {
      await conn.rollback()
      return res.status(400).json({ message: 'У кандидата нет элементов для группировки' })
    }

    if (replaceExisting) {
      await conn.execute(
        'DELETE FROM rfq_econ2_shipment_groups WHERE rfq_id = ? AND candidate_set_id = ?',
        [rfqId, candidateSetId]
      )
    }

    const groupsMap = new Map()
    candidateItems.forEach((row) => {
      const key = `${String(row.from_country || 'UN').toUpperCase()}|standard`
      if (!groupsMap.has(key)) groupsMap.set(key, [])
      groupsMap.get(key).push(row)
    })

    const created = []
    let sortOrder = 0
    for (const [groupKey, items] of groupsMap.entries()) {
      sortOrder += 1
      const [fromCountryRaw] = groupKey.split('|')
      const fromCountry = String(fromCountryRaw || 'UN').toUpperCase().slice(0, 2)
      const uniqueSuppliers = new Set(items.map((i) => toId(i.supplier_id)).filter(Boolean))
      const allHavePrice = items.every((i) => Number(i.has_price || 0) > 0)
      const anyHavePrice = items.some((i) => Number(i.has_price || 0) > 0)
      const dataReadiness = allHavePrice ? 'ready' : anyHavePrice ? 'partial' : 'unknown'
      const countryLabel = fromCountry === 'UN' ? 'UNKNOWN' : fromCountry
      const groupName = `${countryLabel} / ${candidate.name}`
      const groupCode = `G${sortOrder}`

      const [insGroup] = await conn.execute(
        `INSERT INTO rfq_econ2_shipment_groups
          (rfq_id, candidate_set_id, name, code, sort_order, from_country, to_country,
           consolidation_key, urgency_bucket, status, data_readiness,
           total_items_count, total_suppliers_count)
         VALUES (?,?,?,?,?,?,?,?, 'standard', 'draft', ?, ?, ?)`,
        [
          rfqId,
          candidateSetId,
          groupName,
          groupCode,
          sortOrder,
          fromCountry,
          toCountry,
          groupKey,
          dataReadiness,
          items.length,
          uniqueSuppliers.size,
        ]
      )

      const shipmentGroupId = Number(insGroup.insertId)
      for (let idx = 0; idx < items.length; idx += 1) {
        const item = items[idx]
        await conn.execute(
          `INSERT INTO rfq_econ2_shipment_group_items
            (shipment_group_id, candidate_item_id, sort_order, included)
           VALUES (?,?,?,1)`,
          [shipmentGroupId, item.candidate_item_id, idx]
        )
      }

      created.push({
        shipment_group_id: shipmentGroupId,
        name: groupName,
        from_country: fromCountry,
        items_count: items.length,
        suppliers_count: uniqueSuppliers.size,
        data_readiness: dataReadiness,
      })
    }

    await conn.commit()

    const [rows] = await db.execute(
      `SELECT *
         FROM vw_rfq_econ2_shipment_groups_summary
        WHERE rfq_id = ? AND candidate_set_id = ?
        ORDER BY sort_order ASC, shipment_group_id ASC`,
      [rfqId, candidateSetId]
    )

    res.json({
      message: 'Группы консолидации созданы',
      rfq_id: rfqId,
      candidate_set_id: candidateSetId,
      created_count: created.length,
      rows,
    })
  } catch (e) {
    if (conn) {
      try { await conn.rollback() } catch (_e) {}
    }
    console.error('POST /economics/v2/rfq/:rfqId/shipment-groups/auto-from-candidate error:', e)
    res.status(500).json({ message: 'Ошибка сервера при создании групп консолидации v2' })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/v2/rfq/:rfqId/scenarios/create-draft', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const candidateSetId = toId(req.body?.candidate_set_id)
  const calcCurrency = normCurrency(req.body?.calc_currency) || 'USD'
  const strategy = ['MIN_LANDED', 'MIN_ETA', 'BALANCED', 'MANUAL'].includes(String(req.body?.strategy || '').toUpperCase())
    ? String(req.body.strategy).toUpperCase()
    : 'MANUAL'
  const scenarioName = nz(req.body?.name)

  if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })
  if (!candidateSetId) return res.status(400).json({ message: 'Нужно указать candidate_set_id' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[candidate]] = await conn.execute(
      `SELECT *
         FROM rfq_econ2_candidate_sets
        WHERE id = ? AND rfq_id = ? AND is_active = 1
        LIMIT 1`,
      [candidateSetId, rfqId]
    )
    if (!candidate) {
      await conn.rollback()
      return res.status(404).json({ message: 'Кандидат Экономики v2 не найден' })
    }

    const [groups] = await conn.execute(
      `SELECT id
         FROM rfq_econ2_shipment_groups
        WHERE rfq_id = ? AND candidate_set_id = ?
          AND status <> 'archived'
        ORDER BY sort_order ASC, id ASC`,
      [rfqId, candidateSetId]
    )
    if (!groups.length) {
      await conn.rollback()
      return res.status(400).json({ message: 'Сначала создайте группы консолидации для кандидата' })
    }

    const [[agg]] = await conn.execute(
      `SELECT
          COUNT(*) AS rows_count,
          SUM(CASE WHEN ci.goods_amount IS NOT NULL THEN ci.goods_amount ELSE 0 END) AS goods_sum,
          COUNT(DISTINCT NULLIF(ci.goods_currency, '')) AS currency_count,
          MIN(NULLIF(ci.goods_currency, '')) AS currency_hint,
          SUM(CASE WHEN ci.has_price = 1 THEN 1 ELSE 0 END) AS priced_rows
        FROM rfq_econ2_shipment_group_items gi
        JOIN rfq_econ2_shipment_groups g
          ON g.id = gi.shipment_group_id
        JOIN rfq_econ2_candidate_items ci
          ON ci.id = gi.candidate_item_id
       WHERE g.rfq_id = ?
         AND g.candidate_set_id = ?
         AND gi.included = 1`,
      [rfqId, candidateSetId]
    )

    const nowName = new Date()
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19)
    const name = scenarioName || `Черновой сценарий ${nowName}`

    let goodsTotal = null
    const currencyHint = normCurrency(agg?.currency_hint)
    if (
      Number(agg?.currency_count || 0) === 1 &&
      currencyHint &&
      currencyHint === calcCurrency &&
      numOrNull(agg?.goods_sum) !== null
    ) {
      goodsTotal = numOrNull(agg.goods_sum)
    }

    const [insScenario] = await conn.execute(
      `INSERT INTO rfq_econ2_scenarios
        (rfq_id, candidate_set_id, name, source_type, strategy, calc_currency, status,
         goods_total, logistics_total, duty_total, other_total, landed_total,
         coverage_progress_pct, priced_progress_pct, oem_ok, warning_count)
       VALUES (?,?,?,?,?,?, 'draft', ?, NULL, NULL, NULL, NULL, ?, ?, ?, 0)`,
      [
        rfqId,
        candidateSetId,
        name,
        'auto_from_coverage',
        strategy,
        calcCurrency,
        goodsTotal,
        numOrNull(candidate.progress_structure_pct) ?? 0,
        numOrNull(candidate.progress_priced_pct) ?? 0,
        Number(candidate.oem_ok || 0) ? 1 : 0,
      ]
    )
    const scenarioId = Number(insScenario.insertId)

    for (const group of groups) {
      await conn.execute(
        `INSERT INTO rfq_econ2_scenario_group_routes
          (scenario_id, shipment_group_id, route_source_type, calc_status)
         VALUES (?, ?, 'template', 'draft')`,
        [scenarioId, group.id]
      )
    }

    await conn.commit()

    const [[scenarioRow]] = await db.execute(
      `SELECT *
         FROM vw_rfq_econ2_scenarios_summary
        WHERE scenario_id = ?
        LIMIT 1`,
      [scenarioId]
    )

    res.json({
      message: 'Черновой сценарий создан',
      rfq_id: rfqId,
      candidate_set_id: candidateSetId,
      scenario_id: scenarioId,
      row: scenarioRow || null,
      groups_attached: groups.length,
    })
  } catch (e) {
    if (conn) {
      try { await conn.rollback() } catch (_e) {}
    }
    console.error('POST /economics/v2/rfq/:rfqId/scenarios/create-draft error:', e)
    res.status(500).json({ message: 'Ошибка сервера при создании чернового сценария v2' })
  } finally {
    if (conn) conn.release()
  }
})

router.get('/v2/rfq/:rfqId/scenarios/:scenarioId/group-routes', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный RFQ/scenario' })

  try {
    const [rows] = await db.execute(
      `SELECT
          sgr.*,
          g.name AS shipment_group_name,
          g.code AS shipment_group_code,
          g.from_country,
          g.to_country,
          g.urgency_bucket,
          g.data_readiness,
          g.weight_kg,
          g.volume_cbm,
          c.id AS corridor_id_resolved,
          c.name AS corridor_name,
          c.transport_mode,
          c.risk_level AS corridor_risk_level,
          c.eta_min_days AS corridor_eta_min_days,
          c.eta_max_days AS corridor_eta_max_days,
          t.name AS route_template_name,
          t.code AS route_template_code,
          t.pricing_model AS template_pricing_model,
          t.currency AS template_currency
        FROM rfq_econ2_scenario_group_routes sgr
        JOIN rfq_econ2_scenarios s
          ON s.id = sgr.scenario_id
        JOIN rfq_econ2_shipment_groups g
          ON g.id = sgr.shipment_group_id
        LEFT JOIN logistics_route_templates t
          ON t.id = sgr.route_template_id
        LEFT JOIN logistics_corridors c
          ON c.id = COALESCE(sgr.corridor_id, t.corridor_id)
       WHERE sgr.scenario_id = ?
         AND s.rfq_id = ?
       ORDER BY g.sort_order ASC, g.id ASC`,
      [scenarioId, rfqId]
    )
    res.json(rows.map((r) => ({ ...r, route_payload_json: safeJsonParse(r.route_payload_json, null) })))
  } catch (e) {
    console.error('GET /economics/v2/rfq/:rfqId/scenarios/:scenarioId/group-routes error:', e)
    res.status(500).json({ message: 'Ошибка сервера при загрузке маршрутов сценария' })
  }
})

router.post('/v2/rfq/:rfqId/scenarios/:scenarioId/groups/:groupId/route-template', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  const groupId = toId(req.params.groupId)
  const routeTemplateId = toId(req.body?.route_template_id)
  const selectedForScenario = req.body?.selected_for_scenario === undefined ? 1 : (Number(req.body.selected_for_scenario) ? 1 : 0)
  if (!rfqId || !scenarioId || !groupId) return res.status(400).json({ message: 'Некорректные параметры' })
  if (!routeTemplateId) return res.status(400).json({ message: 'Нужно указать route_template_id' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const groupBase = await getScenarioGroupBaseData(scenarioId, groupId)
    if (!groupBase || Number(groupBase.scenario_rfq_id) !== rfqId) {
      await conn.rollback()
      return res.status(404).json({ message: 'Группа сценария не найдена' })
    }

    const [[tpl]] = await conn.execute(
      `SELECT t.*, c.name AS corridor_name, c.transport_mode, c.risk_level
         FROM logistics_route_templates t
         JOIN logistics_corridors c ON c.id = t.corridor_id
        WHERE t.id = ? AND t.is_active = 1
        LIMIT 1`,
      [routeTemplateId]
    )
    if (!tpl) {
      await conn.rollback()
      return res.status(404).json({ message: 'Шаблон маршрута не найден' })
    }

    const calc = calcRouteAmount({
      pricingModel: tpl.pricing_model,
      fixedCost: tpl.fixed_cost,
      ratePerKg: tpl.rate_per_kg,
      ratePerCbm: tpl.rate_per_cbm,
      minCost: tpl.min_cost,
      markupPct: tpl.markup_pct,
      markupFixed: tpl.markup_fixed,
      weightKg: groupBase.weight_kg,
      volumeCbm: groupBase.volume_cbm,
    })

    const payloadSnapshot = {
      source: 'template',
      template_id: tpl.id,
      template_name: tpl.name,
      corridor_id: tpl.corridor_id,
      pricing_model: tpl.pricing_model,
      currency: tpl.currency,
      fixed_cost: numOrNull(tpl.fixed_cost),
      rate_per_kg: numOrNull(tpl.rate_per_kg),
      rate_per_cbm: numOrNull(tpl.rate_per_cbm),
      min_cost: numOrNull(tpl.min_cost),
      markup_pct: numOrNull(tpl.markup_pct),
      markup_fixed: numOrNull(tpl.markup_fixed),
      calc_inputs: {
        weight_kg: numOrNull(groupBase.weight_kg),
        volume_cbm: numOrNull(groupBase.volume_cbm),
      },
    }

    await conn.execute(
      `UPDATE rfq_econ2_scenario_group_routes
          SET corridor_id = ?,
              route_template_id = ?,
              route_source_type = 'template',
              route_name_snapshot = ?,
              route_payload_json = ?,
              pricing_model_snapshot = ?,
              currency_snapshot = ?,
              eta_min_days_calc = ?,
              eta_max_days_calc = ?,
              logistics_amount_calc = ?,
              calc_status = ?,
              calc_message = ?,
              selected_for_scenario = ?
        WHERE scenario_id = ? AND shipment_group_id = ?`,
      [
        tpl.corridor_id,
        tpl.id,
        tpl.name,
        safeJsonStringify(payloadSnapshot),
        tpl.pricing_model,
        tpl.currency,
        numOrNull(tpl.eta_min_days),
        numOrNull(tpl.eta_max_days),
        calc.amount,
        calc.status,
        nz(calc.message),
        selectedForScenario,
        scenarioId,
        groupId,
      ]
    )

    const [[sgr]] = await conn.execute(
      `SELECT id, route_payload_json, route_name_snapshot
         FROM rfq_econ2_scenario_group_routes
        WHERE scenario_id = ? AND shipment_group_id = ?
        LIMIT 1`,
      [scenarioId, groupId]
    )

    await logRouteUsageEvent({
      routeTemplateId: tpl.id,
      corridorId: tpl.corridor_id,
      rfqId,
      sourceId: sgr?.id || null,
      scenarioId,
      shipmentGroupId: groupId,
      routeNameSnapshot: tpl.name,
      routePayload: safeJsonParse(sgr?.route_payload_json, payloadSnapshot),
      note: 'assigned_template_to_group',
    })

    await conn.commit()

    const [rows] = await db.execute(
      `SELECT
          sgr.*,
          g.name AS shipment_group_name,
          c.name AS corridor_name,
          c.transport_mode,
          t.name AS route_template_name
        FROM rfq_econ2_scenario_group_routes sgr
        JOIN rfq_econ2_shipment_groups g ON g.id = sgr.shipment_group_id
        LEFT JOIN logistics_route_templates t ON t.id = sgr.route_template_id
        LEFT JOIN logistics_corridors c ON c.id = COALESCE(sgr.corridor_id, t.corridor_id)
       WHERE sgr.scenario_id = ? AND sgr.shipment_group_id = ?
       LIMIT 1`,
      [scenarioId, groupId]
    )
    const row = rows[0] ? { ...rows[0], route_payload_json: safeJsonParse(rows[0].route_payload_json, null) } : null
    res.json({ message: 'Шаблон маршрута назначен', row })
  } catch (e) {
    if (conn) {
      try { await conn.rollback() } catch (_e) {}
    }
    console.error('POST /economics/v2/rfq/:rfqId/scenarios/:scenarioId/groups/:groupId/route-template error:', e)
    res.status(500).json({ message: 'Ошибка сервера при назначении шаблона маршрута' })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/v2/rfq/:rfqId/scenarios/:scenarioId/groups/:groupId/route-adhoc', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  const groupId = toId(req.params.groupId)
  const corridorId = toId(req.body?.corridor_id)
  const selectedForScenario = req.body?.selected_for_scenario === undefined ? 1 : (Number(req.body.selected_for_scenario) ? 1 : 0)
  if (!rfqId || !scenarioId || !groupId) return res.status(400).json({ message: 'Некорректные параметры' })
  if (!corridorId) return res.status(400).json({ message: 'Нужно указать corridor_id' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const groupBase = await getScenarioGroupBaseData(scenarioId, groupId)
    if (!groupBase || Number(groupBase.scenario_rfq_id) !== rfqId) {
      await conn.rollback()
      return res.status(404).json({ message: 'Группа сценария не найдена' })
    }

    const [[corridor]] = await conn.execute(
      `SELECT * FROM logistics_corridors WHERE id = ? LIMIT 1`,
      [corridorId]
    )
    if (!corridor) {
      await conn.rollback()
      return res.status(404).json({ message: 'Логистический коридор не найден' })
    }

    const adhoc = {
      corridor_id: corridorId,
      name: nz(req.body?.name) || `Ad-hoc ${corridor.name || corridorId}`,
      pricing_model: clampEnum(req.body?.pricing_model, ['fixed', 'per_kg', 'per_cbm', 'per_kg_or_cbm_max', 'hybrid'], 'fixed'),
      currency: normCurrency(req.body?.currency) || 'USD',
      fixed_cost: numOrNull(req.body?.fixed_cost),
      rate_per_kg: numOrNull(req.body?.rate_per_kg),
      rate_per_cbm: numOrNull(req.body?.rate_per_cbm),
      min_cost: numOrNull(req.body?.min_cost),
      markup_pct: numOrNull(req.body?.markup_pct) ?? 0,
      markup_fixed: numOrNull(req.body?.markup_fixed) ?? 0,
      eta_min_days: numOrNull(req.body?.eta_min_days) ?? numOrNull(corridor.eta_min_days),
      eta_max_days: numOrNull(req.body?.eta_max_days) ?? numOrNull(corridor.eta_max_days),
      incoterms_baseline: nz(req.body?.incoterms_baseline),
      oversize_allowed: req.body?.oversize_allowed === undefined ? null : (Number(req.body.oversize_allowed) ? 1 : 0),
      overweight_allowed: req.body?.overweight_allowed === undefined ? null : (Number(req.body.overweight_allowed) ? 1 : 0),
      dangerous_goods_allowed: req.body?.dangerous_goods_allowed === undefined ? null : (Number(req.body.dangerous_goods_allowed) ? 1 : 0),
      calc_inputs: {
        weight_kg: numOrNull(groupBase.weight_kg),
        volume_cbm: numOrNull(groupBase.volume_cbm),
      },
    }

    const calc = calcRouteAmount({
      pricingModel: adhoc.pricing_model,
      fixedCost: adhoc.fixed_cost,
      ratePerKg: adhoc.rate_per_kg,
      ratePerCbm: adhoc.rate_per_cbm,
      minCost: adhoc.min_cost,
      markupPct: adhoc.markup_pct,
      markupFixed: adhoc.markup_fixed,
      weightKg: groupBase.weight_kg,
      volumeCbm: groupBase.volume_cbm,
    })

    await conn.execute(
      `UPDATE rfq_econ2_scenario_group_routes
          SET corridor_id = ?,
              route_template_id = NULL,
              route_source_type = 'adhoc',
              route_name_snapshot = ?,
              route_payload_json = ?,
              pricing_model_snapshot = ?,
              currency_snapshot = ?,
              eta_min_days_calc = ?,
              eta_max_days_calc = ?,
              logistics_amount_calc = ?,
              calc_status = ?,
              calc_message = ?,
              selected_for_scenario = ?
        WHERE scenario_id = ? AND shipment_group_id = ?`,
      [
        corridorId,
        adhoc.name,
        safeJsonStringify(adhoc),
        adhoc.pricing_model,
        adhoc.currency,
        adhoc.eta_min_days,
        adhoc.eta_max_days,
        calc.amount,
        calc.status,
        nz(calc.message),
        selectedForScenario,
        scenarioId,
        groupId,
      ]
    )

    const [[sgr]] = await conn.execute(
      `SELECT id, route_payload_json, route_name_snapshot
         FROM rfq_econ2_scenario_group_routes
        WHERE scenario_id = ? AND shipment_group_id = ?
        LIMIT 1`,
      [scenarioId, groupId]
    )

    await logRouteUsageEvent({
      routeTemplateId: null,
      corridorId,
      rfqId,
      sourceId: sgr?.id || null,
      scenarioId,
      shipmentGroupId: groupId,
      routeNameSnapshot: adhoc.name,
      routePayload: safeJsonParse(sgr?.route_payload_json, adhoc),
      note: 'assigned_adhoc_route_to_group',
    })

    await conn.commit()

    const [[row]] = await db.execute(
      `SELECT sgr.*, g.name AS shipment_group_name, c.name AS corridor_name, c.transport_mode
         FROM rfq_econ2_scenario_group_routes sgr
         JOIN rfq_econ2_shipment_groups g ON g.id = sgr.shipment_group_id
         LEFT JOIN logistics_corridors c ON c.id = sgr.corridor_id
        WHERE sgr.scenario_id = ? AND sgr.shipment_group_id = ?
        LIMIT 1`,
      [scenarioId, groupId]
    )
    res.json({ message: 'Ad-hoc маршрут назначен', row: row ? { ...row, route_payload_json: safeJsonParse(row.route_payload_json, null) } : null })
  } catch (e) {
    if (conn) {
      try { await conn.rollback() } catch (_e) {}
    }
    console.error('POST /economics/v2/rfq/:rfqId/scenarios/:scenarioId/groups/:groupId/route-adhoc error:', e)
    res.status(500).json({ message: 'Ошибка сервера при назначении ad-hoc маршрута' })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/v2/rfq/:rfqId/scenarios/:scenarioId/recalculate', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный RFQ/scenario' })

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[scenario]] = await conn.execute(
      `SELECT *
         FROM rfq_econ2_scenarios
        WHERE id = ? AND rfq_id = ?
        LIMIT 1`,
      [scenarioId, rfqId]
    )
    if (!scenario) {
      await conn.rollback()
      return res.status(404).json({ message: 'Сценарий v2 не найден' })
    }

    const calcCurrency = normCurrency(scenario.calc_currency) || 'USD'
    const candidateSetId = toId(scenario.candidate_set_id)

    const [[candidate]] = candidateSetId
      ? await conn.execute(
          `SELECT progress_structure_pct, progress_priced_pct, oem_ok
             FROM rfq_econ2_candidate_sets
            WHERE id = ?
            LIMIT 1`,
          [candidateSetId]
        )
      : [[null]]

    const [groupRoutes] = await conn.execute(
      `SELECT sgr.*, g.name AS group_name
         FROM rfq_econ2_scenario_group_routes sgr
         JOIN rfq_econ2_shipment_groups g ON g.id = sgr.shipment_group_id
        WHERE sgr.scenario_id = ?
          AND sgr.selected_for_scenario = 1`,
      [scenarioId]
    )

    const [goodsRows] = await conn.execute(
      `SELECT
          gi.shipment_group_id,
          ci.id AS candidate_item_id,
          COALESCE(gi.qty_override, ci.qty) AS qty_effective,
          ci.qty AS qty_base,
          ci.goods_amount,
          ci.goods_currency
        FROM rfq_econ2_scenario_group_routes sgr
        JOIN rfq_econ2_shipment_group_items gi
          ON gi.shipment_group_id = sgr.shipment_group_id AND gi.included = 1
        JOIN rfq_econ2_candidate_items ci
          ON ci.id = gi.candidate_item_id
       WHERE sgr.scenario_id = ?
         AND sgr.selected_for_scenario = 1`,
      [scenarioId]
    )

    let goodsTotal = 0
    let logisticsTotal = 0
    let otherTotal = 0
    let dutyTotal = 0
    let warningCount = 0
    const warnings = []

    for (const row of goodsRows) {
      let amount = numOrNull(row.goods_amount)
      const qtyBase = numOrNull(row.qty_base)
      const qtyEff = numOrNull(row.qty_effective)
      if (amount !== null && qtyBase !== null && qtyBase > 0 && qtyEff !== null && qtyEff >= 0 && qtyEff !== qtyBase) {
        amount = amount * (qtyEff / qtyBase)
      }
      const conv = await convertCurrencyAmount(amount, row.goods_currency, calcCurrency)
      if (conv.value === null) {
        warningCount += 1
        warnings.push({ type: 'goods_fx', item_id: row.candidate_item_id, warning: conv.warning })
      } else {
        goodsTotal += conv.value
      }
    }

    let etaBest = null
    let etaWorst = null
    let routeErrors = 0

    for (const gr of groupRoutes) {
      const calcStatus = String(gr.calc_status || '').toLowerCase()
      if (calcStatus === 'error' || calcStatus === 'not_applicable' || !calcStatus) {
        routeErrors += 1
      } else if (calcStatus === 'warning') {
        warningCount += 1
      }

      const conv = await convertCurrencyAmount(gr.logistics_amount_calc, gr.currency_snapshot, calcCurrency)
      if (conv.value === null && numOrNull(gr.logistics_amount_calc) !== null) {
        warningCount += 1
        warnings.push({ type: 'logistics_fx', group_id: gr.shipment_group_id, warning: conv.warning })
      } else if (conv.value !== null) {
        logisticsTotal += conv.value
      }

      const etaMin = numOrNull(gr.eta_min_days_calc)
      const etaMax = numOrNull(gr.eta_max_days_calc)
      if (etaMin !== null) etaBest = etaBest === null ? etaMin : Math.max(etaBest, etaMin)
      if (etaMax !== null) etaWorst = etaWorst === null ? etaMax : Math.max(etaWorst, etaMax)
    }

    const [otherRows] = await conn.execute(
      `SELECT amount, currency, qty, is_enabled
         FROM rfq_econ2_scenario_other_costs
        WHERE scenario_id = ? AND is_enabled = 1`,
      [scenarioId]
    )
    for (const row of otherRows) {
      const amount = (numOrNull(row.amount) ?? 0) * (numOrNull(row.qty) ?? 1)
      const conv = await convertCurrencyAmount(amount, row.currency, calcCurrency)
      if (conv.value === null) {
        warningCount += 1
        warnings.push({ type: 'other_fx', warning: conv.warning })
      } else {
        otherTotal += conv.value
      }
    }

    goodsTotal = roundMoney(goodsTotal) ?? 0
    logisticsTotal = roundMoney(logisticsTotal) ?? 0
    otherTotal = roundMoney(otherTotal) ?? 0
    dutyTotal = roundMoney(dutyTotal) ?? 0
    const landedTotal = roundMoney(goodsTotal + logisticsTotal + dutyTotal + otherTotal)

    const hasSelectedGroups = groupRoutes.length > 0
    const status = hasSelectedGroups && routeErrors === 0 ? 'calculated' : 'draft'
    const extraWarningCount = routeErrors > 0 ? routeErrors : 0
    const totalWarnings = warningCount + extraWarningCount

    await conn.execute(
      `UPDATE rfq_econ2_scenarios
          SET status = ?,
              goods_total = ?,
              logistics_total = ?,
              duty_total = ?,
              other_total = ?,
              landed_total = ?,
              coverage_progress_pct = ?,
              priced_progress_pct = ?,
              oem_ok = ?,
              eta_days_best = ?,
              eta_days_worst = ?,
              warning_count = ?,
              note = CASE
                       WHEN ? IS NULL OR ? = '' THEN note
                       ELSE ?
                     END
        WHERE id = ?`,
      [
        status,
        goodsTotal,
        logisticsTotal,
        dutyTotal,
        otherTotal,
        landedTotal,
        numOrNull(candidate?.progress_structure_pct),
        numOrNull(candidate?.progress_priced_pct),
        Number(candidate?.oem_ok || 0) ? 1 : 0,
        etaBest,
        etaWorst,
        totalWarnings,
        warnings.length ? safeJsonStringify({ warnings }) : null,
        warnings.length ? safeJsonStringify({ warnings }) : null,
        warnings.length ? `WARNINGS_JSON:${safeJsonStringify({ warnings })}` : null,
        scenarioId,
      ]
    )

    await conn.commit()

    const [[row]] = await db.execute(
      `SELECT *
         FROM vw_rfq_econ2_scenarios_summary
        WHERE scenario_id = ?
        LIMIT 1`,
      [scenarioId]
    )
    res.json({
      message: 'Сценарий пересчитан',
      scenario_id: scenarioId,
      row: row || null,
      meta: {
        selected_groups: groupRoutes.length,
        route_errors: routeErrors,
        warnings: totalWarnings,
      },
    })
  } catch (e) {
    if (conn) {
      try { await conn.rollback() } catch (_e) {}
    }
    console.error('POST /economics/v2/rfq/:rfqId/scenarios/:scenarioId/recalculate error:', e)
    res.status(500).json({ message: 'Ошибка сервера при пересчете сценария v2' })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/rfq/:rfqId/scenarios/auto-min-landed', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const rfqId = toId(req.params.rfqId)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный RFQ' })

    const hasScenarioTables =
      (await tableExists('rfq_econ_scenarios')) && (await tableExists('rfq_econ_scenario_lines'))
    if (!hasScenarioTables) {
      return res.status(400).json({ message: 'Таблицы сценариев экономики не найдены' })
    }

    const views = await pickEconomicsViews()
    if (!views.lineView) {
      return res.status(400).json({ message: 'Представление вариантов экономики не найдено' })
    }

    if (views.lineView === 'vw_rfq_economics_line_options_norm') {
      await ensureFxRatesForRfq(rfqId, views.lineView)
    }
    const lineOptions = await loadLineOptions(rfqId, views.lineView)
    const columns = await getTableColumns('rfq_econ_scenario_lines')
    const colSet = new Set(columns.map((c) => c.Field))

    const requiredNoDefault = columns
      .filter((c) => c.Null === 'NO' && c.Default === null && c.Extra !== 'auto_increment')
      .map((c) => c.Field)
    const knownWritable = new Set([
      'scenario_id',
      'rfq_item_id',
      'response_line_id',
      'selection_key_norm',
      'rfq_supplier_id',
      'supplier_id',
      'route_id',
      'goods_amount',
      'logistics_amount',
      'duty_amount',
      'landed_amount',
      'landed_currency',
      'eta_total_days',
      'supplier_score',
      'created_at',
      'updated_at',
      'id',
    ])
    const unknownRequired = requiredNoDefault.filter(
      (f) => !knownWritable.has(f) && f !== 'id' && f !== 'created_at' && f !== 'updated_at'
    )
    if (unknownRequired.length) {
      return res.status(400).json({
        message: `Не удалось собрать авто-сценарий: неизвестные обязательные поля ${unknownRequired.join(', ')}`,
      })
    }

    const responseRequired = columns.some(
      (c) => c.Field === 'response_line_id' && c.Null === 'NO' && c.Default === null
    )

    const grouped = new Map()
    lineOptions.forEach((row) => {
      if (numOrNull(row.landed_amount) === null) return
      if (Number(row.fx_missing || 0) > 0) return
      if (responseRequired && !row.response_line_id) return
      if (!row.rfq_item_id) return

      const key = `${row.rfq_item_id}:${row.selection_key_raw || row.selection_key_norm || ''}`
      const prev = grouped.get(key)
      if (!prev) {
        grouped.set(key, row)
        return
      }
      const prevLanded = numOrNull(prev.landed_amount)
      const currLanded = numOrNull(row.landed_amount)
      if (currLanded !== null && prevLanded !== null && currLanded < prevLanded) {
        grouped.set(key, row)
        return
      }
      if (currLanded !== null && prevLanded === null) {
        grouped.set(key, row)
        return
      }
      if (currLanded === prevLanded) {
        const prevEta = numOrNull(prev.eta_total_days)
        const currEta = numOrNull(row.eta_total_days)
        if (currEta !== null && prevEta !== null && currEta < prevEta) {
          grouped.set(key, row)
          return
        }
        if (currEta !== null && prevEta === null) {
          grouped.set(key, row)
        }
      }
    })

    const selectedRows = Array.from(grouped.values())
    await conn.beginTransaction()
    const name = nz(req.body?.name) || `AUTO MIN_LANDED ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    const strategy = nz(req.body?.strategy) || 'MIN_LANDED'
    const [insScenario] = await conn.execute(
      `INSERT INTO rfq_econ_scenarios (rfq_id, name, strategy)
       VALUES (?, ?, ?)`,
      [rfqId, name, strategy]
    )
    const scenarioId = insScenario.insertId

    const orderedColumns = [
      'scenario_id',
      'rfq_item_id',
      'response_line_id',
      'selection_key_norm',
      'rfq_supplier_id',
      'supplier_id',
      'route_id',
      'goods_amount',
      'logistics_amount',
      'duty_amount',
      'landed_amount',
      'landed_currency',
      'eta_total_days',
      'supplier_score',
    ].filter((c) => colSet.has(c))

    if (selectedRows.length && orderedColumns.length) {
      const placeholders = selectedRows.map(() => `(${orderedColumns.map(() => '?').join(',')})`).join(',')
      const values = []
      selectedRows.forEach((row) => {
        orderedColumns.forEach((column) => {
          if (column === 'scenario_id') values.push(scenarioId)
          else if (column === 'rfq_item_id') values.push(row.rfq_item_id || null)
          else if (column === 'response_line_id') values.push(row.response_line_id || null)
          else if (column === 'selection_key_norm') values.push(row.selection_key_norm || null)
          else if (column === 'rfq_supplier_id') values.push(row.rfq_supplier_id || null)
          else if (column === 'supplier_id') values.push(row.supplier_id || null)
          else if (column === 'route_id') values.push(row.route_id || null)
          else if (column === 'goods_amount') values.push(numOrNull(row.goods_amount))
          else if (column === 'logistics_amount') values.push(numOrNull(row.logistics_amount))
          else if (column === 'duty_amount') values.push(numOrNull(row.duty_amount))
          else if (column === 'landed_amount') values.push(numOrNull(row.landed_amount))
          else if (column === 'landed_currency') values.push(normCurrency(row.landed_currency))
          else if (column === 'eta_total_days') values.push(numOrNull(row.eta_total_days))
          else if (column === 'supplier_score') values.push(numOrNull(row.supplier_score))
          else values.push(null)
        })
      })
      await conn.query(
        `INSERT INTO rfq_econ_scenario_lines (${orderedColumns.join(',')}) VALUES ${placeholders}`,
        values
      )
    }

    await conn.commit()
    res.status(201).json({
      scenario_id: scenarioId,
      name,
      strategy,
      picked_lines: selectedRows.length,
    })
  } catch (e) {
    await conn.rollback()
    console.error('POST /economics/rfq/:rfqId/scenarios/auto-min-landed error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

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
