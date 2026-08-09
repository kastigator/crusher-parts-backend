const db = require('../../utils/db')
const { hasCapability } = require('../authorizationService')
const { PricingDomainError } = require('./domainError')
const { addEvent, parseJson, requireActor, toId } = require('./helpers')

const jsonFields = (row, fields) => fields.reduce((result, field) => {
  result[field] = parseJson(row[field], Array.isArray(row[field]) ? [] : {})
  return result
}, { ...row })

async function listCases(query = {}) {
  const conditions = []
  const params = []
  if (query.status) { conditions.push('c.status=?'); params.push(query.status) }
  if (query.owner_user_id) { conditions.push('c.owner_user_id=?'); params.push(toId(query.owner_user_id)) }
  const [rows] = await db.execute(
    `SELECT c.*, u.full_name AS owner_name, sd.revision_number AS sourcing_decision_revision,
            COUNT(DISTINCT il.id) AS input_line_count,
            COUNT(DISTINCT g.id) AS group_count,
            COUNT(DISTINCT pd.id) AS decision_count
       FROM pricing_cases c
       JOIN sourcing_decisions sd ON sd.id=c.sourcing_decision_id
       LEFT JOIN users u ON u.id=c.owner_user_id
       LEFT JOIN pricing_input_snapshots s ON s.pricing_case_id=c.id
       LEFT JOIN pricing_input_lines il ON il.pricing_input_snapshot_id=s.id
       LEFT JOIN pricing_calculation_groups g ON g.pricing_case_id=c.id
       LEFT JOIN pricing_decisions pd ON pd.pricing_case_id=c.id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      GROUP BY c.id ORDER BY c.updated_at DESC, c.id DESC`, params
  )
  return rows
}

async function listRouteTemplates() {
  const [rows] = await db.execute(
    `SELECT t.id, t.template_code, t.name, t.status, t.legacy_logistics_route_template_id,
            r.id AS revision_id, r.revision_number, r.definition_snapshot_json, r.definition_hash
       FROM pricing_route_templates t
       JOIN pricing_route_template_revisions r ON r.pricing_route_template_id=t.id AND r.status='PUBLISHED'
      WHERE t.status='PUBLISHED' ORDER BY t.name, r.revision_number DESC`
  )
  return rows.map((row) => jsonFields(row, ['definition_snapshot_json']))
}

async function listSourcingDecisionIntake() {
  const [rows] = await db.execute(
    `SELECT sd.id, sd.revision_number, sd.finalized_at,
            sc.id AS sourcing_case_id, sc.case_number, sc.title AS sourcing_case_title,
            cr.internal_number AS request_number, c.company_name AS client_name,
            COUNT(sdl.id) AS line_count
       FROM sourcing_decisions sd
       JOIN sourcing_cases sc ON sc.id=sd.sourcing_case_id
       JOIN sourcing_decision_lines sdl ON sdl.sourcing_decision_id=sd.id
       JOIN sourcing_demands dem ON dem.id=sdl.sourcing_demand_id
       JOIN client_requests cr ON cr.id=dem.client_request_id
       JOIN clients c ON c.id=cr.client_id
       LEFT JOIN pricing_cases pc ON pc.sourcing_decision_id=sd.id
      WHERE sd.status='finalized' AND pc.id IS NULL
      GROUP BY sd.id, sc.id, cr.id, c.id
      ORDER BY sd.finalized_at DESC, sd.id DESC`
  )
  return rows
}

