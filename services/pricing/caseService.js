const db = require('../../utils/db')
const { PricingDomainError } = require('./domainError')
const { addEvent, cleanText, parseJson, requireActor, sha256, toId } = require('./helpers')

const ALLOCATION_METHODS = ['BY_VALUE', 'BY_WEIGHT', 'BY_QUANTITY', 'EQUAL', 'MANUAL', 'BY_CATEGORY']

function disclosureType(row) {
  if (row.relationship_type === 'kit') return 'KIT_COVERAGE'
  if (row.relationship_type === 'manufactured') return 'MANUFACTURED_TO_DRAWING'
  if (row.relationship_type === 'exact') return 'EXACT_REQUESTED_ITEM'
  if (row.relationship_type === 'analog' || row.relationship_type === 'equivalent') return 'APPROVED_EQUIVALENT'
  return 'PROPOSED_EQUIVALENT'
}

async function createCaseFromSourcingDecision(payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const decisionId = toId(payload.sourcing_decision_id)
  if (!decisionId) throw new PricingDomainError('VALIDATION_ERROR', 'Укажите finalized Sourcing Decision')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[decision]] = await conn.execute(
      `SELECT d.*, sc.case_number AS sourcing_case_number, sc.title AS sourcing_title
         FROM sourcing_decisions d JOIN sourcing_cases sc ON sc.id = d.sourcing_case_id
        WHERE d.id = ? FOR UPDATE`, [decisionId]
    )
    if (!decision) throw new PricingDomainError('SOURCING_DECISION_NOT_FOUND', 'Sourcing Decision не найден', 404)
    if (decision.status !== 'finalized') throw new PricingDomainError('SOURCING_DECISION_NOT_FINAL', 'Pricing принимает только finalized Sourcing Decision', 409)
    const [[existing]] = await conn.execute('SELECT id, case_number FROM pricing_cases WHERE sourcing_decision_id = ?', [decisionId])
    if (existing) {
      await conn.rollback()
      return { case_id: existing.id, case_number: existing.case_number, already_exists: true }
    }
    const [sourceLines] = await conn.execute(
      `SELECT dl.*, sd.client_request_id, sd.client_request_revision_id,
              sd.client_request_revision_item_id, sd.stable_item_key_snapshot,
              sd.line_number_snapshot, sd.catalog_position_id_snapshot,
              sd.requested_quantity_snapshot, sd.admitted_quantity, sd.uom_snapshot,
              sd.source_data_snapshot_json, sd.identification_snapshot_json,
              sd.requirements_snapshot_json, col.purchase_quantity,
              sol.unit_price, sol.currency, sol.relationship_type,
              sol.supplier_part_number_snapshot, sol.description_snapshot,
              sol.lead_time_days, sol.validity_until, sol.payment_terms,
              sol.incoterms, sol.incoterms_place, sol.origin_country,
              ps.name AS supplier_name, sp.supplier_part_number,
              requested_cp.manufacturer_part_number AS requested_catalog_number,
              requested_cp.display_name AS requested_catalog_name,
              offered_cp.manufacturer_part_number AS offered_catalog_number,
              offered_cp.display_name AS offered_catalog_name
         FROM sourcing_decision_lines dl
         JOIN sourcing_demands sd ON sd.id = dl.sourcing_demand_id
         JOIN sourcing_coverage_option_lines col
           ON col.sourcing_coverage_option_id = dl.sourcing_coverage_option_id
          AND col.sourcing_demand_id = dl.sourcing_demand_id
          AND col.supplier_offer_line_id = dl.supplier_offer_line_id
         JOIN supplier_offer_lines sol ON sol.id = dl.supplier_offer_line_id
         JOIN part_suppliers ps ON ps.id = dl.supplier_id
         LEFT JOIN supplier_parts sp ON sp.id = dl.supplier_part_id
         LEFT JOIN catalog_positions requested_cp ON requested_cp.id = sd.catalog_position_id_snapshot
         LEFT JOIN catalog_positions offered_cp ON offered_cp.id = dl.offered_catalog_position_id
        WHERE dl.sourcing_decision_id = ? ORDER BY sd.line_number_snapshot, dl.id`, [decisionId]
    )
    if (!sourceLines.length) throw new PricingDomainError('SOURCING_DECISION_EMPTY', 'Sourcing Decision не содержит строк', 409)
    const clientRequestIds = [...new Set(sourceLines.map((line) => Number(line.client_request_id)))]
    if (clientRequestIds.length !== 1) throw new PricingDomainError('MULTI_REQUEST_DECISION_UNSUPPORTED', 'Один Pricing Case должен относиться к одной Client Request', 409)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(id), 0) + 1 AS next_number FROM pricing_cases FOR UPDATE')
    const caseNumber = cleanText(payload.case_number) || `PC-${String(sequence.next_number).padStart(6, '0')}`
    const currency = String(payload.calculation_currency || 'USD').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) throw new PricingDomainError('INVALID_CURRENCY', 'Некорректная валюта расчёта')
    const [insert] = await conn.execute(
      `INSERT INTO pricing_cases
        (case_number, sourcing_decision_id, sourcing_case_id, client_request_id,
         status, title, calculation_currency, owner_user_id, created_by_user_id)
       VALUES (?, ?, ?, ?, 'INTAKE_REVIEW', ?, ?, ?, ?)`,
      [caseNumber, decisionId, decision.sourcing_case_id, clientRequestIds[0],
        cleanText(payload.title) || `Pricing · ${decision.sourcing_case_number}`, currency,
        toId(payload.owner_user_id) || actorId, actorId]
    )
    const caseId = insert.insertId
    const supplierIds = [...new Set(sourceLines.map((line) => Number(line.supplier_id)))].sort((a, b) => a - b)
    const aliases = new Map(supplierIds.map((supplierId, index) => [supplierId, `Source ${String.fromCharCode(65 + index)}`]))
    for (const supplierId of supplierIds) {
      await conn.execute('INSERT INTO pricing_supplier_aliases (pricing_case_id, supplier_id, supplier_alias) VALUES (?, ?, ?)', [caseId, supplierId, aliases.get(supplierId)])
    }
    const [snapshotInsert] = await conn.execute(
      `INSERT INTO pricing_input_snapshots
        (pricing_case_id, revision_number, status, sourcing_decision_id,
         sourcing_decision_revision_number, created_by_user_id)
       VALUES (?, 1, 'DRAFT', ?, ?, ?)`,
      [caseId, decisionId, decision.revision_number, actorId]
    )
    const snapshotId = snapshotInsert.insertId
    const rework = []
    for (const line of sourceLines) {
      const requestedIdentity = {
        stable_item_key: line.stable_item_key_snapshot,
        client_request_revision_item_id: line.client_request_revision_item_id,
        line_number: line.line_number_snapshot,
        requested_quantity: line.requested_quantity_snapshot,
        uom: line.uom_snapshot,
        source_data: parseJson(line.source_data_snapshot_json),
      }
      const technicalIdentity = {
        catalog_position_id: line.catalog_position_id_snapshot,
        catalog_number: line.requested_catalog_number,
        catalog_name: line.requested_catalog_name,
        identification: parseJson(line.identification_snapshot_json),
      }
      const supplyIdentity = {
        supplier_id: line.supplier_id,
        supplier_name: line.supplier_name,
        supplier_part_id: line.supplier_part_id,
        supplier_part_number: line.supplier_part_number || line.supplier_part_number_snapshot,
        offered_catalog_position_id: line.offered_catalog_position_id,
        offered_catalog_number: line.offered_catalog_number,
        offered_catalog_name: line.offered_catalog_name,
        relationship_type: line.relationship_type,
        unit_price: line.unit_price,
        currency: line.currency,
        offer_line_id: line.supplier_offer_line_id,
        lead_time_days: line.lead_time_days,
        validity_until: line.validity_until,
        payment_terms: line.payment_terms,
        incoterms: line.incoterms,
        incoterms_place: line.incoterms_place,
        origin_country: line.origin_country,
      }
      const disclosure = {
        type: disclosureType(line),
        supplier_alias: aliases.get(Number(line.supplier_id)),
        requested_catalog_position_id: line.catalog_position_id_snapshot,
        offered_catalog_position_id: line.offered_catalog_position_id,
        client_description: parseJson(line.source_data_snapshot_json).client_description || line.description_snapshot,
      }
      await conn.execute(
        `INSERT INTO pricing_input_lines
          (pricing_input_snapshot_id, sourcing_decision_line_id, sourcing_demand_id,
           procurement_release_item_id, client_request_revision_item_id,
           stable_item_key_snapshot, line_number_snapshot, requested_catalog_position_id,
           offered_catalog_position_id, supplier_offer_line_id, supplier_id, supplier_part_id,
           supplier_alias, requested_quantity, client_quantity, purchase_quantity, uom_snapshot,
           purchase_unit_price, purchase_currency, requested_identity_snapshot_json,
           technical_identity_snapshot_json, supply_identity_snapshot_json,
           commercial_disclosure_snapshot_json, source_trace_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [snapshotId, line.id, line.sourcing_demand_id, line.procurement_release_item_id,
          line.client_request_revision_item_id, line.stable_item_key_snapshot, line.line_number_snapshot,
          line.catalog_position_id_snapshot, line.offered_catalog_position_id, line.supplier_offer_line_id,
          line.supplier_id, line.supplier_part_id, aliases.get(Number(line.supplier_id)),
          line.requested_quantity_snapshot, line.decided_quantity, line.purchase_quantity || line.decided_quantity,
          line.uom_snapshot, line.unit_price == null ? 0 : line.unit_price, line.currency || 'XXX',
          JSON.stringify(requestedIdentity), JSON.stringify(technicalIdentity), JSON.stringify(supplyIdentity),
          JSON.stringify(disclosure), line.trace_snapshot_json]
      )
      if (line.unit_price == null || !line.currency) rework.push({ code: 'SOURCE_PRICE_MISSING', sourcing_demand_id: line.sourcing_demand_id })
    }
    for (const issue of rework) {
      await conn.execute(
        `INSERT INTO pricing_rework_signals
          (pricing_case_id, sourcing_decision_id, sourcing_demand_id, reason_code, details_json, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [caseId, decisionId, issue.sourcing_demand_id, issue.code, JSON.stringify({ source: 'pricing_intake_validation' }), actorId]
      )
    }
    await addEvent(conn, caseId, 'pricing_case_created', 'sourcing_decision', decisionId, actorId, { input_snapshot_id: snapshotId, line_count: sourceLines.length, rework_count: rework.length })
    await conn.commit()
    return { case_id: caseId, case_number: caseNumber, input_snapshot_id: snapshotId, line_count: sourceLines.length, rework_count: rework.length }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally { conn.release() }
}

