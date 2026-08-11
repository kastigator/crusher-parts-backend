const crypto = require('crypto')
const db = require('../../utils/db')
const { ClientRequestDomainError } = require('./domainError')
const { cleanText, hashPayload, validateBatch } = require('../technicalIdentification/matchService')
const {
  buildClientRequestTaskSourceSnapshot,
  buildTaskCreatedEventPayload,
  buildTechnicalTaskOpenIdentification,
  normalizeTaskPriority,
} = require('../technicalIdentification/semantics')

const SUBSTITUTION_POLICIES = new Set([
  'exact_only', 'equivalent_requires_approval', 'equivalent_allowed',
  'open_to_proposals', 'unspecified',
])

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const validateHeader = (header = {}, actorUserId) => {
  const normalized = {
    client_id: toId(header.client_id),
    client_contact_id: toId(header.client_contact_id),
    client_installation_id: toId(header.client_installation_id ?? header.client_equipment_unit_id),
    assigned_to_user_id: toId(header.assigned_to_user_id) || toId(actorUserId),
    internal_number: cleanText(header.internal_number, 120),
    client_reference: cleanText(header.client_reference ?? header.title, 255),
    source_type: cleanText(header.source_type, 40) || 'manual',
    received_at: header.received_at || null,
    processing_deadline: header.processing_deadline || header.response_due_at || null,
    contact_name: cleanText(header.contact_name, 255),
    contact_email: cleanText(header.contact_email, 255),
    contact_phone: cleanText(header.contact_phone, 80),
    initial_note: cleanText(header.initial_note ?? header.note),
  }
  const errors = []
  if (!normalized.client_id) errors.push({ code: 'CLIENT_REQUIRED', message: 'Выберите клиента' })
  if (!normalized.internal_number) errors.push({ code: 'REQUEST_NUMBER_REQUIRED', message: 'Укажите номер заявки' })
  if (!normalized.assigned_to_user_id) errors.push({ code: 'ACTOR_REQUIRED', message: 'Не определён ответственный' })
  return { normalized, errors }
}

const validateBusinessContext = async (executor, header) => {
  const errors = []
  if (!header.client_id) return errors
  const [[client]] = await executor.execute('SELECT id FROM clients WHERE id = ?', [header.client_id])
  if (!client) errors.push({ code: 'CLIENT_NOT_FOUND', message: 'Клиент не найден' })
  if (header.client_contact_id) {
    const [[contact]] = await executor.execute(
      'SELECT id FROM client_contacts WHERE id = ? AND client_id = ?',
      [header.client_contact_id, header.client_id]
    )
    if (!contact) errors.push({ code: 'CLIENT_CONTACT_MISMATCH', message: 'Контакт не принадлежит выбранному клиенту' })
  }
  if (header.client_installation_id) {
    const [[installation]] = await executor.execute(
      'SELECT id FROM client_equipment_units WHERE id = ? AND client_id = ?',
      [header.client_installation_id, header.client_id]
    )
    if (!installation) errors.push({ code: 'CLIENT_INSTALLATION_MISMATCH', message: 'Оборудование не принадлежит выбранному клиенту' })
  }
  if (header.internal_number) {
    const [[duplicate]] = await executor.execute(
      'SELECT id FROM client_requests WHERE internal_number = ? LIMIT 1',
      [header.internal_number]
    )
    if (duplicate) errors.push({ code: 'DUPLICATE_INTERNAL_NUMBER', message: `Номер заявки ${header.internal_number} уже используется`, request_id: duplicate.id })
  }
  return errors
}

async function validateIntake(payload, actorUserId, executor = db) {
  const headerResult = validateHeader(payload.header || {}, actorUserId)
  const batch = await validateBatch(payload, executor)
  const contextErrors = await validateBusinessContext(executor, headerResult.normalized)
  const optionErrors = []
  if (payload.options?.confirm_exact_matches === true) {
    const confirmation = payload.options?.exact_confirmation || {}
    if (confirmation.action !== 'bulk_confirm_exact_unique' || !cleanText(confirmation.confirmation_key, 160)) {
      optionErrors.push({
        code: 'EXACT_CONFIRMATION_REQUIRED',
        message: 'Точные совпадения можно подтвердить только явным групповым действием пользователя',
      })
    }
  }
  return {
    ...batch,
    header: headerResult.normalized,
    errors: [...headerResult.errors, ...contextErrors, ...optionErrors, ...(batch.errors || [])],
    can_commit: headerResult.errors.length === 0 && contextErrors.length === 0 && optionErrors.length === 0 &&
      !(batch.errors || []).length && Number(batch.summary?.errors || 0) === 0,
  }
}

