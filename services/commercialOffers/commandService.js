const db = require('../../utils/db')
const { fetchCurrentCompanyLegalProfile } = require('../../utils/companyLegalProfiles')
const { CommercialOfferDomainError } = require('./domainError')
const { addEvent, cleanText, parseJson, requireActor, sha256, toId } = require('./helpers')
const { assessFeedbackChange, defaultDisclosurePolicy, DISCLOSURE_POLICIES, priceAuthority } = require('./policy')
const { buildClientPreview, evaluateReadiness, loadRevision } = require('./readModel')

const REVISION_EDITABLE_FIELDS = new Set([
  'validity_until','payment_terms','payment_policy_snapshot_json','incoterms','destination','client_delivery_commitment_days',
  'warranty_terms','packaging_terms','partial_delivery_terms','general_text',
])

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]))

function snapshotOrUnavailable(value, source) {
  return value ? { available: true, source, ...value } : { available: false, source }
}

function paymentPolicySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const dueDate = cleanText(value.due_date)
  return dueDate ? { mode: 'FIXED_DUE_DATE', due_date: dueDate } : null
}

function clientLineDescription(clientProjection, sellerProjection) {
  const base = cleanText(clientProjection.description) || cleanText(sellerProjection?.requested_identity?.source_data?.client_description) || 'Позиция клиента'
  return sellerProjection.disclosure_type === 'EXACT_REQUESTED_ITEM' ? base : `Эквивалент — ${base}`
}

async function capturePartySnapshots(conn, pricingCase) {
  const [[row]] = await conn.execute(
    `SELECT cr.id AS client_request_id,cr.client_id,cr.client_contact_id,
            cr.contact_name,cr.contact_email,cr.contact_phone,
            c.company_name,c.registration_number,c.tax_id,c.contact_person,c.phone,c.email,c.website,c.version AS client_version,
            cc.name AS structured_contact_name,cc.role AS structured_contact_role,
            cc.email AS structured_contact_email,cc.phone AS structured_contact_phone,cc.version AS contact_version
       FROM client_requests cr JOIN clients c ON c.id=cr.client_id
       LEFT JOIN client_contacts cc ON cc.id=cr.client_contact_id
      WHERE cr.id=?`, [pricingCase.client_request_id]
  )
  if (!row) throw new CommercialOfferDomainError('CLIENT_CONTEXT_NOT_FOUND', 'Не найден клиентский контекст Pricing Case', 409)
  const [[billing]] = await conn.execute('SELECT * FROM client_billing_addresses WHERE client_id=? ORDER BY id LIMIT 1', [row.client_id])
  const [[shipping]] = await conn.execute('SELECT * FROM client_shipping_addresses WHERE client_id=? ORDER BY id LIMIT 1', [row.client_id])
  const legalProfile = await fetchCurrentCompanyLegalProfile(conn)
  return {
    client_id: row.client_id,
    client: snapshotOrUnavailable({
      id: row.client_id, company_name: row.company_name, registration_number: row.registration_number,
      tax_id: row.tax_id, phone: row.phone, email: row.email, website: row.website, version: row.client_version,
    }, 'clients'),
    contact: snapshotOrUnavailable(cleanText(row.structured_contact_name || row.contact_name) ? {
      id: row.client_contact_id || null, name: row.structured_contact_name || row.contact_name,
      role: row.structured_contact_role || null, email: row.structured_contact_email || row.contact_email,
      phone: row.structured_contact_phone || row.contact_phone, version: row.contact_version || null,
    } : null, 'client_request_contact'),
    billing: snapshotOrUnavailable(billing || null, 'client_billing_addresses'),
    shipping: snapshotOrUnavailable(shipping || null, 'client_shipping_addresses'),
    legal: snapshotOrUnavailable(legalProfile, 'company_legal_profiles'),
  }
}

