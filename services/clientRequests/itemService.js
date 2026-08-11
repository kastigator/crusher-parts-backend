const db = require('../../utils/db')
const { ClientRequestDomainError } = require('./domainError')

const IDENTIFICATION_STATUSES = new Set([
  'unprocessed',
  'suggested',
  'needs_review',
  'confirmed',
  'needs_client_clarification',
  'technical_task_open',
  'not_required',
])
const MATCH_METHODS = new Set([
  'manual',
  'exact_number',
  'client_part_link',
  'bom_match',
  'property_match',
  'import_hint',
  'technical_task',
  'legacy_link',
  'other',
])
const SUBSTITUTION_POLICIES = new Set([
  'exact_only',
  'equivalent_requires_approval',
  'equivalent_allowed',
  'open_to_proposals',
  'unspecified',
])

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}
const textOrNull = (value) => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text || null
}

async function fetchItemContext(conn, itemId, lock = false) {
  const [[item]] = await conn.execute(
    `SELECT i.*, r.client_request_id, r.status AS revision_status
       FROM client_request_revision_items i
       JOIN client_request_revisions r ON r.id = i.client_request_revision_id
      WHERE i.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [itemId]
  )
  if (!item) throw new ClientRequestDomainError('ITEM_NOT_FOUND', 'Строка заявки не найдена', 404)
  return item
}

async function setIdentificationInTransaction(conn, itemIdInput, payload, actorUserId) {
  const itemId = toId(itemIdInput)
  const actorId = toId(actorUserId)
  const status = String(payload.status || payload.identification_status || '').toLowerCase()
  const catalogPositionId = toId(payload.catalog_position_id)
  const matchMethod = textOrNull(payload.match_method || payload.basis_type)
  if (!itemId || !actorId || !IDENTIFICATION_STATUSES.has(status)) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректные данные идентификации')
  }
  if (status === 'confirmed' && !catalogPositionId) {
    throw new ClientRequestDomainError(
      'CATALOG_POSITION_REQUIRED',
      'Подтверждённая идентификация требует Catalog Position',
      409
    )
  }
  if (matchMethod && !MATCH_METHODS.has(matchMethod)) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Неизвестный метод идентификации')
  }

  const item = await fetchItemContext(conn, itemId, true)
  if (catalogPositionId) {
    const [[position]] = await conn.execute(
      `SELECT id FROM catalog_positions
        WHERE id = ? AND is_active = 1 AND (status IS NULL OR status <> 'archived')`,
      [catalogPositionId]
    )
    if (!position) {
      throw new ClientRequestDomainError(
        'CATALOG_POSITION_NOT_FOUND',
        'Catalog Position не найдена или недоступна',
        404
      )
    }
  }
  const [[before]] = await conn.execute(
    'SELECT * FROM client_request_item_identifications WHERE client_request_revision_item_id = ?',
    [itemId]
  )
  const confidence = payload.confidence === undefined || payload.confidence === null
    ? null
    : Number(payload.confidence)
  await conn.execute(
    `INSERT INTO client_request_item_identifications
      (client_request_revision_item_id, catalog_position_id, identification_status,
       match_method, confidence, basis_note, confirmed_by_user_id, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       catalog_position_id = VALUES(catalog_position_id),
       identification_status = VALUES(identification_status),
       match_method = VALUES(match_method),
       confidence = VALUES(confidence),
       basis_note = VALUES(basis_note),
       confirmed_by_user_id = VALUES(confirmed_by_user_id),
       confirmed_at = VALUES(confirmed_at),
       row_version = row_version + 1`,
    [
      itemId,
      catalogPositionId,
      status,
      matchMethod,
      Number.isFinite(confidence) ? confidence : null,
      textOrNull(payload.basis_note),
      status === 'confirmed' ? actorId : null,
      status === 'confirmed' ? new Date() : null,
    ]
  )
  // Temporary compatibility projection. Canonical technical identity remains the
  // identification row and referenced Catalog Position.
  await conn.execute(
    'UPDATE client_request_revision_items SET catalog_position_id = ? WHERE id = ?',
    [catalogPositionId, itemId]
  )
  const [[after]] = await conn.execute(
    'SELECT * FROM client_request_item_identifications WHERE client_request_revision_item_id = ?',
    [itemId]
  )
  await conn.execute(
    `INSERT INTO client_request_events
      (client_request_id, revision_id, item_id, event_type, entity_type, entity_id,
       actor_user_id, old_values_json, new_values_json, payload_json)
     VALUES (?, ?, ?, 'request_item_identified', 'client_request_item_identification', ?, ?, ?, ?, ?)`,
    [
      item.client_request_id,
      item.client_request_revision_id,
      itemId,
      after.id,
      actorId,
      JSON.stringify(before || null),
      JSON.stringify(after),
      payload.provenance ? JSON.stringify(payload.provenance) : null,
    ]
  )
  return { identification: after, item }
}

async function setIdentification(itemIdInput, payload, actorUserId) {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const { identification } = await setIdentificationInTransaction(conn, itemIdInput, payload, actorUserId)
    await conn.commit()
    return identification
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function setRequirements(itemIdInput, payload, actorUserId) {
  const itemId = toId(itemIdInput)
  const actorId = toId(actorUserId)
  const policy = String(payload.substitution_policy || 'unspecified').toLowerCase()
  if (!itemId || !actorId || !SUBSTITUTION_POLICIES.has(policy)) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректные требования позиции')
  }
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const item = await fetchItemContext(conn, itemId, true)
    const [[before]] = await conn.execute(
      'SELECT * FROM client_request_item_requirements WHERE client_request_revision_item_id = ?',
      [itemId]
    )
    const documents = payload.required_documents_json ?? payload.required_documents ?? null
    await conn.execute(
      `INSERT INTO client_request_item_requirements
        (client_request_revision_item_id, substitution_policy, required_manufacturer_id,
         required_brand_text, manufacture_to_drawing_allowed, kit_allowed,
         partial_supply_allowed, required_documents_json, technical_requirements, procurement_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         substitution_policy = VALUES(substitution_policy),
         required_manufacturer_id = VALUES(required_manufacturer_id),
         required_brand_text = VALUES(required_brand_text),
         manufacture_to_drawing_allowed = VALUES(manufacture_to_drawing_allowed),
         kit_allowed = VALUES(kit_allowed),
         partial_supply_allowed = VALUES(partial_supply_allowed),
         required_documents_json = VALUES(required_documents_json),
         technical_requirements = VALUES(technical_requirements),
         procurement_note = VALUES(procurement_note),
         row_version = row_version + 1`,
      [
        itemId,
        policy,
        toId(payload.required_manufacturer_id),
        textOrNull(payload.required_brand_text),
        payload.manufacture_to_drawing_allowed ? 1 : 0,
        payload.kit_allowed ? 1 : 0,
        payload.partial_supply_allowed ? 1 : 0,
        documents === null ? null : JSON.stringify(documents),
        textOrNull(payload.technical_requirements ?? payload.technical_requirements_text),
        textOrNull(payload.procurement_note),
      ]
    )
    const [[after]] = await conn.execute(
      'SELECT * FROM client_request_item_requirements WHERE client_request_revision_item_id = ?',
      [itemId]
    )
    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, item_id, event_type, entity_type, entity_id,
         actor_user_id, old_values_json, new_values_json)
       VALUES (?, ?, ?, 'request_item_requirements_changed', 'client_request_item_requirements', ?, ?, ?, ?)`,
      [
        item.client_request_id,
        item.client_request_revision_id,
        itemId,
        after.id,
        actorId,
        JSON.stringify(before || null),
        JSON.stringify(after),
      ]
    )
    await conn.commit()
    return after
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

module.exports = { fetchItemContext, setIdentification, setIdentificationInTransaction, setRequirements }
