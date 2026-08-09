const db = require('../../utils/db')
const { SourcingDomainError } = require('./domainError')
const { addEvent, cleanText, json, requireActor, toId, toPositiveNumber } = require('./helpers')

const parseJson = (value) => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

function validateCoverageLine(demand, offerLine, input) {
  const blockers = []
  const allocated = toPositiveNumber(input.allocated_quantity)
  const purchase = toPositiveNumber(input.purchase_quantity) || allocated
  if (!allocated || !purchase || purchase < allocated) blockers.push('INVALID_QUANTITY')
  if (offerLine.supplier_reply_status !== 'quoted') blockers.push('OFFER_LINE_NOT_QUOTED')
  if (offerLine.unit_price == null || !offerLine.currency) blockers.push('PRICE_OR_CURRENCY_MISSING')
  if (offerLine.offered_quantity != null && purchase > Number(offerLine.offered_quantity)) blockers.push('AVAILABLE_QUANTITY_EXCEEDED')
  if (offerLine.moq != null && purchase < Number(offerLine.moq)) blockers.push('MOQ_NOT_MET')
  if (offerLine.pack_quantity != null && Number(offerLine.pack_quantity) > 0) {
    const remainder = purchase % Number(offerLine.pack_quantity)
    if (Math.min(remainder, Number(offerLine.pack_quantity) - remainder) > 0.000001) blockers.push('PACK_MULTIPLE_NOT_MET')
  }
  if (offerLine.validity_until && new Date(`${offerLine.validity_until}T23:59:59Z`) < new Date()) blockers.push('OFFER_EXPIRED')
  const requirements = parseJson(demand.requirements_snapshot_json)
  if (demand.substitution_policy_snapshot === 'exact_only' && offerLine.relationship_type !== 'exact') {
    blockers.push('EXACT_ONLY_POLICY')
  }
  if (demand.substitution_policy_snapshot === 'equivalent_requires_approval' && offerLine.relationship_type !== 'exact' && !cleanText(input.approval_reference)) {
    blockers.push('SUBSTITUTION_APPROVAL_REQUIRED')
  }
  if (offerLine.relationship_type === 'kit' && !requirements.kit_allowed) blockers.push('KIT_NOT_ALLOWED')
  return { blockers, allocated, purchase, surplus: purchase && allocated ? purchase - allocated : 0 }
}