async function createFromPricingDecision(payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const pricingDecisionId = toId(payload.pricing_decision_id)
  if (!pricingDecisionId) throw new CommercialOfferDomainError('VALIDATION_ERROR', 'Укажите FIXED Pricing Decision')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[decision]] = await conn.execute(
      `SELECT pd.*,pc.client_request_id,pc.id AS pricing_case_id,pc.owner_user_id AS pricing_owner_user_id
         FROM pricing_decisions pd JOIN pricing_cases pc ON pc.id=pd.pricing_case_id
        WHERE pd.id=? FOR UPDATE`, [pricingDecisionId]
    )
    if (!decision) throw new CommercialOfferDomainError('PRICING_DECISION_NOT_FOUND', 'Pricing Decision не найден', 404)
    if (decision.status !== 'FIXED' || !decision.decision_hash) throw new CommercialOfferDomainError('PRICING_DECISION_NOT_FIXED', 'Commercial Offer принимает только FIXED Pricing Decision', 409)
    const [[existing]] = await conn.execute('SELECT id,offer_number,current_revision_id FROM commercial_offers WHERE source_pricing_decision_id=?', [pricingDecisionId])
    if (existing) { await conn.rollback(); return { offer_id: existing.id, offer_number: existing.offer_number, revision_id: existing.current_revision_id, already_exists: true } }
    const [sourceLines] = await conn.execute(
      `SELECT pdl.id,pdl.pricing_input_line_id,pdl.approved_unit_price,pdl.currency,
              pdl.seller_projection_snapshot_json,pdl.client_projection_snapshot_json
         FROM pricing_decision_lines pdl WHERE pdl.pricing_decision_id=? ORDER BY pdl.id`, [pricingDecisionId]
    )
    if (!sourceLines.length) throw new CommercialOfferDomainError('PRICING_DECISION_EMPTY', 'Pricing Decision не содержит строк', 409)
    const currencies = [...new Set(sourceLines.map((line) => String(line.currency || '').toUpperCase()))]
    if (currencies.length !== 1) throw new CommercialOfferDomainError('MULTI_CURRENCY_UNSUPPORTED', 'Одна Commercial Offer Revision должна иметь одну валюту', 409)
    const parties = await capturePartySnapshots(conn, decision)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(id),0)+1 AS next_number FROM commercial_offers FOR UPDATE')
    const offerNumber = cleanText(payload.offer_number) || `CO-${String(sequence.next_number).padStart(6, '0')}`
    const [offerInsert] = await conn.execute(
      `INSERT INTO commercial_offers
        (offer_number,source_pricing_decision_id,pricing_case_id,client_request_id,client_id,owner_user_id,created_by_user_id)
       VALUES (?,?,?,?,?,?,?)`,
      [offerNumber,pricingDecisionId,decision.pricing_case_id,decision.client_request_id,parties.client_id,toId(payload.owner_user_id) || actorId,actorId]
    )
    const offerId = offerInsert.insertId
    const [revisionInsert] = await conn.execute(
      `INSERT INTO commercial_offer_revisions
        (commercial_offer_id,revision_number,source_pricing_decision_id,source_pricing_decision_hash,status,currency,
         validity_until,payment_terms,payment_policy_snapshot_json,incoterms,destination,client_delivery_commitment_days,warranty_terms,packaging_terms,
         partial_delivery_terms,general_text,client_snapshot_json,client_contact_snapshot_json,billing_address_snapshot_json,
         shipping_address_snapshot_json,company_legal_snapshot_json,created_by_user_id)
       VALUES (?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [offerId,1,pricingDecisionId,decision.decision_hash,currencies[0],payload.validity_until || null,
        cleanText(payload.payment_terms),JSON.stringify(paymentPolicySnapshot(payload.payment_policy_snapshot_json)),cleanText(payload.incoterms),cleanText(payload.destination),
        payload.client_delivery_commitment_days == null ? null : Number(payload.client_delivery_commitment_days),
        cleanText(payload.warranty_terms),cleanText(payload.packaging_terms),cleanText(payload.partial_delivery_terms),
        cleanText(payload.general_text),JSON.stringify(parties.client),JSON.stringify(parties.contact),
        JSON.stringify(parties.billing),JSON.stringify(parties.shipping),JSON.stringify(parties.legal),actorId]
    )
    const revisionId = revisionInsert.insertId
    for (let index = 0; index < sourceLines.length; index += 1) {
      const source = sourceLines[index]
      const seller = parseJson(source.seller_projection_snapshot_json)
      const client = parseJson(source.client_projection_snapshot_json)
      const fulfillmentType = seller.disclosure_type || client.disclosure_type || 'PROPOSED_EQUIVALENT'
      const requestedSource = seller?.requested_identity?.source_data || {}
      const partNumber = cleanText(requestedSource.client_part_number || requestedSource.client_catalog_number)
      await conn.execute(
        `INSERT INTO commercial_offer_lines
          (commercial_offer_revision_id,source_pricing_decision_line_id,source_pricing_input_line_id,stable_item_key_snapshot,
           line_number,requested_identity_snapshot_json,offered_execution_snapshot_json,pricing_client_projection_snapshot_json,
           source_trace_snapshot_json,fulfillment_type,disclosure_policy,client_display_part_number,client_display_description,
           offered_quantity,uom,recommended_unit_price_snapshot,delegated_floor_snapshot,absolute_floor_snapshot,offered_unit_price,
           calculated_lead_time_days_snapshot,client_delivery_commitment_days,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [revisionId,source.id,source.pricing_input_line_id,seller.stable_item_key || client.stable_item_key,
          Number(seller.line_number || client.line_number || index + 1),JSON.stringify(seller.requested_identity || {}),
          JSON.stringify({ technical_identity: seller.technical_identity || {}, fulfillment_type: fulfillmentType }),JSON.stringify(client),
          JSON.stringify({ pricing_decision_id: pricingDecisionId,pricing_decision_hash: decision.decision_hash,pricing_decision_line_id: source.id,pricing_input_line_id: source.pricing_input_line_id }),
          fulfillmentType,defaultDisclosurePolicy(fulfillmentType),partNumber,clientLineDescription(client,seller),
          Number(client.quantity || seller.client_quantity),client.uom || seller.uom,source.approved_unit_price,null,null,source.approved_unit_price,
          null,payload.client_delivery_commitment_days == null ? null : Number(payload.client_delivery_commitment_days),index + 1]
      )
    }
    await conn.execute('UPDATE commercial_offers SET current_revision_id=? WHERE id=?', [revisionId,offerId])
    await addEvent(conn,offerId,'commercial_offer_created','pricing_decision',pricingDecisionId,actorId,{ revision_id: revisionId,pricing_decision_hash: decision.decision_hash,line_count: sourceLines.length })
    await conn.commit()
    return { offer_id: offerId,offer_number: offerNumber,revision_id: revisionId,revision_number: 1,line_count: sourceLines.length,status: 'DRAFT' }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function createRevisionFromPricingDecision(offerIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const offerId = toId(offerIdInput)
  const pricingDecisionId = toId(payload.pricing_decision_id)
  if (!offerId || !pricingDecisionId) throw new CommercialOfferDomainError('VALIDATION_ERROR', 'Укажите Commercial Offer и новый FIXED Pricing Decision')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[offer]] = await conn.execute('SELECT * FROM commercial_offers WHERE id=? FOR UPDATE', [offerId])
    if (!offer) throw new CommercialOfferDomainError('OFFER_NOT_FOUND', 'Commercial Offer не найден', 404)
    if (['ACCEPTED','PARTIALLY_ACCEPTED','CLOSED'].includes(offer.aggregate_status)) {
      throw new CommercialOfferDomainError('ACCEPTED_OFFER_IMMUTABLE', 'Принятый результат неизменяем; требуется отдельный downstream change process', 409)
    }
    const current = await loadRevision(offer.current_revision_id,conn)
    if (Number(current.source_pricing_decision_id) === pricingDecisionId) {
      throw new CommercialOfferDomainError('PRICING_DECISION_ALREADY_CURRENT', 'Эта Pricing Decision уже является источником текущей revision', 409)
    }
    const [[decision]] = await conn.execute(
      `SELECT pd.*,pc.client_request_id,pc.id AS pricing_case_id,pc.owner_user_id AS pricing_owner_user_id
         FROM pricing_decisions pd JOIN pricing_cases pc ON pc.id=pd.pricing_case_id
        WHERE pd.id=? FOR UPDATE`, [pricingDecisionId]
    )
    if (!decision) throw new CommercialOfferDomainError('PRICING_DECISION_NOT_FOUND', 'Pricing Decision не найден', 404)
    if (decision.status !== 'FIXED' || !decision.decision_hash) throw new CommercialOfferDomainError('PRICING_DECISION_NOT_FIXED', 'Commercial Offer принимает только FIXED Pricing Decision', 409)
    if (Number(decision.client_request_id) !== Number(offer.client_request_id)) {
      throw new CommercialOfferDomainError('PRICING_DECISION_SCOPE_MISMATCH', 'Новая Pricing Decision должна принадлежать тому же Client Request', 409)
    }
    const [sourceLines] = await conn.execute(
      `SELECT pdl.id,pdl.pricing_input_line_id,pdl.approved_unit_price,pdl.currency,
              pdl.seller_projection_snapshot_json,pdl.client_projection_snapshot_json
         FROM pricing_decision_lines pdl WHERE pdl.pricing_decision_id=? ORDER BY pdl.id`, [pricingDecisionId]
    )
    if (!sourceLines.length) throw new CommercialOfferDomainError('PRICING_DECISION_EMPTY', 'Pricing Decision не содержит строк', 409)
    const currencies = [...new Set(sourceLines.map((line) => String(line.currency || '').toUpperCase()))]
    if (currencies.length !== 1) throw new CommercialOfferDomainError('MULTI_CURRENCY_UNSUPPORTED', 'Одна Commercial Offer Revision должна иметь одну валюту', 409)
    const parties = await capturePartySnapshots(conn, decision)
    if (Number(parties.client_id) !== Number(offer.client_id)) {
      throw new CommercialOfferDomainError('PRICING_DECISION_CLIENT_MISMATCH', 'Новая Pricing Decision должна принадлежать тому же клиенту', 409)
    }
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(revision_number),0)+1 AS next_number FROM commercial_offer_revisions WHERE commercial_offer_id=? FOR UPDATE', [offerId])
    const [revisionInsert] = await conn.execute(
      `INSERT INTO commercial_offer_revisions
        (commercial_offer_id,revision_number,source_pricing_decision_id,source_pricing_decision_hash,status,currency,
         validity_until,payment_terms,payment_policy_snapshot_json,incoterms,destination,client_delivery_commitment_days,warranty_terms,packaging_terms,
         partial_delivery_terms,general_text,client_snapshot_json,client_contact_snapshot_json,billing_address_snapshot_json,
         shipping_address_snapshot_json,company_legal_snapshot_json,supersedes_revision_id,created_by_user_id)
       VALUES (?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [offerId,sequence.next_number,pricingDecisionId,decision.decision_hash,currencies[0],current.validity_until,
        current.payment_terms,JSON.stringify(current.payment_policy_snapshot_json || null),current.incoterms,current.destination,current.client_delivery_commitment_days,current.warranty_terms,
        current.packaging_terms,current.partial_delivery_terms,current.general_text,JSON.stringify(parties.client),
        JSON.stringify(parties.contact),JSON.stringify(parties.billing),JSON.stringify(parties.shipping),
        JSON.stringify(parties.legal),current.id,actorId]
    )
    const revisionId = revisionInsert.insertId
    for (let index = 0; index < sourceLines.length; index += 1) {
      const source = sourceLines[index]
      const seller = parseJson(source.seller_projection_snapshot_json)
      const client = parseJson(source.client_projection_snapshot_json)
      const fulfillmentType = seller.disclosure_type || client.disclosure_type || 'PROPOSED_EQUIVALENT'
      const requestedSource = seller?.requested_identity?.source_data || {}
      const partNumber = cleanText(requestedSource.client_part_number || requestedSource.client_catalog_number)
      await conn.execute(
        `INSERT INTO commercial_offer_lines
          (commercial_offer_revision_id,source_pricing_decision_line_id,source_pricing_input_line_id,stable_item_key_snapshot,
           line_number,requested_identity_snapshot_json,offered_execution_snapshot_json,pricing_client_projection_snapshot_json,
           source_trace_snapshot_json,fulfillment_type,disclosure_policy,client_display_part_number,client_display_description,
           offered_quantity,uom,recommended_unit_price_snapshot,delegated_floor_snapshot,absolute_floor_snapshot,offered_unit_price,
           calculated_lead_time_days_snapshot,client_delivery_commitment_days,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [revisionId,source.id,source.pricing_input_line_id,seller.stable_item_key || client.stable_item_key,
          Number(seller.line_number || client.line_number || index + 1),JSON.stringify(seller.requested_identity || {}),
          JSON.stringify({ technical_identity: seller.technical_identity || {},fulfillment_type: fulfillmentType }),JSON.stringify(client),
          JSON.stringify({ pricing_decision_id: pricingDecisionId,pricing_decision_hash: decision.decision_hash,pricing_decision_line_id: source.id,pricing_input_line_id: source.pricing_input_line_id }),
          fulfillmentType,defaultDisclosurePolicy(fulfillmentType),partNumber,clientLineDescription(client,seller),
          Number(client.quantity || seller.client_quantity),client.uom || seller.uom,source.approved_unit_price,null,null,source.approved_unit_price,
          null,current.client_delivery_commitment_days,index + 1]
      )
    }
    await conn.execute("UPDATE commercial_offers SET current_revision_id=?,pricing_case_id=?,aggregate_status='NEGOTIATION_IN_PROGRESS',row_version=row_version+1 WHERE id=?", [revisionId,decision.pricing_case_id,offerId])
    await addEvent(conn,offerId,'commercial_offer_revision_created_from_pricing_decision','commercial_offer_revision',revisionId,actorId,{ previous_revision_id: current.id,pricing_decision_id: pricingDecisionId,pricing_decision_hash: decision.decision_hash,line_count: sourceLines.length })
    await conn.commit()
    return { offer_id: offerId,revision_id: revisionId,revision_number: Number(sequence.next_number),source_pricing_decision_id: pricingDecisionId,status: 'DRAFT',line_count: sourceLines.length }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function patchRevision(revisionIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const revision = await loadRevision(revisionIdInput, conn, true)
    if (revision.status !== 'DRAFT') throw new CommercialOfferDomainError('REVISION_IMMUTABLE', 'Редактировать можно только DRAFT revision', 409)
    if (payload.row_version != null && Number(payload.row_version) !== Number(revision.row_version)) throw new CommercialOfferDomainError('REVISION_CONFLICT', 'Revision была изменена другим пользователем', 409)
    const fields = []
    const values = []
    for (const field of REVISION_EDITABLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload,field)) continue
      fields.push(`${field}=?`)
      values.push(field === 'payment_policy_snapshot_json'
        ? JSON.stringify(paymentPolicySnapshot(payload[field]))
        : field.endsWith('_days') && payload[field] != null ? Number(payload[field]) : cleanText(payload[field]))
    }
    if (!fields.length) throw new CommercialOfferDomainError('NO_CHANGES', 'Нет разрешённых изменений')
    await conn.execute(`UPDATE commercial_offer_revisions SET ${fields.join(',')},row_version=row_version+1 WHERE id=?`, [...values,revision.id])
    await conn.execute("UPDATE commercial_approval_requests SET status='CANCELLED' WHERE commercial_offer_revision_id=? AND status IN ('DRAFT','SUBMITTED','RETURNED') AND approval_type IN ('TERMS','LEAD_TIME')", [revision.id])
    await addEvent(conn,revision.commercial_offer_id,'commercial_offer_revision_updated','commercial_offer_revision',revision.id,actorId,{ fields: fields.map((field) => field.split('=')[0]) })
    await conn.commit()
    return { revision_id: revision.id,status: 'DRAFT',row_version: Number(revision.row_version) + 1 }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function createApproval(conn, revision, line, type, payload, actorId) {
  const reason = cleanText(payload.reason)
  if (!reason) throw new CommercialOfferDomainError('APPROVAL_REASON_REQUIRED', 'Укажите обоснование исключения')
  const [insert] = await conn.execute(
    `INSERT INTO commercial_approval_requests
      (commercial_offer_revision_id,commercial_offer_line_id,approval_type,status,requested_value_json,baseline_value_json,
       threshold_value_json,policy_version,reason,requester_user_id)
     VALUES (?,?,?,'SUBMITTED',?,?,?,?,?,?)`,
    [revision.id,line?.id || null,type,JSON.stringify(payload.requested_value || {}),JSON.stringify(payload.baseline_value || {}),
      JSON.stringify(payload.threshold_value || {}),'commercial-authority-v1',reason,actorId]
  )
  await addEvent(conn,revision.commercial_offer_id,'commercial_approval_submitted','commercial_approval_request',insert.insertId,actorId,{ approval_type: type,line_id: line?.id || null })
  return insert.insertId
}