async function fixInput(caseIdInput, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[pricingCase]] = await conn.execute('SELECT * FROM pricing_cases WHERE id = ? FOR UPDATE', [caseId])
    if (!pricingCase) throw new PricingDomainError('CASE_NOT_FOUND', 'Pricing Case не найден', 404)
    if (pricingCase.status !== 'INTAKE_REVIEW') throw new PricingDomainError('INPUT_NOT_FIXABLE', 'Pricing input уже зафиксирован или кейс недоступен', 409)
    const [[snapshot]] = await conn.execute("SELECT * FROM pricing_input_snapshots WHERE pricing_case_id = ? AND status = 'DRAFT' FOR UPDATE", [caseId])
    const [lines] = await conn.execute('SELECT * FROM pricing_input_lines WHERE pricing_input_snapshot_id = ? ORDER BY line_number_snapshot, id', [snapshot?.id])
    const blockers = []
    for (const line of lines) {
      const supply = parseJson(line.supply_identity_snapshot_json)
      if (supply.unit_price == null || !supply.currency) blockers.push({ code: 'SOURCE_PRICE_MISSING', input_line_id: line.id })
      if (!line.requested_catalog_position_id) blockers.push({ code: 'TECHNICAL_IDENTITY_MISSING', input_line_id: line.id })
    }
    if (blockers.length) {
      await conn.execute("UPDATE pricing_cases SET status = 'BLOCKED', row_version = row_version + 1 WHERE id = ?", [caseId])
      await addEvent(conn, caseId, 'pricing_input_blocked', 'pricing_input_snapshot', snapshot.id, actorId, { blockers })
      await conn.commit()
      throw new PricingDomainError('INPUT_BLOCKED', 'Pricing input требует нового решения Sourcing', 409, { blockers, rework_required: true })
    }
    const hash = sha256({ sourcing_decision_id: snapshot.sourcing_decision_id, revision: snapshot.sourcing_decision_revision_number, lines: lines.map((line) => ({
      sourcing_decision_line_id: line.sourcing_decision_line_id,
      requested_identity: parseJson(line.requested_identity_snapshot_json),
      technical_identity: parseJson(line.technical_identity_snapshot_json),
      supply_identity: parseJson(line.supply_identity_snapshot_json),
      disclosure: parseJson(line.commercial_disclosure_snapshot_json),
      client_quantity: line.client_quantity, purchase_quantity: line.purchase_quantity,
    })) })
    await conn.execute("UPDATE pricing_input_snapshots SET status = 'FIXED', snapshot_hash = ?, fixed_by_user_id = ?, fixed_at = CURRENT_TIMESTAMP(6) WHERE id = ?", [hash, actorId, snapshot.id])
    await conn.execute("UPDATE pricing_cases SET status = 'ROUTING', row_version = row_version + 1 WHERE id = ?", [caseId])
    await addEvent(conn, caseId, 'pricing_input_fixed', 'pricing_input_snapshot', snapshot.id, actorId, { snapshot_hash: hash })
    await conn.commit()
    return { case_id: caseId, input_snapshot_id: snapshot.id, status: 'FIXED', snapshot_hash: hash }
  } catch (error) {
    if (conn.connection?._closing !== true) await conn.rollback().catch(() => {})
    throw error
  } finally { conn.release() }
}