async function createCoverageOption(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const lines = Array.isArray(payload.lines) ? payload.lines : []
  if (!caseId || !lines.length) throw new SourcingDomainError('VALIDATION_ERROR', 'Укажите кейс и строки покрытия')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[sourcingCase]] = await conn.execute('SELECT * FROM sourcing_cases WHERE id = ? FOR UPDATE', [caseId])
    if (!sourcingCase || ['archived', 'cancelled', 'closed'].includes(sourcingCase.status)) {
      throw new SourcingDomainError('CASE_NOT_ACTIVE', 'Sourcing Case недоступен', 409)
    }
    const normalized = []
    const allBlockers = []
    for (const input of lines) {
      const demandId = toId(input.demand_id)
      const offerLineId = toId(input.offer_line_id)
      const [[row]] = await conn.execute(
        `SELECT sd.*, sol.supplier_reply_status, sol.offered_quantity, sol.moq,
                sol.pack_quantity, sol.unit_price, sol.currency, sol.validity_until,
                sol.relationship_type, so.supplier_id, so.sourcing_case_id AS offer_case_id,
                sor.status AS offer_revision_status
           FROM sourcing_demands sd
           JOIN supplier_offer_line_demands sold ON sold.sourcing_demand_id = sd.id
           JOIN supplier_offer_lines sol ON sol.id = sold.supplier_offer_line_id
           JOIN supplier_offer_revisions sor ON sor.id = sol.supplier_offer_revision_id
           JOIN supplier_offers so ON so.id = sor.supplier_offer_id
          WHERE sd.id = ? AND sol.id = ? AND sd.sourcing_case_id = ?`,
        [demandId, offerLineId, caseId]
      )
      if (!row || Number(row.offer_case_id) !== caseId) {
        throw new SourcingDomainError('COVERAGE_TRACE_MISMATCH', 'Строка предложения не является кандидатом выбранной потребности', 409)
      }
      const validation = validateCoverageLine(row, row, input)
      if (row.offer_revision_status !== 'finalized') validation.blockers.push('OFFER_NOT_FINALIZED')
      allBlockers.push(...validation.blockers.map((code) => ({ code, demand_id: demandId, offer_line_id: offerLineId })))
      normalized.push({ input, row, ...validation })
    }
    const demandTotals = new Map()
    for (const line of normalized) demandTotals.set(Number(line.row.id), (demandTotals.get(Number(line.row.id)) || 0) + Number(line.allocated || 0))
    for (const [demandId, allocated] of demandTotals) {
      const demand = normalized.find((line) => Number(line.row.id) === demandId).row
      if (allocated > Number(demand.admitted_quantity) + 0.000001) allBlockers.push({ code: 'DEMAND_OVERALLOCATED', demand_id: demandId })
      if (allocated < Number(demand.admitted_quantity) - 0.000001) {
        const requirements = parseJson(demand.requirements_snapshot_json)
        if (!requirements.partial_supply_allowed) allBlockers.push({ code: 'PARTIAL_SUPPLY_NOT_ALLOWED', demand_id: demandId })
      }
    }
    const optionType = ['single', 'split', 'kit', 'partial', 'mixed', 'manual'].includes(payload.option_type)
      ? payload.option_type : (lines.length > 1 ? 'split' : 'single')
    const hasPartial = normalized.some((line) => (demandTotals.get(Number(line.row.id)) || 0) < Number(line.row.admitted_quantity))
    const status = allBlockers.length ? 'blocked' : (hasPartial ? 'partial' : 'valid')
    const optionCode = cleanText(payload.option_code) || `OPT-${caseId}-${Date.now()}`
    const [optionInsert] = await conn.execute(
      `INSERT INTO sourcing_coverage_options
        (sourcing_case_id, option_code, option_type, status, title, blocker_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [caseId, optionCode, optionType, status, cleanText(payload.title), json(allBlockers, []), actorId]
    )
    for (const line of normalized) {
      await conn.execute(
        `INSERT INTO sourcing_coverage_option_lines
          (sourcing_coverage_option_id, sourcing_demand_id, supplier_offer_line_id,
           supplier_id, allocated_quantity, purchase_quantity, surplus_quantity,
           uom_snapshot, validation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          optionInsert.insertId, line.row.id, toId(line.input.offer_line_id), line.row.supplier_id,
          line.allocated, line.purchase, line.surplus, line.row.uom_snapshot,
          json({ blockers: line.blockers, approval_reference: cleanText(line.input.approval_reference) }),
        ]
      )
    }
    if (status === 'valid' || status === 'partial') {
      await conn.execute(
        `UPDATE sourcing_demands SET status = ?, row_version = row_version + 1
          WHERE id IN (${[...demandTotals.keys()].map(() => '?').join(',')})
            AND status NOT IN ('decided', 'cancelled')`,
        [status === 'valid' ? 'ready_for_decision' : 'preliminary_covered', ...demandTotals.keys()]
      )
    }
    await conn.execute(
      `UPDATE sourcing_cases SET status = ?, row_version = row_version + 1
        WHERE id = ? AND status NOT IN ('decided', 'released_to_pricing')`,
      [status === 'valid' ? 'decision_ready' : 'decision_pending', caseId]
    )
    await addEvent(conn, caseId, 'coverage_option_created', 'sourcing_coverage_option', optionInsert.insertId, actorId, {
      status, blocker_codes: [...new Set(allBlockers.map((item) => item.code))],
    })
    await conn.commit()
    return { option_id: optionInsert.insertId, option_code: optionCode, status, blockers: allBlockers }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function validateDecision(caseIdInput, optionIdsInput, executor = db) {
  const caseId = toId(caseIdInput)
  const optionIds = [...new Set((optionIdsInput || []).map(toId).filter(Boolean))]
  if (!caseId || !optionIds.length) return { valid: false, blockers: [{ code: 'OPTION_REQUIRED' }], lines: [] }
  const [demands] = await executor.execute(
    `SELECT * FROM sourcing_demands WHERE sourcing_case_id = ? AND status <> 'cancelled' ORDER BY line_number_snapshot`,
    [caseId]
  )
  const [lines] = await executor.execute(
    `SELECT col.*, co.status AS option_status, co.sourcing_case_id,
            sol.supplier_part_id, sol.offered_catalog_position_id,
            sol.supplier_part_number_snapshot, sol.relationship_type,
            sor.id AS offer_revision_id, sor.revision_number AS offer_revision_number,
            so.id AS offer_id, so.supplier_id AS offer_supplier_id
       FROM sourcing_coverage_option_lines col
       JOIN sourcing_coverage_options co ON co.id = col.sourcing_coverage_option_id
       JOIN supplier_offer_lines sol ON sol.id = col.supplier_offer_line_id
       JOIN supplier_offer_revisions sor ON sor.id = sol.supplier_offer_revision_id
       JOIN supplier_offers so ON so.id = sor.supplier_offer_id
      WHERE co.sourcing_case_id = ? AND co.id IN (${optionIds.map(() => '?').join(',')})`,
    [caseId, ...optionIds]
  )
  const blockers = []
  if (!lines.length) blockers.push({ code: 'OPTION_NOT_FOUND' })
  if (lines.some((line) => line.option_status !== 'valid')) blockers.push({ code: 'OPTION_NOT_VALID' })
  for (const demand of demands) {
    const allocated = lines.filter((line) => Number(line.sourcing_demand_id) === Number(demand.id))
      .reduce((sum, line) => sum + Number(line.allocated_quantity), 0)
    if (Math.abs(allocated - Number(demand.admitted_quantity)) > 0.000001) {
      blockers.push({ code: allocated < Number(demand.admitted_quantity) ? 'DEMAND_NOT_FULLY_COVERED' : 'DEMAND_OVERALLOCATED', demand_id: demand.id, allocated })
    }
  }
  const seen = new Set()
  for (const line of lines) {
    const key = `${line.sourcing_demand_id}:${line.supplier_offer_line_id}`
    if (seen.has(key)) blockers.push({ code: 'DUPLICATE_CANDIDATE_ALLOCATION', demand_id: line.sourcing_demand_id, offer_line_id: line.supplier_offer_line_id })
    seen.add(key)
  }
  return { valid: blockers.length === 0, blockers, lines, demand_count: demands.length }
}

