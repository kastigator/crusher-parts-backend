const db = require('../../utils/db')
const { createNotification } = require('../../utils/notifications')
const { ClientRequestDomainError } = require('./domainError')

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

async function resolveLatestRelease(conn, requestId) {
  const [[release]] = await conn.execute(
    `SELECT * FROM procurement_releases
      WHERE client_request_id = ? AND status = 'released'
      ORDER BY release_number DESC FOR UPDATE`,
    [requestId]
  )
  if (!release) {
    throw new ClientRequestDomainError(
      'PROCUREMENT_RELEASE_REQUIRED',
      'Сначала создайте Procurement Release по готовым строкам',
      409
    )
  }
  return release
}

async function syncRfqItemsFromRelease(conn, rfqId, releaseId) {
  const [insert] = await conn.execute(
    `INSERT INTO rfq_items
      (rfq_id, client_request_revision_item_id, procurement_release_item_id,
       catalog_position_id, line_number, requested_qty, uom, oem_only, note)
     SELECT ?, pri.client_request_revision_item_id, pri.id,
            pri.catalog_position_id_snapshot, pri.line_number_snapshot,
            pri.requested_quantity_snapshot, pri.uom_snapshot, 0,
            'Compatibility projection from immutable Procurement Release'
       FROM procurement_release_items pri
      WHERE pri.procurement_release_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM rfq_items existing
          WHERE existing.rfq_id = ? AND existing.procurement_release_item_id = pri.id
        )`,
    [rfqId, releaseId, rfqId]
  )
  return Number(insert.affectedRows || 0)
}

async function createRfqRevision(conn, rfqId, release, actorId) {
  const [[existing]] = await conn.execute(
    `SELECT id FROM rfq_revisions
      WHERE rfq_id = ? AND client_request_revision_id = ?
      ORDER BY rev_number DESC LIMIT 1`,
    [rfqId, release.client_request_revision_id]
  )
  if (existing) return existing.id
  const [[sequence]] = await conn.execute(
    'SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev FROM rfq_revisions WHERE rfq_id = ?',
    [rfqId]
  )
  const [insert] = await conn.execute(
    `INSERT INTO rfq_revisions
      (rfq_id, rev_number, client_request_revision_id, revision_type, sync_status, created_by_user_id)
     VALUES (?, ?, ?, 'release_snapshot', 'synced', ?)`,
    [rfqId, Number(sequence.next_rev), release.client_request_revision_id, actorId]
  )
  return insert.insertId
}

async function assignRfqFromLatestRelease(requestIdInput, payload, actorUserId) {
  const requestId = toId(requestIdInput)
  const assigneeId = toId(payload.assigned_to_user_id)
  const actorId = toId(actorUserId)
  if (!requestId || !assigneeId || !actorId) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Укажите заявку и ответственного')
  }
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[request]] = await conn.execute(
      `SELECT cr.*, c.company_name AS client_name
         FROM client_requests cr JOIN clients c ON c.id = cr.client_id
        WHERE cr.id = ? FOR UPDATE`,
      [requestId]
    )
    if (!request) throw new ClientRequestDomainError('REQUEST_NOT_FOUND', 'Заявка не найдена', 404)
    const release = await resolveLatestRelease(conn, requestId)
    const [[assignee]] = await conn.execute(
      'SELECT id, is_active FROM users WHERE id = ?',
      [assigneeId]
    )
    if (!assignee || !assignee.is_active) {
      throw new ClientRequestDomainError('ASSIGNEE_INVALID', 'Ответственный не найден или неактивен', 409)
    }
    const [[existing]] = await conn.execute(
      'SELECT * FROM rfqs WHERE client_request_id = ? LIMIT 1 FOR UPDATE',
      [requestId]
    )
    let rfqId = existing?.id
    const rfqNumber = existing?.rfq_number || `RFQ-${request.internal_number}`
    if (existing) {
      await conn.execute(
        `UPDATE rfqs SET assigned_to_user_id = ?, procurement_release_id = ?,
                         client_request_revision_id = ?, note = COALESCE(?, note)
          WHERE id = ?`,
        [
          assigneeId,
          release.id,
          release.client_request_revision_id,
          payload.note || null,
          rfqId,
        ]
      )
    } else {
      const [insert] = await conn.execute(
        `INSERT INTO rfqs
          (rfq_number, client_request_id, client_request_revision_id, procurement_release_id,
           status, created_by_user_id, assigned_to_user_id, note)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [
          rfqNumber,
          requestId,
          release.client_request_revision_id,
          release.id,
          actorId,
          assigneeId,
          payload.note || null,
        ]
      )
      rfqId = insert.insertId
    }
    const rfqRevisionId = await createRfqRevision(conn, rfqId, release, actorId)
    const addedItems = await syncRfqItemsFromRelease(conn, rfqId, release.id)
    await conn.execute(
      `UPDATE rfqs
          SET current_rfq_revision_id = ?, rfq_sync_status = 'synced',
              last_sync_at = CURRENT_TIMESTAMP, last_synced_client_request_revision_id = ?
        WHERE id = ?`,
      [rfqRevisionId, release.client_request_revision_id, rfqId]
    )
    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
       VALUES (?, ?, 'legacy_rfq_adapter_invoked', 'rfq', ?, ?,
               JSON_OBJECT('procurement_release_id', ?, 'assigned_to_user_id', ?, 'added_items', ?))`,
      [requestId, release.client_request_revision_id, rfqId, actorId, release.id, assigneeId, addedItems]
    )
    if (!existing || Number(existing.assigned_to_user_id) !== assigneeId) {
      await createNotification(conn, {
        userId: assigneeId,
        type: 'assignment',
        title: 'Назначен RFQ',
        message: `${rfqNumber} · ${request.client_name}`,
        entityType: 'rfqs',
        entityId: rfqId,
      })
    }
    const [[rfq]] = await conn.execute('SELECT * FROM rfqs WHERE id = ?', [rfqId])
    await conn.commit()
    return { success: true, created: !existing, rfq, request, procurement_release: release, added_items: addedItems }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function syncRfqFromLatestRelease(requestIdInput, actorUserId) {
  const requestId = toId(requestIdInput)
  const actorId = toId(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const release = await resolveLatestRelease(conn, requestId)
    const [[rfq]] = await conn.execute(
      'SELECT * FROM rfqs WHERE client_request_id = ? LIMIT 1 FOR UPDATE',
      [requestId]
    )
    if (!rfq) throw new ClientRequestDomainError('RFQ_NOT_FOUND', 'Связанный RFQ не найден', 404)
    const rfqRevisionId = await createRfqRevision(conn, rfq.id, release, actorId)
    const addedItems = await syncRfqItemsFromRelease(conn, rfq.id, release.id)
    await conn.execute(
      `UPDATE rfqs SET procurement_release_id = ?, client_request_revision_id = ?,
                       current_rfq_revision_id = ?, rfq_sync_status = 'synced',
                       last_sync_at = CURRENT_TIMESTAMP,
                       last_synced_client_request_revision_id = ?
        WHERE id = ?`,
      [release.id, release.client_request_revision_id, rfqRevisionId, release.client_request_revision_id, rfq.id]
    )
    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
       VALUES (?, ?, 'legacy_rfq_adapter_synced', 'rfq', ?, ?,
               JSON_OBJECT('procurement_release_id', ?, 'added_items', ?))`,
      [requestId, release.client_request_revision_id, rfq.id, actorId, release.id, addedItems]
    )
    await conn.commit()
    return { success: true, rfq, procurement_release: release, added_items: addedItems }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

module.exports = { assignRfqFromLatestRelease, syncRfqFromLatestRelease }
