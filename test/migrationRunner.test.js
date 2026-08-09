const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { parseMigrationFile, validateMigrationSequence } = require('../migrations/lib/migrationFiles')
const { safeErrorSummary } = require('../migrations/lib/ledger')
const {
  BASELINE_CONFIRMATION,
  FAILED_RECOVERY_CONFIRMATION,
  acknowledgeFailedMigration,
  baselineDatabase,
  runManagedMigrations,
} = require('../migrations/lib/runner')

const LEDGER_COLUMNS = [
  'migration_id', 'version', 'description', 'checksum', 'status',
  'attempted_at', 'applied_at', 'actor', 'release_identity', 'duration_ms',
  'error_summary', 'schema_fingerprint', 'metadata', 'baseline_guard',
  'created_at', 'updated_at',
]

const FP0 = '0'.repeat(64)
const FP1 = '1'.repeat(64)
const FP2 = '2'.repeat(64)

class FakeConnection {
  constructor({ lockAvailable = true, fingerprint = FP0, nextFingerprints = [] } = {}) {
    this.lockAvailable = lockAvailable
    this.currentFingerprint = fingerprint
    this.nextFingerprints = [...nextFingerprints]
    this.ledgerExists = false
    this.ledger = []
    this.executedMigrations = []
    this.ledgerCreates = 0
  }