async function finalizeDecision(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const optionIds = [...new Set((payload.option_ids || []).map(toId).filter(Boolean))]
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[sourcingCase]] = await conn.execute('SELECT * FROM sourcing_cases WHERE id = ? FOR UPDATE', [caseId])
    if (!sourcingCase) throw new SourcingDomainError('CASE_NOT_FOUND', 'Sourcing Case не найден', 404)
    if (['archived', 'cancelled', 'closed', 'released_to_pricing'].includes(sourcingCase.status)) {
      throw new SourcingDomainError('CASE_NOT_DECIDABLE', 'Sourcing Case нельзя финализировать', 409)
    }
    const validation = await validateDecision(caseId, optionIds, conn)
    if (!validation.valid) {
      throw new SourcingDomainError('DECISION_BLOCKED', 'Sourcing Decision содержит блокеры', 409, validation)
    }
    const [[sequence]] = await conn.execute(
      'SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_number FROM sourcing_decisions WHERE sourcing_case_id = ? FOR UPDATE',
      [caseId]
    )
    const [decisionInsert] = await conn.execute(
      `INSERT INTO sourcing_decisions
        (sourcing_case_id, revision_number, status, decision_note,
         validation_snapshot_json, finalized_by_user_id, finalized_at, created_by_user_id)
       VALUES (?, ?, 'finalized', ?, ?, ?, CURRENT_TIMESTAMP(6), ?)`,
      [caseId, sequence.next_number, cleanText(payload.note), json({ option_ids: optionIds, blockers: [] }), actorId, actorId]
    )
    for (const line of validation.lines) {
      const [[demand]] = await conn.execute('SELECT * FROM sourcing_demands WHERE id = ?', [line.sourcing_demand_id])
      await conn.execute(
        `INSERT INTO sourcing_decision_lines
          (sourcing_decision_id, sourcing_demand_id, sourcing_coverage_option_id,
           supplier_offer_line_id, supplier_id, supplier_part_id,
           offered_catalog_position_id, procurement_release_item_id,
           decided_quantity, trace_snapshot_json, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          decisionInsert.insertId, line.sourcing_demand_id, line.sourcing_coverage_option_id,
          line.supplier_offer_line_id, line.offer_supplier_id, line.supplier_part_id,
          line.offered_catalog_position_id, demand.procurement_release_item_id,
          line.allocated_quantity,
          json({
            sourcing_case_id: caseId,
            procurement_release_id: demand.procurement_release_id,
            procurement_release_item_id: demand.procurement_release_item_id,
            client_request_id: demand.client_request_id,
            client_request_revision_id: demand.client_request_revision_id,
            stable_item_key: demand.stable_item_key_snapshot,
            supplier_id: line.offer_supplier_id,
            supplier_part_id: line.supplier_part_id,
            offered_catalog_position_id: line.offered_catalog_position_id,
            relationship_type: line.relationship_type,
            offer_id: line.offer_id,
            offer_revision_id: line.offer_revision_id,
            offer_revision_number: line.offer_revision_number,
            offer_line_id: line.supplier_offer_line_id,
            coverage_option_id: line.sourcing_coverage_option_id,
          }),
          cleanText(payload.rationale),
        ]
      )
    }
    await conn.execute(
      `UPDATE sourcing_coverage_options SET status = 'selected'
        WHERE sourcing_case_id = ? AND id IN (${optionIds.map(() => '?').join(',')})`,
      [caseId, ...optionIds]
    )
    await conn.execute(`UPDATE sourcing_demands SET status = 'decided', row_version = row_version + 1 WHERE sourcing_case_id = ? AND status <> 'cancelled'`, [caseId])
    await conn.execute(
      `UPDATE sourcing_cases SET status = 'decided', decided_at = CURRENT_TIMESTAMP(6), row_version = row_version + 1 WHERE id = ?`,
      [caseId]
    )
    await addEvent(conn, caseId, 'sourcing_decision_finalized', 'sourcing_decision', decisionInsert.insertId, actorId, { option_ids: optionIds })
    await conn.commit()
    return { decision_id: decisionInsert.insertId, revision_number: Number(sequence.next_number), status: 'finalized', line_count: validation.lines.length }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

module.exports = { createCoverageOption, finalizeDecision, validateDecision }
