const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { getRate } = require('../utils/fxRatesService')
const {
  updateRequestStatus,
  fetchRequestIdBySelectionId,
} = require('../utils/clientRequestStatus')
const {
  getClientFacingPartNumber,
  getClientFacingDescription,
  getSupplierFacingPartNumber,
  getSupplierFacingDescription,
} = require('../utils/partPresentation')

const toId = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}
const numOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(String(value).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const textOrNull = (value) => {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s ? s : null
}
const sumNums = (list) => list.reduce((acc, value) => acc + (Number.isFinite(Number(value)) ? Number(value) : 0), 0)
const normCurrency = (value) => {
  if (!value) return null
  const s = String(value).trim().toUpperCase()
  return s ? s.slice(0, 3) : null
}
const TRANSPORT_MODES = new Set(['SEA', 'RAIL', 'AIR', 'ROAD', 'MULTI'])
const normTransportMode = (value) => {
  const s = String(value || '').trim().toUpperCase()
  return TRANSPORT_MODES.has(s) ? s : 'MULTI'
}
const corridorNameFrom = (originCountry, destinationCountry, transportMode) =>
  [originCountry || '—', '→', destinationCountry || '—', transportMode || 'MULTI'].join(' ')

const resolveCorridorId = async (conn, source = {}) => {
  const explicitId = toId(source?.corridor_id)
  const originCountry = textOrNull(source?.origin_country)?.toUpperCase() || null
  const destinationCountry = textOrNull(source?.destination_country)?.toUpperCase() || null
  const transportMode = normTransportMode(source?.transport_mode)

  if (explicitId && !originCountry && !destinationCountry && !textOrNull(source?.transport_mode)) {
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
      (name, origin_country, destination_country, transport_mode, risk_level, notes, is_active)
     VALUES (?,?,?,?,?,?,?)`,
    [
      corridorNameFrom(originCountry, destinationCountry, transportMode),
      originCountry,
      destinationCountry,
      transportMode,
      'medium',
      'Создано автоматически из варианта доставки RFQ',
      1,
    ]
  )
  return Number(inserted.insertId)
}

const schemaColumnCache = new Map()
const hasColumn = async (conn, tableName, columnName) => {
  const cacheKey = `${tableName}.${columnName}`
  if (schemaColumnCache.has(cacheKey)) return schemaColumnCache.get(cacheKey)
  const [rows] = await conn.execute(
    `SELECT 1
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  )
  const exists = !!rows?.length
  schemaColumnCache.set(cacheKey, exists)
  return exists
}

const supportsScenarioFxSnapshot = async (conn) => {
  const [fxAsOf, fxSnapshotJson] = await Promise.all([
    hasColumn(conn, 'rfq_scenarios', 'fx_as_of'),
    hasColumn(conn, 'rfq_scenarios', 'fx_snapshot_json'),
  ])
  return fxAsOf && fxSnapshotJson
}

const parseSnapshot = (raw) => {
  if (!raw) return { target_currency: null, rates: {} }
  if (typeof raw === 'object') {
    return {
      target_currency: normCurrency(raw.target_currency),
      rates: raw.rates && typeof raw.rates === 'object' ? raw.rates : {},
    }
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      target_currency: normCurrency(parsed?.target_currency),
      rates: parsed?.rates && typeof parsed.rates === 'object' ? parsed.rates : {},
    }
  } catch (_) {
    return { target_currency: null, rates: {} }
  }
}

const snapshotAsJson = (snapshot) =>
  JSON.stringify({
    target_currency: normCurrency(snapshot?.target_currency),
    rates: snapshot?.rates || {},
  })

const convertWithSnapshot = (amount, fromCurrency, targetCurrency, snapshot) => {
  const amountNum = Number(amount)
  const from = normCurrency(fromCurrency)
  const target = normCurrency(targetCurrency)
  if (!Number.isFinite(amountNum)) return null
  if (!from || !target || from === target) return amountNum
  const entry = snapshot?.rates?.[from]
  const rate = Number(entry?.rate)
  if (!Number.isFinite(rate) || rate <= 0) return amountNum
  return amountNum * rate
}

const convertWithSnapshotMeta = (amount, fromCurrency, targetCurrency, snapshot) => {
  const amountNum = Number(amount)
  const from = normCurrency(fromCurrency)
  const target = normCurrency(targetCurrency)
  if (!Number.isFinite(amountNum)) return { amount: null, missingRate: false, from, target }
  if (!from || !target || from === target) return { amount: amountNum, missingRate: false, from, target }
  const entry = snapshot?.rates?.[from]
  const rate = Number(entry?.rate)
  if (!Number.isFinite(rate) || rate <= 0) return { amount: amountNum, missingRate: true, from, target }
  return { amount: amountNum * rate, missingRate: false, from, target }
}

const uniqueValues = (list = []) =>
  Array.from(new Set(list.filter((value) => value !== null && value !== undefined && value !== '')))

const parseWarningJson = (raw) => {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map((item) => String(item || '').trim()).filter(Boolean)
  if (typeof raw === 'string') {
    try {
      return parseWarningJson(JSON.parse(raw))
    } catch (_) {
      return raw.split(',').map((item) => item.trim()).filter(Boolean)
    }
  }
  if (typeof raw === 'object' && Array.isArray(raw.codes)) {
    return raw.codes.map((item) => String(item || '').trim()).filter(Boolean)
  }
  return []
}

const getLineOriginCountry = (line) =>
  textOrNull(line?.origin_country) ||
  textOrNull(line?.cost_origin_country)

const getLineDisplayOriginCountry = (line) =>
  getLineOriginCountry(line) ||
  textOrNull(line?.supplier_country)

const getLineIncoterms = (line) => textOrNull(line?.incoterms)
const getLineIncotermsPlace = (line) => normalizePlace(line?.incoterms_place)

const getLineTnvedCodeId = (line) => toId(line?.tnved_code_id) || toId(line?.cost_tnved_code_id)
const getLineTnvedCode = (line) => textOrNull(line?.tnved_code) || textOrNull(line?.cost_tnved_code)
const getLineDutyRatePct = (line) => {
  const primary = numOrNull(line?.duty_rate_pct)
  if (primary !== null) return primary
  return numOrNull(line?.cost_duty_rate_pct)
}

