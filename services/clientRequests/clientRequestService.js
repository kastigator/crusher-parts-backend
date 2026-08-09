const db = require('../../utils/db')
const { createNotification } = require('../../utils/notifications')
const { ClientRequestDomainError } = require('./domainError')

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}
const nullableText = (value) => {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized || null
}

async function validateContext(conn, { clientId, contactId, installationId }) {
  const [[client]] = await conn.execute('SELECT id FROM clients WHERE id = ?', [clientId])
  if (!client) throw new ClientRequestDomainError('CLIENT_NOT_FOUND', 'Клиент не найден', 404)

  if (contactId) {
    const [[contact]] = await conn.execute(
      'SELECT id FROM client_contacts WHERE id = ? AND client_id = ?',
      [contactId, clientId]
    )
    if (!contact) {
      throw new ClientRequestDomainError(
        'CLIENT_CONTACT_MISMATCH',
        'Контакт не принадлежит выбранному клиенту',
        409
      )
    }
  }

  if (installationId) {
    const [[installation]] = await conn.execute(
      'SELECT id FROM client_equipment_units WHERE id = ? AND client_id = ?',
      [installationId, clientId]
    )
    if (!installation) {
      throw new ClientRequestDomainError(
        'CLIENT_INSTALLATION_MISMATCH',
        'Установленное оборудование не принадлежит выбранному клиенту',
        409
      )
    }
  }
}

