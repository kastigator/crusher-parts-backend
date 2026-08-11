const crypto = require('crypto')
const db = require('../../utils/db')
const { ClientRequestDomainError } = require('../clientRequests/domainError')
const { getRevisionReadiness } = require('../clientRequests/clientRequestReadModel')
const { setIdentificationInTransaction } = require('../clientRequests/itemService')
const { cleanText, hashPayload, stableJson } = require('./matchService')
const {
  buildClientRequestTaskSourceSnapshot,
  buildTaskCreatedEventPayload,
  buildTechnicalTaskOpenIdentification,
  normalizeTaskPriority,
} = require('./semantics')

const ACTIVE_STATUSES = new Set(['new', 'in_progress', 'waiting_client'])
const TERMINAL_STATUSES = new Set(['resolved', 'closed', 'cancelled', 'superseded'])
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const requireActor = (value) => {
  const actorId = toId(value)
  if (!actorId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Не определён исполнитель команды')
  return actorId
}

const requireIdempotencyKey = (value) => {
  const key = cleanText(value, 160)
  if (!key || key.length < 8) {
    throw new ClientRequestDomainError('IDEMPOTENCY_KEY_REQUIRED', 'Для команды требуется ключ безопасного повтора')
  }
  return key
}

const getTask = async (executor, taskId, lock = false) => {
  const [[task]] = await executor.execute(
    `SELECT * FROM technical_identification_tasks WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
    [taskId]
  )
  if (!task) throw new ClientRequestDomainError('TASK_NOT_FOUND', 'Задача идентификации не найдена', 404)
  return task
}

const ensureVersion = (task, expectedVersion) => {
  const version = Number(expectedVersion)
  if (!Number.isInteger(version) || version < 1) {
    throw new ClientRequestDomainError('ROW_VERSION_REQUIRED', 'Обновите задачу и повторите действие', 409)
  }
  if (Number(task.row_version) !== version) {
    throw new ClientRequestDomainError(
      'TASK_VERSION_CONFLICT',
      'Задача уже изменена другим пользователем. Обновите данные.',
      409,
      { current_row_version: Number(task.row_version) }
    )
  }
}

const findIdempotentEvent = async (executor, idempotencyKey) => {
  const [[event]] = await executor.execute(
    'SELECT * FROM technical_identification_task_events WHERE idempotency_key = ?',
    [idempotencyKey]
  )
  return event || null
}

const parseEventPayload = (event) => {
  if (!event?.payload_json) return {}
  if (typeof event.payload_json === 'object') return event.payload_json
  try { return JSON.parse(event.payload_json) } catch { return {} }
}

const commandEventPayload = (payload = {}) => {
  const semantic = { ...payload }
  delete semantic.idempotency_key
  delete semantic.row_version
  return JSON.parse(JSON.stringify(semantic))
}

const assertIdempotentEvent = (event, { taskId, eventType, payload }) => {
  const matches = Number(event?.task_id) === Number(taskId) &&
    event?.event_type === eventType &&
    stableJson(parseEventPayload(event)) === stableJson(payload || {})
  if (!matches) {
    throw new ClientRequestDomainError(
      'IDEMPOTENCY_PAYLOAD_CONFLICT',
      'Этот ключ безопасного повтора уже использован для другой команды',
      409
    )
  }
  return event
}

const appendEvent = async (conn, {
  taskId,
  eventType,
  fromStatus = null,
  toStatus = null,
  actorUserId,
  payload = null,
  sourceHash = null,
  idempotencyKey = null,
}) => {
  const [[sequence]] = await conn.execute(
    'SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM technical_identification_task_events WHERE task_id = ?',
    [taskId]
  )
  await conn.execute(
    `INSERT INTO technical_identification_task_events
      (task_id, sequence_no, event_type, from_status, to_status, actor_user_id,
       payload_json, source_hash, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      Number(sequence.next_sequence),
      eventType,
      fromStatus,
      toStatus,
      actorUserId,
      payload ? JSON.stringify(payload) : null,
      sourceHash,
      idempotencyKey,
    ]
  )
}

const loadSourceContext = async (executor, itemId, lock = false) => {
  const [[source]] = await executor.execute(
    `SELECT i.*, r.client_request_id, r.rev_number, r.status AS revision_status,
            cr.internal_number, cr.client_id, cr.client_reference,
            c.company_name AS client_name
       FROM client_request_revision_items i
       JOIN client_request_revisions r ON r.id = i.client_request_revision_id
       JOIN client_requests cr ON cr.id = r.client_request_id
       JOIN clients c ON c.id = cr.client_id
      WHERE i.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [itemId]
  )
  if (!source) throw new ClientRequestDomainError('ITEM_NOT_FOUND', 'Строка заявки не найдена', 404)
  return source
}

const createTaskInTransaction = async (conn, {
  itemId,
  actorUserId,
  priority = 'normal',
  dueAt = null,
  assignedToUserId = null,
  candidateSnapshot = null,
  sourceSnapshotExtra = null,
  idempotencyKey = null,
  reopenedFromTaskId = null,
}) => {
  const actorId = requireActor(actorUserId)
  const normalizedPriority = normalizeTaskPriority(priority)
  const source = await loadSourceContext(conn, toId(itemId), true)
  const activeSourceKey = `client_request_item:${source.id}`
  const [[existing]] = await conn.execute(
    `SELECT * FROM technical_identification_tasks
      WHERE active_source_key = ? AND status IN ('new', 'in_progress', 'waiting_client')
      FOR UPDATE`,
    [activeSourceKey]
  )
  if (existing) return { task: existing, created: false }

  const sourceSnapshot = buildClientRequestTaskSourceSnapshot({
    client_request_number: source.internal_number,
    client_reference: source.client_reference,
    client_name: source.client_name,
    revision_number: source.rev_number,
    line_number: source.line_number,
    stable_item_key: source.stable_item_key,
    client_description: source.client_description,
    client_line_text: source.client_line_text,
    client_catalog_number: source.client_catalog_number || source.client_part_number,
    client_manufacturer_text: source.client_manufacturer_text,
    client_equipment_model_text: source.client_equipment_model_text,
    requested_qty: source.requested_qty,
    uom: source.uom,
    required_date: source.required_date,
    client_comment: source.client_comment,
    source_payload: source.source_payload_json,
  }, sourceSnapshotExtra || {})
  const sourceHash = hashPayload(sourceSnapshot)
  const temporaryNumber = `pending-${crypto.randomUUID()}`
  const [insert] = await conn.execute(
    `INSERT INTO technical_identification_tasks
      (task_number, client_request_id, client_request_revision_id,
       client_request_revision_item_id, source_stable_item_key, source_snapshot_json,
       source_hash, candidate_snapshot_json, status, priority, due_at,
       assigned_to_user_id, reopened_from_task_id, active_source_key, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
    [
      temporaryNumber,
      source.client_request_id,
      source.client_request_revision_id,
      source.id,
      source.stable_item_key,
      JSON.stringify(sourceSnapshot),
      sourceHash,
      candidateSnapshot ? JSON.stringify(candidateSnapshot) : null,
      normalizedPriority,
      dueAt || null,
      toId(assignedToUserId),
      toId(reopenedFromTaskId),
      activeSourceKey,
      actorId,
    ]
  )
  const taskNumber = `TI-${new Date().getUTCFullYear()}-${String(insert.insertId).padStart(6, '0')}`
  await conn.execute('UPDATE technical_identification_tasks SET task_number = ? WHERE id = ?', [taskNumber, insert.insertId])
  await appendEvent(conn, {
    taskId: insert.insertId,
    eventType: reopenedFromTaskId ? 'task_reopened' : 'task_created',
    toStatus: 'new',
    actorUserId: actorId,
    payload: buildTaskCreatedEventPayload({
      priority: normalizedPriority,
      assignedToUserId: toId(assignedToUserId),
      dueAt,
      ...(reopenedFromTaskId ? {
        reopened_from_task_id: toId(reopenedFromTaskId),
        reopen_reason: cleanText(sourceSnapshotExtra?.reopen_reason),
      } : {}),
    }),
    sourceHash,
    idempotencyKey,
  })
  const openIdentification = buildTechnicalTaskOpenIdentification({ id: insert.insertId, task_number: taskNumber })
  await setIdentificationInTransaction(conn, source.id, {
    status: openIdentification.identification_status,
    match_method: openIdentification.match_method,
    basis_note: openIdentification.basis_note,
    provenance: openIdentification.provenance,
  }, actorId)
  return { task: await getTask(conn, insert.insertId), created: true }
}

const createTasksBatch = async (payload, actorUserId) => {
  const actorId = requireActor(actorUserId)
  const itemIds = Array.from(new Set((payload.item_ids || []).map(toId).filter(Boolean)))
  if (!itemIds.length || itemIds.length > 500) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Выберите от 1 до 500 строк заявки')
  }
  const batchKey = requireIdempotencyKey(payload.idempotency_key)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const results = []
    for (const itemId of itemIds) {
      results.push(await createTaskInTransaction(conn, {
        itemId,
        actorUserId: actorId,
        priority: payload.priority,
        dueAt: payload.due_at,
        assignedToUserId: payload.assigned_to_user_id,
        idempotencyKey: `${batchKey}:${itemId}`,
      }))
    }
    await conn.commit()
    return { items: results, created_count: results.filter((entry) => entry.created).length }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

const runTaskCommand = async (taskIdInput, payload, actorUserId, command) => {
  const taskId = toId(taskIdInput)
  const actorId = requireActor(actorUserId)
  const idempotencyKey = requireIdempotencyKey(payload.idempotency_key)
  if (!taskId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректная задача')

  const eventPayload = commandEventPayload(payload)
  const priorEvent = await findIdempotentEvent(db, idempotencyKey)
  if (priorEvent) {
    assertIdempotentEvent(priorEvent, { taskId, eventType: command, payload: eventPayload })
    return { task: await getTask(db, priorEvent.task_id), idempotent_replay: true }
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const task = await getTask(conn, taskId, true)
    const concurrentReplay = await findIdempotentEvent(conn, idempotencyKey)
    if (concurrentReplay) {
      assertIdempotentEvent(concurrentReplay, { taskId, eventType: command, payload: eventPayload })
      await conn.commit()
      return { task: await getTask(db, concurrentReplay.task_id), idempotent_replay: true }
    }
    ensureVersion(task, payload.row_version)
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new ClientRequestDomainError('TASK_TERMINAL', 'Завершённую задачу нельзя изменить', 409)
    }

    let nextStatus = task.status
    let updates = {}
    let identification = null
    let eventType = command
    if (command === 'claim') {
      if (task.status !== 'new') throw new ClientRequestDomainError('INVALID_TRANSITION', 'Взять в работу можно только новую задачу', 409)
      nextStatus = 'in_progress'
      updates = {
        assigned_to_user_id: toId(payload.assigned_to_user_id) || actorId,
        started_by_user_id: task.started_by_user_id || actorId,
      }
    } else if (command === 'assign') {
      const priority = payload.priority ? String(payload.priority).toLowerCase() : task.priority
      if (!PRIORITIES.has(priority)) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректный приоритет')
      updates = {
        assigned_to_user_id: payload.assigned_to_user_id === null ? null : (toId(payload.assigned_to_user_id) || task.assigned_to_user_id),
        priority,
        due_at: payload.due_at === undefined ? task.due_at : (payload.due_at || null),
      }
    } else if (command === 'wait_for_client') {
      if (task.status !== 'in_progress') throw new ClientRequestDomainError('INVALID_TRANSITION', 'Уточнение запрашивается из задачи в работе', 409)
      nextStatus = 'waiting_client'
      if (!cleanText(payload.blocker_note)) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Опишите, какие данные нужны от клиента')
      updates = { blocker_code: cleanText(payload.blocker_code, 64) || 'CLIENT_CLARIFICATION', blocker_note: cleanText(payload.blocker_note) }
      identification = await setIdentificationInTransaction(conn, task.client_request_revision_item_id, {
        status: 'needs_client_clarification', match_method: 'technical_task', basis_note: updates.blocker_note,
        provenance: { technical_identification_task_id: task.id, task_number: task.task_number },
      }, actorId)
    } else if (command === 'resume') {
      if (task.status !== 'waiting_client') throw new ClientRequestDomainError('INVALID_TRANSITION', 'Задача не ожидает уточнения', 409)
      nextStatus = 'in_progress'
      updates = { blocker_code: null, blocker_note: null, assigned_to_user_id: task.assigned_to_user_id || actorId }
      identification = await setIdentificationInTransaction(conn, task.client_request_revision_item_id, {
        status: 'technical_task_open', match_method: 'technical_task', basis_note: `Работа по ${task.task_number} продолжена`,
        provenance: { technical_identification_task_id: task.id, task_number: task.task_number },
      }, actorId)
    } else if (command === 'cancel') {
      nextStatus = payload.superseded ? 'superseded' : 'cancelled'
      updates = { resolution_note: cleanText(payload.note) || 'Задача отменена', active_source_key: null, closed_by_user_id: actorId }
      identification = await setIdentificationInTransaction(conn, task.client_request_revision_item_id, {
        status: 'unprocessed', match_method: 'technical_task', basis_note: updates.resolution_note,
        provenance: { technical_identification_task_id: task.id, task_number: task.task_number },
      }, actorId)
    } else if (command === 'close') {
      if (!['in_progress', 'waiting_client'].includes(task.status)) {
        throw new ClientRequestDomainError('INVALID_TRANSITION', 'Закрыть без Catalog Position можно только задачу в работе или на уточнении', 409)
      }
      const resolutionType = cleanText(payload.resolution_type, 32)
      const resolutionNote = cleanText(payload.resolution_note || payload.note)
      if (!resolutionType || !resolutionNote) {
        throw new ClientRequestDomainError('VALIDATION_ERROR', 'Укажите тип и основание закрытия без Catalog Position')
      }
      nextStatus = 'closed'
      updates = {
        resolution_type: resolutionType,
        resolution_note: resolutionNote,
        blocker_code: null,
        blocker_note: null,
        active_source_key: null,
        closed_by_user_id: actorId,
      }
      identification = await setIdentificationInTransaction(conn, task.client_request_revision_item_id, {
        status: 'not_required',
        match_method: 'technical_task',
        basis_note: resolutionNote,
        provenance: {
          technical_identification_task_id: task.id,
          task_number: task.task_number,
          resolution_type: resolutionType,
          terminal_outcome: 'closed_without_catalog_position',
        },
      }, actorId)
    } else {
      throw new ClientRequestDomainError('VALIDATION_ERROR', 'Неизвестная команда')
    }

    const assignments = [
      'status = ?', 'row_version = row_version + 1',
      'assigned_to_user_id = ?', 'priority = ?', 'due_at = ?',
      'blocker_code = ?', 'blocker_note = ?', 'active_source_key = ?',
      'started_by_user_id = ?',
      "started_at = CASE WHEN ? IS NOT NULL AND started_at IS NULL THEN CURRENT_TIMESTAMP(6) ELSE started_at END",
      'closed_by_user_id = ?',
      "closed_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP(6) ELSE closed_at END",
      'resolution_note = ?',
      'resolution_type = ?',
    ]
    const values = [
      nextStatus,
      updates.assigned_to_user_id === undefined ? task.assigned_to_user_id : updates.assigned_to_user_id,
      updates.priority === undefined ? task.priority : updates.priority,
      updates.due_at === undefined ? task.due_at : updates.due_at,
      updates.blocker_code === undefined ? task.blocker_code : updates.blocker_code,
      updates.blocker_note === undefined ? task.blocker_note : updates.blocker_note,
      updates.active_source_key === undefined ? task.active_source_key : updates.active_source_key,
      updates.started_by_user_id === undefined ? task.started_by_user_id : updates.started_by_user_id,
      updates.started_by_user_id === undefined ? task.started_by_user_id : updates.started_by_user_id,
      updates.closed_by_user_id === undefined ? task.closed_by_user_id : updates.closed_by_user_id,
      updates.closed_by_user_id === undefined ? task.closed_by_user_id : updates.closed_by_user_id,
      updates.resolution_note === undefined ? task.resolution_note : updates.resolution_note,
      updates.resolution_type === undefined ? task.resolution_type : updates.resolution_type,
      task.id,
    ]
    await conn.execute(`UPDATE technical_identification_tasks SET ${assignments.join(', ')} WHERE id = ?`, values)
    await appendEvent(conn, {
      taskId: task.id,
      eventType,
      fromStatus: task.status,
      toStatus: nextStatus,
      actorUserId: actorId,
      payload: eventPayload,
      sourceHash: task.source_hash,
      idempotencyKey,
    })
    const updated = await getTask(conn, task.id)
    await conn.commit()
    return { task: updated, identification: identification?.identification || null, idempotent_replay: false }
  } catch (error) {
    await conn.rollback()
    if (error?.code === 'ER_DUP_ENTRY') {
      const event = await findIdempotentEvent(db, idempotencyKey)
      if (event) {
        assertIdempotentEvent(event, { taskId, eventType: command, payload: eventPayload })
        return { task: await getTask(db, event.task_id), idempotent_replay: true }
      }
    }
    throw error
  } finally {
    conn.release()
  }
}

const resolveTask = async (taskIdInput, payload, actorUserId) => {
  const taskId = toId(taskIdInput)
  const catalogPositionId = toId(payload.catalog_position_id)
  const actorId = requireActor(actorUserId)
  const idempotencyKey = requireIdempotencyKey(payload.idempotency_key)
  if (!taskId || !catalogPositionId) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Выберите задачу и позицию каталога')
  }
  const resolutionType = String(payload.resolution_type || 'reused_existing').toLowerCase()
  if (!['reused_existing', 'created_new'].includes(resolutionType)) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректный результат идентификации')
  }
  const resolutionNote = cleanText(payload.resolution_note)
  const eventPayload = { catalog_position_id: catalogPositionId, resolution_type: resolutionType, resolution_note: resolutionNote }
  const priorEvent = await findIdempotentEvent(db, idempotencyKey)
  if (priorEvent) {
    assertIdempotentEvent(priorEvent, { taskId, eventType: 'task_resolved', payload: eventPayload })
    return { task: await getTask(db, priorEvent.task_id), idempotent_replay: true }
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const task = await getTask(conn, taskId, true)
    const concurrentReplay = await findIdempotentEvent(conn, idempotencyKey)
    if (concurrentReplay) {
      assertIdempotentEvent(concurrentReplay, { taskId, eventType: 'task_resolved', payload: eventPayload })
      await conn.commit()
      return { task: await getTask(db, concurrentReplay.task_id), idempotent_replay: true }
    }
    ensureVersion(task, payload.row_version)
    if (task.status !== 'in_progress') {
      throw new ClientRequestDomainError('INVALID_TRANSITION', 'Перед подтверждением возьмите задачу в работу', 409)
    }
    const identificationResult = await setIdentificationInTransaction(conn, task.client_request_revision_item_id, {
      status: 'confirmed',
      catalog_position_id: catalogPositionId,
      match_method: 'technical_task',
      confidence: 100,
      basis_note: resolutionNote || `Решено в ${task.task_number}`,
      provenance: {
        technical_identification_task_id: task.id,
        task_number: task.task_number,
        resolution_type: resolutionType,
      },
    }, actorId)
    const [result] = await conn.execute(
      `UPDATE technical_identification_tasks
          SET status = 'resolved', result_catalog_position_id = ?, resolution_type = ?,
              resolution_note = ?, active_source_key = NULL, resolved_by_user_id = ?,
              resolved_at = CURRENT_TIMESTAMP(6), row_version = row_version + 1
        WHERE id = ? AND row_version = ?`,
      [catalogPositionId, resolutionType, resolutionNote, actorId, task.id, task.row_version]
    )
    if (Number(result.affectedRows) !== 1) {
      throw new ClientRequestDomainError('TASK_VERSION_CONFLICT', 'Задача уже изменена другим пользователем', 409)
    }
    await appendEvent(conn, {
      taskId: task.id,
      eventType: 'task_resolved',
      fromStatus: task.status,
      toStatus: 'resolved',
      actorUserId: actorId,
      payload: eventPayload,
      sourceHash: task.source_hash,
      idempotencyKey,
    })
    const readiness = await getRevisionReadiness(task.client_request_revision_id, conn)
    const [[requestState]] = await conn.execute(
      `SELECT COUNT(*) AS open_tasks
         FROM technical_identification_tasks
        WHERE client_request_id = ? AND status IN ('new', 'in_progress', 'waiting_client')`,
      [task.client_request_id]
    )
    await conn.execute(
      `UPDATE client_requests
          SET lifecycle_stage = CASE WHEN ? = 0 THEN 'identification' ELSE lifecycle_stage END,
              row_version = row_version + 1
        WHERE id = ?`,
      [Number(requestState.open_tasks), task.client_request_id]
    )
    const updated = await getTask(conn, task.id)
    await conn.commit()
    return {
      task: updated,
      identification: identificationResult.identification,
      readiness: readiness.summary,
      item_readiness: readiness.items.find((item) => Number(item.id) === Number(task.client_request_revision_item_id))?.readiness || null,
      idempotent_replay: false,
    }
  } catch (error) {
    await conn.rollback()
    if (error?.code === 'ER_DUP_ENTRY') {
      const event = await findIdempotentEvent(db, idempotencyKey)
      if (event) {
        assertIdempotentEvent(event, { taskId, eventType: 'task_resolved', payload: eventPayload })
        return { task: await getTask(db, event.task_id), idempotent_replay: true }
      }
    }
    throw error
  } finally {
    conn.release()
  }
}