const ensureSnapshotRates = async (conn, scenario, currencies = []) => {
  const targetCurrency = normCurrency(scenario?.calc_currency) || 'USD'
  const snapshot = parseSnapshot(scenario?.fx_snapshot_json)
  snapshot.target_currency = targetCurrency
  let fxAsOf = scenario?.fx_as_of ? new Date(scenario.fx_as_of) : null
  let changed = false

  for (const currencyRaw of currencies) {
    const currency = normCurrency(currencyRaw)
    if (!currency || currency === targetCurrency) continue
    const existing = snapshot?.rates?.[currency]
    if (existing?.rate && existing?.fetched_at) continue
    const rateObj = await getRate(currency, targetCurrency)
    snapshot.rates[currency] = {
      rate: Number(rateObj.rate),
      source: rateObj.source || 'db',
      fetched_at: rateObj.fetchedAt instanceof Date ? rateObj.fetchedAt.toISOString() : new Date(rateObj.fetchedAt).toISOString(),
      from: currency,
      to: targetCurrency,
    }
    const fetchedAt = rateObj.fetchedAt instanceof Date ? rateObj.fetchedAt : new Date(rateObj.fetchedAt)
    if (!fxAsOf || fetchedAt > fxAsOf) fxAsOf = fetchedAt
    changed = true
  }

  if (changed && await supportsScenarioFxSnapshot(conn)) {
    await conn.execute(
      `UPDATE rfq_scenarios
          SET fx_as_of = ?,
              fx_snapshot_json = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [fxAsOf, snapshotAsJson(snapshot), scenario.id]
    )
    scenario.fx_as_of = fxAsOf
    scenario.fx_snapshot_json = snapshotAsJson(snapshot)
  }

  return {
    snapshot,
    targetCurrency,
    fxAsOf,
  }
}

const loadScenarioHeader = async (conn, rfqId, scenarioId) => {
  const [[row]] = await conn.execute(
    `SELECT *
       FROM rfq_scenarios
      WHERE id = ? AND rfq_id = ?`,
    [scenarioId, rfqId]
  )
  return row || null
}

const loadScenarioLines = async (conn, scenarioId) => {
  const [rows] = await conn.execute(
    `SELECT sl.*,
            o.option_code,
            o.option_kind,
            o.note AS option_note,
            o.coverage_status,
            o.completeness_pct,
            o.priced_pct,
            o.is_oem_ok,
            o.goods_total,
            o.goods_currency,
            i.line_number,
            cri.client_part_number,
            cri.client_description,
            cri.oem_part_id AS original_part_id,
            op.part_number AS original_cat_number
       FROM rfq_scenario_lines sl
       JOIN rfq_coverage_options o ON o.id = sl.coverage_option_id
       JOIN rfq_items i ON i.id = sl.rfq_item_id
       JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
       LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
      WHERE sl.scenario_id = ?
      ORDER BY i.line_number ASC, sl.id ASC`,
    [scenarioId]
  )
  return rows
}

const loadCoverageLinesByOptionIds = async (conn, optionIds) => {
  if (!optionIds.length) return []
  const [rows] = await conn.query(
    `SELECT l.*,
            ps.name AS supplier_name,
            ps.reliability_rating,
            ps.risk_level,
            ps.country AS supplier_country,
            cb.origin_country AS cost_origin_country,
            COALESCE(l.tnved_code_id, cb.tnved_code_id) AS cost_tnved_code_id,
            COALESCE(tn.code, cb.tnved_code) AS cost_tnved_code,
            COALESCE(tn.duty_rate, cb.duty_rate_pct) AS cost_duty_rate_pct
       FROM rfq_coverage_option_lines l
       LEFT JOIN part_suppliers ps ON ps.id = l.supplier_id
       LEFT JOIN vw_rfq_cost_base cb ON cb.response_line_id = l.rfq_response_line_id
       LEFT JOIN tnved_codes tn ON tn.id = l.tnved_code_id
      WHERE l.coverage_option_id IN (?)
      ORDER BY l.coverage_option_id ASC, l.id ASC`,
    [optionIds]
  )
  return rows
}

const loadShipmentGroupDetails = async (conn, scenarioId, groupId = null) => {
  const params = [scenarioId]
  let groupFilterSql = ''
  if (groupId) {
    groupFilterSql = ' AND g.id = ?'
    params.push(groupId)
  }

  const [groupRows] = await conn.execute(
    `SELECT g.*,
            gl.id AS shipment_group_line_id,
            gl.coverage_option_line_id,
            gl.qty_allocated,
            gl.weight_allocated_kg,
            gl.freight_allocated,
            gl.duty_allocated,
            gl.included,
            col.rfq_item_id,
            col.rfq_item_component_id,
            col.rfq_response_line_id,
            col.supplier_id AS line_supplier_id,
            col.line_code,
            col.line_role,
            col.qty,
            col.uom,
            col.unit_price,
            col.goods_amount,
            col.goods_currency,
            col.weight_kg,
            col.volume_cbm,
            col.lead_time_days,
            col.origin_country,
            col.incoterms,
            col.incoterms_place,
            cb.origin_country AS cost_origin_country,
            COALESCE(col.tnved_code_id, cb.tnved_code_id) AS cost_tnved_code_id,
            COALESCE(tn.code, cb.tnved_code) AS cost_tnved_code,
            COALESCE(tn.duty_rate, cb.duty_rate_pct) AS cost_duty_rate_pct,
            col.note AS line_note,
            ps.name AS supplier_name,
            ps.reliability_rating,
            ps.risk_level,
            ps.country AS supplier_country,
            i.line_number,
            cri.client_part_number,
            cri.client_description,
            cri.oem_part_id AS original_part_id,
            op.part_number AS original_cat_number
       FROM rfq_shipment_groups g
       LEFT JOIN rfq_shipment_group_lines gl ON gl.shipment_group_id = g.id
       LEFT JOIN rfq_coverage_option_lines col ON col.id = gl.coverage_option_line_id
       LEFT JOIN vw_rfq_cost_base cb ON cb.response_line_id = col.rfq_response_line_id
       LEFT JOIN tnved_codes tn ON tn.id = col.tnved_code_id
       LEFT JOIN part_suppliers ps ON ps.id = col.supplier_id
       LEFT JOIN rfq_items i ON i.id = col.rfq_item_id
       LEFT JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
       LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
      WHERE g.scenario_id = ?${groupFilterSql}
      ORDER BY g.id ASC, gl.id ASC`,
    params
  )

  const groups = new Map()
  groupRows.forEach((row) => {
    const id = Number(row.id || 0)
    if (!id) return
    const group = groups.get(id) || { ...row, lines: [] }
    if (row.shipment_group_line_id) {
      group.lines.push({
        shipment_group_line_id: row.shipment_group_line_id,
        coverage_option_line_id: row.coverage_option_line_id,
        qty_allocated: row.qty_allocated,
        weight_allocated_kg: row.weight_allocated_kg,
        freight_allocated: row.freight_allocated,
        duty_allocated: row.duty_allocated,
        included: row.included,
        rfq_item_id: row.rfq_item_id,
        rfq_item_component_id: row.rfq_item_component_id,
        rfq_response_line_id: row.rfq_response_line_id,
        supplier_id: row.line_supplier_id,
        supplier_name: row.supplier_name,
        reliability_rating:
          row.reliability_rating === undefined || row.reliability_rating === null
            ? null
            : Number(row.reliability_rating),
        risk_level: row.risk_level || null,
        line_code: row.line_code,
        line_role: row.line_role,
        qty: row.qty,
        uom: row.uom,
        unit_price: row.unit_price,
        goods_amount: row.goods_amount,
        goods_currency: row.goods_currency,
        weight_kg: row.weight_kg,
        volume_cbm: row.volume_cbm,
        lead_time_days: row.lead_time_days,
        origin_country: getLineDisplayOriginCountry(row),
        origin_country_raw: getLineOriginCountry(row),
        cost_origin_country: row.cost_origin_country,
        tnved_code_id: row.cost_tnved_code_id,
        tnved_code: row.cost_tnved_code,
        duty_rate_pct: row.cost_duty_rate_pct,
        incoterms: getLineIncoterms(row),
        incoterms_place: getLineIncotermsPlace(row),
        supplier_country: row.supplier_country,
        note: row.line_note,
        line_number: row.line_number,
        client_part_number: row.client_part_number,
        client_description: row.client_description,
        original_cat_number: row.original_cat_number,
      })
    }
    groups.set(id, group)
  })

  return Array.from(groups.values())
}

const loadScenarioCoverageLinePool = async (conn, scenarioId) => {
  const [rows] = await conn.execute(
    `SELECT col.*,
            sl.id AS scenario_line_id,
            sl.rfq_item_id,
            o.option_code,
            o.option_kind,
            ps.name AS supplier_name,
            ps.reliability_rating,
            ps.risk_level,
            ps.country AS supplier_country,
            cb.origin_country AS cost_origin_country,
            COALESCE(col.tnved_code_id, cb.tnved_code_id) AS cost_tnved_code_id,
            COALESCE(tn.code, cb.tnved_code) AS cost_tnved_code,
            COALESCE(tn.duty_rate, cb.duty_rate_pct) AS cost_duty_rate_pct,
            i.line_number,
            cri.client_part_number,
            cri.client_description,
            cri.oem_part_id AS original_part_id,
            op.part_number AS original_cat_number,
            assigned.shipment_group_id AS assigned_group_id
       FROM rfq_scenario_lines sl
       JOIN rfq_coverage_options o ON o.id = sl.coverage_option_id
       JOIN rfq_coverage_option_lines col ON col.coverage_option_id = o.id
       LEFT JOIN vw_rfq_cost_base cb ON cb.response_line_id = col.rfq_response_line_id
       LEFT JOIN tnved_codes tn ON tn.id = col.tnved_code_id
       LEFT JOIN part_suppliers ps ON ps.id = col.supplier_id
       LEFT JOIN rfq_items i ON i.id = sl.rfq_item_id
       LEFT JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
       LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
       LEFT JOIN rfq_shipment_group_lines assigned ON assigned.coverage_option_line_id = col.id
       LEFT JOIN rfq_shipment_groups ag ON ag.id = assigned.shipment_group_id AND ag.scenario_id = sl.scenario_id
      WHERE sl.scenario_id = ?
      ORDER BY i.line_number ASC, col.id ASC`,
    [scenarioId]
  )
  return rows
}

const normalizePlace = (value) => {
  const normalized = textOrNull(value)
  return normalized ? normalized.replace(/\s+/g, ' ').trim() : null
}

const buildLogisticsDataWarnings = (line) => {
  const warnings = []
  if (!getLineOriginCountry(line)) warnings.push('missing_origin_country')
  if (!getLineIncoterms(line)) warnings.push('missing_incoterms')
  if (getLineIncoterms(line) && !getLineIncotermsPlace(line)) warnings.push('missing_incoterms_place')
  if (!numOrNull(line.weight_kg)) warnings.push('missing_weight')
  if (!numOrNull(line.lead_time_days)) warnings.push('missing_lead_time')
  if (!getLineTnvedCodeId(line) && !getLineTnvedCode(line)) warnings.push('missing_tnved')
  if (getLineTnvedCodeId(line) && getLineDutyRatePct(line) === null) warnings.push('missing_duty_rate')
  return warnings
}

const buildShipmentGroupCompatibilityWarnings = (lines = []) => {
  const warnings = []
  const originCountries = uniqueValues(lines.map((line) => getLineOriginCountry(line)))
  const incotermsValues = uniqueValues(lines.map((line) => getLineIncoterms(line)))
  const incotermsPlaces = uniqueValues(lines.map((line) => getLineIncotermsPlace(line)))
  const dutyRates = uniqueValues(lines.map((line) => getLineDutyRatePct(line)))
  const hasMissingCustomsData = lines.some((line) => !getLineTnvedCodeId(line) && !getLineTnvedCode(line))

  if (originCountries.length > 1) warnings.push('mixed_origin_countries')
  if (incotermsValues.length > 1) warnings.push('mixed_incoterms')
  if (incotermsPlaces.length > 1) warnings.push('mixed_incoterms_places')
  if (dutyRates.length > 1) warnings.push('mixed_duty_rates')
  if (hasMissingCustomsData) warnings.push('missing_customs_data')

  return warnings
}

const summarizeOriginSource = (lines = []) => {
  const hasSnapshotOrigin = lines.some((line) => textOrNull(line?.origin_country))
  const hasCostBaseOrigin = lines.some((line) => !textOrNull(line?.origin_country) && textOrNull(line?.cost_origin_country))
  const hasSupplierOnly = lines.some(
    (line) => !textOrNull(line?.origin_country) && !textOrNull(line?.cost_origin_country) && textOrNull(line?.supplier_country)
  )

  if (hasSnapshotOrigin) return 'coverage_snapshot'
  if (hasCostBaseOrigin) return 'response_or_cost_base'
  if (hasSupplierOnly) return 'supplier_only'
  return 'missing'
}

const summarizeDutySource = (lines = []) => {
  const hasDuty = lines.some((line) => getLineDutyRatePct(line) !== null)
  const hasTnved = lines.some((line) => getLineTnvedCodeId(line) || getLineTnvedCode(line))
  if (hasDuty && hasTnved) return 'tnved'
  if (hasTnved) return 'tnved_missing_rate'
  return 'missing'
}

const parseJsonObject = (raw) => {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

const calcRouteCost = ({
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
  const weight = Math.max(numOrNull(weightKg) || 0, 0)
  const volume = Math.max(numOrNull(volumeCbm) || 0, 0)
  const fixed = Math.max(numOrNull(fixedCost) || 0, 0)
  const perKg = Math.max(numOrNull(ratePerKg) || 0, 0)
  const perCbm = Math.max(numOrNull(ratePerCbm) || 0, 0)
  const min = Math.max(numOrNull(minCost) || 0, 0)
  const pct = Math.max(numOrNull(markupPct) || 0, 0)
  const extra = Math.max(numOrNull(markupFixed) || 0, 0)

  let base = 0
  switch (String(pricingModel || 'fixed')) {
    case 'per_kg':
      base = perKg * weight
      break
    case 'per_cbm':
      base = perCbm * volume
      break
    case 'per_kg_or_cbm_max':
      base = Math.max(perKg * weight, perCbm * volume)
      break
    case 'hybrid':
      base = fixed + (perKg * weight) + (perCbm * volume)
      break
    case 'fixed':
    default:
      base = fixed
      break
  }

  const withMin = Math.max(base, min)
  const withPct = withMin * (1 + pct / 100)
  return withPct + extra
}

const buildRouteCalc = (route, shipmentGroup) => {
  const payload = parseJsonObject(route?.route_payload_json)
  const pricingModel = textOrNull(route?.pricing_model_snapshot) || textOrNull(route?.template_pricing_model) || textOrNull(payload?.pricing_model) || 'fixed'
  const currency = normCurrency(route?.currency_snapshot || route?.template_currency || payload?.currency) || null
  const fixedCost = numOrNull(route?.fixed_cost_snapshot ?? route?.template_fixed_cost ?? payload?.fixed_cost)
  const ratePerKg = numOrNull(route?.rate_per_kg_snapshot ?? route?.template_rate_per_kg ?? payload?.rate_per_kg)
  const ratePerCbm = numOrNull(route?.rate_per_cbm_snapshot ?? route?.template_rate_per_cbm ?? payload?.rate_per_cbm)
  const minCost = numOrNull(route?.min_cost_snapshot ?? route?.template_min_cost ?? payload?.min_cost)
  const markupPct = numOrNull(route?.markup_pct_snapshot ?? route?.template_markup_pct ?? payload?.markup_pct)
  const markupFixed = numOrNull(route?.markup_fixed_snapshot ?? route?.template_markup_fixed ?? payload?.markup_fixed)
  const etaMin = numOrNull(route?.eta_min_days_snapshot ?? route?.template_eta_min_days ?? payload?.eta_min_days)
  const etaMax = numOrNull(route?.eta_max_days_snapshot ?? route?.template_eta_max_days ?? payload?.eta_max_days)
  const corridorId = toId(route?.corridor_id) || toId(route?.template_corridor_id) || toId(payload?.corridor_id)

  const warnings = []
  if (!corridorId) warnings.push('missing_corridor')
  if (!currency) warnings.push('missing_currency')
  if (!pricingModel) warnings.push('missing_pricing_model')

  const logisticsAmount = currency
    ? calcRouteCost({
        pricingModel,
        fixedCost,
        ratePerKg,
        ratePerCbm,
        minCost,
        markupPct,
        markupFixed,
        weightKg: shipmentGroup?.total_weight_kg,
        volumeCbm: shipmentGroup?.total_volume_cbm,
      })
    : null

  let calcStatus = 'ok'
  if (!corridorId || !currency) calcStatus = 'draft'
  else if (warnings.length) calcStatus = 'warning'

  return {
    corridorId,
    pricingModel,
    currency,
    logisticsAmount,
    etaMin,
    etaMax,
    warnings,
    calcStatus,
  }
}

const syncShipmentGroupWithSelectedRoute = async (conn, routeId) => {
  const [[row]] = await conn.execute(
    `SELECT r.id,
            r.shipment_group_id,
            r.logistics_amount_calc,
            r.currency_snapshot,
            r.eta_min_days_snapshot,
            r.eta_max_days_snapshot,
            r.route_name_snapshot,
            c.transport_mode AS corridor_transport_mode
       FROM rfq_shipment_group_routes r
       LEFT JOIN logistics_corridors c ON c.id = r.corridor_id
      WHERE r.id = ?`,
    [routeId]
  )
  if (!row) return
  await conn.execute(
    `UPDATE rfq_shipment_groups
        SET route_type = COALESCE(?, route_type),
            freight_input_mode = 'TOTAL',
            freight_total = ?,
            freight_currency = COALESCE(?, freight_currency),
            eta_min_days = ?,
            eta_max_days = ?,
            source_note = CONCAT('Выбран вариант доставки: ', ?),
            updated_at = NOW()
      WHERE id = ?`,
    [
      textOrNull(row.corridor_transport_mode) || 'MANUAL',
      numOrNull(row.logistics_amount_calc),
      textOrNull(row.currency_snapshot),
      numOrNull(row.eta_min_days_snapshot),
      numOrNull(row.eta_max_days_snapshot),
      textOrNull(row.route_name_snapshot) || `Вариант доставки #${row.id}`,
      row.shipment_group_id,
    ]
  )
}