async function patchLine(lineIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const lineId = toId(lineIdInput)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[line]] = await conn.execute(
      `SELECT l.*,r.status AS revision_status,r.commercial_offer_id,r.row_version AS revision_row_version
         FROM commercial_offer_lines l JOIN commercial_offer_revisions r ON r.id=l.commercial_offer_revision_id
        WHERE l.id=? FOR UPDATE`, [lineId]
    )
    if (!line) throw new CommercialOfferDomainError('LINE_NOT_FOUND', 'Commercial Offer Line не найдена', 404)
    if (line.revision_status !== 'DRAFT') throw new CommercialOfferDomainError('REVISION_IMMUTABLE', 'Issued/review revision неизменяема; создайте новую revision', 409)
    const offeredPrice = payload.offered_unit_price == null ? Number(line.offered_unit_price) : Number(payload.offered_unit_price)
    const offeredQuantity = payload.offered_quantity == null ? Number(line.offered_quantity) : Number(payload.offered_quantity)
    if (!Number.isFinite(offeredPrice) || offeredPrice < 0 || !Number.isFinite(offeredQuantity) || offeredQuantity <= 0) throw new CommercialOfferDomainError('LINE_VALUE_INVALID', 'Некорректная цена или количество')
    const disclosurePolicy = payload.disclosure_policy || line.disclosure_policy
    if (!DISCLOSURE_POLICIES.has(disclosurePolicy)) throw new CommercialOfferDomainError('DISCLOSURE_POLICY_INVALID', 'Некорректная disclosure policy')
    if (line.fulfillment_type !== 'EXACT_REQUESTED_ITEM' && disclosurePolicy === 'SHOW_EXACT_EXECUTION') throw new CommercialOfferDomainError('EQUIVALENT_DISCLOSURE_INVALID', 'Эквивалент нельзя представить как exact requested item', 409)
    const authority = priceAuthority(line,offeredPrice)
    if (authority === 'PRICING_REEVALUATION_REQUIRED') throw new CommercialOfferDomainError('PRICING_REEVALUATION_REQUIRED', 'Цена ниже absolute floor требует новой Pricing Decision', 409)
    await conn.execute(
      `UPDATE commercial_offer_lines SET client_display_part_number=?,client_display_description=?,offered_quantity=?,
       offered_unit_price=?,client_delivery_commitment_days=?,disclosure_policy=?,line_status=?,override_reason=? WHERE id=?`,
      [Object.prototype.hasOwnProperty.call(payload,'client_display_part_number') ? cleanText(payload.client_display_part_number) : line.client_display_part_number,
        Object.prototype.hasOwnProperty.call(payload,'client_display_description') ? cleanText(payload.client_display_description) : line.client_display_description,
        offeredQuantity,offeredPrice,Object.prototype.hasOwnProperty.call(payload,'client_delivery_commitment_days') ? Number(payload.client_delivery_commitment_days) : line.client_delivery_commitment_days,
        disclosurePolicy,payload.line_status || line.line_status,cleanText(payload.reason) || line.override_reason,lineId]
    )
    await conn.execute("UPDATE commercial_approval_requests SET status='CANCELLED' WHERE commercial_offer_line_id=? AND status IN ('DRAFT','SUBMITTED','RETURNED')", [lineId])
    const revision = { id: line.commercial_offer_revision_id,commercial_offer_id: line.commercial_offer_id }
    const approvalIds = []
    if (authority === 'APPROVAL_REQUIRED') approvalIds.push(await createApproval(conn,revision,line,'PRICE',{
      reason: payload.reason,requested_value: { offered_unit_price: offeredPrice },
      baseline_value: { recommended_unit_price: line.recommended_unit_price_snapshot },
      threshold_value: { delegated_floor: line.delegated_floor_snapshot ?? line.recommended_unit_price_snapshot,absolute_floor: line.absolute_floor_snapshot },
    },actorId))
    if (disclosurePolicy === 'CUSTOM_APPROVED_PRESENTATION') approvalIds.push(await createApproval(conn,revision,line,'DISCLOSURE',{
      reason: payload.reason,requested_value: { disclosure_policy: disclosurePolicy,description: cleanText(payload.client_display_description) || line.client_display_description },
      baseline_value: { disclosure_policy: line.disclosure_policy },threshold_value: { validation: 'manual_approval' },
    },actorId))
    await conn.execute('UPDATE commercial_offer_revisions SET row_version=row_version+1 WHERE id=?', [line.commercial_offer_revision_id])
    await addEvent(conn,line.commercial_offer_id,'commercial_offer_line_updated','commercial_offer_line',lineId,actorId,{ authority,approval_ids: approvalIds })
    await conn.commit()
    return { line_id: lineId,authority,approval_ids: approvalIds }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function requestApproval(revisionIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (!['DRAFT','INTERNAL_REVIEW'].includes(revision.status)) throw new CommercialOfferDomainError('APPROVAL_NOT_ALLOWED', 'Approval доступен только до выпуска revision', 409)
    const type = String(payload.approval_type || '').toUpperCase()
    if (!['PRICE','LEAD_TIME','TERMS','DISCLOSURE'].includes(type)) throw new CommercialOfferDomainError('APPROVAL_TYPE_INVALID', 'Некорректный тип approval')
    let line = null
    if (payload.line_id) {
      const [[row]] = await conn.execute('SELECT * FROM commercial_offer_lines WHERE id=? AND commercial_offer_revision_id=?', [toId(payload.line_id),revision.id])
      if (!row) throw new CommercialOfferDomainError('LINE_NOT_FOUND', 'Строка revision не найдена', 404)
      line = row
    }
    const approvalId = await createApproval(conn,revision,line,type,payload,actorId)
    await conn.execute("UPDATE commercial_offer_revisions SET status='INTERNAL_REVIEW',row_version=row_version+1 WHERE id=?", [revision.id])
    await conn.execute("UPDATE commercial_offers SET aggregate_status='INTERNAL_REVIEW',row_version=row_version+1 WHERE id=?", [revision.commercial_offer_id])
    await conn.commit()
    return { approval_id: approvalId,status: 'SUBMITTED' }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function decideApproval(approvalIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const approvalId = toId(approvalIdInput)
  const action = String(payload.action || '').toUpperCase()
  const status = { APPROVE: 'APPROVED',REJECT: 'REJECTED',RETURN: 'RETURNED' }[action]
  if (!status) throw new CommercialOfferDomainError('APPROVAL_ACTION_INVALID', 'Используйте APPROVE, REJECT или RETURN')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[approval]] = await conn.execute(
      `SELECT a.*,r.commercial_offer_id,r.status AS revision_status FROM commercial_approval_requests a
       JOIN commercial_offer_revisions r ON r.id=a.commercial_offer_revision_id WHERE a.id=? FOR UPDATE`, [approvalId]
    )
    if (!approval || !['SUBMITTED','RETURNED'].includes(approval.status)) throw new CommercialOfferDomainError('APPROVAL_NOT_DECIDABLE', 'Approval уже решён или не найден', 409)
    if (!['DRAFT','INTERNAL_REVIEW'].includes(approval.revision_status)) throw new CommercialOfferDomainError('REVISION_IMMUTABLE', 'Нельзя изменить approval выпущенной revision', 409)
    await conn.execute('UPDATE commercial_approval_requests SET status=?,approver_user_id=?,decision_comment=?,decided_at=CURRENT_TIMESTAMP(6) WHERE id=?', [status,actorId,cleanText(payload.comment),approvalId])
    await addEvent(conn,approval.commercial_offer_id,`commercial_approval_${status.toLowerCase()}`,'commercial_approval_request',approvalId,actorId,{ comment: cleanText(payload.comment) })
    await conn.commit()
    return { approval_id: approvalId,status }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function submitReview(revisionIdInput, actorUserId) {
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (revision.status !== 'DRAFT') throw new CommercialOfferDomainError('REVISION_NOT_DRAFT', 'Review начинается только из DRAFT', 409)
    await conn.execute("UPDATE commercial_offer_revisions SET status='INTERNAL_REVIEW',row_version=row_version+1 WHERE id=?", [revision.id])
    await conn.execute("UPDATE commercial_offers SET aggregate_status='INTERNAL_REVIEW',row_version=row_version+1 WHERE id=?", [revision.commercial_offer_id])
    await addEvent(conn,revision.commercial_offer_id,'commercial_offer_review_submitted','commercial_offer_revision',revision.id,actorId)
    await conn.commit()
    return { revision_id: revision.id,status: 'INTERNAL_REVIEW' }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function markReady(revisionIdInput, actorUserId) {
  const actorId = requireActor(actorUserId)
  const revision = await loadRevision(revisionIdInput)
  if (revision.status !== 'INTERNAL_REVIEW') throw new CommercialOfferDomainError('REVISION_NOT_IN_REVIEW', 'Readiness фиксируется после Internal Review', 409)
  const readiness = await evaluateReadiness(revision.id)
  if (!readiness.ready) throw new CommercialOfferDomainError('REVISION_NOT_READY', 'Commercial Offer не готов к выпуску', 409,readiness)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute("UPDATE commercial_offer_revisions SET status='READY_TO_SEND',content_hash=?,row_version=row_version+1 WHERE id=? AND status='INTERNAL_REVIEW'", [readiness.preview_hash,revision.id])
    await conn.execute("UPDATE commercial_offers SET aggregate_status='READY_TO_SEND',row_version=row_version+1 WHERE id=?", [revision.commercial_offer_id])
    await addEvent(conn,revision.commercial_offer_id,'commercial_offer_ready_to_send','commercial_offer_revision',revision.id,actorId,{ preview_hash: readiness.preview_hash,warnings: readiness.warnings })
    await conn.commit()
    return { revision_id: revision.id,status: 'READY_TO_SEND',readiness }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

function renderClientHtml(payload) {
  const lineRows = payload.lines.map((line) => `<tr><td>${escapeHtml(line.line_number)}</td><td>${escapeHtml(line.part_number || '')}</td><td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.quantity)} ${escapeHtml(line.uom)}</td><td>${escapeHtml(line.unit_price)} ${escapeHtml(line.currency)}</td><td>${escapeHtml(line.line_total)} ${escapeHtml(line.currency)}</td></tr>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(payload.offer_number)}</title></head><body><h1>Commercial Offer ${escapeHtml(payload.offer_number)} · R${escapeHtml(payload.revision_number)}</h1><p>Client: ${escapeHtml(payload.client?.company_name || '—')}</p><table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>#</th><th>Part</th><th>Description</th><th>Quantity</th><th>Unit price</th><th>Total</th></tr></thead><tbody>${lineRows}</tbody></table><h2>Terms</h2><p>Validity: ${escapeHtml(payload.validity_until || '—')}</p><p>Payment: ${escapeHtml(payload.payment_terms || '—')}</p><p>Incoterms / destination: ${escapeHtml(payload.incoterms || '—')} / ${escapeHtml(payload.destination || '—')}</p><p>Delivery: ${escapeHtml(payload.delivery_commitment_days ?? '—')} days</p><p>Warranty: ${escapeHtml(payload.warranty_terms || '—')}</p><p>Partial delivery: ${escapeHtml(payload.partial_delivery_terms || '—')}</p></body></html>`
}

async function renderDocument(revisionIdInput, actorUserId) {
  const actorId = requireActor(actorUserId)
  const preview = await buildClientPreview(revisionIdInput)
  const html = renderClientHtml(preview.payload)
  const documentHash = sha256({ payload: preview.payload,html,template_version: 'commercial-offer-html-v1' })
  const [insert] = await db.execute(
    `INSERT INTO commercial_offer_document_generations
      (commercial_offer_revision_id,template_version,format,client_payload_json,rendered_content,document_hash,generated_by_user_id)
     VALUES (?,'commercial-offer-html-v1','HTML',?,?,?,?)`,
    [preview.revision.id,JSON.stringify(preview.payload),html,documentHash,actorId]
  )
  await addEvent(db,preview.revision.commercial_offer_id,'commercial_offer_document_generated','commercial_offer_document_generation',insert.insertId,actorId,{ document_hash: documentHash,preview_hash: preview.payload_hash })
  return { generation_id: insert.insertId,format: 'HTML',document_hash: documentHash,client_payload: preview.payload,rendered_content: html,confidentiality_findings: preview.confidentiality_findings }
}

async function sendRevision(revisionIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const revisionId = toId(revisionIdInput)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const revision = await loadRevision(revisionId,conn,true)
    if (revision.status !== 'READY_TO_SEND') throw new CommercialOfferDomainError('REVISION_NOT_READY_TO_SEND', 'Выпуск возможен только из READY_TO_SEND', 409)
    const readiness = await evaluateReadiness(revision.id,conn)
    if (!readiness.ready) throw new CommercialOfferDomainError('REVISION_NOT_READY', 'Readiness изменилась; выпуск заблокирован', 409,readiness)
    const preview = await buildClientPreview(revision.id,conn)
    const recipients = Array.isArray(payload.recipients) ? payload.recipients.map(cleanText).filter(Boolean) : []
    if (!recipients.length) throw new CommercialOfferDomainError('RECIPIENT_REQUIRED', 'Укажите получателя immutable send snapshot')
    const html = renderClientHtml(preview.payload)
    const documentHash = sha256({ payload: preview.payload,html,template_version: 'commercial-offer-html-v1' })
    const [generation] = await conn.execute(
      `INSERT INTO commercial_offer_document_generations
        (commercial_offer_revision_id,template_version,format,client_payload_json,rendered_content,document_hash,generated_by_user_id)
       VALUES (?,'commercial-offer-html-v1','HTML',?,?,?,?)`,
      [revision.id,JSON.stringify(preview.payload),html,documentHash,actorId]
    )
    const snapshotHash = sha256({ payload: preview.payload,recipients,subject: cleanText(payload.subject),body: cleanText(payload.body),channel: String(payload.channel || 'MANUAL').toUpperCase() })
    const [sent] = await conn.execute(
      `INSERT INTO commercial_sent_offer_snapshots
        (commercial_offer_revision_id,document_generation_id,snapshot_payload_json,recipients_json,subject_snapshot,body_snapshot,channel,snapshot_hash,sent_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [revision.id,generation.insertId,JSON.stringify(preview.payload),JSON.stringify(recipients),cleanText(payload.subject),cleanText(payload.body),String(payload.channel || 'MANUAL').toUpperCase(),snapshotHash,actorId]
    )
    await conn.execute("UPDATE commercial_offer_revisions SET status='ISSUED',content_hash=?,issued_by_user_id=?,issued_at=CURRENT_TIMESTAMP(6),row_version=row_version+1 WHERE id=?", [preview.payload_hash,actorId,revision.id])
    if (revision.supersedes_revision_id) await conn.execute("UPDATE commercial_offer_revisions SET status='SUPERSEDED' WHERE id=? AND status='ISSUED'", [revision.supersedes_revision_id])
    await conn.execute("UPDATE commercial_offers SET aggregate_status='AWAITING_CLIENT',row_version=row_version+1 WHERE id=?", [revision.commercial_offer_id])
    await addEvent(conn,revision.commercial_offer_id,'commercial_offer_revision_sent','commercial_sent_offer_snapshot',sent.insertId,actorId,{ revision_id: revision.id,snapshot_hash: snapshotHash,document_hash: documentHash })
    await conn.commit()
    return { sent_snapshot_id: sent.insertId,revision_id: revision.id,status: 'ISSUED',aggregate_status: 'AWAITING_CLIENT',snapshot_hash: snapshotHash,document_hash: documentHash }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function registerFeedback(offerIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const offerId = toId(offerIdInput)
  const sentSnapshotId = toId(payload.sent_snapshot_id)
  const evidence = cleanText(payload.evidence_reference)
  if (!sentSnapshotId || !evidence || !Array.isArray(payload.lines) || !payload.lines.length) throw new CommercialOfferDomainError('FEEDBACK_INVALID', 'Укажите sent snapshot, evidence и line outcomes')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[snapshot]] = await conn.execute(
      `SELECT s.*,r.commercial_offer_id FROM commercial_sent_offer_snapshots s
       JOIN commercial_offer_revisions r ON r.id=s.commercial_offer_revision_id
       WHERE s.id=? AND r.commercial_offer_id=? FOR UPDATE`, [sentSnapshotId,offerId]
    )
    if (!snapshot) throw new CommercialOfferDomainError('SENT_SNAPSHOT_NOT_FOUND', 'Sent snapshot не принадлежит Commercial Offer', 404)
    const [validLines] = await conn.execute('SELECT * FROM commercial_offer_lines WHERE commercial_offer_revision_id=? AND line_status=\'ACTIVE\'', [snapshot.commercial_offer_revision_id])
    const byId = new Map(validLines.map((line) => [Number(line.id),line]))
    const outcomes = new Set(['ACCEPTED_AS_OFFERED','CHANGE_REQUESTED','REJECTED','NOT_REQUIRED','CLARIFICATION'])
    for (const line of payload.lines) if (!byId.has(toId(line.line_id)) || !outcomes.has(String(line.result || '').toUpperCase())) throw new CommercialOfferDomainError('FEEDBACK_LINE_INVALID', 'Feedback содержит строку или outcome вне sent revision')
    const [insert] = await conn.execute(
      `INSERT INTO commercial_client_feedback
        (commercial_offer_id,sent_offer_snapshot_id,received_at,channel,evidence_reference,overall_note,registered_by_user_id)
       VALUES (?,?,?,?,?,?,?)`,
      [offerId,sentSnapshotId,payload.received_at ? new Date(payload.received_at) : new Date(),String(payload.channel || 'OTHER').toUpperCase(),evidence,cleanText(payload.overall_note),actorId]
    )
    for (const item of payload.lines) await conn.execute(
      `INSERT INTO commercial_client_feedback_lines
        (client_feedback_id,commercial_offer_line_id,result,requested_quantity,requested_unit_price,requested_execution_text,requested_delivery_days,comment)
       VALUES (?,?,?,?,?,?,?,?)`,
      [insert.insertId,toId(item.line_id),String(item.result).toUpperCase(),item.requested_quantity ?? null,item.requested_unit_price ?? null,cleanText(item.requested_execution_text),item.requested_delivery_days ?? null,cleanText(item.comment)]
    )
    const resultValues = payload.lines.map((line) => String(line.result).toUpperCase())
    const aggregate = resultValues.some((value) => ['CHANGE_REQUESTED','CLARIFICATION'].includes(value)) ? 'CHANGE_REQUESTED'
      : resultValues.every((value) => value === 'REJECTED' || value === 'NOT_REQUIRED') ? 'REJECTED'
        : resultValues.every((value) => value === 'ACCEPTED_AS_OFFERED') && payload.lines.length === validLines.length ? 'AWAITING_CLIENT'
          : 'PARTIALLY_ACCEPTED'
    await conn.execute('UPDATE commercial_offers SET aggregate_status=?,row_version=row_version+1 WHERE id=?', [aggregate,offerId])
    await addEvent(conn,offerId,'client_feedback_received','commercial_client_feedback',insert.insertId,actorId,{ sent_snapshot_id: sentSnapshotId,line_count: payload.lines.length,aggregate_status: aggregate })
    await conn.commit()
    return { feedback_id: insert.insertId,status: 'REGISTERED',aggregate_status: aggregate }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function assessFeedback(feedbackIdInput, actorUserId) {
  const actorId = requireActor(actorUserId)
  const feedbackId = toId(feedbackIdInput)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[feedback]] = await conn.execute('SELECT * FROM commercial_client_feedback WHERE id=? FOR UPDATE', [feedbackId])
    if (!feedback) throw new CommercialOfferDomainError('FEEDBACK_NOT_FOUND', 'Client Feedback не найден', 404)
    const [rows] = await conn.execute(
      `SELECT fl.*,l.offered_quantity,l.offered_unit_price,l.recommended_unit_price_snapshot,l.delegated_floor_snapshot,
              l.absolute_floor_snapshot,l.client_delivery_commitment_days
         FROM commercial_client_feedback_lines fl JOIN commercial_offer_lines l ON l.id=fl.commercial_offer_line_id
        WHERE fl.client_feedback_id=? ORDER BY fl.id`, [feedbackId]
    )
    const assessments = []
    for (const row of rows) {
      const assessment = assessFeedbackChange(row,row)
      const [insert] = await conn.execute(
        `INSERT INTO commercial_change_impact_assessments
          (client_feedback_id,client_feedback_line_id,affected_domains_json,reason_codes_json,required_action,resolver_version,input_change_snapshot_json,assessed_by_user_id)
         VALUES (?,?,?,?,?,'commercial-change-impact-v1',?,?)
         ON DUPLICATE KEY UPDATE affected_domains_json=VALUES(affected_domains_json),reason_codes_json=VALUES(reason_codes_json),
           required_action=VALUES(required_action),resolver_version=VALUES(resolver_version),input_change_snapshot_json=VALUES(input_change_snapshot_json),
           assessed_by_user_id=VALUES(assessed_by_user_id),assessed_at=CURRENT_TIMESTAMP(6)`,
        [feedbackId,row.id,JSON.stringify(assessment.affected_domains),JSON.stringify(assessment.reason_codes),assessment.required_action,
          JSON.stringify({ result: row.result,requested_quantity: row.requested_quantity,requested_unit_price: row.requested_unit_price,requested_execution_text: row.requested_execution_text,requested_delivery_days: row.requested_delivery_days }),actorId]
      )
      assessments.push({ id: insert.insertId || null,feedback_line_id: row.id,...assessment })
    }
    await conn.execute("UPDATE commercial_client_feedback SET status='ASSESSED' WHERE id=?", [feedbackId])
    await addEvent(conn,feedback.commercial_offer_id,'commercial_change_impact_assessed','commercial_client_feedback',feedbackId,actorId,{ assessments })
    await conn.commit()
    return { feedback_id: feedbackId,status: 'ASSESSED',assessments }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function createNextRevision(feedbackIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const feedbackId = toId(feedbackIdInput)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[feedback]] = await conn.execute(
      `SELECT f.*,s.commercial_offer_revision_id FROM commercial_client_feedback f
       JOIN commercial_sent_offer_snapshots s ON s.id=f.sent_offer_snapshot_id WHERE f.id=? FOR UPDATE`, [feedbackId]
    )
    if (!feedback || feedback.status !== 'ASSESSED') throw new CommercialOfferDomainError('FEEDBACK_NOT_ASSESSED', 'Сначала выполните Change Impact Assessment', 409)
    const [assessments] = await conn.execute('SELECT * FROM commercial_change_impact_assessments WHERE client_feedback_id=?', [feedbackId])
    const upstream = assessments.filter((item) => item.required_action === 'UPSTREAM_REVISION_REQUIRED')
    if (upstream.length) throw new CommercialOfferDomainError('UPSTREAM_REVISION_REQUIRED', 'Изменения требуют новой Pricing/Sourcing/Client Request revision', 409,{ assessment_ids: upstream.map((item) => item.id) })
    const source = await loadRevision(feedback.commercial_offer_revision_id,conn)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(revision_number),0)+1 AS next_number FROM commercial_offer_revisions WHERE commercial_offer_id=? FOR UPDATE', [feedback.commercial_offer_id])
    const [insert] = await conn.execute(
      `INSERT INTO commercial_offer_revisions
        (commercial_offer_id,revision_number,source_pricing_decision_id,source_pricing_decision_hash,status,currency,validity_until,
         payment_terms,payment_policy_snapshot_json,incoterms,destination,client_delivery_commitment_days,warranty_terms,packaging_terms,partial_delivery_terms,
         general_text,client_snapshot_json,client_contact_snapshot_json,billing_address_snapshot_json,shipping_address_snapshot_json,
         company_legal_snapshot_json,supersedes_revision_id,created_by_user_id)
       SELECT commercial_offer_id,?,source_pricing_decision_id,source_pricing_decision_hash,'DRAFT',currency,validity_until,
         payment_terms,payment_policy_snapshot_json,incoterms,destination,client_delivery_commitment_days,warranty_terms,packaging_terms,partial_delivery_terms,
         general_text,client_snapshot_json,client_contact_snapshot_json,billing_address_snapshot_json,shipping_address_snapshot_json,
         company_legal_snapshot_json,id,?
       FROM commercial_offer_revisions WHERE id=?`, [sequence.next_number,actorId,source.id]
    )
    const revisionId = insert.insertId
    const [sourceLines] = await conn.execute('SELECT * FROM commercial_offer_lines WHERE commercial_offer_revision_id=? ORDER BY sort_order,line_number,id', [source.id])
    const [feedbackLines] = await conn.execute('SELECT * FROM commercial_client_feedback_lines WHERE client_feedback_id=?', [feedbackId])
    const byLine = new Map(feedbackLines.map((line) => [Number(line.commercial_offer_line_id),line]))
    for (const line of sourceLines) {
      const change = byLine.get(Number(line.id))
      const excluded = change && ['REJECTED','NOT_REQUIRED'].includes(change.result)
      const offeredPrice = change?.requested_unit_price ?? line.offered_unit_price
      const [lineInsert] = await conn.execute(
        `INSERT INTO commercial_offer_lines
          (commercial_offer_revision_id,source_pricing_decision_line_id,source_pricing_input_line_id,stable_item_key_snapshot,line_number,
           requested_identity_snapshot_json,offered_execution_snapshot_json,pricing_client_projection_snapshot_json,source_trace_snapshot_json,
           fulfillment_type,disclosure_policy,client_display_part_number,client_display_description,offered_quantity,uom,
           recommended_unit_price_snapshot,delegated_floor_snapshot,absolute_floor_snapshot,offered_unit_price,calculated_lead_time_days_snapshot,
           client_delivery_commitment_days,line_status,override_reason,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [revisionId,line.source_pricing_decision_line_id,line.source_pricing_input_line_id,line.stable_item_key_snapshot,line.line_number,
          line.requested_identity_snapshot_json,line.offered_execution_snapshot_json,line.pricing_client_projection_snapshot_json,line.source_trace_snapshot_json,
          line.fulfillment_type,line.disclosure_policy,line.client_display_part_number,line.client_display_description,line.offered_quantity,line.uom,
          line.recommended_unit_price_snapshot,line.delegated_floor_snapshot,line.absolute_floor_snapshot,offeredPrice,line.calculated_lead_time_days_snapshot,
          change?.requested_delivery_days ?? line.client_delivery_commitment_days,excluded ? 'EXCLUDED' : 'ACTIVE',cleanText(change?.comment) || line.override_reason,line.sort_order]
      )
      if (!excluded && priceAuthority(line,offeredPrice) === 'APPROVAL_REQUIRED') await createApproval(conn,{ id: revisionId,commercial_offer_id: feedback.commercial_offer_id },{ id: lineInsert.insertId },'PRICE',{
        reason: cleanText(change?.comment) || 'Client requested price change',requested_value: { offered_unit_price: Number(offeredPrice) },
        baseline_value: { recommended_unit_price: line.recommended_unit_price_snapshot },threshold_value: { delegated_floor: line.delegated_floor_snapshot ?? line.recommended_unit_price_snapshot,absolute_floor: line.absolute_floor_snapshot },
      },actorId)
    }
    await conn.execute("UPDATE commercial_offers SET current_revision_id=?,aggregate_status='NEGOTIATION_IN_PROGRESS',row_version=row_version+1 WHERE id=?", [revisionId,feedback.commercial_offer_id])
    await addEvent(conn,feedback.commercial_offer_id,'commercial_offer_revision_created_from_feedback','commercial_offer_revision',revisionId,actorId,{ feedback_id: feedbackId,supersedes_revision_id: source.id })
    await conn.commit()
    return { revision_id: revisionId,revision_number: Number(sequence.next_number),status: 'DRAFT' }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function acceptFeedback(offerIdInput, payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const offerId = toId(offerIdInput)
  const feedbackId = toId(payload.feedback_id)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[feedback]] = await conn.execute(
      `SELECT f.*,s.commercial_offer_revision_id,s.snapshot_hash,s.snapshot_payload_json
         FROM commercial_client_feedback f JOIN commercial_sent_offer_snapshots s ON s.id=f.sent_offer_snapshot_id
        WHERE f.id=? AND f.commercial_offer_id=? FOR UPDATE`, [feedbackId,offerId]
    )
    if (!feedback) throw new CommercialOfferDomainError('FEEDBACK_NOT_FOUND', 'Client Feedback не найден', 404)
    const [acceptedRows] = await conn.execute(
      `SELECT fl.*,l.* FROM commercial_client_feedback_lines fl JOIN commercial_offer_lines l ON l.id=fl.commercial_offer_line_id
       WHERE fl.client_feedback_id=? AND fl.result='ACCEPTED_AS_OFFERED' ORDER BY l.sort_order,l.line_number,l.id`, [feedbackId]
    )
    if (!acceptedRows.length) throw new CommercialOfferDomainError('NO_ACCEPTED_LINES', 'Нет строк, принятых без изменения', 409)
    const [[revision]] = await conn.execute('SELECT * FROM commercial_offer_revisions WHERE id=?', [feedback.commercial_offer_revision_id])
    const [allActive] = await conn.execute("SELECT id FROM commercial_offer_lines WHERE commercial_offer_revision_id=? AND line_status='ACTIVE'", [revision.id])
    const terms = { currency: revision.currency,validity_until: revision.validity_until,payment_terms: revision.payment_terms,payment_policy: parseJson(revision.payment_policy_snapshot_json),incoterms: revision.incoterms,destination: revision.destination,delivery_commitment_days: revision.client_delivery_commitment_days,warranty_terms: revision.warranty_terms,packaging_terms: revision.packaging_terms,partial_delivery_terms: revision.partial_delivery_terms,company_legal_snapshot: parseJson(revision.company_legal_snapshot_json),client_snapshot: parseJson(revision.client_snapshot_json),client_contact_snapshot: parseJson(revision.client_contact_snapshot_json),billing_address_snapshot: parseJson(revision.billing_address_snapshot_json),shipping_address_snapshot: parseJson(revision.shipping_address_snapshot_json) }
    const acceptedLinesHashInput = acceptedRows.map((line) => ({ source_offer_line_id: line.commercial_offer_line_id,quantity: line.offered_quantity,unit_price: line.offered_unit_price,source_pricing_decision_line_id: line.source_pricing_decision_line_id }))
    const acceptanceHash = sha256({ offer_id: offerId,revision_id: revision.id,sent_snapshot_id: feedback.sent_offer_snapshot_id,sent_snapshot_hash: feedback.snapshot_hash,feedback_id: feedbackId,lines: acceptedLinesHashInput,terms })
    const total = acceptedRows.reduce((sum,line) => sum + Number(line.offered_quantity) * Number(line.offered_unit_price),0)
    const [insert] = await conn.execute(
      `INSERT INTO commercial_accepted_revisions
        (commercial_offer_id,accepted_offer_revision_id,accepted_sent_snapshot_id,client_feedback_id,acceptance_evidence_reference,
         accepted_at,accepted_by_external_text,aggregate_total,currency,terms_snapshot_json,acceptance_hash,created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [offerId,revision.id,feedback.sent_offer_snapshot_id,feedbackId,feedback.evidence_reference,payload.accepted_at ? new Date(payload.accepted_at) : feedback.received_at,
        cleanText(payload.accepted_by_external_text),total,revision.currency,JSON.stringify(terms),acceptanceHash,actorId]
    )
    for (const line of acceptedRows) await conn.execute(
      `INSERT INTO commercial_accepted_lines
        (accepted_commercial_revision_id,source_offer_line_id,source_pricing_decision_line_id,accepted_quantity,accepted_unit_price,currency,
         accepted_execution_snapshot_json,client_representation_snapshot_json,fulfillment_type,delivery_commitment_days,line_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [insert.insertId,line.commercial_offer_line_id,line.source_pricing_decision_line_id,line.offered_quantity,line.offered_unit_price,revision.currency,
        line.offered_execution_snapshot_json,JSON.stringify({ part_number: line.client_display_part_number,description: line.client_display_description,disclosure_policy: line.disclosure_policy }),
        line.fulfillment_type,line.client_delivery_commitment_days ?? revision.client_delivery_commitment_days,Number(line.offered_quantity) * Number(line.offered_unit_price)]
    )
    const complete = acceptedRows.length === allActive.length
    if (complete) await conn.execute("UPDATE commercial_offer_revisions SET status='ACCEPTED' WHERE id=?", [revision.id])
    await conn.execute('UPDATE commercial_client_feedback SET status=\'CLOSED\' WHERE id=?', [feedbackId])
    await conn.execute('UPDATE commercial_offers SET aggregate_status=?,row_version=row_version+1 WHERE id=?', [complete ? 'ACCEPTED' : 'PARTIALLY_ACCEPTED',offerId])
    await addEvent(conn,offerId,'commercial_offer_accepted','commercial_accepted_revision',insert.insertId,actorId,{ revision_id: revision.id,sent_snapshot_id: feedback.sent_offer_snapshot_id,accepted_line_count: acceptedRows.length,complete,acceptance_hash: acceptanceHash })
    await conn.commit()
    return { accepted_revision_id: insert.insertId,status: 'FIXED',aggregate_status: complete ? 'ACCEPTED' : 'PARTIALLY_ACCEPTED',accepted_line_count: acceptedRows.length,aggregate_total: total,currency: revision.currency,acceptance_hash: acceptanceHash }
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

async function compareRevisions(offerIdInput,fromIdInput,toIdInput) {
  const offerId = toId(offerIdInput)
  const fromId = toId(fromIdInput)
  const toRevisionId = toId(toIdInput)
  const [[from],[toRevision]] = await Promise.all([
    db.execute('SELECT * FROM commercial_offer_revisions WHERE id=? AND commercial_offer_id=?', [fromId,offerId]).then(([rows]) => rows),
    db.execute('SELECT * FROM commercial_offer_revisions WHERE id=? AND commercial_offer_id=?', [toRevisionId,offerId]).then(([rows]) => rows),
  ])
  if (!from || !toRevision) throw new CommercialOfferDomainError('REVISION_NOT_FOUND', 'Revision для сравнения не найдена', 404)
  const [fromLines,toLines] = await Promise.all([
    db.execute('SELECT * FROM commercial_offer_lines WHERE commercial_offer_revision_id=?', [fromId]).then(([rows]) => rows),
    db.execute('SELECT * FROM commercial_offer_lines WHERE commercial_offer_revision_id=?', [toRevisionId]).then(([rows]) => rows),
  ])
  const byKey = (rows) => new Map(rows.map((line) => [line.stable_item_key_snapshot,line]))
  const left = byKey(fromLines); const right = byKey(toLines)
  const keys = [...new Set([...left.keys(),...right.keys()])]
  const lineDiff = keys.map((key) => {
    const before = left.get(key); const after = right.get(key)
    if (!before) return { stable_item_key: key,change: 'ADDED',after }
    if (!after) return { stable_item_key: key,change: 'REMOVED',before }
    const fields = ['line_status','client_display_part_number','client_display_description','offered_quantity','offered_unit_price','disclosure_policy','client_delivery_commitment_days']
    const changed = fields.filter((field) => String(before[field] ?? '') !== String(after[field] ?? '')).map((field) => ({ field,before: before[field],after: after[field] }))
    return { stable_item_key: key,change: changed.length ? 'CHANGED' : 'UNCHANGED',fields: changed }
  })
  const termFields = ['currency','validity_until','payment_terms','incoterms','destination','client_delivery_commitment_days','warranty_terms','packaging_terms','partial_delivery_terms','general_text']
  return { from_revision_id: fromId,to_revision_id: toRevisionId,lines: lineDiff,terms: termFields.filter((field) => String(from[field] ?? '') !== String(toRevision[field] ?? '')).map((field) => ({ field,before: from[field],after: toRevision[field] })) }
}

module.exports = {
  acceptFeedback,
  assessFeedback,
  compareRevisions,
  createFromPricingDecision,
  createRevisionFromPricingDecision,
  createNextRevision,
  decideApproval,
  markReady,
  patchLine,
  patchRevision,
  registerFeedback,
  renderDocument,
  requestApproval,
  sendRevision,
  submitReview,
}
