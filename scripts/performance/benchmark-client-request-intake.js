#!/usr/bin/env node

const crypto = require('node:crypto')

const db = require('../../utils/db')

const getArg = (name, fallback = null) => {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))
  return value ? value.slice(prefix.length) : fallback
}

const sizes = String(getArg('sizes', '10,50,100')).split(',').map(Number).filter((value) => value > 0)
const runs = Number(getArg('runs', '1')) || 1
const label = getArg('label', 'profile')
const actorUserId = Number(getArg('actor', '4')) || 4
const clientId = Number(getArg('client', '86')) || 86

const classifySql = (sqlInput) => {
  const sql = String(sqlInput || '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (sql.includes('client_request_intake_commands')) {
    return sql.startsWith('select') ? 'idempotency_lookup' : 'idempotency_write'
  }
  if (sql.includes('from measurement_units')) return 'uom_resolution'
  if (sql.includes('from catalog_positions cp')) return 'matching_candidates'
  if (
    sql.includes('select id from clients') ||
    sql.includes('select id from client_contacts') ||
    sql.includes('select id from client_equipment_units') ||
    sql.includes('select id from client_requests where internal_number')
  ) return 'business_validation'
  if (
    sql.startsWith('insert into client_requests') ||
    sql.startsWith('insert into client_request_revisions') ||
    sql.startsWith('update client_requests set current_revision_id')
  ) return 'request_revision'
  if (
    sql.startsWith('insert into client_request_revision_items') ||
    sql.startsWith('insert into client_request_item_requirements') ||
    sql.includes('from client_request_revision_items where client_request_revision_id')
  ) return 'line_persistence'
  if (sql.includes('technical_identification_task_events')) return 'task_events'
  if (sql.includes('technical_identification_tasks')) return 'task_creation'
  if (
    sql.includes('client_request_item_identifications') ||
    sql.startsWith('update client_request_revision_items set catalog_position_id') ||
    (sql.includes('from client_request_revision_items i') && sql.includes('r.status as revision_status'))
  ) return 'identification_persistence'
  if (sql.includes('from client_request_revision_items i') && sql.includes('c.company_name as client_name')) {
    return 'task_creation'
  }
  if (sql.startsWith('select company_name from clients')) return 'task_creation'
  if (sql.startsWith('insert into client_request_events')) return 'client_request_events'
  if (sql.includes('readiness')) return 'readiness_projection'
  return 'other_sql'
}

const profile = {
  active: null,
  start(run) {
    this.active = { run, statements: [], transaction: [] }
  },
  record(kind, elapsedMs, sql = null) {
    if (!this.active) return
    const target = sql ? this.active.statements : this.active.transaction
    target.push({ kind, elapsed_ms: elapsedMs, sql })
  },
  finish() {
    const current = this.active
    this.active = null
    return current
  },
}

const elapsedMs = (started) => Number(process.hrtime.bigint() - started) / 1e6
const originalPoolExecute = db.execute.bind(db)
const originalGetConnection = db.getConnection.bind(db)

db.execute = async (sql, params) => {
  const started = process.hrtime.bigint()
  try {
    return await originalPoolExecute(sql, params)
  } finally {
    profile.record(classifySql(sql), elapsedMs(started), String(sql).replace(/\s+/g, ' ').trim().slice(0, 180))
  }
}

db.getConnection = async () => {
  const started = process.hrtime.bigint()
  const conn = await originalGetConnection()
  profile.record('connection_acquire', elapsedMs(started))
  if (conn.__task101Profiled) return conn
  conn.__task101Profiled = true
  const originalExecute = conn.execute.bind(conn)
  const originalBegin = conn.beginTransaction.bind(conn)
  const originalCommit = conn.commit.bind(conn)
  const originalRollback = conn.rollback.bind(conn)
  conn.execute = async (sql, params) => {
    const queryStarted = process.hrtime.bigint()
    try {
      return await originalExecute(sql, params)
    } finally {
      profile.record(classifySql(sql), elapsedMs(queryStarted), String(sql).replace(/\s+/g, ' ').trim().slice(0, 180))
    }
  }
  conn.beginTransaction = async () => {
    const transactionStarted = process.hrtime.bigint()
    try {
      return await originalBegin()
    } finally {
      profile.record('begin_transaction', elapsedMs(transactionStarted))
    }
  }
  conn.commit = async () => {
    const transactionStarted = process.hrtime.bigint()
    try {
      return await originalCommit()
    } finally {
      profile.record('commit', elapsedMs(transactionStarted))
    }
  }
  conn.rollback = async () => {
    const transactionStarted = process.hrtime.bigint()
    try {
      return await originalRollback()
    } finally {
      profile.record('rollback', elapsedMs(transactionStarted))
    }
  }
  return conn
}