const reopenTask = async (taskIdInput, payload, actorUserId) => {
  const taskId = toId(taskIdInput)
  const actorId = requireActor(actorUserId)
  const idempotencyKey = requireIdempotencyKey(payload.idempotency_key)
  const reopenReason = cleanText(payload.reason)
  if (!reopenReason) {
    throw new ClientRequestDomainError('VALIDATION_ERROR', 'Укажите основание повторной идентификации')
  }
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const previous = await getTask(conn, taskId, true)
    if (!TERMINAL_STATUSES.has(previous.status)) {
      throw new ClientRequestDomainError('TASK_NOT_TERMINAL', 'Повторная идентификация доступна после завершения задачи', 409)
    }
    const reopenEventPayload = buildTaskCreatedEventPayload({
      priority: payload.priority || previous.priority,
      assignedToUserId: toId(payload.assigned_to_user_id) || previous.assigned_to_user_id,
      dueAt: payload.due_at || null,
      reopened_from_task_id: previous.id,
      reopen_reason: reopenReason,
    })
    const priorEvent = await findIdempotentEvent(conn, idempotencyKey)
    if (priorEvent) {
      const replayTask = await getTask(conn, priorEvent.task_id)
      assertIdempotentEvent(priorEvent, { taskId: replayTask.id, eventType: 'task_reopened', payload: reopenEventPayload })
      if (Number(replayTask.reopened_from_task_id) !== Number(previous.id)) {
        throw new ClientRequestDomainError('IDEMPOTENCY_PAYLOAD_CONFLICT', 'Этот ключ уже использован для другой команды', 409)
      }
      await conn.commit()
      return { task: replayTask, created: false, idempotent_replay: true }
    }
    const result = await createTaskInTransaction(conn, {
      itemId: previous.client_request_revision_item_id,
      actorUserId: actorId,
      priority: payload.priority || previous.priority,
      dueAt: payload.due_at || null,
      assignedToUserId: payload.assigned_to_user_id || previous.assigned_to_user_id,
      sourceSnapshotExtra: { reopen_reason: reopenReason, previous_task_number: previous.task_number },
      idempotencyKey,
      reopenedFromTaskId: previous.id,
    })
    if (!result.created) {
      throw new ClientRequestDomainError('ACTIVE_TASK_EXISTS', 'Для этой строки уже существует активная задача идентификации', 409)
    }
    await conn.commit()
    return result
  } catch (error) {
    await conn.rollback()
    if (error?.code === 'ER_DUP_ENTRY') {
      const event = await findIdempotentEvent(db, idempotencyKey)
      if (event) return { task: await getTask(db, event.task_id), created: false, idempotent_replay: true }
    }
    throw error
  } finally {
    conn.release()
  }
}

module.exports = {
  ACTIVE_STATUSES,
  appendEvent,
  createTaskInTransaction,
  createTasksBatch,
  reopenTask,
  resolveTask,
  runTaskCommand,
}