const fetchCommitted = async (key, executor = db) => {
  const [[row]] = await executor.execute(
    'SELECT * FROM client_request_intake_commands WHERE idempotency_key = ?',
    [key]
  )
  if (!row) return null
  const result = typeof row.result_json === 'object' ? row.result_json : JSON.parse(row.result_json)
  return { ...result, idempotent_replay: true, payload_hash: row.payload_hash }
}

const insertRows = async (conn, table, columns, rows) => {
  if (!rows.length) return
  const placeholders = `(${columns.map(() => '?').join(', ')})`
  await conn.execute(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${rows.map(() => placeholders).join(', ')}`,
    rows.flat()
  )
}

async function persistRowsSetBased(conn, {
  validation,
  header,
  requestId,
  revisionId,
  actorId,
  payload,
  idempotencyKey,
  runtime,
}) {
  const confirmExact = payload.options?.confirm_exact_matches === true
  const exactConfirmation = confirmExact ? payload.options.exact_confirmation : null
  const createTasks = payload.options?.create_tasks_for_unresolved !== false
  const taskDefaults = payload.options?.task_defaults || {}

  const prepared = validation.rows.map((row, index) => {
    const exactCandidate = row.match_status === 'exact_unique' ? row.candidates[0] : null
    const explicitCandidate = row.match_status === 'already_resolved' ? row.candidates[0] : null
    const confirmedCandidate = explicitCandidate || (confirmExact ? exactCandidate : null)
    const stableItemKey = crypto.randomUUID()
    const sourcePayload = {
      source_row: row.source_row,
      row_key: row.row_key,
      original: row.source_payload,
      normalized: {
        client_description: row.client_description,
        client_catalog_number: row.client_catalog_number,
        client_manufacturer_text: row.client_manufacturer_text,
        client_equipment_model_text: row.client_equipment_model_text,
        requested_qty: row.requested_qty,
        source_uom: row.source_uom,
        uom: row.uom,
        measurement_unit_id: row.measurement_unit_id,
        uom_resolution: row.uom_resolution,
        required_date: row.required_date,
      },
    }
    return {
      row,
      index,
      line_number: index + 1,
      stable_item_key: stableItemKey,
      source_payload: sourcePayload,
      exact_candidate: exactCandidate,
      explicit_candidate: explicitCandidate,
      confirmed_candidate: confirmedCandidate,
      needs_task: !confirmedCandidate && createTasks && ['probable', 'ambiguous', 'no_match'].includes(row.match_status),
    }
  })

  await insertRows(conn, 'client_request_revision_items', [
    'client_request_revision_id', 'stable_item_key', 'line_number', 'item_status',
    'catalog_position_id', 'client_manufacturer_text', 'client_equipment_model_text',
    'client_catalog_number', 'client_part_number', 'client_description', 'client_line_text',
    'requested_qty', 'uom', 'required_date', 'priority', 'client_comment', 'source_payload_json',
  ], prepared.map((entry) => {
    const row = entry.row
    return [
      revisionId, entry.stable_item_key, entry.line_number, 'active',
      entry.confirmed_candidate?.catalog_position_id || null,
      row.client_manufacturer_text, row.client_equipment_model_text,
      row.client_catalog_number, row.client_catalog_number, row.client_description,
      [row.client_manufacturer_text, row.client_equipment_model_text, row.client_catalog_number, row.client_description].filter(Boolean).join(' · '),
      row.requested_qty, row.uom, row.required_date, row.priority, row.client_comment,
      JSON.stringify(entry.source_payload),
    ]
  }))

  const [insertedItems] = await conn.execute(
    `SELECT id, stable_item_key, line_number
       FROM client_request_revision_items
      WHERE client_request_revision_id = ?
      ORDER BY line_number`,
    [revisionId]
  )
  if (insertedItems.length !== prepared.length) {
    throw new Error(`Bulk intake item count mismatch: expected ${prepared.length}, got ${insertedItems.length}`)
  }
  const itemByLine = new Map(insertedItems.map((item) => [Number(item.line_number), item]))
  for (const entry of prepared) entry.item = { ...itemByLine.get(entry.line_number), source_payload: entry.source_payload }

  await insertRows(conn, 'client_request_item_requirements', [
    'client_request_revision_item_id', 'substitution_policy', 'technical_requirements', 'procurement_note',
  ], prepared.map((entry) => {
    const policy = String(entry.row.source_payload?.substitution_policy || '').toLowerCase()
    return [
      entry.item.id,
      SUBSTITUTION_POLICIES.has(policy) ? policy : 'unspecified',
      cleanText(entry.row.source_payload?.technical_requirements),
      cleanText(entry.row.source_payload?.procurement_note),
    ]
  }))

  const [[client]] = await conn.execute('SELECT company_name FROM clients WHERE id = ?', [header.client_id])
  const taskEntries = prepared.filter((entry) => entry.needs_task)
  const taskYear = new Date().getUTCFullYear()
  for (const entry of taskEntries) {
    const priority = normalizeTaskPriority(taskDefaults.priority || entry.row.priority)
    const sourceSnapshot = buildClientRequestTaskSourceSnapshot({
      client_request_number: header.internal_number,
      client_reference: header.client_reference,
      client_name: client.company_name,
      revision_number: 1,
      line_number: entry.item.line_number,
      stable_item_key: entry.item.stable_item_key,
      client_description: entry.row.client_description,
      client_line_text: [entry.row.client_manufacturer_text, entry.row.client_equipment_model_text, entry.row.client_catalog_number, entry.row.client_description].filter(Boolean).join(' · ') || null,
      client_catalog_number: entry.row.client_catalog_number,
      client_manufacturer_text: entry.row.client_manufacturer_text,
      client_equipment_model_text: entry.row.client_equipment_model_text,
      requested_qty: entry.row.requested_qty,
      uom: entry.row.uom,
      required_date: entry.row.required_date,
      client_comment: entry.row.client_comment,
      source_payload: entry.item.source_payload,
    }, { intake_match_status: entry.row.match_status, intake_payload_hash: validation.payload_hash })
    entry.task_data = {
      temporary_number: `pending-${crypto.randomUUID()}`,
      active_source_key: `client_request_item:${entry.item.id}`,
      priority,
      due_at: taskDefaults.due_at || null,
      assigned_to_user_id: toId(taskDefaults.assigned_to_user_id),
      source_snapshot: sourceSnapshot,
      source_hash: hashPayload(sourceSnapshot),
    }
  }

  await insertRows(conn, 'technical_identification_tasks', [
    'task_number', 'client_request_id', 'client_request_revision_id',
    'client_request_revision_item_id', 'source_stable_item_key', 'source_snapshot_json',
    'source_hash', 'candidate_snapshot_json', 'status', 'priority', 'due_at',
    'assigned_to_user_id', 'active_source_key', 'created_by_user_id',
  ], taskEntries.map((entry) => [
    entry.task_data.temporary_number, requestId, revisionId, entry.item.id, entry.stable_item_key,
    JSON.stringify(entry.task_data.source_snapshot), entry.task_data.source_hash,
    JSON.stringify(entry.row.candidates), 'new', entry.task_data.priority, entry.task_data.due_at,
    entry.task_data.assigned_to_user_id, entry.task_data.active_source_key, actorId,
  ]))

  if (taskEntries.length) {
    const taskItemIds = taskEntries.map((entry) => entry.item.id)
    await conn.execute(
      `UPDATE technical_identification_tasks
          SET task_number = CONCAT('TI-', ?, '-', LPAD(id, 6, '0'))
        WHERE client_request_revision_item_id IN (${taskItemIds.map(() => '?').join(', ')})`,
      [taskYear, ...taskItemIds]
    )
    const [tasks] = await conn.execute(
      `SELECT * FROM technical_identification_tasks
        WHERE client_request_revision_item_id IN (${taskItemIds.map(() => '?').join(', ')})`,
      taskItemIds
    )
    const taskByItem = new Map(tasks.map((task) => [Number(task.client_request_revision_item_id), task]))
    for (const entry of taskEntries) entry.task = taskByItem.get(Number(entry.item.id))

    await insertRows(conn, 'technical_identification_task_events', [
      'task_id', 'sequence_no', 'event_type', 'from_status', 'to_status', 'actor_user_id',
      'payload_json', 'source_hash', 'idempotency_key',
    ], taskEntries.map((entry) => [
      entry.task.id, 1, 'task_created', null, 'new', actorId,
      JSON.stringify(buildTaskCreatedEventPayload({
        priority: entry.task_data.priority,
        assignedToUserId: entry.task_data.assigned_to_user_id,
        dueAt: entry.task_data.due_at,
      })),
      entry.task_data.source_hash,
      `${idempotencyKey}:task:${entry.row.source_row}`,
    ]))
  }

  const confirmedAt = new Date()
  for (const entry of prepared) {
    if (entry.confirmed_candidate) {
      entry.identification = {
        catalog_position_id: entry.confirmed_candidate.catalog_position_id,
        identification_status: 'confirmed',
        match_method: entry.explicit_candidate ? 'manual' : 'exact_number',
        confidence: 100,
        basis_note: entry.explicit_candidate
          ? 'Позиция явно выбрана пользователем до создания заявки'
          : 'Единственное точное совпадение подтверждено явным групповым действием',
        confirmed_by_user_id: actorId,
        confirmed_at: confirmedAt,
        provenance: entry.explicit_candidate
          ? { source: 'intake_preview', confirmation: 'explicit_candidate_selection' }
          : {
              source: 'intake_matching_suggestion',
              confirmation: 'explicit_bulk_action',
              action: exactConfirmation.action,
              confirmation_key: exactConfirmation.confirmation_key,
              candidate_evidence: entry.confirmed_candidate.evidence || null,
              candidate_reason_codes: entry.confirmed_candidate.reason_codes || [],
            },
      }
    } else if (entry.needs_task) {
      entry.identification = buildTechnicalTaskOpenIdentification(entry.task)
    } else {
      const suggested = entry.row.match_status === 'exact_unique'
      entry.identification = {
        catalog_position_id: null,
        identification_status: suggested ? 'suggested' : 'unprocessed',
        match_method: suggested ? 'exact_number' : null,
        confidence: suggested ? Number(entry.row.candidates[0]?.score || 100) : null,
        basis_note: suggested ? 'Найдено единственное точное совпадение; требуется подтверждение' : null,
        confirmed_by_user_id: null,
        confirmed_at: null,
        provenance: null,
      }
    }
  }

  await insertRows(conn, 'client_request_item_identifications', [
    'client_request_revision_item_id', 'catalog_position_id', 'identification_status',
    'match_method', 'confidence', 'basis_note', 'confirmed_by_user_id', 'confirmed_at',
  ], prepared.map((entry) => [
    entry.item.id,
    entry.identification.catalog_position_id,
    entry.identification.identification_status,
    entry.identification.match_method,
    entry.identification.confidence,
    entry.identification.basis_note,
    entry.identification.confirmed_by_user_id,
    entry.identification.confirmed_at,
  ]))

  const itemIds = prepared.map((entry) => entry.item.id)
  const [identifications] = await conn.execute(
    `SELECT * FROM client_request_item_identifications
      WHERE client_request_revision_item_id IN (${itemIds.map(() => '?').join(', ')})`,
    itemIds
  )
  const identificationByItem = new Map(identifications.map((row) => [Number(row.client_request_revision_item_id), row]))
  const identifiedEvents = prepared.filter((entry) => entry.confirmed_candidate || entry.needs_task)
  await insertRows(conn, 'client_request_events', [
    'client_request_id', 'revision_id', 'item_id', 'event_type', 'entity_type',
    'entity_id', 'actor_user_id', 'old_values_json', 'new_values_json', 'payload_json',
  ], identifiedEvents.map((entry) => {
    const identification = identificationByItem.get(Number(entry.item.id))
    return [
      requestId, revisionId, entry.item.id, 'request_item_identified',
      'client_request_item_identification', identification.id, actorId,
      JSON.stringify(null), JSON.stringify(identification), JSON.stringify(entry.identification.provenance),
    ]
  }))

  const createdRows = prepared.map((entry) => ({
    source_row: entry.row.source_row,
    item_id: entry.item.id,
    line_number: entry.line_number,
    stable_item_key: entry.stable_item_key,
    match_status: entry.row.match_status,
    catalog_position_id: entry.confirmed_candidate?.catalog_position_id || null,
    technical_identification_task_id: entry.task?.id || null,
    technical_identification_task_number: entry.task?.task_number || null,
    source_uom: entry.row.source_uom,
    uom: entry.row.uom,
    measurement_unit_id: entry.row.measurement_unit_id,
  }))
  if (typeof runtime.afterRow === 'function') {
    for (const entry of prepared) {
      await runtime.afterRow({
        index: entry.index,
        row: entry.row,
        item_id: entry.item.id,
        request_id: requestId,
        revision_id: revisionId,
        conn,
      })
    }
  }
  return { createdRows, exactConfirmation }
}

async function commitIntake(payload, actorUserId, runtime = {}) {
  const actorId = toId(actorUserId)
  const idempotencyKey = cleanText(payload.idempotency_key, 160)
  if (!actorId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Не определён автор заявки')
  if (!idempotencyKey || idempotencyKey.length < 8) {
    throw new ClientRequestDomainError('IDEMPOTENCY_KEY_REQUIRED', 'Для создания заявки требуется ключ безопасного повтора')
  }
  const replay = await fetchCommitted(idempotencyKey)
  if (replay) {
    if (payload.payload_hash && replay.payload_hash !== payload.payload_hash) {
      throw new ClientRequestDomainError('IDEMPOTENCY_PAYLOAD_CONFLICT', 'Этот ключ уже использован для другого набора данных', 409)
    }
    return replay
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const validation = await validateIntake(payload, actorId, conn)
    if (payload.payload_hash !== validation.payload_hash) {
      throw new ClientRequestDomainError('PREVIEW_STALE', 'Данные изменились после проверки. Выполните проверку ещё раз.', 409, {
        current_payload_hash: validation.payload_hash,
      })
    }
    if (!validation.can_commit) {
      throw new ClientRequestDomainError('INTAKE_INVALID', 'Исправьте ошибки перед созданием заявки', 409, {
        errors: validation.errors,
        rows: validation.rows.filter((row) => row.errors.length).map((row) => ({ source_row: row.source_row, errors: row.errors })),
      })
    }

    const header = validation.header
    const [requestInsert] = await conn.execute(
      `INSERT INTO client_requests
        (client_id, client_contact_id, client_installation_id, status, lifecycle_stage,
         source_type, received_at, processing_deadline, created_by_user_id,
         assigned_to_user_id, internal_number, client_reference, contact_name,
         contact_email, contact_phone, comment_internal, comment_client)
       VALUES (?, ?, ?, 'draft', 'intake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        header.client_id, header.client_contact_id, header.client_installation_id,
        header.source_type, header.received_at, header.processing_deadline,
        actorId, header.assigned_to_user_id, header.internal_number, header.client_reference,
        header.contact_name, header.contact_email, header.contact_phone,
        header.initial_note, header.initial_note,
      ]
    )
    const requestId = requestInsert.insertId
    const [revisionInsert] = await conn.execute(
      `INSERT INTO client_request_revisions
        (client_request_id, rev_number, status, revision_reason, created_by_user_id, note)
       VALUES (?, 1, 'draft', 'initial', ?, ?)`,
      [requestId, actorId, header.initial_note]
    )
    const revisionId = revisionInsert.insertId
    await conn.execute(
      'UPDATE client_requests SET current_revision_id = ?, row_version = row_version + 1 WHERE id = ?',
      [revisionId, requestId]
    )

    const { createdRows, exactConfirmation } = await persistRowsSetBased(conn, {
      validation,
      header,
      requestId,
      revisionId,
      actorId,
      payload,
      idempotencyKey,
      runtime,
    })

    await conn.execute(
      `INSERT INTO client_request_events
        (client_request_id, revision_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
       VALUES (?, ?, 'request_intake_committed', 'client_request_revision', ?, ?, ?)`,
      [
        requestId,
        revisionId,
        revisionId,
        actorId,
        JSON.stringify({
          payload_hash: validation.payload_hash,
          row_count: createdRows.length,
          matching_summary: validation.summary,
          exact_confirmation: exactConfirmation,
          idempotency_key: idempotencyKey,
        }),
      ]
    )
    const result = {
      request_id: requestId,
      revision_id: revisionId,
      internal_number: header.internal_number,
      row_count: createdRows.length,
      rows: createdRows,
      matching_summary: validation.summary,
      payload_hash: validation.payload_hash,
      idempotent_replay: false,
    }
    await conn.execute(
      `INSERT INTO client_request_intake_commands
        (idempotency_key, payload_hash, status, client_request_id,
         client_request_revision_id, result_json, created_by_user_id)
       VALUES (?, ?, 'committed', ?, ?, ?, ?)`,
      [idempotencyKey, validation.payload_hash, requestId, revisionId, JSON.stringify(result), actorId]
    )
    await conn.commit()
    return result
  } catch (error) {
    await conn.rollback()
    if (error?.code === 'ER_DUP_ENTRY') {
      const existing = await fetchCommitted(idempotencyKey)
      if (existing) {
        if (payload.payload_hash && existing.payload_hash !== payload.payload_hash) {
          throw new ClientRequestDomainError('IDEMPOTENCY_PAYLOAD_CONFLICT', 'Этот ключ уже использован для другого набора данных', 409)
        }
        return existing
      }
    }
    throw error
  } finally {
    conn.release()
  }
}

module.exports = { commitIntake, validateHeader, validateIntake }