const summarizeProfile = (capture) => {
  const phases = {}
  for (const entry of [...capture.statements, ...capture.transaction]) {
    const phase = phases[entry.kind] || { count: 0, elapsed_ms: 0 }
    phase.count += 1
    phase.elapsed_ms += entry.elapsed_ms
    phases[entry.kind] = phase
  }
  for (const phase of Object.values(phases)) phase.elapsed_ms = Number(phase.elapsed_ms.toFixed(3))
  return {
    sql_queries: capture.statements.length,
    db_round_trips: capture.statements.length + capture.transaction.length,
    phases,
  }
}

const makePayload = (size, runNumber) => {
  const token = `${label}-${size}-${runNumber}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  return {
    header: {
      client_id: clientId,
      assigned_to_user_id: actorUserId,
      internal_number: `T101-${token}`.slice(0, 120),
      client_reference: `Task 101 ${label} ${size} rows run ${runNumber}`,
      source_type: 'manual',
    },
    rows: Array.from({ length: size }, (_, index) => ({
      row_key: `${token}-row-${index + 1}`,
      source_row: index + 1,
      client_description: `Task 101 performance synthetic position ${token} ${index + 1}`,
      client_catalog_number: `T101-${token}-${String(index + 1).padStart(4, '0')}`,
      client_manufacturer_text: 'Task 101 Synthetic',
      requested_qty: (index % 7) + 1,
      uom: index % 4 === 2 ? 'kg' : (index % 2 ? 'pcs' : 'ea'),
      source_uom: index % 4 === 2 ? 'kg' : (index % 2 ? 'pcs' : 'ea'),
      source_payload: {
        source_type: 'task101_performance_profile',
        source_row: index + 1,
        original_uom: index % 4 === 2 ? 'kg' : (index % 2 ? 'pcs' : 'ea'),
      },
    })),
    options: {
      confirm_exact_matches: false,
      create_tasks_for_unresolved: true,
      task_defaults: { priority: 'normal' },
    },
    idempotency_key: `task101:${token}`,
  }
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function main() {
  const { commitIntake, validateIntake } = require('../../services/clientRequests/intakeService')
  const results = []
  for (const size of sizes) {
    for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
      process.stderr.write(`[task101] ${label}: ${size} rows, run ${runNumber}/${runs}\n`)
      const payload = makePayload(size, runNumber)
      const previewStarted = process.hrtime.bigint()
      const preview = await validateIntake(payload, actorUserId)
      const previewElapsed = elapsedMs(previewStarted)
      if (!preview.can_commit) throw new Error(`Preview rejected: ${JSON.stringify(preview.errors)}`)
      payload.payload_hash = preview.payload_hash

      profile.start({ size, run: runNumber })
      const commitStarted = process.hrtime.bigint()
      const committed = await commitIntake(payload, actorUserId)
      const commitElapsed = elapsedMs(commitStarted)
      const capture = profile.finish()
      const summary = summarizeProfile(capture)
      const result = {
        label,
        size,
        run: runNumber,
        request_id: committed.request_id,
        internal_number: committed.internal_number,
        preview_elapsed_ms: Number(previewElapsed.toFixed(3)),
        commit_elapsed_ms: Number(commitElapsed.toFixed(3)),
        ...summary,
      }
      results.push(result)
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  }
  const aggregate = sizes.map((size) => {
    const entries = results.filter((entry) => entry.size === size)
    return {
      size,
      runs: entries.length,
      individual_commit_ms: entries.map((entry) => entry.commit_elapsed_ms),
      median_commit_ms: Number(median(entries.map((entry) => entry.commit_elapsed_ms)).toFixed(3)),
      individual_queries: entries.map((entry) => entry.sql_queries),
      median_queries: Number(median(entries.map((entry) => entry.sql_queries)).toFixed(3)),
      individual_round_trips: entries.map((entry) => entry.db_round_trips),
      median_round_trips: Number(median(entries.map((entry) => entry.db_round_trips)).toFixed(3)),
    }
  })
  process.stdout.write(`${JSON.stringify({ label, aggregate })}\n`)
  await db.end()
}

main().catch(async (error) => {
  console.error(error)
  await db.end().catch(() => {})
  process.exitCode = 1
})