  async execute(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    if (normalized.startsWith('SELECT GET_LOCK')) {
      return [[{ acquired: this.lockAvailable ? 1 : 0 }]]
    }
    if (normalized.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]]
    if (normalized.includes('FROM information_schema.TABLES')) {
      return [[{ count: this.ledgerExists ? 1 : 0 }]]
    }
    if (normalized.includes('FROM information_schema.COLUMNS')) {
      return [this.ledgerExists ? LEDGER_COLUMNS.map((columnName) => ({ columnName })) : []]
    }
    if (normalized.includes('FROM schema_migrations')) {
      return [this.ledger
        .slice()
        .sort((left, right) => left.version - right.version)
        .map((row) => ({ ...row }))]
    }
    if (normalized.startsWith('INSERT INTO schema_migrations')) {
      if (normalized.includes("'BASELINE'")) {
        this.ledger.push({
          id: params[0],
          version: params[1],
          description: params[2],
          checksum: params[3],
          status: 'BASELINE',
          attemptedAt: new Date(),
          appliedAt: new Date(),
          actor: params[4],
          releaseIdentity: params[5],
          durationMs: params[6],
          errorSummary: null,
          schemaFingerprint: params[7],
          metadata: JSON.parse(params[8]),
        })
      } else {
        this.ledger.push({
          id: params[0],
          version: params[1],
          description: params[2],
          checksum: params[3],
          status: 'RUNNING',
          attemptedAt: new Date(),
          appliedAt: null,
          actor: params[4],
          releaseIdentity: params[5],
          durationMs: null,
          errorSummary: null,
          schemaFingerprint: null,
          metadata: JSON.parse(params[6]),
        })
      }
      return [{ affectedRows: 1 }]
    }
    if (normalized.startsWith('UPDATE schema_migrations')) {
      if (normalized.includes('SET metadata = ?')) {
        const row = this.ledger.find((item) => item.id === params[1])
        assert(row, `Missing fake ledger row ${params[1]}`)
        row.metadata = JSON.parse(params[0])
        return [{ affectedRows: 1 }]
      }
      const row = this.ledger.find((item) => item.id === params.at(-1))
      assert(row, `Missing fake ledger row ${params.at(-1)}`)
      if (normalized.includes("status = 'APPLIED'")) {
        row.status = 'APPLIED'
        row.appliedAt = new Date()
        row.durationMs = params[0]
        row.errorSummary = null
        row.schemaFingerprint = params[1]
      } else {
        row.status = 'FAILED'
        row.durationMs = params[0]
        row.errorSummary = params[1]
        row.schemaFingerprint = params[2]
      }
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unexpected fake execute: ${normalized}`)
  }

  async query(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      this.ledgerExists = true
      this.ledgerCreates += 1
      return [{ warningStatus: 0 }]
    }

    this.executedMigrations.push(normalized)
    if (normalized.includes('FAIL_FOR_TEST')) {
      if (this.nextFingerprints.length > 0) this.currentFingerprint = this.nextFingerprints.shift()
      throw new Error('test failure password=do-not-store')
    }
    if (this.nextFingerprints.length > 0) this.currentFingerprint = this.nextFingerprints.shift()
    return [{ affectedRows: 0 }]
  }
}

function schemaBuilder(connection) {
  return Promise.resolve({
    manifestVersion: 1,
    fingerprintAlgorithm: 'test',
    schemaFingerprint: connection.currentFingerprint,
    objects: { tables: [], views: [], triggers: [], routines: [] },
  })
}

function migration(fileName, sql = 'SELECT 1;') {
  return parseMigrationFile(fileName, sql)
}

const context = {
  actor: 'test-suite',
  releaseIdentity: 'test-release',
  buildManifest: schemaBuilder,
}

test('fresh test database creates the ledger and applies migrations in order', async () => {
  const connection = new FakeConnection({ nextFingerprints: [FP1, FP2] })
  const migrations = [
    migration('202608080001_create_test_one.sql', 'CREATE TABLE test_one (id INT);'),
    migration('202608080002_create_test_two.sql', 'CREATE TABLE test_two (id INT);'),
  ]

  const result = await runManagedMigrations({
    connection,
    migrations,
    requireBaseline: false,
    ...context,
  })

  assert.equal(connection.ledgerCreates, 1)
  assert.deepEqual(connection.executedMigrations, [
    'CREATE TABLE test_one (id INT);',
    'CREATE TABLE test_two (id INT);',
  ])
  assert.deepEqual(result.appliedNow, migrations.map((item) => item.id))
  assert.deepEqual(connection.ledger.map((row) => row.status), ['APPLIED', 'APPLIED'])
})

test('existing schema is fingerprint-verified before inserting only one baseline marker', async () => {
  const connection = new FakeConnection({ fingerprint: FP0 })
  const expectedManifest = await schemaBuilder(connection)

  const first = await baselineDatabase({
    connection,
    expectedManifest,
    confirmation: BASELINE_CONFIRMATION,
    evidence: { dump: 'accepted' },
    ...context,
  })
  const second = await baselineDatabase({
    connection,
    expectedManifest,
    confirmation: BASELINE_CONFIRMATION,
    evidence: { dump: 'accepted' },
    ...context,
  })

  assert.equal(first.action, 'baseline-inserted')
  assert.equal(second.action, 'already-baselined')
  assert.equal(connection.ledger.length, 1)
  assert.equal(connection.ledger[0].status, 'BASELINE')
  assert.deepEqual(connection.executedMigrations, [])
})

test('baseline mismatch fails before ledger creation or any database mutation', async () => {
  const connection = new FakeConnection({ fingerprint: FP0 })
  const expectedManifest = { ...(await schemaBuilder(connection)), schemaFingerprint: FP1 }

  await assert.rejects(
    baselineDatabase({
      connection,
      expectedManifest,
      confirmation: BASELINE_CONFIRMATION,
      evidence: {},
      ...context,
    }),
    /Baseline fingerprint mismatch/
  )
  assert.equal(connection.ledgerExists, false)
  assert.equal(connection.ledger.length, 0)
})

test('re-running is idempotent and does not execute an applied migration again', async () => {
  const connection = new FakeConnection({ nextFingerprints: [FP1] })
  const migrations = [migration('202608080001_test_once.sql')]
  await runManagedMigrations({ connection, migrations, requireBaseline: false, ...context })
  const executed = connection.executedMigrations.length
  const result = await runManagedMigrations({ connection, migrations, requireBaseline: false, ...context })

  assert.equal(connection.executedMigrations.length, executed)
  assert.deepEqual(result.appliedNow, [])
  assert.deepEqual(result.alreadyApplied, [migrations[0].id])
})

test('changed checksum of an applied migration fails closed', async () => {
  const connection = new FakeConnection({ nextFingerprints: [FP1] })
  const original = [migration('202608080001_immutable.sql', 'SELECT 1;')]
  await runManagedMigrations({ connection, migrations: original, requireBaseline: false, ...context })

  const changed = [migration('202608080001_immutable.sql', 'SELECT 2;')]
  await assert.rejects(
    runManagedMigrations({ connection, migrations: changed, requireBaseline: false, ...context }),
    /Checksum drift/
  )
  assert.equal(connection.executedMigrations.length, 1)
})

test('duplicate and out-of-order migration versions fail validation', () => {
  const one = migration('202608080001_one.sql')
  const duplicate = migration('202608080001_duplicate.sql')
  const two = migration('202608080002_two.sql')
  assert.throws(() => validateMigrationSequence([one, one]), /Duplicate migration ID/)
  assert.throws(() => validateMigrationSequence([one, duplicate]), /Duplicate migration version/)
  assert.throws(() => validateMigrationSequence([two, one]), /Out-of-order migration version/)
})

test('out-of-band schema fingerprint drift fails closed before re-running', async () => {
  const connection = new FakeConnection({ nextFingerprints: [FP1] })
  const migrations = [migration('202608080001_drift_guard.sql')]
  await runManagedMigrations({ connection, migrations, requireBaseline: false, ...context })
  connection.currentFingerprint = FP2

  await assert.rejects(
    runManagedMigrations({ connection, migrations, requireBaseline: false, ...context }),
    /Schema fingerprint drift/
  )
  assert.equal(connection.executedMigrations.length, 1)
})

test('held advisory lock prevents a concurrent runner before mutation', async () => {
  const connection = new FakeConnection({ lockAvailable: false })
  await assert.rejects(
    runManagedMigrations({ connection, migrations: [], requireBaseline: false, ...context }),
    /Migration lock is already held/
  )
  assert.equal(connection.ledgerExists, false)
})

test('failed migration records safe evidence and stops every later migration', async () => {
  const connection = new FakeConnection({ nextFingerprints: [FP1] })
  const migrations = [
    migration('202608080001_good.sql', 'SELECT 1;'),
    migration('202608080002_bad.sql', 'FAIL_FOR_TEST;'),
    migration('202608080003_must_not_run.sql', 'SELECT 3;'),
  ]

  await assert.rejects(
    runManagedMigrations({ connection, migrations, requireBaseline: false, ...context }),
    /MySQL DDL rollback is not assumed/
  )
  assert.equal(connection.executedMigrations.some((sql) => sql.includes('SELECT 3')), false)
  assert.equal(connection.ledger[1].status, 'FAILED')
  assert.equal(connection.ledger[1].errorSummary.includes('do-not-store'), false)
})

test('an inspected partial DDL failure can proceed only through an explicitly named later forward-fix', async () => {
  const connection = new FakeConnection({ nextFingerprints: [FP1, FP2] })
  const failed = migration('202608080001_partial.sql', 'FAIL_FOR_TEST;')
  const forwardFix = migration('202608080002_forward_fix.sql', 'CREATE TABLE repaired (id INT);')

  await assert.rejects(
    runManagedMigrations({ connection, migrations: [failed, forwardFix], requireBaseline: false, ...context })
  )
  await acknowledgeFailedMigration({
    connection,
    migrations: [failed, forwardFix],
    migrationId: failed.id,
    forwardFixId: forwardFix.id,
    confirmation: FAILED_RECOVERY_CONFIRMATION,
    ...context,
  })
  const result = await runManagedMigrations({
    connection,
    migrations: [failed, forwardFix],
    requireBaseline: false,
    ...context,
  })

  assert.equal(connection.ledger[0].status, 'FAILED')
  assert.equal(connection.ledger[0].metadata.recovery.forwardFixId, forwardFix.id)
  assert.deepEqual(result.appliedNow, [forwardFix.id])
  assert.equal(connection.currentFingerprint, FP2)
})

test('normal application startup has no migration import or execution path', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8')
  assert.doesNotMatch(server, /migrations\//)
  assert.doesNotMatch(server, /runManagedMigrations|baselineDatabase/)
})

test('safe error summaries redact common credential assignments', () => {
  const summary = safeErrorSummary(
    new Error('request failed password=secret token=token-value&next=1')
  )
  assert.equal(summary.includes('secret'), false)
  assert.equal(summary.includes('token-value'), false)
})
