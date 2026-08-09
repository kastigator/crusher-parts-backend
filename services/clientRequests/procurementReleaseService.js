const crypto = require('crypto')
const db = require('../../utils/db')
const { getRevisionReadiness } = require('./clientRequestReadModel')
const { finalizeRevision } = require('./clientRequestService')
const { ClientRequestDomainError } = require('./domainError')

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

async function createProcurementRelease(payload, actorUserId) {
  const revisionId = toId(payload.client_request_revision_id)
  const actorId = toId(actorUserId)
  const itemIds = [...new Set((payload.item_ids || []).map(toId).filter(Boolean))]
  if (!revisionId || !actorId || !itemIds.length) {
    throw new ClientRequestDomainError(
      'VALIDATION_ERROR',
      'Укажите finalized-ревизию и выбранные строки'
    )
  }
  const releaseKey = String(payload.idempotency_key || crypto.randomUUID()).trim()
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[revision]] = await conn.execute(
      `SELECT r.*, cr.id AS request_id
         FROM client_request_revisions r
         JOIN client_requests cr ON cr.id = r.client_request_id
        WHERE r.id = ? FOR UPDATE`,
      [revisionId]
    )
    if (!revision) throw new ClientRequestDomainError('REVISION_NOT_FOUND', 'Ревизия не найдена', 404)
    if (revision.status !== 'finalized') {
      throw new ClientRequestDomainError(
        'REVISION_NOT_FINALIZED',
        'Procurement Release создаётся только из зафиксированной ревизии',
        409
      )
    }
    const [[existing]] = await conn.execute(
      'SELECT * FROM procurement_releases WHERE release_key = ?',
      [releaseKey]
    )
    if (existing) {
      const [items] = await conn.execute(
        'SELECT * FROM procurement_release_items WHERE procurement_release_id = ? ORDER BY line_number_snapshot',
        [existing.id]
      )
      await conn.commit()
      return { release: existing, items, idempotent_replay: true }
    }
    const readiness = await getRevisionReadiness(revisionId, conn)
    const byId = new Map(readiness.items.map((item) => [Number(item.id), item]))
    const selected = itemIds.map((id) => byId.get(id)).filter(Boolean)
    if (selected.length !== itemIds.length) {
      throw new ClientRequestDomainError(
        'ITEM_REVISION_MISMATCH',
        'Одна или несколько строк не принадлежат выбранной ревизии',
        409
      )
    }
    const blocked = selected.filter((item) => !item.readiness.ready)
    if (blocked.length) {
      throw new ClientRequestDomainError(
        'ITEM_NOT_READY',
        'Выбранные строки содержат блокеры готовности',
        409,
        {
          items: blocked.map((item) => ({ id: item.id, blockers: item.readiness.blocker_codes })),
        }
      )
    }
    const [[sequence]] = await conn.execute(
      'SELECT COALESCE(MAX(release_number), 0) + 1 AS next_number FROM procurement_releases WHERE client_request_id = ? FOR UPDATE',
      [revision.request_id]
    )
    const [releaseInsert] = await conn.execute(
      `INSERT INTO procurement_releases
        (release_key, client_request_id, client_request_revision_id, release_number,
         status, title, note, requested_procurement_owner_id, released_by_user_id, released_at)
       VALUES (?, ?, ?, ?, 'released', ?, ?, ?, ?, CURRENT_TIMESTAMP(6))`,
      [
        releaseKey,
        revision.request_id,
        revisionId,
        Number(sequence.next_number),
        payload.title ? String(payload.title).trim() : null,
        payload.note ? String(payload.note).trim() : null,
        toId(payload.requested_procurement_owner_id),
        actorId,
      ]
    )
    for (const item of selected) {
      const sourceSnapshot = {
        client_part_number: item.client_part_number,
        client_description: item.client_description,
        client_line_text: item.client_line_text,
        client_manufacturer_text: item.client_manufacturer_text,
        client_equipment_model_text: item.client_equipment_model_text,
        client_catalog_number: item.client_catalog_number,
        required_date: item.required_date,
        priority: item.priority,
        client_comment: item.client_comment,
      }
      const identificationSnapshot = {
        catalog_position_id: item.identification_catalog_position_id,
        status: item.identification_status,
        match_method: item.match_method,
        confidence: item.confidence,
        basis_note: item.basis_note,
        confirmed_by_user_id: item.confirmed_by_user_id,
        confirmed_at: item.confirmed_at,
      }
      const requirementsSnapshot = {
        substitution_policy: item.substitution_policy,
        required_manufacturer_id: item.required_manufacturer_id,
        required_brand_text: item.required_brand_text,
        manufacture_to_drawing_allowed: Boolean(item.manufacture_to_drawing_allowed),
        kit_allowed: Boolean(item.kit_allowed),
        partial_supply_allowed: Boolean(item.partial_supply_allowed),
        required_documents: item.required_documents_json,
        technical_requirements: item.technical_requirements,
        procurement_note: item.procurement_note,
      }
      await conn.execute(
        `INSERT INTO procurement_release_items
          (procurement_release_id, client_request_revision_item_id, stable_item_key_snapshot,
           line_number_snapshot, catalog_position_id_snapshot, requested_quantity_snapshot,
           uom_snapshot, source_data_snapshot_json, identification_snapshot_json,
           requirements_snapshot_json, document_refs_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          releaseInsert.insertId,
          item.id,
          item.stable_item_key,
          item.line_number,
          toId(item.identification_catalog_position_id),
          item.requested_qty,
          item.uom,
          JSON.stringify(sourceSnapshot),
          JSON.stringify(identificationSnapshot),
          JSON.stringify(requirementsSnapshot),
          JSON.stringify([]),
        ]
      )
    }
    await conn.execute(
      `UPDATE client_requests
          SET lifecycle_stage = 'released', row_version = row_version + 1
        WHERE id = ?`,
      [revision.request_id]
    )
    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
       VALUES (?, ?, 'procurement_release_created', 'procurement_release', ?, ?,
               JSON_OBJECT('release_number', ?, 'item_count', ?))`,
      [
        revision.request_id,
        revisionId,
        releaseInsert.insertId,
        actorId,
        Number(sequence.next_number),
        selected.length,
      ]
    )
    const [[release]] = await conn.execute(
      'SELECT * FROM procurement_releases WHERE id = ?',
      [releaseInsert.insertId]
    )
    const [items] = await conn.execute(
      'SELECT * FROM procurement_release_items WHERE procurement_release_id = ? ORDER BY line_number_snapshot',
      [releaseInsert.insertId]
    )
    await conn.commit()
    return { release, items, idempotent_replay: false }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function releaseAllReadyForCompatibility(requestIdInput, actorUserId) {
  const requestId = toId(requestIdInput)
  const actorId = toId(actorUserId)
  const [[request]] = await db.execute(
    'SELECT * FROM client_requests WHERE id = ?',
    [requestId]
  )
  if (!request) throw new ClientRequestDomainError('REQUEST_NOT_FOUND', 'Заявка не найдена', 404)
  const [[existing]] = await db.execute(
    `SELECT * FROM procurement_releases
      WHERE client_request_id = ? AND status = 'released'
      ORDER BY release_number DESC LIMIT 1`,
    [requestId]
  )
  if (existing) {
    return { release: existing, request, idempotent_replay: true }
  }
  const revisionId = toId(request.current_revision_id)
  if (!revisionId) {
    throw new ClientRequestDomainError('REVISION_NOT_FOUND', 'У заявки нет текущей ревизии', 409)
  }
  const [[revision]] = await db.execute(
    'SELECT status FROM client_request_revisions WHERE id = ?',
    [revisionId]
  )
  if (revision?.status === 'draft') await finalizeRevision(revisionId, actorId)
  const readiness = await getRevisionReadiness(revisionId)
  const itemIds = readiness.items.filter((item) => item.readiness.ready).map((item) => item.id)
  if (!itemIds.length) {
    throw new ClientRequestDomainError(
      'NO_READY_ITEMS',
      'Нет строк, готовых к Procurement Release',
      409,
      { items: readiness.items.map((item) => ({ id: item.id, blockers: item.readiness.blocker_codes })) }
    )
  }
  const result = await createProcurementRelease(
    {
      client_request_revision_id: revisionId,
      item_ids: itemIds,
      title: `Release ${request.internal_number}`,
      note: 'Created by the legacy whole-request release compatibility adapter',
      idempotency_key: `legacy-route-request-${requestId}-revision-${revisionId}`,
    },
    actorId
  )
  const [[updatedRequest]] = await db.execute('SELECT * FROM client_requests WHERE id = ?', [requestId])
  return { ...result, request: updatedRequest }
}

module.exports = { createProcurementRelease, releaseAllReadyForCompatibility }