const bootstrapShipmentGroupRoutes = async (conn, scenarioId, userId = null) => {
  const [groups] = await conn.execute(
    `SELECT g.id
       FROM rfq_shipment_groups g
      WHERE g.scenario_id = ?
        AND NOT EXISTS (
          SELECT 1
            FROM rfq_shipment_group_routes r
           WHERE r.shipment_group_id = g.id
        )`,
    [scenarioId]
  )

  for (const group of groups) {
    await conn.execute(
      `INSERT INTO rfq_shipment_group_routes
        (shipment_group_id, route_source_type, route_name_snapshot, calc_status, created_by_user_id, updated_by_user_id)
       VALUES (?,?,?,?,?,?)`,
      [group.id, 'adhoc', 'Черновой вариант доставки', 'draft', toId(userId), toId(userId)]
    )
  }
}

const buildShipmentGroupsForScenario = async (conn, rfqId, scenarioId, userId) => {
  const scenarioLines = await loadScenarioLines(conn, scenarioId)
  const optionIds = scenarioLines.map((row) => Number(row.coverage_option_id)).filter(Boolean)
  const coverageLines = await loadCoverageLinesByOptionIds(conn, optionIds)
  const scenarioLineByOption = new Map(scenarioLines.map((row) => [Number(row.coverage_option_id), row]))

  await conn.execute('DELETE FROM rfq_shipment_groups WHERE scenario_id = ?', [scenarioId])

  const grouped = new Map()
  coverageLines.forEach((line) => {
    const supplierId = Number(line.supplier_id || 0) || null
    const originCountry = getLineOriginCountry(line) || 'XX'
    const incoterms = getLineIncoterms(line)
    const incotermsPlace = getLineIncotermsPlace(line)
    const key = [
      supplierId || 0,
      originCountry,
      incoterms || 'NO_INCOTERMS',
      incotermsPlace || 'NO_PLACE',
    ].join(':')
    const bucket = grouped.get(key) || {
      supplier_id: supplierId,
      from_country: originCountry === 'XX' ? null : originCountry,
      from_city: null,
      to_country: null,
      to_city: null,
      incoterms,
      incoterms_place: incotermsPlace,
      warnings: new Set(),
      lines: [],
    }
    buildLogisticsDataWarnings(line).forEach((warning) => bucket.warnings.add(warning))
    bucket.lines.push(line)
    grouped.set(key, bucket)
  })

  for (const bucket of grouped.values()) {
    const supplierName = bucket.lines.find((row) => row.supplier_name)?.supplier_name || `Поставщик #${bucket.supplier_id}`
    const totalWeight = sumNums(bucket.lines.map((row) => row.weight_kg))
    const totalVolume = sumNums(bucket.lines.map((row) => row.volume_cbm))
    buildShipmentGroupCompatibilityWarnings(bucket.lines).forEach((warning) => bucket.warnings.add(warning))
    const groupLabelParts = [supplierName]
    if (bucket.from_country) groupLabelParts.push(bucket.from_country)
    if (bucket.incoterms) {
      groupLabelParts.push(bucket.incoterms_place ? `${bucket.incoterms} ${bucket.incoterms_place}` : bucket.incoterms)
    }
    const [insertGroup] = await conn.execute(
      `INSERT INTO rfq_shipment_groups
        (scenario_id, group_code, name, status, consolidation_mode, supplier_id,
         from_country, from_city, to_country, to_city, route_type, incoterms, incoterms_place,
         total_weight_kg, total_volume_cbm, freight_input_mode, entered_by_user_id, source_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        scenarioId,
        `GRP-${scenarioId}-${bucket.supplier_id || 'MIX'}`,
        groupLabelParts.join(' · '),
        'DRAFT',
        'BY_SUPPLIER',
        bucket.supplier_id,
        bucket.from_country,
        null,
        null,
        null,
        'MANUAL',
        bucket.incoterms,
        bucket.incoterms_place,
        totalWeight || null,
        totalVolume || null,
        'TOTAL',
        userId,
        bucket.warnings.size ? `Предупреждения: ${Array.from(bucket.warnings).join(', ')}` : null,
      ]
    )

    const shipmentGroupId = insertGroup.insertId
    for (const line of bucket.lines) {
      await conn.execute(
        `INSERT INTO rfq_shipment_group_lines
          (shipment_group_id, coverage_option_line_id, qty_allocated, weight_allocated_kg, included)
         VALUES (?,?,?,?,1)`,
        [
          shipmentGroupId,
          line.id,
          numOrNull(line.qty),
          numOrNull(line.weight_kg),
        ]
      )
    }
  }

  const [rows] = await conn.execute(
    `SELECT g.*,
            COUNT(gl.id) AS line_count
       FROM rfq_shipment_groups g
       LEFT JOIN rfq_shipment_group_lines gl ON gl.shipment_group_id = g.id
      WHERE g.scenario_id = ?
      GROUP BY g.id
      ORDER BY g.id ASC`,
    [scenarioId]
  )
  return rows
}

const calculateScenario = async (conn, rfqId, scenarioId) => {
  const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
  if (!scenario) {
    throw Object.assign(new Error('scenario_not_found'), { statusCode: 404, message: 'Сценарий не найден' })
  }

  const scenarioLines = await loadScenarioLines(conn, scenarioId)
  const optionIds = scenarioLines.map((row) => Number(row.coverage_option_id)).filter(Boolean)
  const coverageLines = await loadCoverageLinesByOptionIds(conn, optionIds)
  const coverageLinesByOption = new Map()
  coverageLines.forEach((row) => {
    const optionId = Number(row.coverage_option_id || 0)
    const list = coverageLinesByOption.get(optionId) || []
    list.push(row)
    coverageLinesByOption.set(optionId, list)
  })

  const [groupRows] = await conn.execute(
    `SELECT g.*,
            gl.id AS shipment_group_line_id,
            gl.coverage_option_line_id,
            gl.weight_allocated_kg,
            gl.included
       FROM rfq_shipment_groups g
       LEFT JOIN rfq_shipment_group_lines gl ON gl.shipment_group_id = g.id
      WHERE g.scenario_id = ?
      ORDER BY g.id ASC, gl.id ASC`,
    [scenarioId]
  )

  const groupsById = new Map()
  groupRows.forEach((row) => {
    const groupId = Number(row.id || 0)
    if (!groupId) return
    const group = groupsById.get(groupId) || { ...row, lines: [] }
    if (row.shipment_group_line_id) {
      group.lines.push({
        shipment_group_line_id: row.shipment_group_line_id,
        coverage_option_line_id: row.coverage_option_line_id,
        weight_allocated_kg: row.weight_allocated_kg,
        included: row.included,
      })
    }
    groupsById.set(groupId, group)
  })

  const fxCurrencies = [
    ...coverageLines.map((row) => row.goods_currency),
    ...Array.from(groupsById.values()).map((group) => group.freight_currency),
  ]
  const { snapshot, targetCurrency } = await ensureSnapshotRates(conn, scenario, fxCurrencies)

  const freightByCoverageLineId = new Map()
  const shipmentGroupLineIdByCoverageLineId = new Map()
  groupRows.forEach((row) => {
    const coverageOptionLineId = Number(row.coverage_option_line_id || 0)
    const shipmentGroupLineId = Number(row.shipment_group_line_id || 0)
    if (coverageOptionLineId && shipmentGroupLineId) {
      shipmentGroupLineIdByCoverageLineId.set(coverageOptionLineId, shipmentGroupLineId)
    }
  })
  for (const group of groupsById.values()) {
    const activeLines = group.lines.filter((line) => Number(line.included || 0) === 1)
    if (!activeLines.length) continue

    const totalWeight = sumNums(activeLines.map((line) => line.weight_allocated_kg))
    let freightTotal = numOrNull(group.freight_total) || 0
    if (String(group.freight_input_mode || 'TOTAL') === 'PER_KG') {
      freightTotal = (numOrNull(group.freight_rate_per_kg) || 0) * (numOrNull(group.total_weight_kg) || totalWeight || 0)
    }
    freightTotal = convertWithSnapshot(
      freightTotal,
      textOrNull(group.freight_currency) || targetCurrency,
      targetCurrency,
      snapshot
    ) || 0
    const useWeight = totalWeight > 0
    const equalShare = freightTotal / activeLines.length

    for (const line of activeLines) {
      const weight = numOrNull(line.weight_allocated_kg) || 0
      const freightAllocated = useWeight ? (freightTotal * weight) / totalWeight : equalShare
      freightByCoverageLineId.set(Number(line.coverage_option_line_id), freightAllocated)
      await conn.execute(
        `UPDATE rfq_shipment_group_lines
            SET freight_allocated = ?, duty_allocated = 0
          WHERE id = ?`,
        [freightAllocated, line.shipment_group_line_id]
      )
    }
  }

  let goodsTotal = 0
  let freightTotal = 0
  let dutyTotal = 0
  let otherTotal = 0
  let landedTotal = 0
  let coverageCount = 0
  let pricedCount = 0
  let oemOk = true
  const scenarioWarnings = new Set()

  await conn.execute(
    `DELETE c FROM rfq_scenario_line_costs c
      JOIN rfq_scenario_lines sl ON sl.id = c.scenario_line_id
     WHERE sl.scenario_id = ?`,
    [scenarioId]
  )

  for (const scenarioLine of scenarioLines) {
    const optionCoverageLines = coverageLinesByOption.get(Number(scenarioLine.coverage_option_id)) || []
    const lineWarnings = new Set()
    const dutyByCoverageLineId = new Map()
    const goodsAmount = sumNums(optionCoverageLines.map((line) => {
      const converted = convertWithSnapshotMeta(
        line.goods_amount,
        textOrNull(line.goods_currency) || targetCurrency,
        targetCurrency,
        snapshot
      )
      if (converted.missingRate) lineWarnings.add('missing_fx_rate')
      return converted.amount
    }))
    const freightAmount = sumNums(optionCoverageLines.map((line) => freightByCoverageLineId.get(Number(line.id)) || 0))
    const dutyAmount = sumNums(optionCoverageLines.map((line) => {
      const originCountry = getLineOriginCountry(line)
      const tnvedCodeId = getLineTnvedCodeId(line)
      const tnvedCode = getLineTnvedCode(line)
      const dutyRatePct = getLineDutyRatePct(line)

      if (!originCountry) lineWarnings.add('missing_origin_country')
      if (!getLineIncoterms(line)) lineWarnings.add('missing_incoterms')
      if (getLineIncoterms(line) && !getLineIncotermsPlace(line)) lineWarnings.add('missing_incoterms_place')
      if (!numOrNull(line.weight_kg)) lineWarnings.add('missing_weight')
      if (!numOrNull(line.lead_time_days)) lineWarnings.add('missing_lead_time')
      if (!tnvedCodeId && !tnvedCode) lineWarnings.add('missing_tnved')
      if ((tnvedCodeId || tnvedCode) && dutyRatePct === null) lineWarnings.add('missing_duty_rate')

      const convertedGoods = convertWithSnapshotMeta(
        line.goods_amount,
        textOrNull(line.goods_currency) || targetCurrency,
        targetCurrency,
        snapshot
      )
      if (convertedGoods.missingRate) lineWarnings.add('missing_fx_rate')
      if (convertedGoods.amount === null || dutyRatePct === null || dutyRatePct <= 0) {
        dutyByCoverageLineId.set(Number(line.id), 0)
        return 0
      }
      const dutyValue = convertedGoods.amount * (dutyRatePct / 100)
      dutyByCoverageLineId.set(Number(line.id), dutyValue)
      return dutyValue
    }))
    const otherAmount = 0
    const landedAmount = goodsAmount + freightAmount + dutyAmount + otherAmount
    const currency = targetCurrency
    const etaDays = optionCoverageLines
      .map((line) => numOrNull(line.lead_time_days))
      .filter((value) => value !== null)
      .reduce((max, value) => Math.max(max, value), 0)
    const dutyRates = uniqueValues(optionCoverageLines.map((line) => getLineDutyRatePct(line)))
    if (dutyRates.length > 1) lineWarnings.add('mixed_duty_rates')
    lineWarnings.forEach((warning) => scenarioWarnings.add(warning))

    for (const [coverageOptionLineId, dutyAllocated] of dutyByCoverageLineId.entries()) {
      const shipmentGroupLineId = shipmentGroupLineIdByCoverageLineId.get(coverageOptionLineId)
      if (!shipmentGroupLineId) continue
      await conn.execute(
        `UPDATE rfq_shipment_group_lines
            SET duty_allocated = ?
          WHERE id = ?`,
        [dutyAllocated || 0, shipmentGroupLineId]
      )
    }

    await conn.execute(
      `INSERT INTO rfq_scenario_line_costs
        (scenario_line_id, goods_amount, freight_amount, duty_amount, other_amount, landed_amount,
         currency, eta_days, warning_json)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         goods_amount = VALUES(goods_amount),
         freight_amount = VALUES(freight_amount),
         duty_amount = VALUES(duty_amount),
         other_amount = VALUES(other_amount),
         landed_amount = VALUES(landed_amount),
         currency = VALUES(currency),
         eta_days = VALUES(eta_days),
         warning_json = VALUES(warning_json)`,
      [
        scenarioLine.id,
        goodsAmount || null,
        freightAmount || null,
        dutyAmount || null,
        otherAmount || null,
        landedAmount || null,
        currency,
        etaDays || null,
        JSON.stringify(Array.from(lineWarnings)),
      ]
    )

    goodsTotal += goodsAmount
    freightTotal += freightAmount
    dutyTotal += dutyAmount
    otherTotal += otherAmount
    landedTotal += landedAmount
    if (numOrNull(scenarioLine.completeness_pct) >= 100) coverageCount += 1
    if (numOrNull(scenarioLine.priced_pct) >= 100) pricedCount += 1
    if (!Number(scenarioLine.is_oem_ok || 0)) oemOk = false
  }

  const [etaRows] = await conn.execute(
    `SELECT MIN(NULLIF(eta_min_days, 0)) AS eta_min_days,
            MAX(NULLIF(eta_max_days, 0)) AS eta_max_days
       FROM rfq_shipment_groups
      WHERE scenario_id = ?`,
    [scenarioId]
  )
  const etaMin = numOrNull(etaRows?.[0]?.eta_min_days)
  const etaMax = numOrNull(etaRows?.[0]?.eta_max_days)
  const lineCount = scenarioLines.length || 1

  await conn.execute(
    `UPDATE rfq_scenarios
        SET status = 'CALCULATED',
            goods_total = ?,
            freight_total = ?,
            duty_total = ?,
            other_total = ?,
            landed_total = ?,
            coverage_pct = ?,
            priced_pct = ?,
            is_oem_ok = ?,
            eta_min_days = ?,
            eta_max_days = ?,
            warning_json = ?
      WHERE id = ?`,
    [
      goodsTotal || null,
      freightTotal || null,
      dutyTotal || null,
      otherTotal || null,
      landedTotal || null,
      Math.round((coverageCount / lineCount) * 100),
      Math.round((pricedCount / lineCount) * 100),
      oemOk ? 1 : 0,
      etaMin,
      etaMax,
      JSON.stringify(Array.from(scenarioWarnings)),
      scenarioId,
    ]
  )

  const [[updated]] = await conn.execute('SELECT * FROM rfq_scenarios WHERE id = ?', [scenarioId])
  return updated
}

router.get('/rfq/:rfqId/coverage-options', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    if (!rfqId) return res.status(400).json({ message: 'Не выбран RFQ' })

    const [rows] = await db.execute(
      `SELECT o.*,
              i.line_number,
              cri.client_part_number,
              cri.client_description,
              cri.oem_part_id AS original_part_id,
              op.part_number AS original_cat_number,
              COUNT(l.id) AS line_count
         FROM rfq_coverage_options o
         JOIN rfq_items i ON i.id = o.rfq_item_id
         JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
         LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
         LEFT JOIN rfq_coverage_option_lines l ON l.coverage_option_id = o.id
        WHERE o.rfq_id = ?
        GROUP BY o.id
        ORDER BY i.line_number ASC, o.option_kind ASC, o.id ASC`,
      [rfqId]
    )
    const optionIds = rows.map((row) => Number(row.id || 0)).filter(Boolean)
    const lines = await loadCoverageLinesByOptionIds(db, optionIds)
    const linesByOption = new Map()
    lines.forEach((line) => {
      const optionId = Number(line.coverage_option_id || 0)
      if (!optionId) return
      const bucket = linesByOption.get(optionId) || []
      bucket.push(line)
      linesByOption.set(optionId, bucket)
    })

    const enrichedRows = rows.map((row) => ({
      ...row,
      lines: linesByOption.get(Number(row.id || 0)) || [],
    }))
    res.json({ rows: enrichedRows })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/coverage-options error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/rfq/:rfqId/dashboard', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    if (!rfqId) return res.status(400).json({ message: 'Не выбран RFQ' })
    const [scenarios] = await db.execute(
      `SELECT *
         FROM rfq_scenarios
        WHERE rfq_id = ?
        ORDER BY id DESC`,
      [rfqId]
    )
    const latestScenarioId = Number(scenarios?.[0]?.id || 0) || null
    let latestScenarioLines = []
    if (latestScenarioId) {
      const [rows] = await db.execute(
        `SELECT sl.id AS scenario_line_id,
                sl.rfq_item_id,
                c.goods_amount,
                c.freight_amount,
                c.duty_amount,
                c.landed_amount,
                c.currency
           FROM rfq_scenario_lines sl
           LEFT JOIN rfq_scenario_line_costs c ON c.scenario_line_id = sl.id
          WHERE sl.scenario_id = ?
          ORDER BY sl.id ASC`,
        [latestScenarioId]
      )
      latestScenarioLines = rows
    }
    res.json({
      suppliers: [],
      lines: [],
      scenarios,
      latest_scenario_lines: latestScenarioLines,
      latest_scenario_name: scenarios?.[0]?.name || null,
      target_currency: scenarios?.[0]?.calc_currency || 'USD',
    })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/dashboard error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/rfq/:rfqId/scenarios', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    if (!rfqId) return res.status(400).json({ message: 'Не выбран RFQ' })
    const [rows] = await db.execute(
      `SELECT *
         FROM rfq_scenarios
        WHERE rfq_id = ?
        ORDER BY id DESC`,
      [rfqId]
    )
    res.json({ rows })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/scenarios error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/rfq/:rfqId/scenarios', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const name = textOrNull(req.body?.name) || 'Сценарий'
  const basis = textOrNull(req.body?.basis) || 'MANUAL'
  const calcCurrency = textOrNull(req.body?.calc_currency) || 'USD'
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (!rfqId) return res.status(400).json({ message: 'Не выбран RFQ' })
  if (!items.length) return res.status(400).json({ message: 'Нужно выбрать варианты покрытия по строкам RFQ' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const withFxSnapshot = await supportsScenarioFxSnapshot(conn)
    const insertSql = withFxSnapshot
      ? `INSERT INTO rfq_scenarios
          (rfq_id, name, basis, status, calc_currency, fx_as_of, fx_snapshot_json, created_by_user_id, updated_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?)`
      : `INSERT INTO rfq_scenarios
          (rfq_id, name, basis, status, calc_currency, created_by_user_id, updated_by_user_id)
         VALUES (?,?,?,?,?,?,?)`
    const insertParams = withFxSnapshot
      ? [rfqId, name, basis, 'DRAFT', calcCurrency, null, null, toId(req.user?.id), toId(req.user?.id)]
      : [rfqId, name, basis, 'DRAFT', calcCurrency, toId(req.user?.id), toId(req.user?.id)]
    const [insertScenario] = await conn.execute(insertSql, insertParams)
    const scenarioId = insertScenario.insertId

    for (const item of items) {
      const rfqItemId = toId(item?.rfq_item_id)
      const coverageOptionId = toId(item?.coverage_option_id)
      if (!rfqItemId || !coverageOptionId) continue
      await conn.execute(
        `INSERT INTO rfq_scenario_lines (scenario_id, rfq_item_id, coverage_option_id, decision_status, note)
         VALUES (?,?,?,?,?)`,
        [scenarioId, rfqItemId, coverageOptionId, 'SELECTED', textOrNull(item?.note)]
      )
    }

    await calculateScenario(conn, rfqId, scenarioId)

    await conn.commit()
    const [[created]] = await db.execute('SELECT * FROM rfq_scenarios WHERE id = ?', [scenarioId])
    res.status(201).json({ message: 'Сценарий создан', row: created })
  } catch (e) {
    await conn.rollback()
    console.error('POST /economics/rfq/:rfqId/scenarios error:', e)
    res.status(500).json({ message: 'Ошибка создания сценария' })
  } finally {
    conn.release()
  }
})

router.delete('/rfq/:rfqId/scenarios/:scenarioId', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
    if (!scenario) {
      throw Object.assign(new Error('Сценарий не найден'), { statusCode: 404 })
    }

    const [[selectionUsage]] = await conn.execute(
      `SELECT COUNT(*) AS cnt
         FROM selections
        WHERE scenario_id = ?`,
      [scenarioId]
    )

    if (Number(selectionUsage?.cnt || 0) > 0) {
      throw Object.assign(
        new Error('Сценарий уже использован во вкладке «Выбор» и не может быть удалён'),
        { statusCode: 409 }
      )
    }

    await conn.execute('DELETE FROM rfq_scenarios WHERE id = ? AND rfq_id = ?', [scenarioId, rfqId])

    await conn.commit()
    res.json({ message: 'Сценарий удалён' })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /economics/rfq/:rfqId/scenarios/:scenarioId error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка удаления сценария' })
  } finally {
    conn.release()
  }
})

router.put('/rfq/:rfqId/scenarios/:scenarioId/lines', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  if (!items.length) return res.status(400).json({ message: 'Нужно передать строки сценария' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
    if (!scenario) {
      throw Object.assign(new Error('Сценарий не найден'), { statusCode: 404 })
    }

    await conn.execute('DELETE FROM rfq_scenario_lines WHERE scenario_id = ?', [scenarioId])

    for (const item of items) {
      const rfqItemId = toId(item?.rfq_item_id)
      const coverageOptionId = toId(item?.coverage_option_id)
      if (!rfqItemId || !coverageOptionId) continue
      await conn.execute(
        `INSERT INTO rfq_scenario_lines (scenario_id, rfq_item_id, coverage_option_id, decision_status, note)
         VALUES (?,?,?,?,?)`,
        [scenarioId, rfqItemId, coverageOptionId, 'SELECTED', textOrNull(item?.note)]
      )
    }

    await conn.execute(
      `UPDATE rfq_scenarios
          SET status = 'DRAFT',
              calc_currency = COALESCE(?, calc_currency),
              updated_by_user_id = ?
        WHERE id = ?`,
      [textOrNull(req.body?.calc_currency), toId(req.user?.id), scenarioId]
    )

    await calculateScenario(conn, rfqId, scenarioId)

    await conn.commit()
    res.json({ message: 'Состав сценария обновлён' })
  } catch (e) {
    await conn.rollback()
    console.error('PUT /economics/rfq/:rfqId/scenarios/:scenarioId/lines error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка обновления сценария' })
  } finally {
    conn.release()
  }
})

router.get('/rfq/:rfqId/scenarios/:scenarioId', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    const scenarioId = toId(req.params.scenarioId)
    if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const conn = await db.getConnection()
    try {
      const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
      if (!scenario) return res.status(404).json({ message: 'Сценарий не найден' })
      scenario.warning_json = parseWarningJson(scenario.warning_json)

      const lines = await loadScenarioLines(conn, scenarioId)
      const optionIds = lines.map((line) => Number(line?.coverage_option_id || 0)).filter(Boolean)
      const optionLines = await loadCoverageLinesByOptionIds(conn, optionIds)
      const optionLinesByOption = new Map()
      optionLines.forEach((line) => {
        const optionId = Number(line.coverage_option_id || 0)
        const bucket = optionLinesByOption.get(optionId) || []
        bucket.push(line)
        optionLinesByOption.set(optionId, bucket)
      })
      const [costs] = await conn.execute(
        `SELECT c.*, sl.rfq_item_id
           FROM rfq_scenario_line_costs c
           JOIN rfq_scenario_lines sl ON sl.id = c.scenario_line_id
          WHERE sl.scenario_id = ?`,
        [scenarioId]
      )
      const costByLine = new Map(costs.map((row) => [Number(row.scenario_line_id), row]))
      res.json({
        scenario,
        lines: lines.map((line) => ({
          ...line,
          option_lines: optionLinesByOption.get(Number(line.coverage_option_id || 0)) || [],
          costs: costByLine.get(Number(line.id))
            ? {
                ...costByLine.get(Number(line.id)),
                warning_json: parseWarningJson(costByLine.get(Number(line.id)).warning_json),
              }
            : null,
        })),
      })
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/scenarios/:scenarioId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/rfq/:rfqId/scenarios/:scenarioId/shipment-groups/auto', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const rows = await buildShipmentGroupsForScenario(conn, rfqId, scenarioId, toId(req.user?.id))
    await conn.execute(
      `UPDATE rfq_scenarios
          SET status = 'LOGISTICS_READY',
              updated_by_user_id = ?
        WHERE id = ?`,
      [toId(req.user?.id), scenarioId]
    )
    await conn.commit()
    res.json({ message: 'Группы поставки созданы', rows })
  } catch (e) {
    await conn.rollback()
    console.error('POST /economics/rfq/:rfqId/scenarios/:scenarioId/shipment-groups/auto error:', e)
    res.status(500).json({ message: 'Ошибка создания shipment groups' })
  } finally {
    conn.release()
  }
})

router.get('/rfq/:rfqId/scenarios/:scenarioId/shipment-groups', async (req, res) => {
  try {
    const scenarioId = toId(req.params.scenarioId)
    if (!scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const rows = await loadShipmentGroupDetails(db, scenarioId)
    res.json({ rows })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/scenarios/:scenarioId/shipment-groups error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/rfq/:rfqId/scenarios/:scenarioId/route-catalogs', async (req, res) => {
  try {
    const scenarioId = toId(req.params.scenarioId)
    if (!scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [[scenario]] = await db.execute('SELECT id FROM rfq_scenarios WHERE id = ?', [scenarioId])
    if (!scenario) return res.status(404).json({ message: 'Сценарий не найден' })

    const [templates] = await Promise.all([
      db.execute(
        `SELECT rt.id,
                rt.name,
                rt.code,
                rt.corridor_id,
                rt.pricing_model,
                rt.currency,
                rt.eta_min_days,
                rt.eta_max_days,
                c.name AS corridor_name,
                c.origin_country,
                c.destination_country,
                c.transport_mode
           FROM logistics_route_templates rt
           LEFT JOIN logistics_corridors c ON c.id = rt.corridor_id
          WHERE rt.is_active = 1
          ORDER BY rt.name ASC, rt.id ASC`
      ),
    ])

    res.json({
      templates: templates[0] || [],
    })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/scenarios/:scenarioId/route-catalogs error:', e)
    res.status(500).json({ message: 'Ошибка загрузки шаблонов доставки' })
  }
})

router.get('/rfq/:rfqId/scenarios/:scenarioId/group-routes', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
    if (!scenario) return res.status(404).json({ message: 'Сценарий не найден' })

    await bootstrapShipmentGroupRoutes(conn, scenarioId, req.user?.id)

    const [rows] = await conn.execute(
      `SELECT r.*,
              g.name AS shipment_group_name,
              g.group_code AS shipment_group_code,
              g.total_weight_kg AS weight_kg,
              g.total_volume_cbm AS volume_cbm,
              g.from_country,
              g.to_country,
              rt.name AS route_template_name,
              rt.corridor_id AS template_corridor_id,
              rt.pricing_model AS template_pricing_model,
              rt.currency AS template_currency,
              rt.fixed_cost AS template_fixed_cost,
              rt.rate_per_kg AS template_rate_per_kg,
              rt.rate_per_cbm AS template_rate_per_cbm,
              rt.min_cost AS template_min_cost,
              rt.markup_pct AS template_markup_pct,
              rt.markup_fixed AS template_markup_fixed,
              rt.eta_min_days AS template_eta_min_days,
              rt.eta_max_days AS template_eta_max_days,
              c.name AS corridor_name,
              c.origin_country AS corridor_origin_country,
              c.destination_country AS corridor_destination_country,
              c.transport_mode
         FROM rfq_shipment_group_routes r
         JOIN rfq_shipment_groups g ON g.id = r.shipment_group_id
         LEFT JOIN logistics_route_templates rt ON rt.id = r.route_template_id
         LEFT JOIN logistics_corridors c ON c.id = COALESCE(r.corridor_id, rt.corridor_id)
        WHERE g.scenario_id = ?
        ORDER BY g.id ASC, r.selected_for_scenario DESC, r.id ASC`,
      [scenarioId]
    )

    const enriched = rows.map((row) => {
      const calc = buildRouteCalc(row, row)
      return {
        ...row,
        route_payload_json: parseJsonObject(row.route_payload_json),
        logistics_amount_calc: calc.logisticsAmount,
        calc_status: calc.calcStatus,
        warning_json: calc.warnings,
        corridor_id: calc.corridorId || toId(row.corridor_id),
        currency_snapshot: calc.currency || row.currency_snapshot,
        pricing_model_snapshot: calc.pricingModel || row.pricing_model_snapshot,
        eta_min_days_calc: calc.etaMin,
        eta_max_days_calc: calc.etaMax,
      }
    })
    res.json({ rows: enriched })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/scenarios/:scenarioId/group-routes error:', e)
    res.status(500).json({ message: 'Ошибка загрузки вариантов доставки групп' })
  } finally {
    conn.release()
  }
})

router.post('/shipment-groups/:groupId/routes/draft', async (req, res) => {
  const groupId = toId(req.params.groupId)
  if (!groupId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  try {
    const [[group]] = await db.execute('SELECT * FROM rfq_shipment_groups WHERE id = ?', [groupId])
    if (!group) return res.status(404).json({ message: 'Группа не найдена' })
    const [inserted] = await db.execute(
      `INSERT INTO rfq_shipment_group_routes
        (shipment_group_id, route_source_type, route_name_snapshot, calc_status, created_by_user_id, updated_by_user_id)
       VALUES (?,?,?,?,?,?)`,
      [groupId, 'adhoc', 'Черновой вариант доставки', 'draft', toId(req.user?.id), toId(req.user?.id)]
    )
    res.status(201).json({ id: inserted.insertId })
  } catch (e) {
    console.error('POST /economics/shipment-groups/:groupId/routes/draft error:', e)
    res.status(500).json({ message: 'Ошибка создания чернового варианта доставки' })
  }
})

router.put('/shipment-group-routes/:routeId/template', async (req, res) => {
  const routeId = toId(req.params.routeId)
  const routeTemplateId = toId(req.body?.route_template_id)
  if (!routeId || !routeTemplateId) return res.status(400).json({ message: 'Некорректные параметры варианта доставки' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[route]] = await conn.execute(
      `SELECT r.*, g.total_weight_kg, g.total_volume_cbm, g.from_country, g.to_country
         FROM rfq_shipment_group_routes r
         JOIN rfq_shipment_groups g ON g.id = r.shipment_group_id
        WHERE r.id = ?`,
      [routeId]
    )
    if (!route) throw Object.assign(new Error('Вариант доставки не найден'), { statusCode: 404 })

    const [[template]] = await conn.execute(
      `SELECT rt.*, c.transport_mode
         FROM logistics_route_templates rt
         LEFT JOIN logistics_corridors c ON c.id = rt.corridor_id
        WHERE rt.id = ? AND rt.is_active = 1`,
      [routeTemplateId]
    )
    if (!template) throw Object.assign(new Error('Шаблон доставки не найден'), { statusCode: 404 })

    const calc = buildRouteCalc(
      {
        route_template_id: template.id,
        template_corridor_id: template.corridor_id,
        template_pricing_model: template.pricing_model,
        template_currency: template.currency,
        template_fixed_cost: template.fixed_cost,
        template_rate_per_kg: template.rate_per_kg,
        template_rate_per_cbm: template.rate_per_cbm,
        template_min_cost: template.min_cost,
        template_markup_pct: template.markup_pct,
        template_markup_fixed: template.markup_fixed,
        template_eta_min_days: template.eta_min_days,
        template_eta_max_days: template.eta_max_days,
      },
      route
    )

    await conn.execute(
      `UPDATE rfq_shipment_group_routes
          SET route_source_type = 'template',
              route_template_id = ?,
              corridor_id = ?,
              route_name_snapshot = ?,
              pricing_model_snapshot = ?,
              currency_snapshot = ?,
              fixed_cost_snapshot = ?,
              rate_per_kg_snapshot = ?,
              rate_per_cbm_snapshot = ?,
              min_cost_snapshot = ?,
              markup_pct_snapshot = ?,
              markup_fixed_snapshot = ?,
              eta_min_days_snapshot = ?,
              eta_max_days_snapshot = ?,
              incoterms_baseline_snapshot = ?,
              route_payload_json = NULL,
              logistics_amount_calc = ?,
              calc_status = ?,
              warning_json = ?,
              updated_by_user_id = ?
        WHERE id = ?`,
      [
        template.id,
        template.corridor_id,
        textOrNull(template.name),
        textOrNull(template.pricing_model),
        normCurrency(template.currency),
        numOrNull(template.fixed_cost),
        numOrNull(template.rate_per_kg),
        numOrNull(template.rate_per_cbm),
        numOrNull(template.min_cost),
        numOrNull(template.markup_pct),
        numOrNull(template.markup_fixed),
        numOrNull(template.eta_min_days),
        numOrNull(template.eta_max_days),
        textOrNull(template.incoterms_baseline),
        numOrNull(calc.logisticsAmount),
        calc.calcStatus,
        JSON.stringify(calc.warnings),
        toId(req.user?.id),
        routeId,
      ]
    )

    const [[updatedRoute]] = await conn.execute('SELECT selected_for_scenario FROM rfq_shipment_group_routes WHERE id = ?', [routeId])
    if (Number(updatedRoute?.selected_for_scenario || 0) === 1) {
      await syncShipmentGroupWithSelectedRoute(conn, routeId)
    }

    await conn.commit()
    res.json({ message: 'Шаблон доставки назначен' })
  } catch (e) {
    await conn.rollback()
    console.error('PUT /economics/shipment-group-routes/:routeId/template error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка назначения шаблона доставки' })
  } finally {
    conn.release()
  }
})

router.put('/shipment-group-routes/:routeId/adhoc', async (req, res) => {
  const routeId = toId(req.params.routeId)
  if (!routeId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[route]] = await conn.execute(
      `SELECT r.*, g.total_weight_kg, g.total_volume_cbm
         FROM rfq_shipment_group_routes r
         JOIN rfq_shipment_groups g ON g.id = r.shipment_group_id
        WHERE r.id = ?`,
      [routeId]
    )
    if (!route) throw Object.assign(new Error('Вариант доставки не найден'), { statusCode: 404 })

    const corridorId = await resolveCorridorId(conn, {
      corridor_id: req.body?.corridor_id,
      origin_country: req.body?.origin_country || route.from_country,
      destination_country: req.body?.destination_country || route.to_country,
      transport_mode: req.body?.transport_mode,
    })
    if (!corridorId) throw Object.assign(new Error('Нужно указать направление доставки и транспорт'), { statusCode: 400 })
    const [[corridor]] = await conn.execute('SELECT * FROM logistics_corridors WHERE id = ?', [corridorId])
    if (!corridor) throw Object.assign(new Error('Коридор не найден'), { statusCode: 404 })

    const payload = {
      corridor_id: corridorId,
      origin_country: textOrNull(req.body?.origin_country) || textOrNull(route.from_country),
      destination_country: textOrNull(req.body?.destination_country) || textOrNull(route.to_country),
      transport_mode: normTransportMode(req.body?.transport_mode || corridor.transport_mode),
      name: textOrNull(req.body?.name),
      pricing_model: textOrNull(req.body?.pricing_model),
      currency: normCurrency(req.body?.currency),
      fixed_cost: numOrNull(req.body?.fixed_cost),
      min_cost: numOrNull(req.body?.min_cost),
      rate_per_kg: numOrNull(req.body?.rate_per_kg),
      rate_per_cbm: numOrNull(req.body?.rate_per_cbm),
      markup_pct: numOrNull(req.body?.markup_pct),
      markup_fixed: numOrNull(req.body?.markup_fixed),
      eta_min_days: numOrNull(req.body?.eta_min_days),
      eta_max_days: numOrNull(req.body?.eta_max_days),
    }

    const calc = buildRouteCalc(
      {
        corridor_id: corridorId,
        route_payload_json: payload,
        pricing_model_snapshot: payload.pricing_model,
        currency_snapshot: payload.currency,
        fixed_cost_snapshot: payload.fixed_cost,
        min_cost_snapshot: payload.min_cost,
        rate_per_kg_snapshot: payload.rate_per_kg,
        rate_per_cbm_snapshot: payload.rate_per_cbm,
        markup_pct_snapshot: payload.markup_pct,
        markup_fixed_snapshot: payload.markup_fixed,
        eta_min_days_snapshot: payload.eta_min_days,
        eta_max_days_snapshot: payload.eta_max_days,
      },
      route
    )

    await conn.execute(
      `UPDATE rfq_shipment_group_routes
          SET route_source_type = 'adhoc',
              route_template_id = NULL,
              corridor_id = ?,
              route_name_snapshot = ?,
              pricing_model_snapshot = ?,
              currency_snapshot = ?,
              fixed_cost_snapshot = ?,
              rate_per_kg_snapshot = ?,
              rate_per_cbm_snapshot = ?,
              min_cost_snapshot = ?,
              markup_pct_snapshot = ?,
              markup_fixed_snapshot = ?,
              eta_min_days_snapshot = ?,
              eta_max_days_snapshot = ?,
              route_payload_json = ?,
              logistics_amount_calc = ?,
              calc_status = ?,
              warning_json = ?,
              updated_by_user_id = ?
        WHERE id = ?`,
      [
        corridorId,
        payload.name || corridor.name || 'Ручной вариант доставки',
        payload.pricing_model,
        payload.currency,
        payload.fixed_cost,
        payload.rate_per_kg,
        payload.rate_per_cbm,
        payload.min_cost,
        payload.markup_pct,
        payload.markup_fixed,
        payload.eta_min_days,
        payload.eta_max_days,
        JSON.stringify(payload),
        numOrNull(calc.logisticsAmount),
        calc.calcStatus,
        JSON.stringify(calc.warnings),
        toId(req.user?.id),
        routeId,
      ]
    )

    const [[updatedRoute]] = await conn.execute('SELECT selected_for_scenario FROM rfq_shipment_group_routes WHERE id = ?', [routeId])
    if (Number(updatedRoute?.selected_for_scenario || 0) === 1) {
      await syncShipmentGroupWithSelectedRoute(conn, routeId)
    }

    await conn.commit()
    res.json({ message: 'Ручной вариант доставки сохранен' })
  } catch (e) {
    await conn.rollback()
    console.error('PUT /economics/shipment-group-routes/:routeId/adhoc error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка сохранения ручного варианта доставки' })
  } finally {
    conn.release()
  }
})

router.patch('/shipment-group-routes/:routeId/selected', async (req, res) => {
  const routeId = toId(req.params.routeId)
  const selected = Number(req.body?.selected) === 1 || req.body?.selected === true
  if (!routeId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[route]] = await conn.execute('SELECT * FROM rfq_shipment_group_routes WHERE id = ?', [routeId])
    if (!route) throw Object.assign(new Error('Вариант доставки не найден'), { statusCode: 404 })

    if (selected) {
      await conn.execute(
        'UPDATE rfq_shipment_group_routes SET selected_for_scenario = 0, updated_by_user_id = ? WHERE shipment_group_id = ?',
        [toId(req.user?.id), route.shipment_group_id]
      )
    }

    await conn.execute(
      'UPDATE rfq_shipment_group_routes SET selected_for_scenario = ?, updated_by_user_id = ? WHERE id = ?',
      [selected ? 1 : 0, toId(req.user?.id), routeId]
    )

    if (selected) {
      await syncShipmentGroupWithSelectedRoute(conn, routeId)
    }

    await conn.commit()
    res.json({ message: selected ? 'Вариант доставки выбран для сценария' : 'Вариант доставки снят с выбора' })
  } catch (e) {
    await conn.rollback()
    console.error('PATCH /economics/shipment-group-routes/:routeId/selected error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка выбора варианта доставки' })
  } finally {
    conn.release()
  }
})

router.get('/rfq/:rfqId/scenarios/:scenarioId/shipment-line-pool', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    const scenarioId = toId(req.params.scenarioId)
    const groupId = toId(req.query.group_id)
    if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const scenario = await loadScenarioHeader(db, rfqId, scenarioId)
    if (!scenario) return res.status(404).json({ message: 'Сценарий не найден' })

    const rows = await loadScenarioCoverageLinePool(db, scenarioId)
  const filtered = rows.filter((row) => {
      const assignedGroupId = toId(row.assigned_group_id)
      return !assignedGroupId || assignedGroupId === groupId
    })
    res.json({ rows: filtered })
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/scenarios/:scenarioId/shipment-line-pool error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.patch('/shipment-groups/:groupId', async (req, res) => {
  try {
    const groupId = toId(req.params.groupId)
    if (!groupId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    await db.execute(
      `UPDATE rfq_shipment_groups
          SET name = COALESCE(?, name),
              route_type = COALESCE(?, route_type),
              incoterms = ?,
              incoterms_place = ?,
              readiness_date = ?,
              freight_input_mode = COALESCE(?, freight_input_mode),
              freight_total = ?,
              freight_currency = ?,
              freight_rate_per_kg = ?,
              eta_min_days = ?,
              eta_max_days = ?,
              source_note = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [
        textOrNull(req.body?.name),
        textOrNull(req.body?.route_type),
        textOrNull(req.body?.incoterms),
        textOrNull(req.body?.incoterms_place),
        textOrNull(req.body?.readiness_date),
        textOrNull(req.body?.freight_input_mode),
        numOrNull(req.body?.freight_total),
        textOrNull(req.body?.freight_currency),
        numOrNull(req.body?.freight_rate_per_kg),
        numOrNull(req.body?.eta_min_days),
        numOrNull(req.body?.eta_max_days),
        textOrNull(req.body?.source_note),
        groupId,
      ]
    )
    const [[updated]] = await db.execute('SELECT * FROM rfq_shipment_groups WHERE id = ?', [groupId])
    res.json({ message: 'Группа обновлена', row: updated })
  } catch (e) {
    console.error('PATCH /economics/shipment-groups/:groupId error:', e)
    res.status(500).json({ message: 'Ошибка обновления группы' })
  }
})