async function getWorkspace(caseIdInput, access) {
  const caseId = toId(caseIdInput)
  const [[pricingCase]] = await db.execute(
    `SELECT c.*, u.full_name AS owner_name, sd.revision_number AS sourcing_decision_revision,
            sd.finalized_at AS sourcing_decision_finalized_at
       FROM pricing_cases c JOIN sourcing_decisions sd ON sd.id=c.sourcing_decision_id
       LEFT JOIN users u ON u.id=c.owner_user_id WHERE c.id=?`, [caseId]
  )
  if (!pricingCase) throw new PricingDomainError('CASE_NOT_FOUND', 'Pricing Case не найден', 404)
  const [snapshots, inputRows, groups, groupLines, variants, parameterRevisions, calculations,
    lineResults, blockResults, clientPrices, overrides, decisions, decisionLines, reworkSignals, history] = await Promise.all([
    db.execute('SELECT * FROM pricing_input_snapshots WHERE pricing_case_id=? ORDER BY revision_number', [caseId]).then(([rows]) => rows),
    db.execute(`SELECT il.* FROM pricing_input_lines il JOIN pricing_input_snapshots s ON s.id=il.pricing_input_snapshot_id WHERE s.pricing_case_id=? ORDER BY il.line_number_snapshot,il.id`, [caseId]).then(([rows]) => rows),
    db.execute('SELECT * FROM pricing_calculation_groups WHERE pricing_case_id=? ORDER BY id', [caseId]).then(([rows]) => rows),
    db.execute(`SELECT gl.* FROM pricing_calculation_group_lines gl JOIN pricing_calculation_groups g ON g.id=gl.pricing_calculation_group_id WHERE g.pricing_case_id=? ORDER BY gl.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT v.*, tr.definition_hash, t.name AS template_name FROM pricing_route_variants v JOIN pricing_calculation_groups g ON g.id=v.pricing_calculation_group_id JOIN pricing_route_template_revisions tr ON tr.id=v.pricing_route_template_revision_id JOIN pricing_route_templates t ON t.id=tr.pricing_route_template_id WHERE g.pricing_case_id=? ORDER BY v.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT pr.* FROM pricing_variant_parameter_revisions pr JOIN pricing_route_variants v ON v.id=pr.pricing_route_variant_id JOIN pricing_calculation_groups g ON g.id=v.pricing_calculation_group_id WHERE g.pricing_case_id=? ORDER BY pr.pricing_route_variant_id,pr.revision_number`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT r.* FROM pricing_calculation_revisions r JOIN pricing_route_variants v ON v.id=r.pricing_route_variant_id JOIN pricing_calculation_groups g ON g.id=v.pricing_calculation_group_id WHERE g.pricing_case_id=? ORDER BY r.pricing_route_variant_id,r.revision_number`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT lr.* FROM pricing_calculation_line_results lr JOIN pricing_calculation_revisions r ON r.id=lr.pricing_calculation_revision_id JOIN pricing_route_variants v ON v.id=r.pricing_route_variant_id JOIN pricing_calculation_groups g ON g.id=v.pricing_calculation_group_id WHERE g.pricing_case_id=? ORDER BY lr.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT br.* FROM pricing_calculation_block_results br JOIN pricing_calculation_revisions r ON r.id=br.pricing_calculation_revision_id JOIN pricing_route_variants v ON v.id=r.pricing_route_variant_id JOIN pricing_calculation_groups g ON g.id=v.pricing_calculation_group_id WHERE g.pricing_case_id=? ORDER BY br.pricing_calculation_revision_id,br.sequence_number,br.id`, [caseId]).then(([rows]) => rows),
    db.execute('SELECT * FROM pricing_client_price_lines WHERE pricing_case_id=? ORDER BY id', [caseId]).then(([rows]) => rows),
    db.execute(`SELECT o.* FROM pricing_price_overrides o JOIN pricing_client_price_lines p ON p.id=o.pricing_client_price_line_id WHERE p.pricing_case_id=? ORDER BY o.requested_at`, [caseId]).then(([rows]) => rows),
    db.execute('SELECT * FROM pricing_decisions WHERE pricing_case_id=? ORDER BY revision_number', [caseId]).then(([rows]) => rows),
    db.execute(`SELECT dl.* FROM pricing_decision_lines dl JOIN pricing_decisions d ON d.id=dl.pricing_decision_id WHERE d.pricing_case_id=? ORDER BY dl.id`, [caseId]).then(([rows]) => rows),
    db.execute('SELECT * FROM pricing_rework_signals WHERE pricing_case_id=? ORDER BY created_at', [caseId]).then(([rows]) => rows),
    db.execute(`SELECT e.*,u.full_name AS actor_name FROM pricing_case_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.pricing_case_id=? ORDER BY e.created_at,e.id`, [caseId]).then(([rows]) => rows),
  ])
  const canViewCosts = hasCapability(access, 'pricing.costs.view')
  const inputLines = inputRows.map((row) => {
    const base = jsonFields(row, ['requested_identity_snapshot_json','technical_identity_snapshot_json','commercial_disclosure_snapshot_json','source_trace_snapshot_json'])
    const sourceTrace = base.source_trace_snapshot_json || {}
    base.source_trace_snapshot_json = {
      sourcing_case_id: sourceTrace.sourcing_case_id,
      procurement_release_id: sourceTrace.procurement_release_id,
      procurement_release_item_id: sourceTrace.procurement_release_item_id,
      client_request_id: sourceTrace.client_request_id,
      client_request_revision_id: sourceTrace.client_request_revision_id,
      stable_item_key: sourceTrace.stable_item_key,
      coverage_option_id: sourceTrace.coverage_option_id,
    }
    const supply = parseJson(base.supply_identity_snapshot_json)
    base.supply_projection = canViewCosts ? {
      supplier_alias: base.supplier_alias,
      supplier_part_number: supply.supplier_part_number || supply.part_number || null,
      relationship_type: supply.relationship_type || null,
    } : { supplier_alias: base.supplier_alias }
    delete base.supply_identity_snapshot_json
    delete base.supplier_id
    delete base.supplier_part_id
    delete base.supplier_offer_line_id
    if (!canViewCosts) {
      delete base.purchase_unit_price
      delete base.purchase_currency
      delete base.purchase_quantity
    }
    return base
  })
  const safeLineResults = lineResults.map((row) => {
    const result = jsonFields(row, ['trace_snapshot_json'])
    if (!canViewCosts) for (const key of ['goods_amount_raw','freight_amount_raw','duty_amount_raw','other_amount_raw','landed_amount_raw','internal_unit_price_raw']) delete result[key]
    return result
  })
  const safeCalculations = calculations.map((row) => {
    const result = jsonFields(row, ['fx_snapshot_json','totals_snapshot_json','validation_snapshot_json'])
    if (!canViewCosts) { delete result.fx_snapshot_json; delete result.totals_snapshot_json }
    return result
  })
  const safeParameterRevisions = parameterRevisions.map((row) => {
    const result = jsonFields(row, ['parameter_snapshot_json'])
    if (!canViewCosts) delete result.parameter_snapshot_json
    return result
  })
  const safeHistory = history.map((event) => {
    if (event.event_type !== 'supplier_identity_revealed') return event
    return { ...event, payload_json: JSON.stringify({ audited: true, restricted: true }) }
  })
  const safeBlockResults = canViewCosts ? blockResults.map((row) => jsonFields(row, ['input_snapshot_json','output_snapshot_json'])) : []
  return {
    case: pricingCase,
    input_snapshots: snapshots,
    input_lines: inputLines,
    groups: groups.map((group) => ({ ...group, lines: groupLines.filter((line) => Number(line.pricing_calculation_group_id) === Number(group.id)), variants: variants.filter((variant) => Number(variant.pricing_calculation_group_id) === Number(group.id)).map((variant) => ({ ...variant, parameter_revisions: safeParameterRevisions.filter((item) => Number(item.pricing_route_variant_id) === Number(variant.id)), calculation_revisions: safeCalculations.filter((item) => Number(item.pricing_route_variant_id) === Number(variant.id)) })) })),
    calculation_line_results: safeLineResults,
    calculation_block_results: safeBlockResults,
    client_prices: clientPrices,
    price_overrides: overrides,
    decisions: decisions.map((decision) => ({ ...jsonFields(decision, ['disclosure_snapshot_json']), lines: decisionLines.filter((line) => Number(line.pricing_decision_id) === Number(decision.id)).map((line) => {
      const safe = jsonFields(line, ['seller_projection_snapshot_json','client_projection_snapshot_json'])
      delete safe.procurement_projection_snapshot_json
      return safe
    }) })),
    rework_signals: reworkSignals.map((row) => {
      const signal = jsonFields(row, ['details_json'])
      if (!canViewCosts) delete signal.details_json
      return signal
    }),
    history: safeHistory,
    projection: { costs_visible: canViewCosts, supplier_identity: 'alias_only', reveal_requires_explicit_audited_request: true },
  }
}

