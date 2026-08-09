const db = require('../../utils/db')
const { SourcingDomainError } = require('./domainError')
const { addEvent, cleanText, requireActor, toId, toPositiveNumber } = require('./helpers')

const ACTIVE_CASE_STATUSES = [
  'new', 'in_progress', 'waiting_responses', 'offer_review', 'decision_pending',
  'decision_ready', 'decided', 'released_to_pricing', 'blocked', 'on_hold',
]

async function createCaseFromRelease(payload, actorUserId) {
  const actorId = requireActor(actorUserId)
  const releaseId = toId(payload.procurement_release_id)
  const requestedIds = [...new Set((payload.release_item_ids || []).map(toId).filter(Boolean))]
  if (!releaseId) throw new SourcingDomainError('VALIDATION_ERROR', 'Укажите Procurement Release')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[release]] = await conn.execute(
      'SELECT * FROM procurement_releases WHERE id = ? FOR UPDATE',
      [releaseId]
    )
    if (!release) throw new SourcingDomainError('RELEASE_NOT_FOUND', 'Procurement Release не найден', 404)
    if (release.status !== 'released') {
      throw new SourcingDomainError('RELEASE_NOT_ACTIVE', 'Sourcing принимает только released Procurement Release', 409)
    }
    const [releaseItems] = await conn.execute(
      'SELECT * FROM procurement_release_items WHERE procurement_release_id = ? ORDER BY line_number_snapshot FOR UPDATE',
      [releaseId]
    )
    const selected = requestedIds.length
      ? releaseItems.filter((item) => requestedIds.includes(Number(item.id)))
      : releaseItems
    if (!selected.length || (requestedIds.length && selected.length !== requestedIds.length)) {
      throw new SourcingDomainError('RELEASE_ITEM_MISMATCH', 'Выбранные позиции не принадлежат Procurement Release', 409)
    }

    for (const item of selected) {
      const requested = toPositiveNumber(payload.quantities?.[item.id]) || Number(item.requested_quantity_snapshot)
      const [[allocation]] = await conn.execute(
        `SELECT COALESCE(SUM(sd.admitted_quantity), 0) AS admitted
           FROM sourcing_demands sd
           JOIN sourcing_cases sc ON sc.id = sd.sourcing_case_id
          WHERE sd.procurement_release_item_id = ?
            AND sc.status IN (${ACTIVE_CASE_STATUSES.map(() => '?').join(',')})`,
        [item.id, ...ACTIVE_CASE_STATUSES]
      )
      if (Number(allocation.admitted) + requested > Number(item.requested_quantity_snapshot)) {
        throw new SourcingDomainError(
          'RELEASE_ITEM_OVERALLOCATED',
          `Позиция release item ${item.id} уже полностью или частично принята в активный Sourcing Case`,
          409,
          { release_item_id: item.id, admitted: Number(allocation.admitted), requested }
        )
      }
    }

    const [[sequence]] = await conn.execute(
      `SELECT COALESCE(MAX(id), 0) + 1 AS next_number FROM sourcing_cases FOR UPDATE`
    )
    const caseNumber = cleanText(payload.case_number) || `SC-${String(sequence.next_number).padStart(6, '0')}`
    const [insert] = await conn.execute(
      `INSERT INTO sourcing_cases
        (case_number, title, status, priority, owner_user_id, response_deadline, created_by_user_id)
       VALUES (?, ?, 'new', ?, ?, ?, ?)`,
      [
        caseNumber,
        cleanText(payload.title) || release.title || `Sourcing release ${release.release_number}`,
        ['low', 'normal', 'high', 'urgent'].includes(payload.priority) ? payload.priority : 'normal',
        toId(payload.owner_user_id) || toId(release.requested_procurement_owner_id) || actorId,
        payload.response_deadline || null,
        actorId,
      ]
    )
    const caseId = insert.insertId
    await conn.execute(
      `INSERT INTO sourcing_case_release_links
        (sourcing_case_id, procurement_release_id, linked_by_user_id) VALUES (?, ?, ?)`,
      [caseId, releaseId, actorId]
    )
    for (const item of selected) {
      const admitted = toPositiveNumber(payload.quantities?.[item.id]) || Number(item.requested_quantity_snapshot)
      const requirements = typeof item.requirements_snapshot_json === 'string'
        ? JSON.parse(item.requirements_snapshot_json) : item.requirements_snapshot_json
      await conn.execute(
        `INSERT INTO sourcing_demands
          (sourcing_case_id, procurement_release_id, procurement_release_item_id,
           client_request_id, client_request_revision_id, client_request_revision_item_id,
           stable_item_key_snapshot, line_number_snapshot, catalog_position_id_snapshot,
           requested_quantity_snapshot, admitted_quantity, uom_snapshot,
           substitution_policy_snapshot, source_data_snapshot_json,
           identification_snapshot_json, requirements_snapshot_json,
           document_refs_snapshot_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
        [
          caseId, releaseId, item.id, release.client_request_id, release.client_request_revision_id,
          item.client_request_revision_item_id, item.stable_item_key_snapshot,
          item.line_number_snapshot, item.catalog_position_id_snapshot,
          item.requested_quantity_snapshot, admitted, item.uom_snapshot,
          requirements?.substitution_policy || 'unspecified', item.source_data_snapshot_json,
          item.identification_snapshot_json, item.requirements_snapshot_json,
          item.document_refs_snapshot_json,
        ]
      )
    }
    await addEvent(conn, caseId, 'case_created_from_release', 'procurement_release', releaseId, actorId, {
      release_item_ids: selected.map((item) => item.id),
    })
    await conn.commit()
    return { case_id: caseId, case_number: caseNumber, procurement_release_id: releaseId, demand_count: selected.length }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function acceptCase(caseIdInput, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const [result] = await db.execute(
    `UPDATE sourcing_cases
        SET status = 'in_progress', owner_user_id = COALESCE(owner_user_id, ?),
            accepted_by_user_id = ?, accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP(6)),
            row_version = row_version + 1
      WHERE id = ? AND status = 'new'`,
    [actorId, actorId, caseId]
  )
  if (!result.affectedRows) throw new SourcingDomainError('CASE_NOT_ACCEPTABLE', 'Sourcing Case не найден или уже принят', 409)
  await addEvent(db, caseId, 'case_accepted', 'sourcing_case', caseId, actorId)
  return { case_id: caseId, status: 'in_progress' }
}

async function archiveCase(caseIdInput, payload, actorUserId) {
  const caseId = toId(caseIdInput)
  const actorId = requireActor(actorUserId)
  const [result] = await db.execute(
    `UPDATE sourcing_cases
        SET status = 'archived', archived_by_user_id = ?, archived_at = CURRENT_TIMESTAMP(6),
            archive_reason = ?, row_version = row_version + 1
      WHERE id = ? AND status NOT IN ('archived', 'released_to_pricing')`,
    [actorId, cleanText(payload.reason), caseId]
  )
  if (!result.affectedRows) throw new SourcingDomainError('CASE_NOT_ARCHIVABLE', 'Sourcing Case не найден или недоступен для архива', 409)
  await addEvent(db, caseId, 'case_archived', 'sourcing_case', caseId, actorId, { reason: cleanText(payload.reason) })
  return { case_id: caseId, status: 'archived' }
}

module.exports = { acceptCase, archiveCase, createCaseFromRelease }
