const db = require('../../utils/db')
const { SourcingDomainError } = require('./domainError')
const { addEvent, json, requireActor, toId } = require('./helpers')

async function requestMasterDataPromotion(offerLineIdInput, payload, actorUserId) {
  const offerLineId = toId(offerLineIdInput)
  const actorId = requireActor(actorUserId)
  const requestType = ['supplier_part', 'catalog_relation', 'supplier_price', 'supplier_identity'].includes(payload.request_type)
    ? payload.request_type : null
  if (!offerLineId || !requestType || !payload.proposed_values) {
    throw new SourcingDomainError('VALIDATION_ERROR', 'Укажите источник, тип и предлагаемые значения')
  }
  const [[source]] = await db.execute(
    `SELECT sol.id, so.sourcing_case_id, so.supplier_id, sor.id AS offer_revision_id
       FROM supplier_offer_lines sol
       JOIN supplier_offer_revisions sor ON sor.id = sol.supplier_offer_revision_id
       JOIN supplier_offers so ON so.id = sor.supplier_offer_id
      WHERE sol.id = ?`,
    [offerLineId]
  )
  if (!source) throw new SourcingDomainError('OFFER_LINE_NOT_FOUND', 'Строка Supplier Offer не найдена', 404)
  const [insert] = await db.execute(
    `INSERT INTO supplier_master_data_promotion_requests
      (supplier_offer_line_id, request_type, status, proposed_values_json,
       source_trace_json, requested_by_user_id)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
    [
      offerLineId, requestType, json(payload.proposed_values),
      json({ sourcing_case_id: source.sourcing_case_id, supplier_id: source.supplier_id, offer_revision_id: source.offer_revision_id, offer_line_id: offerLineId }),
      actorId,
    ]
  )
  await addEvent(db, source.sourcing_case_id, 'master_data_promotion_requested', 'supplier_master_data_promotion_request', insert.insertId, actorId, {
    request_type: requestType, supplier_offer_line_id: offerLineId,
  })
  return { promotion_request_id: insert.insertId, status: 'pending' }
}

module.exports = { requestMasterDataPromotion }
