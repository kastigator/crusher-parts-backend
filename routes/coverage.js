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
const numOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const textOrNull = (value) => {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s ? s : null
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

router.get('/rfq/:rfqId/options', async (req, res) => {
  try {
    const rfqId = toId(req.params.rfqId)
    if (!rfqId) {
      return res.status(400).json({ message: 'Не выбран RFQ' })
    }

    const [optionRows] = await db.execute(
      `SELECT o.*,
              i.line_number,
              cri.client_part_number,
              cri.client_description,
              op.cat_number AS original_cat_number
         FROM rfq_coverage_options o
         JOIN rfq_items i ON i.id = o.rfq_item_id
         JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE o.rfq_id = ?
        ORDER BY i.line_number ASC, o.option_kind ASC, o.id ASC`,
      [rfqId]
    )

    const optionIds = optionRows.map((row) => Number(row.id)).filter(Boolean)
    let lineRows = []
    if (optionIds.length) {
      const [rows] = await db.query(
        `SELECT l.*,
                ps.name AS supplier_name,
                sp.supplier_part_number,
                op.cat_number AS original_cat_number
           FROM rfq_coverage_option_lines l
           LEFT JOIN part_suppliers ps ON ps.id = l.supplier_id
           LEFT JOIN rfq_response_lines rl ON rl.id = l.rfq_response_line_id
           LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
           LEFT JOIN original_parts op ON op.id = l.original_part_id
          WHERE l.coverage_option_id IN (?)
          ORDER BY l.coverage_option_id ASC, l.id ASC`,
        [optionIds]
      )
      lineRows = rows
    }

    const linesByOption = new Map()
    lineRows.forEach((row) => {
      const optionId = Number(row.coverage_option_id || 0)
      if (!optionId) return
      const list = linesByOption.get(optionId) || []
      list.push(row)
      linesByOption.set(optionId, list)
    })

    const rows = optionRows.map((row) => ({
      ...row,
      lines: linesByOption.get(Number(row.id)) || [],
    }))

    res.json({ rows })
  } catch (e) {
    console.error('GET /coverage/rfq/:rfqId/options error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/rfq/:rfqId/options/replace', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  if (!rfqId) {
    return res.status(400).json({ message: 'Не выбран RFQ' })
  }

  const options = Array.isArray(req.body?.options) ? req.body.options : []
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [linkedScenarios] = await conn.execute(
      `SELECT DISTINCT sc.id, sc.name, sc.status
         FROM rfq_scenarios sc
         JOIN rfq_scenario_lines sl ON sl.scenario_id = sc.id
         JOIN rfq_coverage_options o ON o.id = sl.coverage_option_id
        WHERE o.rfq_id = ?
        ORDER BY sc.id DESC`,
      [rfqId]
    )

    if (Array.isArray(linkedScenarios) && linkedScenarios.length) {
      const scenarioList = linkedScenarios
        .map((row) => row?.name || `Сценарий #${row?.id}`)
        .join(', ')
      await conn.rollback()
      return res.status(409).json({
        message: `Нельзя пересохранить покрытие: уже существуют сценарии, завязанные на текущие варианты покрытия (${scenarioList}). Сначала пересоберите или удалите сценарии.`,
        code: 'COVERAGE_OPTIONS_IN_USE',
        scenarios: linkedScenarios,
      })
    }

    await conn.execute('DELETE FROM rfq_coverage_options WHERE rfq_id = ?', [rfqId])

    let insertedCount = 0
    for (const option of options) {
      const rfqItemId = toId(option?.rfq_item_id)
      if (!rfqItemId) continue

      const [insertOption] = await conn.execute(
        `INSERT INTO rfq_coverage_options
          (rfq_id, rfq_item_id, option_code, option_kind, coverage_status,
           completeness_pct, priced_pct, is_oem_ok, goods_total, goods_currency,
           supplier_count, lead_time_min_days, lead_time_max_days, warning_json, note, created_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          rfqId,
          rfqItemId,
          textOrNull(option?.option_code) || `OPTION-${rfqItemId}-${insertedCount + 1}`,
          textOrNull(option?.option_kind) || 'MANUAL',
          textOrNull(option?.coverage_status) || 'DRAFT',
          numOrNull(option?.completeness_pct) ?? 0,
          numOrNull(option?.priced_pct) ?? 0,
          Number(option?.is_oem_ok) ? 1 : 0,
          numOrNull(option?.goods_total),
          textOrNull(option?.goods_currency),
          Number(option?.supplier_count || 0) || 0,
          numOrNull(option?.lead_time_min_days),
          numOrNull(option?.lead_time_max_days),
          option?.warning_json ? JSON.stringify(option.warning_json) : null,
          textOrNull(option?.note),
          toId(req.user?.id),
        ]
      )

      const coverageOptionId = insertOption.insertId
      insertedCount += 1
      const lines = Array.isArray(option?.lines) ? option.lines : []
      for (const line of lines) {
        const supplierId = toId(line?.supplier_id)
        if (!supplierId) continue
        await conn.execute(
          `INSERT INTO rfq_coverage_option_lines
            (coverage_option_id, rfq_item_id, rfq_item_component_id, rfq_response_line_id, supplier_id,
             original_part_id, tnved_code_id, line_code, line_role, line_status, qty, uom,
             unit_price, goods_amount, goods_currency, weight_kg, volume_cbm, lead_time_days,
             has_price, is_oem_offer, origin_country, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            coverageOptionId,
            rfqItemId,
            toId(line?.rfq_item_component_id),
            toId(line?.rfq_response_line_id),
            supplierId,
            toId(line?.original_part_id),
            toId(line?.tnved_code_id),
            textOrNull(line?.line_code) || `LINE-${supplierId}-${coverageOptionId}`,
            textOrNull(line?.line_role) || 'MANUAL',
            textOrNull(line?.line_status) || 'CANDIDATE',
            numOrNull(line?.qty),
            textOrNull(line?.uom),
            numOrNull(line?.unit_price),
            numOrNull(line?.goods_amount),
            textOrNull(line?.goods_currency),
            numOrNull(line?.weight_kg),
            numOrNull(line?.volume_cbm),
            numOrNull(line?.lead_time_days),
            Number(line?.has_price) ? 1 : 0,
            Number(line?.is_oem_offer) ? 1 : 0,
            textOrNull(line?.origin_country),
            textOrNull(line?.note),
          ]
        )
      }
    }

    await conn.commit()
    res.json({ message: 'Варианты покрытия сохранены', inserted_count: insertedCount })
  } catch (e) {
    await conn.rollback()
    console.error('POST /coverage/rfq/:rfqId/options/replace error:', e)
    res.status(500).json({ message: 'Ошибка сохранения покрытия' })
  } finally {
    conn.release()
  }
})

router.post('/rfq/:rfqId/options', async (req, res) => {
  const rfqId = toId(req.params.rfqId)
  if (!rfqId) {
    return res.status(400).json({ message: 'Не выбран RFQ' })
  }

  const option = req.body?.option
  const rfqItemId = toId(option?.rfq_item_id)
  const lines = Array.isArray(option?.lines) ? option.lines : []
  if (!rfqItemId) {
    return res.status(400).json({ message: 'Не выбрана строка RFQ' })
  }
  if (!lines.length) {
    return res.status(400).json({ message: 'Нужно добавить хотя бы одну строку в вариант покрытия' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [insertOption] = await conn.execute(
      `INSERT INTO rfq_coverage_options
        (rfq_id, rfq_item_id, option_code, option_kind, coverage_status,
         completeness_pct, priced_pct, is_oem_ok, goods_total, goods_currency,
         supplier_count, lead_time_min_days, lead_time_max_days, warning_json, note, created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rfqId,
        rfqItemId,
        textOrNull(option?.option_code) || `MANUAL-${Date.now()}`,
        textOrNull(option?.option_kind) || 'MANUAL',
        textOrNull(option?.coverage_status) || 'DRAFT',
        numOrNull(option?.completeness_pct) ?? 0,
        numOrNull(option?.priced_pct) ?? 0,
        Number(option?.is_oem_ok) ? 1 : 0,
        numOrNull(option?.goods_total),
        textOrNull(option?.goods_currency),
        Number(option?.supplier_count || 0) || 0,
        numOrNull(option?.lead_time_min_days),
        numOrNull(option?.lead_time_max_days),
        option?.warning_json ? JSON.stringify(option.warning_json) : null,
        textOrNull(option?.note),
        toId(req.user?.id),
      ]
    )

    const coverageOptionId = insertOption.insertId
    for (const line of lines) {
      const supplierId = toId(line?.supplier_id)
      if (!supplierId) continue
      await conn.execute(
        `INSERT INTO rfq_coverage_option_lines
          (coverage_option_id, rfq_item_id, rfq_item_component_id, rfq_response_line_id, supplier_id,
           original_part_id, tnved_code_id, line_code, line_role, line_status, qty, uom,
           unit_price, goods_amount, goods_currency, weight_kg, volume_cbm, lead_time_days,
           has_price, is_oem_offer, origin_country, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          coverageOptionId,
          rfqItemId,
          toId(line?.rfq_item_component_id),
          toId(line?.rfq_response_line_id),
          supplierId,
          toId(line?.original_part_id),
          toId(line?.tnved_code_id),
          textOrNull(line?.line_code) || `MANUAL-LINE-${supplierId}-${coverageOptionId}`,
          textOrNull(line?.line_role) || 'MANUAL',
          textOrNull(line?.line_status) || 'SELECTED',
          numOrNull(line?.qty),
          textOrNull(line?.uom),
          numOrNull(line?.unit_price),
          numOrNull(line?.goods_amount),
          textOrNull(line?.goods_currency),
          numOrNull(line?.weight_kg),
          numOrNull(line?.volume_cbm),
          numOrNull(line?.lead_time_days),
          Number(line?.has_price) ? 1 : 0,
          Number(line?.is_oem_offer) ? 1 : 0,
          textOrNull(line?.origin_country),
          textOrNull(line?.note),
        ]
      )
    }

    await conn.commit()
    res.status(201).json({ message: 'Ручной вариант покрытия создан', coverage_option_id: coverageOptionId })
  } catch (e) {
    await conn.rollback()
    console.error('POST /coverage/rfq/:rfqId/options error:', e)
    res.status(500).json({ message: 'Ошибка создания ручного варианта покрытия' })
  } finally {
    conn.release()
  }
})

module.exports = router