router.post('/rfq/:rfqId/scenarios/:scenarioId/shipment-groups', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
    if (!scenario) {
      throw Object.assign(new Error('Сценарий не найден'), { statusCode: 404 })
    }

    const [insertGroup] = await conn.execute(
      `INSERT INTO rfq_shipment_groups
        (scenario_id, group_code, name, status, consolidation_mode, supplier_id,
         from_country, from_city, to_country, to_city, route_type, incoterms, incoterms_place,
         readiness_date, total_weight_kg, total_volume_cbm, freight_input_mode,
         freight_total, freight_currency, freight_rate_per_kg, eta_min_days, eta_max_days,
         entered_by_user_id, source_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        scenarioId,
        textOrNull(req.body?.group_code) || `MANUAL-${scenarioId}-${Date.now()}`,
        textOrNull(req.body?.name) || 'Ручная группа',
        'DRAFT',
        textOrNull(req.body?.consolidation_mode) || 'MANUAL',
        toId(req.body?.supplier_id),
        textOrNull(req.body?.from_country),
        textOrNull(req.body?.from_city),
        textOrNull(req.body?.to_country),
        textOrNull(req.body?.to_city),
        textOrNull(req.body?.route_type) || 'MANUAL',
        textOrNull(req.body?.incoterms),
        textOrNull(req.body?.incoterms_place),
        textOrNull(req.body?.readiness_date),
        numOrNull(req.body?.total_weight_kg),
        numOrNull(req.body?.total_volume_cbm),
        textOrNull(req.body?.freight_input_mode) || 'TOTAL',
        numOrNull(req.body?.freight_total),
        textOrNull(req.body?.freight_currency) || 'USD',
        numOrNull(req.body?.freight_rate_per_kg),
        numOrNull(req.body?.eta_min_days),
        numOrNull(req.body?.eta_max_days),
        toId(req.user?.id),
        textOrNull(req.body?.source_note),
      ]
    )

    const groupId = insertGroup.insertId
    await conn.execute(
      `UPDATE rfq_scenarios
          SET status = 'LOGISTICS_READY',
              updated_by_user_id = ?
        WHERE id = ?`,
      [toId(req.user?.id), scenarioId]
    )
    await conn.commit()

    const rows = await loadShipmentGroupDetails(db, scenarioId, groupId)
    res.status(201).json({ message: 'Ручная группа создана', row: rows[0] || null })
  } catch (e) {
    await conn.rollback()
    console.error('POST /economics/rfq/:rfqId/scenarios/:scenarioId/shipment-groups error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка создания группы' })
  } finally {
    conn.release()
  }
})

router.put('/shipment-groups/:groupId/lines', async (req, res) => {
  const groupId = toId(req.params.groupId)
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : []
  if (!groupId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[group]] = await conn.execute('SELECT * FROM rfq_shipment_groups WHERE id = ?', [groupId])
    if (!group) {
      throw Object.assign(new Error('Группа не найдена'), { statusCode: 404 })
    }

    const pool = await loadScenarioCoverageLinePool(conn, Number(group.scenario_id))
    const poolMap = new Map(pool.map((row) => [Number(row.id), row]))

    for (const line of lines) {
      const coverageOptionLineId = toId(line?.coverage_option_line_id)
      if (!coverageOptionLineId) continue
      const poolLine = poolMap.get(coverageOptionLineId)
      if (!poolLine) {
        throw Object.assign(new Error(`Строка ${coverageOptionLineId} не принадлежит сценарию`), { statusCode: 400 })
      }
      const assignedGroupId = toId(poolLine.assigned_group_id)
      if (assignedGroupId && assignedGroupId !== groupId) {
        throw Object.assign(new Error(`Строка ${coverageOptionLineId} уже привязана к другой группе`), { statusCode: 400 })
      }
    }

    await conn.execute('DELETE FROM rfq_shipment_group_lines WHERE shipment_group_id = ?', [groupId])

    for (const line of lines) {
      const coverageOptionLineId = toId(line?.coverage_option_line_id)
      if (!coverageOptionLineId) continue
      const poolLine = poolMap.get(coverageOptionLineId)
      await conn.execute(
        `INSERT INTO rfq_shipment_group_lines
          (shipment_group_id, coverage_option_line_id, qty_allocated, weight_allocated_kg, freight_allocated, duty_allocated, included)
         VALUES (?,?,?,?,?,?,?)`,
        [
          groupId,
          coverageOptionLineId,
          numOrNull(line?.qty_allocated) ?? numOrNull(poolLine?.qty),
          numOrNull(line?.weight_allocated_kg) ?? numOrNull(poolLine?.weight_kg),
          numOrNull(line?.freight_allocated),
          numOrNull(line?.duty_allocated),
          Number(line?.included) === 0 ? 0 : 1,
        ]
      )
    }

    await conn.execute(
      `UPDATE rfq_shipment_groups g
          SET total_weight_kg = (
                SELECT NULLIF(SUM(COALESCE(gl.weight_allocated_kg, 0)), 0)
                  FROM rfq_shipment_group_lines gl
                 WHERE gl.shipment_group_id = g.id
                   AND gl.included = 1
              ),
              source_note = ?,
              updated_at = NOW()
        WHERE g.id = ?`,
      [
        (() => {
          const selectedLines = lines
            .map((line) => poolMap.get(toId(line?.coverage_option_line_id)))
            .filter(Boolean)
          const warnings = buildShipmentGroupCompatibilityWarnings(selectedLines)
          return warnings.length ? `Предупреждения: ${warnings.join(', ')}` : null
        })(),
        groupId,
      ]
    )

    await conn.commit()
    const rows = await loadShipmentGroupDetails(db, Number(group.scenario_id), groupId)
    res.json({ message: 'Состав группы обновлён', row: rows[0] || null })
  } catch (e) {
    await conn.rollback()
    console.error('PUT /economics/shipment-groups/:groupId/lines error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка обновления состава группы' })
  } finally {
    conn.release()
  }
})

router.post('/rfq/:rfqId/scenarios/:scenarioId/calculate', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const row = await calculateScenario(conn, rfqId, scenarioId)
    await conn.commit()
    res.json({ message: 'Сценарий пересчитан', row })
  } catch (e) {
    await conn.rollback()
    console.error('POST /economics/rfq/:rfqId/scenarios/:scenarioId/calculate error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка расчета сценария' })
  } finally {
    conn.release()
  }
})

router.get('/rfq/:rfqId/scenarios/:scenarioId/economics', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    const scenarioId = toId(req.params.scenarioId)
    if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const conn = await db.getConnection()
    try {
      const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
      if (!scenario) return res.status(404).json({ message: 'Сценарий не найден' })
      scenario.warning_json = parseWarningJson(scenario.warning_json)
      const [rows] = await conn.execute(
        `SELECT sl.*,
                i.line_number,
                cri.client_part_number,
                cri.client_description,
                cri.oem_part_id AS original_part_id,
                op.part_number AS original_cat_number,
                c.goods_amount,
                c.freight_amount,
                c.duty_amount,
                c.other_amount,
                c.landed_amount,
                c.currency,
                c.eta_days,
                c.warning_json
           FROM rfq_scenario_lines sl
           JOIN rfq_items i ON i.id = sl.rfq_item_id
           JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
           LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
           LEFT JOIN rfq_scenario_line_costs c ON c.scenario_line_id = sl.id
          WHERE sl.scenario_id = ?
          ORDER BY i.line_number ASC`,
        [scenarioId]
      )
      const scenarioLines = await loadScenarioLines(conn, scenarioId)
      const optionIds = scenarioLines.map((line) => Number(line?.coverage_option_id || 0)).filter(Boolean)
      const coverageLines = await loadCoverageLinesByOptionIds(conn, optionIds)
      const coverageByOptionId = new Map()
      coverageLines.forEach((line) => {
        const optionId = Number(line.coverage_option_id || 0)
        if (!optionId) return
        const bucket = coverageByOptionId.get(optionId) || []
        bucket.push(line)
        coverageByOptionId.set(optionId, bucket)
      })
      res.json({
        scenario,
        rows: rows.map((row) => ({
          ...row,
          warning_json: parseWarningJson(row.warning_json),
          origin_source: summarizeOriginSource(coverageByOptionId.get(Number(row.coverage_option_id || 0)) || []),
          duty_source: summarizeDutySource(coverageByOptionId.get(Number(row.coverage_option_id || 0)) || []),
        })),
      })
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('GET /economics/rfq/:rfqId/scenarios/:scenarioId/economics error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/rfq/:rfqId/scenarios/:scenarioId/finalize-selection', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  const scenarioId = toId(req.params.scenarioId)
  if (!rfqId || !scenarioId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const scenario = await loadScenarioHeader(conn, rfqId, scenarioId)
    if (!scenario) {
      throw Object.assign(new Error('Сценарий не найден'), { statusCode: 404 })
    }

    const [insertSelection] = await conn.execute(
      `INSERT INTO selections
        (rfq_id, status, note, created_by_user_id, scenario_id, selected_by_user_id, selected_at,
         calc_currency, goods_total, freight_total, duty_total, other_total, landed_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rfqId,
        'approved',
        textOrNull(req.body?.note) || 'Финализировано из сценария',
        toId(req.user?.id),
        scenarioId,
        toId(req.user?.id),
        new Date(),
        textOrNull(scenario.calc_currency) || 'USD',
        numOrNull(scenario.goods_total),
        numOrNull(scenario.freight_total),
        numOrNull(scenario.duty_total),
        numOrNull(scenario.other_total),
        numOrNull(scenario.landed_total),
      ]
    )
    const selectionId = insertSelection.insertId

    const [rows] = await conn.execute(
      `SELECT sl.id AS scenario_line_id,
              sl.rfq_item_id,
              sl.coverage_option_id,
              col.id AS coverage_option_line_id,
              col.rfq_item_component_id,
              col.rfq_response_line_id,
              col.supplier_id,
              col.qty,
              col.goods_amount,
              col.goods_currency,
              col.lead_time_days,
              col.incoterms,
              col.incoterms_place,
              col.origin_country,
              ps.name AS supplier_name,
              ps.public_code AS supplier_public_code,
              cri.client_part_number,
              cri.client_description,
              op.part_number AS original_cat_number,
              sels.line_label AS supplier_display_part_number,
              sels.line_description AS supplier_display_description,
              rsp.supplier_part_number,
              opp.internal_part_number,
              opp.supplier_visible_part_number,
              opp.supplier_visible_description,
              sgl.shipment_group_id,
              sg.route_type,
              sgr.id AS shipment_group_route_id,
              sgr.route_template_id,
              sgr.corridor_id,
              sgr.route_name_snapshot,
              sgl.freight_allocated,
              sgl.duty_allocated
         FROM rfq_scenario_lines sl
         JOIN rfq_coverage_option_lines col ON col.coverage_option_id = sl.coverage_option_id
         LEFT JOIN part_suppliers ps ON ps.id = col.supplier_id
         LEFT JOIN rfq_items ri ON ri.id = sl.rfq_item_id
         LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN oem_parts op ON op.id = cri.oem_part_id
         LEFT JOIN rfq_response_lines rl ON rl.id = col.rfq_response_line_id
         LEFT JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
         LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
         LEFT JOIN rfq_supplier_line_selections sels
           ON sels.rfq_supplier_id = rsr.rfq_supplier_id
          AND sels.rfq_item_id = sl.rfq_item_id
          AND BINARY sels.selection_key = BINARY rl.selection_key
         LEFT JOIN supplier_parts rsp ON rsp.id = rl.supplier_part_id
         LEFT JOIN oem_part_presentation_profiles opp ON opp.id = rl.presentation_profile_id
         LEFT JOIN rfq_shipment_group_lines sgl
           ON sgl.coverage_option_line_id = col.id
          AND EXISTS (
                SELECT 1
                  FROM rfq_shipment_groups sgx
                 WHERE sgx.id = sgl.shipment_group_id
                   AND sgx.scenario_id = sl.scenario_id
              )
         LEFT JOIN rfq_shipment_groups sg ON sg.id = sgl.shipment_group_id
         LEFT JOIN rfq_shipment_group_routes sgr
           ON sgr.shipment_group_id = sg.id
          AND sgr.selected_for_scenario = 1
        WHERE sl.scenario_id = ?
        ORDER BY sl.id ASC, col.id ASC`,
      [scenarioId]
    )

    for (const row of rows) {
      const goodsAmount = numOrNull(row.goods_amount) || 0
      const freightAmount = numOrNull(row.freight_allocated) || 0
      const dutyAmount = numOrNull(row.duty_allocated) || 0
      const clientDisplayPartNumber = getClientFacingPartNumber(row, null)
      const clientDisplayDescription = getClientFacingDescription(row, null)
      const supplierDisplayPartNumber = getSupplierFacingPartNumber(row, null)
      const supplierDisplayDescription = getSupplierFacingDescription(row, null)
      await conn.execute(
        `INSERT INTO selection_lines
          (selection_id, rfq_item_id, rfq_item_component_id, rfq_response_line_id, qty, decision_note,
           scenario_line_id, coverage_option_id, supplier_id, shipment_group_id,
           goods_amount, freight_amount, duty_amount, other_amount, landed_amount, currency,
           supplier_name_snapshot, supplier_public_code_snapshot, route_type, incoterms, incoterms_place,
           lead_time_days, origin_country, shipment_group_route_id, route_template_id, corridor_id, route_name_snapshot,
           client_display_part_number_snapshot, client_display_description_snapshot,
           supplier_display_part_number_snapshot, supplier_display_description_snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          selectionId,
          row.rfq_item_id,
          row.rfq_item_component_id,
          row.rfq_response_line_id,
          numOrNull(row.qty) || 1,
          'Зафиксировано из утвержденного сценария',
          row.scenario_line_id,
          row.coverage_option_id,
          row.supplier_id,
          row.shipment_group_id,
          goodsAmount || null,
          freightAmount || null,
          dutyAmount || null,
          null,
          goodsAmount + freightAmount + dutyAmount || null,
          textOrNull(row.goods_currency) || textOrNull(scenario.calc_currency) || 'USD',
          textOrNull(row.supplier_name),
          textOrNull(row.supplier_public_code),
          textOrNull(row.route_type),
          textOrNull(row.incoterms),
          textOrNull(row.incoterms_place),
          numOrNull(row.lead_time_days),
          textOrNull(row.origin_country),
          toId(row.shipment_group_route_id),
          toId(row.route_template_id),
          toId(row.corridor_id),
          textOrNull(row.route_name_snapshot),
          clientDisplayPartNumber,
          clientDisplayDescription,
          supplierDisplayPartNumber,
          supplierDisplayDescription,
        ]
      )
    }

    await conn.execute(
      `UPDATE rfq_scenarios
          SET status = 'SELECTED',
              updated_by_user_id = ?
        WHERE id = ?`,
      [toId(req.user?.id), scenarioId]
    )

    const requestId = await fetchRequestIdBySelectionId(conn, selectionId)
    if (requestId) {
      await updateRequestStatus(conn, requestId, { skipPersist: false })
    }

    await conn.commit()
    res.json({ message: 'Финальный выбор создан', selection_id: selectionId })
  } catch (e) {
    await conn.rollback()
    console.error('POST /economics/rfq/:rfqId/scenarios/:scenarioId/finalize-selection error:', e)
    res.status(e?.statusCode || 500).json({ message: e?.message || 'Ошибка финализации выбора' })
  } finally {
    conn.release()
  }
})

module.exports = router