async function createClientRequest(payload, actorUserId) {
  const clientId = toId(payload.client_id)
  const actorId = toId(actorUserId)
  const internalNumber = nullableText(payload.internal_number ?? payload.internalNumber)
  if (!clientId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Не выбран клиент')
  if (!actorId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Не определён автор заявки')
  if (!internalNumber) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'internal_number обязателен')
  }

  const contactId = toId(payload.client_contact_id)
  const installationId = toId(payload.client_installation_id ?? payload.client_equipment_unit_id)
  const assignedTo = toId(payload.assigned_to_user_id) || actorId
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    await validateContext(conn, { clientId, contactId, installationId })

    const [[duplicate]] = await conn.execute(
      'SELECT id, client_id FROM client_requests WHERE internal_number = ? FOR UPDATE',
      [internalNumber]
    )
    if (duplicate) {
      throw new ClientRequestDomainError(
        'DUPLICATE_INTERNAL_NUMBER',
        `Номер заявки ${internalNumber} уже используется`,
        409,
        { request_id: duplicate.id }
      )
    }

    const [requestInsert] = await conn.execute(
      `INSERT INTO client_requests
        (client_id, client_contact_id, client_installation_id, status, lifecycle_stage,
         source_type, received_at, processing_deadline, created_by_user_id,
         assigned_to_user_id, internal_number, client_reference, contact_name,
         contact_email, contact_phone, comment_internal, comment_client)
       VALUES (?, ?, ?, 'draft', 'intake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId,
        contactId,
        installationId,
        nullableText(payload.source_type),
        payload.received_at || null,
        payload.processing_deadline || payload.response_due_at || null,
        actorId,
        assignedTo,
        internalNumber,
        nullableText(payload.client_reference),
        nullableText(payload.contact_name),
        nullableText(payload.contact_email),
        nullableText(payload.contact_phone),
        nullableText(payload.comment_internal ?? payload.internal_note),
        nullableText(payload.comment_client ?? payload.initial_note),
      ]
    )
    const requestId = requestInsert.insertId
    const [revisionInsert] = await conn.execute(
      `INSERT INTO client_request_revisions
        (client_request_id, rev_number, status, revision_reason, created_by_user_id, note)
       VALUES (?, 1, 'draft', 'initial', ?, ?)`,
      [requestId, actorId, nullableText(payload.initial_note)]
    )
    const revisionId = revisionInsert.insertId
    await conn.execute(
      'UPDATE client_requests SET current_revision_id = ?, row_version = row_version + 1 WHERE id = ?',
      [revisionId, requestId]
    )
    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
       VALUES (?, ?, 'request_created', 'client_request', ?, ?, JSON_OBJECT('revision_number', 1))`,
      [requestId, revisionId, requestId, actorId]
    )
    if (assignedTo !== actorId) {
      await createNotification(conn, {
        userId: assignedTo,
        type: 'assignment',
        title: 'Назначена заявка',
        message: `Заявка ${internalNumber}`,
        entityType: 'client_requests',
        entityId: requestId,
      })
    }
    const [[request]] = await conn.execute(
      `SELECT cr.*, c.company_name AS client_name
         FROM client_requests cr JOIN clients c ON c.id = cr.client_id
        WHERE cr.id = ?`,
      [requestId]
    )
    const [[revision]] = await conn.execute(
      'SELECT * FROM client_request_revisions WHERE id = ?',
      [revisionId]
    )
    await conn.commit()
    return { ...request, current_revision: revision }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function createRevision(requestIdInput, payload, actorUserId) {
  const requestId = toId(requestIdInput)
  const actorId = toId(actorUserId)
  if (!requestId || !actorId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректные параметры')
  const mode = String(payload.mode || 'COPY_CURRENT').toUpperCase()
  if (!['COPY_CURRENT', 'EMPTY', 'IMPORT'].includes(mode)) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Неизвестный режим создания ревизии')
  }
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[request]] = await conn.execute(
      'SELECT * FROM client_requests WHERE id = ? FOR UPDATE',
      [requestId]
    )
    if (!request) throw new ClientRequestDomainError('REQUEST_NOT_FOUND', 'Заявка не найдена', 404)

    const [[sequence]] = await conn.execute(
      'SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev FROM client_request_revisions WHERE client_request_id = ?',
      [requestId]
    )
    const sourceRevisionId = toId(request.current_revision_id)
    if (sourceRevisionId) {
      await conn.execute(
        `UPDATE client_request_revisions
            SET status = CASE WHEN status = 'draft' THEN 'finalized' ELSE status END,
                finalized_at = CASE WHEN status = 'draft' THEN COALESCE(finalized_at, CURRENT_TIMESTAMP(6)) ELSE finalized_at END,
                finalized_by_user_id = CASE WHEN status = 'draft' THEN COALESCE(finalized_by_user_id, ?) ELSE finalized_by_user_id END
          WHERE id = ?`,
        [actorId, sourceRevisionId]
      )
    }
    const [revisionInsert] = await conn.execute(
      `INSERT INTO client_request_revisions
        (client_request_id, rev_number, status, revision_reason, created_from_revision_id,
         created_by_user_id, note)
       VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
      [
        requestId,
        Number(sequence.next_rev),
        nullableText(payload.change_reason) || 'client_update',
        sourceRevisionId,
        actorId,
        nullableText(payload.note),
      ]
    )
    const revisionId = revisionInsert.insertId

    if (mode === 'COPY_CURRENT' && sourceRevisionId) {
      await conn.execute(
        `INSERT INTO client_request_revision_items
          (client_request_revision_id, stable_item_key, line_number, item_status,
           catalog_position_id, oem_part_id, standard_part_id, client_part_id,
           equipment_model_id, client_manufacturer_text, client_equipment_model_text,
           client_catalog_number, client_part_number, client_description, client_line_text,
           requested_qty, uom, required_date, priority, oem_only, client_comment,
           internal_comment, source_payload_json)
         SELECT ?, stable_item_key, line_number, item_status,
                catalog_position_id, oem_part_id, standard_part_id, client_part_id,
                equipment_model_id, client_manufacturer_text, client_equipment_model_text,
                client_catalog_number, client_part_number, client_description, client_line_text,
                requested_qty, uom, required_date, priority, oem_only, client_comment,
                internal_comment, source_payload_json
           FROM client_request_revision_items
          WHERE client_request_revision_id = ?
          ORDER BY line_number`,
        [revisionId, sourceRevisionId]
      )
      await conn.execute(
        `INSERT INTO client_request_item_identifications
          (client_request_revision_item_id, catalog_position_id, identification_status,
           match_method, confidence, basis_note, confirmed_by_user_id, confirmed_at)
         SELECT target.id, source_ident.catalog_position_id, source_ident.identification_status,
                source_ident.match_method, source_ident.confidence, source_ident.basis_note,
                source_ident.confirmed_by_user_id, source_ident.confirmed_at
           FROM client_request_revision_items target
           JOIN client_request_revision_items source_item
             ON source_item.client_request_revision_id = ?
            AND source_item.stable_item_key = target.stable_item_key
           JOIN client_request_item_identifications source_ident
             ON source_ident.client_request_revision_item_id = source_item.id
          WHERE target.client_request_revision_id = ?`,
        [sourceRevisionId, revisionId]
      )
      await conn.execute(
        `INSERT INTO client_request_item_requirements
          (client_request_revision_item_id, substitution_policy, required_manufacturer_id,
           required_brand_text, manufacture_to_drawing_allowed, kit_allowed,
           partial_supply_allowed, required_documents_json, technical_requirements,
           procurement_note)
         SELECT target.id, source_req.substitution_policy, source_req.required_manufacturer_id,
                source_req.required_brand_text, source_req.manufacture_to_drawing_allowed,
                source_req.kit_allowed, source_req.partial_supply_allowed,
                source_req.required_documents_json, source_req.technical_requirements,
                source_req.procurement_note
           FROM client_request_revision_items target
           JOIN client_request_revision_items source_item
             ON source_item.client_request_revision_id = ?
            AND source_item.stable_item_key = target.stable_item_key
           JOIN client_request_item_requirements source_req
             ON source_req.client_request_revision_item_id = source_item.id
          WHERE target.client_request_revision_id = ?`,
        [sourceRevisionId, revisionId]
      )
    }

    await conn.execute(
      `UPDATE client_requests
          SET current_revision_id = ?, lifecycle_stage = 'intake', row_version = row_version + 1
        WHERE id = ?`,
      [revisionId, requestId]
    )
    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
       VALUES (?, ?, 'request_revision_created', 'client_request_revision', ?, ?,
               JSON_OBJECT('mode', ?, 'created_from_revision_id', ?))`,
      [requestId, revisionId, revisionId, actorId, mode, sourceRevisionId]
    )
    const [[revision]] = await conn.execute(
      'SELECT * FROM client_request_revisions WHERE id = ?',
      [revisionId]
    )
    await conn.commit()
    return revision
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function finalizeRevision(revisionIdInput, actorUserId) {
  const revisionId = toId(revisionIdInput)
  const actorId = toId(actorUserId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[revision]] = await conn.execute(
      `SELECT r.*, cr.current_revision_id
         FROM client_request_revisions r
         JOIN client_requests cr ON cr.id = r.client_request_id
        WHERE r.id = ? FOR UPDATE`,
      [revisionId]
    )
    if (!revision) throw new ClientRequestDomainError('REVISION_NOT_FOUND', 'Ревизия не найдена', 404)
    if (revision.status !== 'draft') {
      throw new ClientRequestDomainError('REVISION_IMMUTABLE', 'Ревизия уже зафиксирована', 409)
    }
    const [[metrics]] = await conn.execute(
      `SELECT COUNT(*) AS item_count,
              SUM(CASE WHEN requested_qty <= 0 THEN 1 ELSE 0 END) AS invalid_qty,
              SUM(CASE WHEN uom IS NULL OR TRIM(uom) = '' THEN 1 ELSE 0 END) AS missing_uom
         FROM client_request_revision_items
        WHERE client_request_revision_id = ? AND item_status = 'active'`,
      [revisionId]
    )
    if (!Number(metrics.item_count)) {
      throw new ClientRequestDomainError('REVISION_EMPTY', 'В ревизии нет активных строк', 409)
    }
    if (Number(metrics.invalid_qty) || Number(metrics.missing_uom)) {
      throw new ClientRequestDomainError(
        'REVISION_INVALID',
        'Исправьте количество и единицы измерения до фиксации ревизии',
        409
      )
    }
    await conn.execute(
      `UPDATE client_request_revisions
          SET status = 'finalized', finalized_at = CURRENT_TIMESTAMP(6),
              finalized_by_user_id = ?, row_version = row_version + 1
        WHERE id = ?`,
      [actorId, revisionId]
    )
    await conn.execute(
      `UPDATE client_requests
          SET lifecycle_stage = 'identification', row_version = row_version + 1
        WHERE id = ?`,
      [revision.client_request_id]
    )
    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, event_type, entity_type, entity_id, actor_user_id)
       VALUES (?, ?, 'request_revision_finalized', 'client_request_revision', ?, ?)`,
      [revision.client_request_id, revisionId, revisionId, actorId]
    )
    const [[updated]] = await conn.execute(
      'SELECT * FROM client_request_revisions WHERE id = ?',
      [revisionId]
    )
    await conn.commit()
    return updated
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

module.exports = { createClientRequest, createRevision, finalizeRevision }