async function revealSupplierIdentity(inputLineIdInput, access) {
  const inputLineId = toId(inputLineIdInput)
  const actorId = requireActor(access?.id)
  if (!hasCapability(access, 'pricing.supplier_identity.reveal')) throw new PricingDomainError('SUPPLIER_IDENTITY_FORBIDDEN', 'Нет полномочия на раскрытие поставщика', 403)
  const [[row]] = await db.execute(
    `SELECT il.id, il.supplier_alias, il.supplier_id, il.supplier_part_id,
            il.supplier_offer_line_id, il.supply_identity_snapshot_json,
            s.pricing_case_id, ps.name AS supplier_name, ps.public_code AS supplier_public_code
       FROM pricing_input_lines il JOIN pricing_input_snapshots s ON s.id=il.pricing_input_snapshot_id
       JOIN part_suppliers ps ON ps.id=il.supplier_id WHERE il.id=?`, [inputLineId]
  )
  if (!row) throw new PricingDomainError('INPUT_LINE_NOT_FOUND', 'Pricing input line не найдена', 404)
  await addEvent(db, row.pricing_case_id, 'supplier_identity_revealed', 'pricing_input_line', inputLineId, actorId, { supplier_id: row.supplier_id })
  return { input_line_id: row.id, supplier_alias: row.supplier_alias, supplier_id: row.supplier_id,
    supplier_name: row.supplier_name, supplier_public_code: row.supplier_public_code,
    supplier_part_id: row.supplier_part_id, supplier_offer_line_id: row.supplier_offer_line_id,
    supply_identity_snapshot: parseJson(row.supply_identity_snapshot_json), audited: true }
}

module.exports = { getWorkspace, listCases, listRouteTemplates, listSourcingDecisionIntake, revealSupplierIdentity }
