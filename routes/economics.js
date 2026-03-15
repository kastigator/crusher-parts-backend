const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { getRate } = require('../utils/fxRatesService')
const {
  updateRequestStatus,
  fetchRequestIdBySelectionId,
} = require('../utils/clientRequestStatus')

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
  textOrNull(line?.cost_origin_country) ||
  textOrNull(line?.supplier_country)

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
            ps.country AS supplier_country,
            rl.incoterms,
            rl.incoterms_place,
            cb.origin_country AS cost_origin_country,
            cb.tnved_code_id AS cost_tnved_code_id,
            cb.tnved_code AS cost_tnved_code,
            cb.duty_rate_pct AS cost_duty_rate_pct
       FROM rfq_coverage_option_lines l
       LEFT JOIN part_suppliers ps ON ps.id = l.supplier_id
       LEFT JOIN rfq_response_lines rl ON rl.id = l.rfq_response_line_id
       LEFT JOIN vw_rfq_cost_base cb ON cb.response_line_id = l.rfq_response_line_id
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
            cb.origin_country AS cost_origin_country,
            cb.tnved_code_id AS cost_tnved_code_id,
            cb.tnved_code AS cost_tnved_code,
            cb.duty_rate_pct AS cost_duty_rate_pct,
            rl.incoterms,
            rl.incoterms_place,
            col.note AS line_note,
            ps.name AS supplier_name,
            ps.country AS supplier_country,
            i.line_number,
            cri.client_part_number,
            cri.client_description,
            cri.oem_part_id AS original_part_id,
            op.part_number AS original_cat_number
       FROM rfq_shipment_groups g
       LEFT JOIN rfq_shipment_group_lines gl ON gl.shipment_group_id = g.id
       LEFT JOIN rfq_coverage_option_lines col ON col.id = gl.coverage_option_line_id
       LEFT JOIN rfq_response_lines rl ON rl.id = col.rfq_response_line_id
       LEFT JOIN vw_rfq_cost_base cb ON cb.response_line_id = col.rfq_response_line_id
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
        origin_country: row.origin_country,
        cost_origin_country: row.cost_origin_country,
        tnved_code_id: row.cost_tnved_code_id,
        tnved_code: row.cost_tnved_code,
        duty_rate_pct: row.cost_duty_rate_pct,
        incoterms: row.incoterms,
        incoterms_place: row.incoterms_place,
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
            ps.country AS supplier_country,
            rl.incoterms,
            rl.incoterms_place,
            cb.origin_country AS cost_origin_country,
            cb.tnved_code_id AS cost_tnved_code_id,
            cb.tnved_code AS cost_tnved_code,
            cb.duty_rate_pct AS cost_duty_rate_pct,
            i.line_number,
            cri.client_part_number,
            cri.client_description,
            cri.oem_part_id AS original_part_id,
            op.part_number AS original_cat_number,
            assigned.shipment_group_id AS assigned_group_id
       FROM rfq_scenario_lines sl
       JOIN rfq_coverage_options o ON o.id = sl.coverage_option_id
       JOIN rfq_coverage_option_lines col ON col.coverage_option_id = o.id
       LEFT JOIN rfq_response_lines rl ON rl.id = col.rfq_response_line_id
       LEFT JOIN vw_rfq_cost_base cb ON cb.response_line_id = col.rfq_response_line_id
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
  if (!textOrNull(line.incoterms)) warnings.push('missing_incoterms')
  if (textOrNull(line.incoterms) && !normalizePlace(line.incoterms_place)) warnings.push('missing_incoterms_place')
  if (!numOrNull(line.weight_kg)) warnings.push('missing_weight')
  if (!numOrNull(line.lead_time_days)) warnings.push('missing_lead_time')
  if (!getLineTnvedCodeId(line) && !getLineTnvedCode(line)) warnings.push('missing_tnved')
  if (getLineTnvedCodeId(line) && getLineDutyRatePct(line) === null) warnings.push('missing_duty_rate')
  return warnings
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
    const incoterms = textOrNull(line.incoterms)
    const incotermsPlace = normalizePlace(line.incoterms_place)
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
    const dutyRates = uniqueValues(bucket.lines.map((row) => getLineDutyRatePct(row)))
    if (dutyRates.length > 1) bucket.warnings.add('mixed_duty_rates')
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
      if (!textOrNull(line.incoterms)) lineWarnings.add('missing_incoterms')
      if (textOrNull(line.incoterms) && !normalizePlace(line.incoterms_place)) lineWarnings.add('missing_incoterms_place')
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
              updated_at = NOW()
        WHERE g.id = ?`,
      [groupId]
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
      res.json({
        scenario,
        rows: rows.map((row) => ({
          ...row,
          warning_json: parseWarningJson(row.warning_json),
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
              col.origin_country,
              col.supplier_name,
              sgl.shipment_group_id,
              sgl.freight_allocated,
              sgl.duty_allocated
         FROM rfq_scenario_lines sl
         JOIN rfq_coverage_option_lines col ON col.coverage_option_id = sl.coverage_option_id
         LEFT JOIN rfq_shipment_group_lines sgl ON sgl.coverage_option_line_id = col.id
         LEFT JOIN rfq_shipment_groups sg ON sg.id = sgl.shipment_group_id AND sg.scenario_id = sl.scenario_id
        WHERE sl.scenario_id = ?
        ORDER BY sl.id ASC, col.id ASC`,
      [scenarioId]
    )

    for (const row of rows) {
      const goodsAmount = numOrNull(row.goods_amount) || 0
      const freightAmount = numOrNull(row.freight_allocated) || 0
      const dutyAmount = numOrNull(row.duty_allocated) || 0
      await conn.execute(
        `INSERT INTO selection_lines
          (selection_id, rfq_item_id, rfq_item_component_id, rfq_response_line_id, qty, decision_note,
           scenario_line_id, coverage_option_id, supplier_id, shipment_group_id,
           goods_amount, freight_amount, duty_amount, other_amount, landed_amount, currency,
           supplier_name_snapshot, route_type, origin_country)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          null,
          textOrNull(row.origin_country),
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
