const db = require('../../utils/db')
const { SourcingDomainError } = require('./domainError')
const { addEvent, cleanText, json, requireActor, toId, toPositiveNumber } = require('./helpers')

const OFFER_SOURCES = new Set(['inquiry', 'email', 'phone', 'portal', 'price_list', 'historic', 'negotiation', 'manual'])
const RELATIONSHIPS = new Set(['exact', 'analog', 'substitute', 'kit', 'component', 'unknown'])
const REPLY_STATUSES = new Set(['quoted', 'no_stock', 'discontinued', 'needs_clarification', 'no_response'])

async function createOffer(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const inquiryId = toId(payload.supplier_inquiry_id)
  const supplierId = toId(payload.supplier_id)
  const lines = Array.isArray(payload.lines) ? payload.lines : []
  if (!caseId || !supplierId || !lines.length) {
    throw new SourcingDomainError('VALIDATION_ERROR', 'Укажите кейс, поставщика и строки предложения')
  }
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[sourcingCase]] = await conn.execute('SELECT * FROM sourcing_cases WHERE id = ? FOR UPDATE', [caseId])
    if (!sourcingCase || ['archived', 'cancelled', 'closed'].includes(sourcingCase.status)) {
      throw new SourcingDomainError('CASE_NOT_ACTIVE', 'Sourcing Case недоступен', 409)
    }
    if (inquiryId) {
      const [[inquiry]] = await conn.execute(
        'SELECT * FROM supplier_inquiries WHERE id = ? AND sourcing_case_id = ?',
        [inquiryId, caseId]
      )
      if (!inquiry || Number(inquiry.supplier_id) !== supplierId) {
        throw new SourcingDomainError('INQUIRY_SUPPLIER_MISMATCH', 'Inquiry не принадлежит кейсу или поставщику', 409)
      }
    } else {
      const [[supplier]] = await conn.execute('SELECT id FROM part_suppliers WHERE id = ?', [supplierId])
      if (!supplier) throw new SourcingDomainError('SUPPLIER_NOT_FOUND', 'Поставщик не найден', 404)
    }
    const demandIds = [...new Set(lines.flatMap((line) => (line.demands || []).map((link) => toId(link.demand_id))).filter(Boolean))]
    if (!demandIds.length) throw new SourcingDomainError('OFFER_TRACE_REQUIRED', 'Каждая цена должна быть связана с потребностью')
    const [demands] = await conn.execute(
      `SELECT * FROM sourcing_demands WHERE sourcing_case_id = ? AND id IN (${demandIds.map(() => '?').join(',')})`,
      [caseId, ...demandIds]
    )
    if (demands.length !== demandIds.length) {
      throw new SourcingDomainError('DEMAND_CASE_MISMATCH', 'Offer ссылается на чужую потребность', 409)
    }
    const demandMap = new Map(demands.map((row) => [Number(row.id), row]))
    const sourceType = OFFER_SOURCES.has(payload.source_type) ? payload.source_type : (inquiryId ? 'inquiry' : 'manual')
    const [offerInsert] = await conn.execute(
      `INSERT INTO supplier_offers
        (sourcing_case_id, supplier_inquiry_id, supplier_id, source_type, status, created_by_user_id)
       VALUES (?, ?, ?, ?, 'draft', ?)`,
      [caseId, inquiryId, supplierId, sourceType, actorId]
    )
    const offerId = offerInsert.insertId
    const [revisionInsert] = await conn.execute(
      `INSERT INTO supplier_offer_revisions
        (supplier_offer_id, revision_number, status, currency, offer_reference,
         source_evidence_json, note, created_by_user_id)
       VALUES (?, 1, 'draft', ?, ?, ?, ?, ?)`,
      [offerId, cleanText(payload.currency)?.toUpperCase() || null, cleanText(payload.offer_reference), json(payload.source_evidence), cleanText(payload.note), actorId]
    )
    for (const line of lines) {
      const links = (line.demands || []).map((link) => ({
        demand_id: toId(link.demand_id),
        capable_quantity: link.capable_quantity == null ? null : toPositiveNumber(link.capable_quantity),
      })).filter((link) => link.demand_id && demandMap.has(link.demand_id))
      if (!links.length) throw new SourcingDomainError('OFFER_LINE_TRACE_REQUIRED', 'Строка Supplier Offer не связана с потребностью')
      const replyStatus = REPLY_STATUSES.has(line.supplier_reply_status) ? line.supplier_reply_status : 'quoted'
      const unitPrice = line.unit_price == null ? null : Number(line.unit_price)
      if (replyStatus === 'quoted' && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
        throw new SourcingDomainError('OFFER_PRICE_REQUIRED', 'Для quoted-строки нужна неотрицательная цена')
      }
      const [lineInsert] = await conn.execute(
        `INSERT INTO supplier_offer_lines
          (supplier_offer_revision_id, supplier_part_id, offered_catalog_position_id,
           relationship_type, supplier_part_number_snapshot, description_snapshot,
           supplier_reply_status, offered_quantity, moq, pack_quantity, unit_price,
           currency, lead_time_days, validity_until, payment_terms, incoterms,
           incoterms_place, origin_country, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          revisionInsert.insertId, toId(line.supplier_part_id), toId(line.offered_catalog_position_id),
          RELATIONSHIPS.has(line.relationship_type) ? line.relationship_type : 'unknown',
          cleanText(line.supplier_part_number), cleanText(line.description), replyStatus,
          line.offered_quantity == null ? null : Number(line.offered_quantity),
          line.moq == null ? null : Number(line.moq),
          line.pack_quantity == null ? null : Number(line.pack_quantity), unitPrice,
          cleanText(line.currency)?.toUpperCase() || cleanText(payload.currency)?.toUpperCase() || null,
          line.lead_time_days == null ? null : Number(line.lead_time_days), line.validity_until || null,
          cleanText(line.payment_terms), cleanText(line.incoterms), cleanText(line.incoterms_place),
          cleanText(line.origin_country)?.toUpperCase() || null, json(line.evidence),
        ]
      )
      for (const link of links) {
        await conn.execute(
          `INSERT INTO supplier_offer_line_demands
            (supplier_offer_line_id, sourcing_demand_id, capable_quantity, match_basis_json)
           VALUES (?, ?, ?, ?)`,
          [lineInsert.insertId, link.demand_id, link.capable_quantity, json({ source: 'explicit_offer_entry' })]
        )
      }
    }
    await addEvent(conn, caseId, 'supplier_offer_created', 'supplier_offer', offerId, actorId, {
      supplier_id: supplierId, inquiry_id: inquiryId, revision_id: revisionInsert.insertId, line_count: lines.length,
    })
    await conn.commit()
    return { offer_id: offerId, revision_id: revisionInsert.insertId, revision_number: 1, status: 'draft' }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function finalizeOffer(offerIdInput, actorUserId) {
  const offerId = toId(offerIdInput)
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[offer]] = await conn.execute('SELECT * FROM supplier_offers WHERE id = ? FOR UPDATE', [offerId])
    if (!offer) throw new SourcingDomainError('OFFER_NOT_FOUND', 'Supplier Offer не найден', 404)
    const [[revision]] = await conn.execute(
      `SELECT * FROM supplier_offer_revisions WHERE supplier_offer_id = ?
        ORDER BY revision_number DESC LIMIT 1 FOR UPDATE`,
      [offerId]
    )
    if (!revision || revision.status !== 'draft') {
      throw new SourcingDomainError('OFFER_REVISION_IMMUTABLE', 'Последняя ревизия уже зафиксирована', 409)
    }
    const [[lineCount]] = await conn.execute(
      'SELECT COUNT(*) AS count FROM supplier_offer_lines WHERE supplier_offer_revision_id = ?',
      [revision.id]
    )
    if (!Number(lineCount.count)) throw new SourcingDomainError('OFFER_EMPTY', 'Supplier Offer не содержит строк', 409)
    await conn.execute(
      `UPDATE supplier_offer_revisions
          SET status = 'finalized', finalized_by_user_id = ?, finalized_at = CURRENT_TIMESTAMP(6)
        WHERE id = ?`,
      [actorId, revision.id]
    )
    await conn.execute(`UPDATE supplier_offers SET status = 'finalized', row_version = row_version + 1 WHERE id = ?`, [offerId])
    if (offer.supplier_inquiry_id) {
      await conn.execute(`UPDATE supplier_inquiries SET status = 'responded', row_version = row_version + 1 WHERE id = ?`, [offer.supplier_inquiry_id])
    }
    await conn.execute(
      `UPDATE sourcing_demands sd
       JOIN supplier_offer_line_demands sold ON sold.sourcing_demand_id = sd.id
       JOIN supplier_offer_lines sol ON sol.id = sold.supplier_offer_line_id
          SET sd.status = 'offers_available', sd.row_version = sd.row_version + 1
        WHERE sol.supplier_offer_revision_id = ? AND sd.status IN ('received', 'strategy_defined', 'sourcing_active')`,
      [revision.id]
    )
    await conn.execute(
      `UPDATE sourcing_cases SET status = 'offer_review', row_version = row_version + 1
        WHERE id = ? AND status NOT IN ('decision_ready', 'decided', 'released_to_pricing')`,
      [offer.sourcing_case_id]
    )
    await addEvent(conn, offer.sourcing_case_id, 'supplier_offer_finalized', 'supplier_offer_revision', revision.id, actorId)
    await conn.commit()
    return { offer_id: offerId, revision_id: revision.id, status: 'finalized' }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

module.exports = { createOffer, finalizeOffer }
