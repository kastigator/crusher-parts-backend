#!/usr/bin/env node

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const db = require('../../utils/db')
const { commitIntake, validateIntake } = require('../../services/clientRequests/intakeService')
const { reopenTask, runTaskCommand } = require('../../services/technicalIdentification/taskService')

const actorUserId = Number(process.env.TASK103_ACTOR_USER_ID || 4)
const clientId = Number(process.env.TASK103_CLIENT_ID || 86)
const uniqueKey = (name) => `task103:${name}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`

async function expectConflict(action, code) {
  let actual = null
  try { await action() } catch (error) { actual = error.code }
  assert.equal(actual, code)
}

async function createTwoTasks() {
  const token = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const payload = {
    header: {
      client_id: clientId,
      assigned_to_user_id: actorUserId,
      internal_number: `T103-TI-IDEMP-${token}`,
      client_reference: 'Task 103 TI semantic idempotency verification',
      source_type: 'manual',
    },
    rows: [1, 2].map((line) => ({
      row_key: `${token}-${line}`,
      source_row: line,
      client_description: `Task 103 synthetic identification ${token} line ${line}`,
      client_catalog_number: `T103-NO-MATCH-${token}-${line}`,
      requested_qty: line,
      source_uom: 'ea',
      uom: 'ea',
    })),
    options: { confirm_exact_matches: false, create_tasks_for_unresolved: true },
    idempotency_key: uniqueKey('intake'),
  }
  const preview = await validateIntake(payload, actorUserId)
  assert.equal(preview.can_commit, true, JSON.stringify(preview.errors))
  payload.payload_hash = preview.payload_hash
  const committed = await commitIntake(payload, actorUserId)
  assert.equal(committed.rows.length, 2)
  assert.ok(committed.rows.every((row) => row.technical_identification_task_id))
  return committed
}

async function main() {
  const committed = await createTwoTasks()
  const [first, second] = committed.rows
  const concurrentKey = uniqueKey('claim')
  const claimPayload = { row_version: 1, idempotency_key: concurrentKey }
  const concurrent = await Promise.all([
    runTaskCommand(first.technical_identification_task_id, claimPayload, actorUserId, 'claim'),
    runTaskCommand(first.technical_identification_task_id, claimPayload, actorUserId, 'claim'),
  ])
  assert.equal(concurrent.filter((result) => result.idempotent_replay).length, 1)
  assert.ok(concurrent.every((result) => result.task.status === 'in_progress'))

  await expectConflict(
    () => runTaskCommand(second.technical_identification_task_id, claimPayload, actorUserId, 'claim'),
    'IDEMPOTENCY_PAYLOAD_CONFLICT'
  )

  const waitKey = uniqueKey('wait')
  const waitPayload = {
    row_version: 2,
    idempotency_key: waitKey,
    blocker_code: 'CLIENT_CLARIFICATION',
    blocker_note: 'Нужен точный заводской номер',
  }
  const waited = await runTaskCommand(first.technical_identification_task_id, waitPayload, actorUserId, 'wait_for_client')
  const waitReplay = await runTaskCommand(first.technical_identification_task_id, waitPayload, actorUserId, 'wait_for_client')
  assert.equal(waited.task.status, 'waiting_client')
  assert.equal(waitReplay.idempotent_replay, true)
  await expectConflict(
    () => runTaskCommand(first.technical_identification_task_id, { ...waitPayload, blocker_note: 'Другой запрос' }, actorUserId, 'wait_for_client'),
    'IDEMPOTENCY_PAYLOAD_CONFLICT'
  )

  const closeKey = uniqueKey('close')
  const closed = await runTaskCommand(first.technical_identification_task_id, {
    row_version: 3,
    idempotency_key: closeKey,
    resolution_type: 'not_catalog_item',
    resolution_note: 'Синтетическая терминальная проверка Task 103',
  }, actorUserId, 'close')
  assert.equal(closed.task.status, 'closed')

  const reopenKey = uniqueKey('reopen')
  const reopenPayload = { idempotency_key: reopenKey, reason: 'Повторная проверка Task 103' }
  const reopened = await reopenTask(first.technical_identification_task_id, reopenPayload, actorUserId)
  const reopenReplay = await reopenTask(first.technical_identification_task_id, reopenPayload, actorUserId)
  assert.equal(reopened.created, true)
  assert.equal(reopenReplay.idempotent_replay, true)
  assert.equal(Number(reopenReplay.task.id), Number(reopened.task.id))
  await expectConflict(
    () => reopenTask(first.technical_identification_task_id, { ...reopenPayload, reason: 'Другая причина' }, actorUserId),
    'IDEMPOTENCY_PAYLOAD_CONFLICT'
  )
  await expectConflict(
    () => reopenTask(first.technical_identification_task_id, { idempotency_key: uniqueKey('reopen-active'), reason: 'Ещё одно поколение' }, actorUserId),
    'ACTIVE_TASK_EXISTS'
  )

  const [events] = await db.execute(
    `SELECT idempotency_key, COUNT(*) AS event_count
       FROM technical_identification_task_events
      WHERE idempotency_key IN (?, ?, ?, ?)
      GROUP BY idempotency_key`,
    [concurrentKey, waitKey, closeKey, reopenKey]
  )
  assert.equal(events.length, 4)
  assert.ok(events.every((event) => Number(event.event_count) === 1))

  process.stdout.write(`${JSON.stringify({
    request_id: committed.request_id,
    concurrent_claim: concurrent.map((result) => ({ task_id: result.task.id, replay: result.idempotent_replay })),
    wait_replay: waitReplay.idempotent_replay,
    reopened_task_id: reopened.task.id,
    reopen_replay: reopenReplay.idempotent_replay,
    event_counts: events,
  }, null, 2)}\n`)
}

main()
  .then(() => db.end())
  .catch(async (error) => {
    console.error(error)
    await db.end().catch(() => {})
    process.exitCode = 1
  })
