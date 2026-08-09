const db = require('../../utils/db')
const { calculatePricingRevision } = require('./calculationEngine')
const { PricingDomainError } = require('./domainError')
const { addEvent, cleanText, parseJson, requireActor, sha256, toId } = require('./helpers')

async function calculateVariant(variantIdInput, actorUserId) {
  const variantId = toId(variantIdInput)
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[variant]] = await conn.execute(
      `SELECT v.*, g.pricing_case_id, g.allocation_method, c.status AS case_status,
              tr.definition_snapshot_json, tr.definition_hash,
              s.id AS input_snapshot_id, s.snapshot_hash
         FROM pricing_route_variants v
         JOIN pricing_calculation_groups g ON g.id = v.pricing_calculation_group_id
         JOIN pricing_cases c ON c.id = g.pricing_case_id
         JOIN pricing_route_template_revisions tr ON tr.id = v.pricing_route_template_revision_id
         JOIN pricing_input_snapshots s ON s.pricing_case_id = c.id AND s.status = 'FIXED'
        WHERE v.id = ? FOR UPDATE`, [variantId]
    )
    if (!variant) throw new PricingDomainError('VARIANT_NOT_FOUND', 'Route Variant не найден', 404)
    if (variant.case_status === 'FIXED') throw new PricingDomainError('CASE_IMMUTABLE', 'Fixed Pricing Case не принимает новые Calculation Revision', 409)
    if (!['READY','CALCULATED','RESERVE','OUTDATED'].includes(variant.status)) throw new PricingDomainError('VARIANT_NOT_CALCULABLE', 'Route Variant недоступен для расчёта', 409)
    const [[parameterRevision]] = await conn.execute(
      'SELECT * FROM pricing_variant_parameter_revisions WHERE pricing_route_variant_id = ? ORDER BY revision_number DESC LIMIT 1', [variantId]
    )
    const [lines] = await conn.execute(
      `SELECT il.*, gl.included_quantity
         FROM pricing_calculation_group_lines gl
         JOIN pricing_input_lines il ON il.id = gl.pricing_input_line_id
        WHERE gl.pricing_calculation_group_id = ? ORDER BY il.line_number_snapshot, il.id`,
      [variant.pricing_calculation_group_id]
    )
    const parameters = parseJson(parameterRevision.parameter_snapshot_json)
    const template = parseJson(variant.definition_snapshot_json)
    const calculation = calculatePricingRevision({
      lines, parameters, template, allocationMethod: variant.allocation_method,
      calculationCurrency: variant.calculation_currency,
    })
    const inputHash = sha256({ snapshot_hash: variant.snapshot_hash, template_hash: variant.definition_hash, parameter_hash: parameterRevision.parameter_hash })
    const resultHash = sha256({ input_hash: inputHash, totals: calculation.totals, results: calculation.results })
    const [[sequence]] = await conn.execute(
      'SELECT COALESCE(MAX(revision_number),0)+1 AS next_number FROM pricing_calculation_revisions WHERE pricing_route_variant_id = ? FOR UPDATE', [variantId]
    )
    await conn.execute("UPDATE pricing_calculation_revisions SET status='OUTDATED' WHERE pricing_route_variant_id=? AND status IN ('CALCULATED','SELECTED')", [variantId])
    await conn.execute("UPDATE pricing_client_price_lines p JOIN pricing_calculation_revisions r ON r.id=p.pricing_calculation_revision_id SET p.status='OUTDATED' WHERE r.pricing_route_variant_id=? AND p.status IN ('CALCULATED','APPROVED')", [variantId])
    const [insert] = await conn.execute(
      `INSERT INTO pricing_calculation_revisions
        (pricing_route_variant_id, revision_number, pricing_input_snapshot_id,
         pricing_variant_parameter_revision_id, pricing_route_template_revision_id,
         status, input_hash, result_hash, fx_snapshot_json, totals_snapshot_json,
         validation_snapshot_json, calculated_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'CALCULATED', ?, ?, ?, ?, ?, ?)`,
      [variantId, sequence.next_number, variant.input_snapshot_id, parameterRevision.id,
        variant.pricing_route_template_revision_id, inputHash, resultHash,
        JSON.stringify({ calculation_currency: variant.calculation_currency, fx_rates: parameters.fx_rates || {}, route_currency: calculation.route_currency }),
        JSON.stringify({ ...calculation.totals, route_cost: calculation.route_cost, route_currency: calculation.route_currency }),
        JSON.stringify({ blockers: [], allocation_method: variant.allocation_method, engine: 'pricing-deterministic-v1' }), actorId]
    )
    const calculationRevisionId = insert.insertId
    for (const result of calculation.results) {
      await conn.execute(
        `INSERT INTO pricing_calculation_line_results
          (pricing_calculation_revision_id, pricing_input_line_id, goods_amount_raw,
           freight_amount_raw, duty_amount_raw, other_amount_raw, landed_amount_raw,
           internal_unit_price_raw, calculated_client_unit_price_raw,
           rounded_client_unit_price, allocation_residual, currency, trace_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [calculationRevisionId, result.input_line_id, result.goods_amount_raw,
          result.freight_amount_raw, result.duty_amount_raw, result.other_amount_raw,
          result.landed_amount_raw, result.internal_unit_price_raw,
          result.calculated_client_unit_price_raw, result.rounded_client_unit_price,
          result.allocation_residual, result.currency,
          JSON.stringify({ engine: 'pricing-deterministic-v1', input_hash: inputHash,
            goods_source_amount: result.goods_source_amount, fx_rate: result.fx_rate,
            duty_rate_pct: result.duty_rate_pct })]
      )
      const blocks = [
        [10, 'INITIAL_COST', result.goods_source_amount, result.goods_source_amount, { purchase_currency: lines.find((line) => Number(line.id) === Number(result.input_line_id)).purchase_currency }],
        [20, 'FX_CONVERSION', result.goods_amount_raw, result.goods_amount_raw, { fx_rate: result.fx_rate }],
        [30, 'GROUP_FIXED_COST', result.freight_amount_raw, result.freight_amount_raw, { other_amount: result.other_amount_raw, allocation_method: variant.allocation_method }],
        [40, 'CUSTOMS_DUTY', result.duty_amount_raw, result.duty_amount_raw, { duty_rate_pct: result.duty_rate_pct }],
        [50, 'TARGET_MARKUP', result.calculated_client_unit_price_raw, result.calculated_client_unit_price_raw, { target_markup_pct: parameters.TARGET_MARKUP_PCT || 0 }],
        [60, 'ROUNDING', result.calculated_client_unit_price_raw, result.rounded_client_unit_price, { rounding_increment: parameters.ROUNDING_INCREMENT || '0.01' }],
        [70, 'VALIDATION_CHECKPOINT', result.landed_amount_raw, result.landed_amount_raw, { blockers: [] }],
      ]
      for (const [sequenceNumber, blockKey, raw, rounded, metadata] of blocks) {
        await conn.execute(
          `INSERT INTO pricing_calculation_block_results
            (pricing_calculation_revision_id, pricing_input_line_id, sequence_number,
             block_key, input_snapshot_json, output_snapshot_json, raw_amount,
             rounded_amount, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [calculationRevisionId, result.input_line_id, sequenceNumber, blockKey,
            JSON.stringify(metadata), JSON.stringify({ amount: rounded, currency: result.currency }),
            raw, rounded, result.currency]
        )
      }
      await conn.execute(
        `INSERT INTO pricing_client_price_lines
          (pricing_case_id, pricing_input_line_id, pricing_calculation_revision_id,
           status, calculated_unit_price, rounded_unit_price, currency)
         VALUES (?, ?, ?, 'CALCULATED', ?, ?, ?)`,
        [variant.pricing_case_id, result.input_line_id, calculationRevisionId,
          result.calculated_client_unit_price_raw, result.rounded_client_unit_price, result.currency]
      )
    }
    await conn.execute("UPDATE pricing_route_variants SET status='CALCULATED', row_version=row_version+1 WHERE id=?", [variantId])
    await conn.execute("UPDATE pricing_calculation_groups SET status='CALCULATED', row_version=row_version+1 WHERE id=?", [variant.pricing_calculation_group_id])
    await conn.execute("UPDATE pricing_cases SET status='CALCULATED', row_version=row_version+1 WHERE id=?", [variant.pricing_case_id])
    await addEvent(conn, variant.pricing_case_id, 'calculation_revision_created', 'pricing_calculation_revision', calculationRevisionId, actorId, { revision_number: Number(sequence.next_number), input_hash: inputHash, result_hash: resultHash })
    await conn.commit()
    return { calculation_revision_id: calculationRevisionId, revision_number: Number(sequence.next_number), status: 'CALCULATED', input_hash: inputHash, result_hash: resultHash, totals: calculation.totals, results: calculation.results }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function selectVariant(variantIdInput, actorUserId) {
  const variantId = toId(variantIdInput)
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[variant]] = await conn.execute(
      `SELECT v.*, g.pricing_case_id, c.status AS case_status FROM pricing_route_variants v
       JOIN pricing_calculation_groups g ON g.id=v.pricing_calculation_group_id
       JOIN pricing_cases c ON c.id=g.pricing_case_id WHERE v.id=? FOR UPDATE`, [variantId]
    )
    if (!variant || variant.status !== 'CALCULATED') throw new PricingDomainError('VARIANT_NOT_SELECTABLE', 'Сначала выполните актуальный расчёт варианта', 409)
    if (variant.case_status === 'FIXED') throw new PricingDomainError('CASE_IMMUTABLE', 'Fixed Pricing Case не принимает новый selected variant', 409)
    const [[revision]] = await conn.execute("SELECT * FROM pricing_calculation_revisions WHERE pricing_route_variant_id=? AND status='CALCULATED' ORDER BY revision_number DESC LIMIT 1 FOR UPDATE", [variantId])
    if (!revision) throw new PricingDomainError('CALCULATION_NOT_FOUND', 'Актуальная Calculation Revision не найдена', 409)
    await conn.execute("UPDATE pricing_route_variants SET status=CASE WHEN id=? THEN 'SELECTED' WHEN status='SELECTED' THEN 'RESERVE' ELSE status END, selected_at=CASE WHEN id=? THEN CURRENT_TIMESTAMP(6) ELSE selected_at END, selected_by_user_id=CASE WHEN id=? THEN ? ELSE selected_by_user_id END, row_version=row_version+1 WHERE pricing_calculation_group_id=?", [variantId, variantId, variantId, actorId, variant.pricing_calculation_group_id])
    await conn.execute("UPDATE pricing_calculation_revisions r JOIN pricing_route_variants v ON v.id=r.pricing_route_variant_id SET r.status=CASE WHEN r.id=? THEN 'SELECTED' WHEN r.status='SELECTED' THEN 'OUTDATED' ELSE r.status END WHERE v.pricing_calculation_group_id=?", [revision.id, variant.pricing_calculation_group_id])
    await conn.execute("UPDATE pricing_calculation_groups SET status='SELECTED', row_version=row_version+1 WHERE id=?", [variant.pricing_calculation_group_id])
    await conn.execute("UPDATE pricing_cases SET status='COMPARISON', row_version=row_version+1 WHERE id=?", [variant.pricing_case_id])
    await addEvent(conn, variant.pricing_case_id, 'route_variant_selected', 'pricing_route_variant', variantId, actorId, { calculation_revision_id: revision.id })
    await conn.commit()
    return { variant_id: variantId, calculation_revision_id: revision.id, status: 'SELECTED' }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function approveClientPrices(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const requestedIds = [...new Set((payload.price_line_ids || []).map(toId).filter(Boolean))]
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[pricingCase]] = await conn.execute('SELECT * FROM pricing_cases WHERE id=? FOR UPDATE', [caseId])
    if (!pricingCase) throw new PricingDomainError('CASE_NOT_FOUND', 'Pricing Case не найден', 404)
    if (pricingCase.status === 'FIXED') throw new PricingDomainError('CASE_IMMUTABLE', 'Fixed Pricing Case не принимает новые price approvals', 409)
    const [prices] = await conn.execute(
      `SELECT p.* FROM pricing_client_price_lines p
       JOIN pricing_calculation_revisions r ON r.id=p.pricing_calculation_revision_id AND r.status='SELECTED'
       WHERE p.pricing_case_id=? AND p.status='CALCULATED'
       ${requestedIds.length ? `AND p.id IN (${requestedIds.map(() => '?').join(',')})` : ''} FOR UPDATE`,
      [caseId, ...requestedIds]
    )
    if (!prices.length || (requestedIds.length && prices.length !== requestedIds.length)) throw new PricingDomainError('PRICE_NOT_APPROVABLE', 'Нет выбранных расчётных цен для утверждения', 409)
    for (const price of prices) await conn.execute(
      `UPDATE pricing_client_price_lines SET status='APPROVED', approved_unit_price=rounded_unit_price,
       approval_evidence_json=?, approved_by_user_id=?, approved_at=CURRENT_TIMESTAMP(6) WHERE id=?`,
      [JSON.stringify({ method: 'rounded_calculated_price', note: cleanText(payload.note) }), actorId, price.id]
    )
    await conn.execute("UPDATE pricing_cases SET status='APPROVAL', row_version=row_version+1 WHERE id=?", [caseId])
    await addEvent(conn, caseId, 'client_prices_approved', 'pricing_case', caseId, actorId, { price_line_ids: prices.map((price) => price.id) })
    await conn.commit()
    return { case_id: caseId, approved_price_line_ids: prices.map((price) => price.id), status: 'APPROVAL' }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function requestPriceOverride(priceLineIdInput, payload, actorUserId) {
  const priceLineId = toId(priceLineIdInput)
  const actorId = requireActor(actorUserId)
  const requested = Number(payload.requested_unit_price)
  const reason = cleanText(payload.reason)
  if (!priceLineId || !Number.isFinite(requested) || requested < 0 || !reason) throw new PricingDomainError('VALIDATION_ERROR', 'Укажите новую цену и обоснование')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[price]] = await conn.execute(
      `SELECT p.*, c.status AS case_status FROM pricing_client_price_lines p
       JOIN pricing_cases c ON c.id=p.pricing_case_id WHERE p.id=? FOR UPDATE`, [priceLineId]
    )
    if (!price || !['CALCULATED','APPROVED'].includes(price.status)) throw new PricingDomainError('PRICE_NOT_OVERRIDABLE', 'Цена недоступна для override', 409)
    if (price.case_status === 'FIXED') throw new PricingDomainError('CASE_IMMUTABLE', 'Fixed Pricing Case не принимает price override', 409)
    const [insert] = await conn.execute(
      `INSERT INTO pricing_price_overrides
       (pricing_client_price_line_id, requested_unit_price, previous_unit_price, reason, requested_by_user_id)
       VALUES (?, ?, ?, ?, ?)`, [priceLineId, requested, price.approved_unit_price || price.rounded_unit_price, reason, actorId]
    )
    await conn.execute("UPDATE pricing_client_price_lines SET status='OVERRIDE_PENDING' WHERE id=?", [priceLineId])
    await addEvent(conn, price.pricing_case_id, 'price_override_requested', 'pricing_price_override', insert.insertId, actorId, { price_line_id: priceLineId, requested_unit_price: requested })
    await conn.commit()
    return { override_id: insert.insertId, status: 'PENDING' }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function reviewPriceOverride(overrideIdInput, payload, actorUserId) {
  const overrideId = toId(overrideIdInput)
  const actorId = requireActor(actorUserId)
  const approve = payload.approve === true
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[override]] = await conn.execute(
      `SELECT o.*, p.pricing_case_id FROM pricing_price_overrides o
       JOIN pricing_client_price_lines p ON p.id=o.pricing_client_price_line_id
       WHERE o.id=? FOR UPDATE`, [overrideId]
    )
    if (!override || override.status !== 'PENDING') throw new PricingDomainError('OVERRIDE_NOT_REVIEWABLE', 'Override уже рассмотрен или не найден', 409)
    await conn.execute(
      `UPDATE pricing_price_overrides SET status=?, reviewed_by_user_id=?, reviewed_at=CURRENT_TIMESTAMP(6), review_note=? WHERE id=?`,
      [approve ? 'APPROVED' : 'REJECTED', actorId, cleanText(payload.review_note), overrideId]
    )
    await conn.execute(
      `UPDATE pricing_client_price_lines SET status=?, approved_unit_price=?,
       approval_evidence_json=?, approved_by_user_id=?, approved_at=CURRENT_TIMESTAMP(6) WHERE id=?`,
      [approve ? 'APPROVED' : 'REJECTED', approve ? override.requested_unit_price : null,
        JSON.stringify({ method: 'approved_override', override_id: overrideId, review_note: cleanText(payload.review_note) }),
        actorId, override.pricing_client_price_line_id]
    )
    await addEvent(conn, override.pricing_case_id, approve ? 'price_override_approved' : 'price_override_rejected', 'pricing_price_override', overrideId, actorId)
    await conn.commit()
    return { override_id: overrideId, status: approve ? 'APPROVED' : 'REJECTED' }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function finalizePricingDecision(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[pricingCase]] = await conn.execute('SELECT * FROM pricing_cases WHERE id=? FOR UPDATE', [caseId])
    if (!pricingCase || !['APPROVAL','COMPARISON'].includes(pricingCase.status)) throw new PricingDomainError('CASE_NOT_FINALIZABLE', 'Pricing Case не готов к финализации', 409)
    const [[snapshot]] = await conn.execute("SELECT * FROM pricing_input_snapshots WHERE pricing_case_id=? AND status='FIXED'", [caseId])
    const [inputLines] = await conn.execute('SELECT * FROM pricing_input_lines WHERE pricing_input_snapshot_id=? ORDER BY line_number_snapshot,id', [snapshot.id])
    const [candidates] = await conn.execute(
      `SELECT p.*, lr.landed_amount_raw, lr.internal_unit_price_raw,
              r.result_hash, r.pricing_route_variant_id
         FROM pricing_client_price_lines p
         JOIN pricing_calculation_revisions r ON r.id=p.pricing_calculation_revision_id AND r.status='SELECTED'
         JOIN pricing_calculation_line_results lr ON lr.pricing_calculation_revision_id=r.id AND lr.pricing_input_line_id=p.pricing_input_line_id
        WHERE p.pricing_case_id=? AND p.status='APPROVED' ORDER BY p.id DESC`, [caseId]
    )
    const byInput = new Map()
    for (const row of candidates) if (!byInput.has(Number(row.pricing_input_line_id))) byInput.set(Number(row.pricing_input_line_id), row)
    const missing = inputLines.filter((line) => !byInput.has(Number(line.id))).map((line) => line.id)
    if (missing.length) throw new PricingDomainError('APPROVED_PRICE_MISSING', 'Не все позиции имеют утверждённую цену из selected revision', 409, { input_line_ids: missing })
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(revision_number),0)+1 AS next_number FROM pricing_decisions WHERE pricing_case_id=? FOR UPDATE', [caseId])
    const disclosureSnapshot = { policy: 'supplier_alias_only', supplier_identity_in_seller_projection: false, supplier_identity_in_client_projection: false }
    const [insert] = await conn.execute(
      `INSERT INTO pricing_decisions
       (pricing_case_id, revision_number, status, pricing_input_snapshot_id,
        disclosure_snapshot_json, finalized_by_user_id, finalized_at, created_by_user_id)
       VALUES (?, ?, 'DRAFT', ?, ?, ?, CURRENT_TIMESTAMP(6), ?)`,
      [caseId, sequence.next_number, snapshot.id, JSON.stringify(disclosureSnapshot), actorId, actorId]
    )
    const decisionId = insert.insertId
    const decisionHashInput = []
    for (const input of inputLines) {
      const price = byInput.get(Number(input.id))
      const requested = parseJson(input.requested_identity_snapshot_json)
      const technical = parseJson(input.technical_identity_snapshot_json)
      const supply = parseJson(input.supply_identity_snapshot_json)
      const disclosure = parseJson(input.commercial_disclosure_snapshot_json)
      const sellerProjection = {
        stable_item_key: input.stable_item_key_snapshot, line_number: input.line_number_snapshot,
        requested_identity: requested, technical_identity: technical,
        disclosure_type: disclosure.type, supplier_alias: input.supplier_alias,
        client_quantity: input.client_quantity, uom: input.uom_snapshot,
        approved_unit_price: price.approved_unit_price, currency: price.currency,
      }
      const clientProjection = {
        stable_item_key: input.stable_item_key_snapshot, line_number: input.line_number_snapshot,
        description: disclosure.client_description, disclosure_type: disclosure.type,
        quantity: input.client_quantity, uom: input.uom_snapshot,
        unit_price: price.approved_unit_price, currency: price.currency,
      }
      const procurementProjection = {
        sourcing_decision_id: pricingCase.sourcing_decision_id,
        sourcing_decision_line_id: input.sourcing_decision_line_id,
        supplier_id: input.supplier_id, supplier_alias: input.supplier_alias,
        supplier_offer_line_id: input.supplier_offer_line_id, supplier_part_id: input.supplier_part_id,
        purchase_quantity: input.purchase_quantity, purchase_unit_price: input.purchase_unit_price,
        purchase_currency: input.purchase_currency, supply_identity: supply,
        landed_amount: price.landed_amount_raw, internal_unit_price: price.internal_unit_price_raw,
        calculation_revision_id: price.pricing_calculation_revision_id,
      }
      await conn.execute(
        `INSERT INTO pricing_decision_lines
         (pricing_decision_id, pricing_input_line_id, pricing_calculation_revision_id,
          pricing_client_price_line_id, approved_unit_price, currency,
          seller_projection_snapshot_json, client_projection_snapshot_json,
          procurement_projection_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [decisionId, input.id, price.pricing_calculation_revision_id, price.id,
          price.approved_unit_price, price.currency, JSON.stringify(sellerProjection),
          JSON.stringify(clientProjection), JSON.stringify(procurementProjection)]
      )
      decisionHashInput.push({ input_line_id: input.id, calculation_result_hash: price.result_hash, approved_unit_price: price.approved_unit_price, currency: price.currency, disclosure_type: disclosure.type })
    }
    const decisionHash = sha256({ input_snapshot_hash: snapshot.snapshot_hash, lines: decisionHashInput, note: cleanText(payload.note) })
    await conn.execute("UPDATE pricing_decisions SET status='FIXED', decision_hash=? WHERE id=?", [decisionHash, decisionId])
    await conn.execute("UPDATE pricing_calculation_revisions r JOIN pricing_decision_lines dl ON dl.pricing_calculation_revision_id=r.id SET r.status='FIXED', r.fixed_at=CURRENT_TIMESTAMP(6) WHERE dl.pricing_decision_id=?", [decisionId])
    await conn.execute("UPDATE pricing_cases SET status='FIXED', fixed_at=CURRENT_TIMESTAMP(6), row_version=row_version+1 WHERE id=?", [caseId])
    await addEvent(conn, caseId, 'pricing_decision_finalized', 'pricing_decision', decisionId, actorId, { revision_number: Number(sequence.next_number), decision_hash: decisionHash })
    await conn.commit()
    return { pricing_decision_id: decisionId, revision_number: Number(sequence.next_number), status: 'FIXED', decision_hash: decisionHash, line_count: inputLines.length }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

module.exports = { approveClientPrices, calculateVariant, finalizePricingDecision, requestPriceOverride, reviewPriceOverride, selectVariant }
