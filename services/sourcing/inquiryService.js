const db = require('../../utils/db')
const { SourcingDomainError } = require('./domainError')
const { addEvent, cleanText, json, requireActor, sha256, toId } = require('./helpers')

async function createInquiry(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const supplierId = toId(payload.supplier_id)
  const actorId = requireActor(actorUserId)
  const demandIds = [...new Set((payload.demand_ids || []).map(toId).filter(Boolean))]
  if (!caseId || !supplierId || !demandIds.length) {
    throw new SourcingDomainError('VALIDATION_ERROR', 'Укажите кейс, поставщика и позиции потребности')
  }
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[sourcingCase]] = await conn.execute('SELECT * FROM sourcing_cases WHERE id = ? FOR UPDATE', [caseId])
    if (!sourcingCase || ['archived', 'cancelled', 'closed'].includes(sourcingCase.status)) {
      throw new SourcingDomainError('CASE_NOT_ACTIVE', 'Sourcing Case недоступен', 409)
    }
    const [demands] = await conn.execute(
      `SELECT * FROM sourcing_demands
        WHERE sourcing_case_id = ? AND id IN (${demandIds.map(() => '?').join(',')})
        ORDER BY line_number_snapshot`,
      [caseId, ...demandIds]
    )
    if (demands.length !== demandIds.length) {
      throw new SourcingDomainError('DEMAND_CASE_MISMATCH', 'Позиции не принадлежат Sourcing Case', 409)
    }
    const [[supplier]] = await conn.execute('SELECT id FROM part_suppliers WHERE id = ?', [supplierId])
    if (!supplier) throw new SourcingDomainError('SUPPLIER_NOT_FOUND', 'Поставщик не найден', 404)
    const [inquiryInsert] = await conn.execute(
      `INSERT INTO supplier_inquiries
        (sourcing_case_id, supplier_id, supplier_identity_snapshot_json, status,
         language, response_due_at, created_by_user_id)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
      [
        caseId, supplierId,
        json({ supplier_id: supplierId, source: 'supplier_master_reference_at_creation' }),
        cleanText(payload.language) || 'en', payload.response_due_at || null, actorId,
      ]
    )
    const inquiryId = inquiryInsert.insertId
    const revisionPayload = {
      subject: cleanText(payload.subject), message: cleanText(payload.message),
      supplier_id: supplierId, demand_ids: demandIds,
    }
    const [revisionInsert] = await conn.execute(
      `INSERT INTO supplier_inquiry_revisions
        (supplier_inquiry_id, revision_number, status, subject_snapshot, message_snapshot,
         contact_snapshot_json, payload_hash, created_by_user_id)
       VALUES (?, 1, 'draft', ?, ?, ?, ?, ?)`,
      [inquiryId, revisionPayload.subject, revisionPayload.message, json(payload.contact_snapshot), sha256(revisionPayload), actorId]
    )
    for (const demand of demands) {
      await conn.execute(
        `INSERT INTO supplier_inquiry_revision_lines
          (supplier_inquiry_revision_id, sourcing_demand_id, requested_quantity_snapshot,
           uom_snapshot, request_snapshot_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
          revisionInsert.insertId, demand.id, demand.admitted_quantity, demand.uom_snapshot,
          json({
            stable_item_key: demand.stable_item_key_snapshot,
            catalog_position_id: demand.catalog_position_id_snapshot,
            substitution_policy: demand.substitution_policy_snapshot,
            source: demand.source_data_snapshot_json,
            requirements: demand.requirements_snapshot_json,
          }),
        ]
      )
    }
    await conn.execute(
      `UPDATE sourcing_cases SET status = 'in_progress', row_version = row_version + 1
        WHERE id = ? AND status IN ('new', 'in_progress')`,
      [caseId]
    )
    await conn.execute(
      `UPDATE sourcing_demands SET status = 'sourcing_active', row_version = row_version + 1
        WHERE id IN (${demandIds.map(() => '?').join(',')}) AND status IN ('received', 'strategy_defined')`,
      demandIds
    )
    await addEvent(conn, caseId, 'inquiry_created', 'supplier_inquiry', inquiryId, actorId, {
      supplier_id: supplierId, revision_id: revisionInsert.insertId, demand_ids: demandIds,
    })
    await conn.commit()
    return { inquiry_id: inquiryId, revision_id: revisionInsert.insertId, revision_number: 1, status: 'draft' }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function finalizeInquiryRevision(inquiryIdInput, actorUserId) {
  const inquiryId = toId(inquiryIdInput)
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[inquiry]] = await conn.execute('SELECT * FROM supplier_inquiries WHERE id = ? FOR UPDATE', [inquiryId])
    if (!inquiry) throw new SourcingDomainError('INQUIRY_NOT_FOUND', 'Supplier Inquiry не найден', 404)
    const [[revision]] = await conn.execute(
      `SELECT * FROM supplier_inquiry_revisions
        WHERE supplier_inquiry_id = ? ORDER BY revision_number DESC LIMIT 1 FOR UPDATE`,
      [inquiryId]
    )
    if (!revision || revision.status !== 'draft') {
      throw new SourcingDomainError('INQUIRY_REVISION_IMMUTABLE', 'Последняя ревизия уже зафиксирована', 409)
    }
    const [[lineCount]] = await conn.execute(
      'SELECT COUNT(*) AS count FROM supplier_inquiry_revision_lines WHERE supplier_inquiry_revision_id = ?',
      [revision.id]
    )
    if (!Number(lineCount.count)) throw new SourcingDomainError('INQUIRY_EMPTY', 'Inquiry не содержит позиций', 409)
    await conn.execute(
      `UPDATE supplier_inquiry_revisions
          SET status = 'finalized', finalized_by_user_id = ?, finalized_at = CURRENT_TIMESTAMP(6)
        WHERE id = ?`,
      [actorId, revision.id]
    )
    await conn.execute(`UPDATE supplier_inquiries SET status = 'ready', row_version = row_version + 1 WHERE id = ?`, [inquiryId])
    await addEvent(conn, inquiry.sourcing_case_id, 'inquiry_revision_finalized', 'supplier_inquiry_revision', revision.id, actorId)
    await conn.commit()
    return { inquiry_id: inquiryId, revision_id: revision.id, status: 'finalized' }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function dispatchInquiry(inquiryIdInput, payload, actorUserId) {
  const inquiryId = toId(inquiryIdInput)
  const actorId = requireActor(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[inquiry]] = await conn.execute('SELECT * FROM supplier_inquiries WHERE id = ? FOR UPDATE', [inquiryId])
    if (!inquiry) throw new SourcingDomainError('INQUIRY_NOT_FOUND', 'Supplier Inquiry не найден', 404)
    const [[revision]] = await conn.execute(
      `SELECT * FROM supplier_inquiry_revisions
        WHERE supplier_inquiry_id = ? ORDER BY revision_number DESC LIMIT 1`,
      [inquiryId]
    )
    if (!revision || revision.status !== 'finalized') {
      throw new SourcingDomainError('INQUIRY_NOT_FINALIZED', 'Отправить можно только finalized-ревизию', 409)
    }
    const recipient = payload.recipient_snapshot || { supplier_id: inquiry.supplier_id }
    const [insert] = await conn.execute(
      `INSERT INTO supplier_inquiry_dispatches
        (supplier_inquiry_id, supplier_inquiry_revision_id, channel,
         recipient_snapshot_json, payload_hash, document_id,
         dispatched_by_user_id, dispatched_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6), ?)`,
      [
        inquiryId, revision.id, cleanText(payload.channel) || 'email', json(recipient),
        sha256({ revision_id: revision.id, recipient }), toId(payload.document_id), actorId,
        cleanText(payload.note),
      ]
    )
    await conn.execute(`UPDATE supplier_inquiries SET status = 'sent', row_version = row_version + 1 WHERE id = ?`, [inquiryId])
    await conn.execute(
      `UPDATE sourcing_cases SET status = 'waiting_responses', row_version = row_version + 1
        WHERE id = ? AND status IN ('new', 'in_progress')`,
      [inquiry.sourcing_case_id]
    )
    await addEvent(conn, inquiry.sourcing_case_id, 'inquiry_dispatched', 'supplier_inquiry_dispatch', insert.insertId, actorId, {
      inquiry_id: inquiryId, revision_id: revision.id, channel: cleanText(payload.channel) || 'email',
    })
    await conn.commit()
    return { dispatch_id: insert.insertId, inquiry_id: inquiryId, revision_id: revision.id, status: 'sent' }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

module.exports = { createInquiry, dispatchInquiry, finalizeInquiryRevision }