async function createGroup(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const inputLineIds = [...new Set((payload.input_line_ids || []).map(toId).filter(Boolean))]
  if (!caseId || !inputLineIds.length) throw new PricingDomainError('VALIDATION_ERROR', 'Укажите позиции Calculation Group')
  const allocation = ALLOCATION_METHODS.includes(payload.allocation_method) ? payload.allocation_method : 'BY_VALUE'
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[pricingCase]] = await conn.execute('SELECT * FROM pricing_cases WHERE id = ? FOR UPDATE', [caseId])
    if (!pricingCase || !['ROUTING','PARAMETER_COLLECTION','CALCULATED','COMPARISON'].includes(pricingCase.status)) throw new PricingDomainError('CASE_NOT_GROUPABLE', 'Pricing Case недоступен для группировки', 409)
    const [lines] = await conn.execute(
      `SELECT il.* FROM pricing_input_lines il JOIN pricing_input_snapshots s ON s.id = il.pricing_input_snapshot_id
        WHERE s.pricing_case_id = ? AND s.status = 'FIXED' AND il.id IN (${inputLineIds.map(() => '?').join(',')})`, [caseId, ...inputLineIds]
    )
    if (lines.length !== inputLineIds.length) throw new PricingDomainError('INPUT_LINE_MISMATCH', 'Позиции не принадлежат fixed input кейса', 409)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(id),0)+1 AS next_number FROM pricing_calculation_groups FOR UPDATE')
    const groupCode = cleanText(payload.group_code) || `GRP-${caseId}-${sequence.next_number}`
    const [insert] = await conn.execute(
      `INSERT INTO pricing_calculation_groups (pricing_case_id, group_code, title, status, allocation_method, created_by_user_id)
       VALUES (?, ?, ?, 'READY', ?, ?)`, [caseId, groupCode, cleanText(payload.title) || groupCode, allocation, actorId]
    )
    for (const line of lines) await conn.execute(
      `INSERT INTO pricing_calculation_group_lines (pricing_calculation_group_id, pricing_input_line_id, included_quantity)
       VALUES (?, ?, ?)`, [insert.insertId, line.id, line.purchase_quantity]
    )
    await conn.execute("UPDATE pricing_cases SET status = 'PARAMETER_COLLECTION', row_version = row_version + 1 WHERE id = ?", [caseId])
    await addEvent(conn, caseId, 'calculation_group_created', 'pricing_calculation_group', insert.insertId, actorId, { input_line_ids: inputLineIds, allocation_method: allocation })
    await conn.commit()
    return { group_id: insert.insertId, group_code: groupCode, status: 'READY' }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function createVariant(groupIdInput, payload, actorUserId) {
  const groupId = toId(groupIdInput)
  const actorId = requireActor(actorUserId)
  const templateRevisionId = toId(payload.pricing_route_template_revision_id)
  if (!groupId || !templateRevisionId) throw new PricingDomainError('VALIDATION_ERROR', 'Укажите published Route Template Revision')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[group]] = await conn.execute(
      `SELECT g.*, c.status AS case_status FROM pricing_calculation_groups g
       JOIN pricing_cases c ON c.id=g.pricing_case_id WHERE g.id = ? FOR UPDATE`, [groupId]
    )
    const [[revision]] = await conn.execute('SELECT * FROM pricing_route_template_revisions WHERE id = ?', [templateRevisionId])
    if (!group) throw new PricingDomainError('GROUP_NOT_FOUND', 'Calculation Group не найдена', 404)
    if (!['ROUTING','PARAMETER_COLLECTION','CALCULATED','COMPARISON'].includes(group.case_status)) throw new PricingDomainError('CASE_NOT_MUTABLE', 'Pricing Case уже зафиксирован или недоступен', 409)
    if (!revision || revision.status !== 'PUBLISHED') throw new PricingDomainError('TEMPLATE_NOT_PUBLISHED', 'Разрешены только published template revisions', 409)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(id),0)+1 AS next_number FROM pricing_route_variants FOR UPDATE')
    const code = cleanText(payload.variant_code) || `VAR-${groupId}-${sequence.next_number}`
    const [[pricingCase]] = await conn.execute('SELECT * FROM pricing_cases WHERE id = ?', [group.pricing_case_id])
    const [insert] = await conn.execute(
      `INSERT INTO pricing_route_variants
        (pricing_calculation_group_id, pricing_route_template_revision_id, variant_code,
         title, status, calculation_currency, created_by_user_id)
       VALUES (?, ?, ?, ?, 'READY', ?, ?)`,
      [groupId, templateRevisionId, code, cleanText(payload.title) || code, pricingCase.calculation_currency, actorId]
    )
    const parameters = payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : {}
    await conn.execute(
      `INSERT INTO pricing_variant_parameter_revisions
        (pricing_route_variant_id, revision_number, parameter_snapshot_json, parameter_hash, created_by_user_id)
       VALUES (?, 1, ?, ?, ?)`, [insert.insertId, JSON.stringify(parameters), sha256(parameters), actorId]
    )
    await addEvent(conn, group.pricing_case_id, 'route_variant_created', 'pricing_route_variant', insert.insertId, actorId, { template_revision_id: templateRevisionId })
    await conn.commit()
    return { variant_id: insert.insertId, variant_code: code, status: 'READY' }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function reviseVariantParameters(variantIdInput, payload, actorUserId) {
  const variantId = toId(variantIdInput)
  const actorId = requireActor(actorUserId)
  const parameters = payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : null
  if (!variantId || !parameters) throw new PricingDomainError('VALIDATION_ERROR', 'Укажите параметры варианта')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[variant]] = await conn.execute(
      `SELECT v.*, g.pricing_case_id, c.status AS case_status FROM pricing_route_variants v
       JOIN pricing_calculation_groups g ON g.id = v.pricing_calculation_group_id
       JOIN pricing_cases c ON c.id = g.pricing_case_id
       WHERE v.id = ? FOR UPDATE`, [variantId]
    )
    if (!variant || ['SELECTED','REJECTED'].includes(variant.status)) throw new PricingDomainError('VARIANT_NOT_EDITABLE', 'Route Variant недоступен для новых параметров', 409)
    if (variant.case_status === 'FIXED') throw new PricingDomainError('CASE_IMMUTABLE', 'Fixed Pricing Case не принимает новые параметры', 409)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(revision_number),0)+1 AS next_number FROM pricing_variant_parameter_revisions WHERE pricing_route_variant_id = ? FOR UPDATE', [variantId])
    const [insert] = await conn.execute(
      `INSERT INTO pricing_variant_parameter_revisions
        (pricing_route_variant_id, revision_number, parameter_snapshot_json, parameter_hash, created_by_user_id)
       VALUES (?, ?, ?, ?, ?)`, [variantId, sequence.next_number, JSON.stringify(parameters), sha256(parameters), actorId]
    )
    await conn.execute("UPDATE pricing_calculation_revisions SET status = 'OUTDATED' WHERE pricing_route_variant_id = ? AND status IN ('CALCULATED','SELECTED')", [variantId])
    await conn.execute("UPDATE pricing_client_price_lines p JOIN pricing_calculation_revisions r ON r.id=p.pricing_calculation_revision_id SET p.status='OUTDATED' WHERE r.pricing_route_variant_id=? AND p.status IN ('CALCULATED','APPROVED')", [variantId])
    await conn.execute("UPDATE pricing_route_variants SET status='READY', row_version=row_version+1 WHERE id=?", [variantId])
    await addEvent(conn, variant.pricing_case_id, 'variant_parameters_revised', 'pricing_variant_parameter_revision', insert.insertId, actorId, { revision_number: Number(sequence.next_number), parameter_hash: sha256(parameters) })
    await conn.commit()
    return { parameter_revision_id: insert.insertId, revision_number: Number(sequence.next_number), parameter_hash: sha256(parameters) }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function createReworkSignal(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const reasonCode = cleanText(payload.reason_code)
  if (!caseId || !reasonCode) throw new PricingDomainError('VALIDATION_ERROR', 'Укажите reason_code для возврата в Sourcing')
  const [[pricingCase]] = await db.execute('SELECT * FROM pricing_cases WHERE id=?', [caseId])
  if (!pricingCase) throw new PricingDomainError('CASE_NOT_FOUND', 'Pricing Case не найден', 404)
  if (pricingCase.status === 'FIXED') throw new PricingDomainError('CASE_IMMUTABLE', 'Fixed Pricing Case не принимает rework-сигналы', 409)
  const demandId = toId(payload.sourcing_demand_id)
  if (demandId) {
    const [[demand]] = await db.execute(
      `SELECT sd.id FROM sourcing_demands sd JOIN sourcing_decision_lines dl ON dl.sourcing_demand_id=sd.id
       WHERE dl.sourcing_decision_id=? AND sd.id=? LIMIT 1`, [pricingCase.sourcing_decision_id, demandId]
    )
    if (!demand) throw new PricingDomainError('DEMAND_TRACE_MISMATCH', 'Потребность не входит в Sourcing Decision кейса', 409)
  }
  const [insert] = await db.execute(
    `INSERT INTO pricing_rework_signals
      (pricing_case_id, sourcing_decision_id, sourcing_demand_id, reason_code, details_json, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [caseId, pricingCase.sourcing_decision_id, demandId, reasonCode, JSON.stringify(payload.details || {}), actorId]
  )
  await db.execute("UPDATE pricing_cases SET status='BLOCKED', row_version=row_version+1 WHERE id=? AND status<>'FIXED'", [caseId])
  await addEvent(db, caseId, 'sourcing_rework_requested', 'pricing_rework_signal', insert.insertId, actorId, { reason_code: reasonCode, sourcing_demand_id: demandId })
  return { rework_signal_id: insert.insertId, status: 'OPEN', sourcing_mutated: false }
}

module.exports = { createCaseFromSourcingDecision, createGroup, createReworkSignal, createVariant, fixInput, reviseVariantParameters }
