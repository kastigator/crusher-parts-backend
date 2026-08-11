#!/usr/bin/env node

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const db = require('../../utils/db')
const { commitIntake, validateIntake } = require('../../services/clientRequests/intakeService')

const actorUserId = Number(process.env.TASK101_ACTOR_USER_ID || 4)
const clientId = Number(process.env.TASK101_CLIENT_ID || 86)

const makePayload = (token, size, overrides = {}) => ({
  header: {
    client_id: clientId,
    assigned_to_user_id: actorUserId,
    internal_number: `T101-verify-${token}`.slice(0, 120),
    client_reference: `Task 101 verification ${token}`,
    source_type: 'manual',
  },
  rows: Array.from({ length: size }, (_, index) => ({
    row_key: `${token}-${index + 1}`,
    source_row: index + 1,
    client_description: `Task 101 verification position ${token} ${index + 1}`,
    client_catalog_number: `T101-V-${token}-${index + 1}`,
    client_manufacturer_text: 'Task 101 Synthetic',
    requested_qty: index + 1,
    source_uom: index % 3 === 0 ? 'ea' : (index % 3 === 1 ? 'pcs' : 'kg'),
    uom: index % 3 === 0 ? 'ea' : (index % 3 === 1 ? 'pcs' : 'kg'),
    source_payload: {
      source_type: 'task101_verification',
      original_uom: index % 3 === 0 ? 'ea' : (index % 3 === 1 ? 'pcs' : 'kg'),
    },
  })),
  options: {
    confirm_exact_matches: false,
    create_tasks_for_unresolved: true,
    task_defaults: { priority: 'normal' },
  },
  idempotency_key: `task101:verify:${token}`,
  ...overrides,
})

const preview = async (payload) => {
  const result = await validateIntake(payload, actorUserId)
  assert.equal(result.can_commit, true, JSON.stringify(result.errors))
  payload.payload_hash = result.payload_hash
  return result
}

async function verifyIdempotency() {
  const token = `idempotency-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const payload = makePayload(token, 10)
  await preview(payload)
  const first = await commitIntake(payload, actorUserId)
  const replay = await commitIntake(payload, actorUserId)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.request_id, first.request_id)
  const [[counts]] = await db.execute(
    `SELECT
       (SELECT COUNT(*) FROM client_requests WHERE internal_number = ?) AS requests,
       (SELECT COUNT(*) FROM client_request_intake_commands WHERE idempotency_key = ?) AS commands`,
    [payload.header.internal_number, payload.idempotency_key]
  )
  assert.equal(Number(counts.requests), 1)
  assert.equal(Number(counts.commands), 1)

  let conflictCode = null
  try {
    await commitIntake({ ...payload, payload_hash: '0'.repeat(64) }, actorUserId)
  } catch (error) {
    conflictCode = error.code
  }
  assert.equal(conflictCode, 'IDEMPOTENCY_PAYLOAD_CONFLICT')
  return { request_id: first.request_id, replay_request_id: replay.request_id, conflict_code: conflictCode, ...counts }
}

async function verifyRollback() {
  const token = `rollback-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const payload = makePayload(token, 12)
  await preview(payload)
  let injectedError = null
  try {
    await commitIntake(payload, actorUserId, {
      afterRow: async ({ index }) => {
        if (index === 4) throw new Error('TASK101_INJECTED_ROLLBACK')
      },
    })
  } catch (error) {
    injectedError = error.message
  }
  assert.equal(injectedError, 'TASK101_INJECTED_ROLLBACK')
  const [[counts]] = await db.execute(
    `SELECT
       (SELECT COUNT(*) FROM client_requests WHERE internal_number = ?) AS requests,
       (SELECT COUNT(*) FROM client_request_intake_commands WHERE idempotency_key = ?) AS commands,
       (SELECT COUNT(*) FROM technical_identification_task_events WHERE idempotency_key LIKE ?) AS task_events`,
    [payload.header.internal_number, payload.idempotency_key, `${payload.idempotency_key}:%`]
  )
  assert.deepEqual(
    { requests: Number(counts.requests), commands: Number(counts.commands), task_events: Number(counts.task_events) },
    { requests: 0, commands: 0, task_events: 0 }
  )
  return { injected_error: injectedError, ...counts }
}

async function verifySemantics() {
  const [[catalogPosition]] = await db.execute(
    `SELECT id FROM catalog_positions
      WHERE is_active = 1 AND (status IS NULL OR status <> 'archived')
      ORDER BY id LIMIT 1`
  )
  assert.ok(catalogPosition?.id)
  const token = `semantics-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const payload = makePayload(token, 3)
  payload.rows[0].confirmed_catalog_position_id = Number(catalogPosition.id)
  await preview(payload)
  const committed = await commitIntake(payload, actorUserId)
  const [rows] = await db.execute(
    `SELECT i.line_number, i.catalog_position_id, i.uom,
            JSON_UNQUOTE(JSON_EXTRACT(i.source_payload_json, '$.normalized.source_uom')) AS source_uom,
            ident.identification_status, ident.match_method,
            t.id AS task_id, t.task_number, te.event_type AS task_event_type
       FROM client_request_revision_items i
       JOIN client_request_item_identifications ident ON ident.client_request_revision_item_id = i.id
       LEFT JOIN technical_identification_tasks t ON t.client_request_revision_item_id = i.id
       LEFT JOIN technical_identification_task_events te ON te.task_id = t.id AND te.sequence_no = 1
      WHERE i.client_request_revision_id = ?
      ORDER BY i.line_number`,
    [committed.revision_id]
  )
  assert.equal(rows.length, 3)
  assert.equal(rows[0].identification_status, 'confirmed')
  assert.equal(rows[0].match_method, 'manual')
  assert.equal(Number(rows[0].catalog_position_id), Number(catalogPosition.id))
  assert.equal(rows[0].task_id, null)
  assert.equal(rows[0].source_uom, 'ea')
  assert.equal(rows[0].uom, 'шт')
  for (const row of rows.slice(1)) {
    assert.equal(row.identification_status, 'technical_task_open')
    assert.equal(row.match_method, 'technical_task')
    assert.ok(row.task_id)
    assert.match(row.task_number, /^TI-\d{4}-\d{6}$/)
    assert.equal(row.task_event_type, 'task_created')
  }
  assert.equal(rows[1].source_uom, 'pcs')
  assert.equal(rows[1].uom, 'шт')
  assert.equal(rows[2].source_uom, 'kg')
  assert.equal(rows[2].uom, 'кг')
  return { request_id: committed.request_id, revision_id: committed.revision_id, rows }
}

async function main() {
  const result = {
    idempotency: await verifyIdempotency(),
    rollback: await verifyRollback(),
    semantics: await verifySemantics(),
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  await db.end()
}

main().catch(async (error) => {
  console.error(error)
  await db.end().catch(() => {})
  process.exitCode = 1
})
