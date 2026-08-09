const {
  BASELINE_ID,
  beginMigration,
  completeMigration,
  ensureLedger,
  failMigration,
  getLedgerRows,
  insertBaseline,
  ledgerExists,
} = require('./ledger')
const {
  buildSchemaManifest,
  compareSchemaManifests,
} = require('./schemaManifest')
const { validateMigrationSequence } = require('./migrationFiles')

const DEFAULT_LOCK_NAME = 'crusher_parts_db:schema_migrations:v1'
const BASELINE_CONFIRMATION = 'BASELINE_CURRENT_SCHEMA'
const FAILED_RECOVERY_CONFIRMATION = 'ACKNOWLEDGE_PARTIAL_DDL_FORWARD_FIX'

function nowMs() {
  return Date.now()
}

async function withMigrationLock(connection, callback, lockName = DEFAULT_LOCK_NAME) {
  const [rows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
  if (Number(rows[0]?.acquired) !== 1) {
    throw new Error(`Migration lock is already held: ${lockName}`)
  }

  try {
    return await callback()
  } finally {
    await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
  }
}

function successfulRows(rows) {
  return rows.filter((row) => row.status === 'BASELINE' || row.status === 'APPLIED')
}

function isAcknowledgedFailure(row, migrations) {
  if (row?.status !== 'FAILED') return false
  const recovery = row?.metadata?.recovery
  if (recovery?.kind !== 'FORWARD_FIX' || !recovery.forwardFixId) return false
  const forwardFix = migrations.find((migration) => migration.id === recovery.forwardFixId)
  return Boolean(forwardFix && forwardFix.version > row.version)
}

function schemaStateRows(rows, migrations) {
  return rows.filter((row) =>
    row.status === 'BASELINE' || row.status === 'APPLIED' || isAcknowledgedFailure(row, migrations)
  )
}

function assertLedgerHistory(rows, migrations, { requireBaseline }) {
  const baselines = rows.filter((row) => row.status === 'BASELINE')
  if (requireBaseline && (baselines.length !== 1 || baselines[0].id !== BASELINE_ID)) {
    throw new Error('Exactly one canonical BASELINE marker is required before managed migrations')
  }

  const incomplete = rows.find((row) =>
    row.status === 'RUNNING' || (row.status === 'FAILED' && !isAcknowledgedFailure(row, migrations))
  )
  if (incomplete) {
    throw new Error(
      `Migration ${incomplete.id} is ${incomplete.status}; manual inspection/forward-fix is required`
    )
  }

  const migrationById = new Map(migrations.map((migration) => [migration.id, migration]))
  for (const row of rows.filter((item) => item.status === 'APPLIED')) {
    const migration = migrationById.get(row.id)
    if (!migration) throw new Error(`Applied migration file is missing: ${row.id}`)
    if (migration.checksum !== row.checksum) {
      throw new Error(`Checksum drift for applied migration ${row.id}`)
    }
  }

  let pendingSeen = false
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  for (const migration of migrations) {
    const row = rowsById.get(migration.id)
    const applied = row?.status === 'APPLIED' || isAcknowledgedFailure(row, migrations)
    if (!applied) pendingSeen = true
    else if (pendingSeen) {
      throw new Error(`Out-of-order ledger history at migration ${migration.id}`)
    }
  }
}

async function assertSchemaState(connection, rows, buildManifest, migrations) {
  const applied = schemaStateRows(rows, migrations)
  const latest = applied[applied.length - 1]
  if (!latest?.schemaFingerprint) return null

  const current = await buildManifest(connection)
  if (current.schemaFingerprint !== latest.schemaFingerprint) {
    throw new Error(
      `Schema fingerprint drift: expected ${latest.schemaFingerprint}, actual ${current.schemaFingerprint}`
    )
  }
  return current
}

async function acknowledgeFailedMigration({
  connection,
  migrations,
  migrationId,
  forwardFixId,
  actor,
  releaseIdentity,
  confirmation,
  buildManifest = buildSchemaManifest,
  lockName = DEFAULT_LOCK_NAME,
}) {
  if (confirmation !== FAILED_RECOVERY_CONFIRMATION) {
    throw new Error(`Recovery confirmation must equal ${FAILED_RECOVERY_CONFIRMATION}`)
  }

  return withMigrationLock(connection, async () => {
    const rows = await getLedgerRows(connection)
    const failed = rows.find((row) => row.id === migrationId && row.status === 'FAILED')
    if (!failed) throw new Error(`FAILED migration not found: ${migrationId}`)

    const source = migrations.find((migration) => migration.id === migrationId)
    const forwardFix = migrations.find((migration) => migration.id === forwardFixId)
    if (!source || source.checksum !== failed.checksum) {
      throw new Error(`Failed migration file/checksum is unavailable: ${migrationId}`)
    }
    if (!forwardFix || forwardFix.version <= failed.version) {
      throw new Error('A later managed forward-fix migration is required')
    }

    const current = await buildManifest(connection)
    if (!failed.schemaFingerprint || current.schemaFingerprint !== failed.schemaFingerprint) {
      throw new Error('Schema changed after the failed migration; recovery acknowledgement refused')
    }

    const metadata = {
      ...(failed.metadata || {}),
      recovery: {
        kind: 'FORWARD_FIX',
        forwardFixId,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: actor,
        releaseIdentity,
      },
    }
    await connection.execute(
      `UPDATE schema_migrations SET metadata = ? WHERE migration_id = ? AND status = 'FAILED'`,
      [JSON.stringify(metadata), migrationId]
    )
    return {
      acknowledged: migrationId,
      forwardFixId,
      schemaFingerprint: current.schemaFingerprint,
    }
  }, lockName)
}

async function baselineDatabase({
  connection,
  expectedManifest,
  actor,
  releaseIdentity,
  confirmation,
  evidence,
  buildManifest = buildSchemaManifest,
  lockName = DEFAULT_LOCK_NAME,
}) {
  if (confirmation !== BASELINE_CONFIRMATION) {
    throw new Error(`Baseline confirmation must equal ${BASELINE_CONFIRMATION}`)
  }

  return withMigrationLock(connection, async () => {
    const startedAt = nowMs()
    const actualManifest = await buildManifest(connection)
    const differences = compareSchemaManifests(expectedManifest, actualManifest)
    if (expectedManifest.schemaFingerprint !== actualManifest.schemaFingerprint) {
      throw new Error(
        `Baseline fingerprint mismatch: expected ${expectedManifest.schemaFingerprint}, ` +
        `actual ${actualManifest.schemaFingerprint}; ${differences.slice(0, 20).join(', ')}`
      )
    }

    await ensureLedger(connection)
    const ledgerRows = await getLedgerRows(connection)
    if (ledgerRows.length > 0) {
      if (
        ledgerRows.length === 1 &&
        ledgerRows[0].id === BASELINE_ID &&
        ledgerRows[0].status === 'BASELINE' &&
        ledgerRows[0].checksum === expectedManifest.schemaFingerprint
      ) {
        return { action: 'already-baselined', schemaFingerprint: actualManifest.schemaFingerprint }
      }
      throw new Error('Ledger is not empty and does not contain the one expected baseline marker')
    }

    await insertBaseline(connection, {
      checksum: expectedManifest.schemaFingerprint,
      actor,
      releaseIdentity,
      durationMs: nowMs() - startedAt,
      metadata: {
        method: expectedManifest.fingerprintAlgorithm,
        manifestVersion: expectedManifest.manifestVersion,
        evidence,
      },
    })

    return { action: 'baseline-inserted', schemaFingerprint: actualManifest.schemaFingerprint }
  }, lockName)
}

async function runManagedMigrations({
  connection,
  migrations,
  actor,
  releaseIdentity,
  dryRun = false,
  requireBaseline = true,
  buildManifest = buildSchemaManifest,
  lockName = DEFAULT_LOCK_NAME,
}) {
  validateMigrationSequence(migrations)

  return withMigrationLock(connection, async () => {
    let exists = await ledgerExists(connection)
    if (!exists && requireBaseline) {
      throw new Error('schema_migrations does not exist; baseline the current schema first')
    }
    if (!exists && dryRun) {
      return { dryRun: true, pending: migrations.map((migration) => migration.id), applied: [] }
    }
    if (!exists) {
      await ensureLedger(connection)
      exists = true
    }

    let rows = await getLedgerRows(connection)
    assertLedgerHistory(rows, migrations, { requireBaseline })
    await assertSchemaState(connection, rows, buildManifest, migrations)

    const rowsById = new Map(rows.map((row) => [row.id, row]))
    const pending = migrations.filter((migration) => !rowsById.has(migration.id))
    if (dryRun) {
      return {
        dryRun: true,
        pending: pending.map((migration) => migration.id),
        applied: rows.filter((row) => row.status === 'APPLIED').map((row) => row.id),
      }
    }

    const appliedNow = []
    for (const migration of pending) {
      const startedAt = nowMs()
      await beginMigration(connection, migration, { actor, releaseIdentity })
      try {
        await connection.query(migration.sql)
        const manifest = await buildManifest(connection)
        await completeMigration(
          connection,
          migration,
          nowMs() - startedAt,
          manifest.schemaFingerprint
        )
        appliedNow.push(migration.id)
      } catch (error) {
        let failedFingerprint = null
        try {
          failedFingerprint = (await buildManifest(connection)).schemaFingerprint
        } catch {
          // Preserve the original failure if schema inspection also fails.
        }
        await failMigration(
          connection,
          migration,
          nowMs() - startedAt,
          error,
          failedFingerprint
        )
        throw new Error(
          `Migration ${migration.id} failed; later migrations were not executed. ` +
          'MySQL DDL rollback is not assumed.',
          { cause: error }
        )
      }
    }

    rows = await getLedgerRows(connection)
    assertLedgerHistory(rows, migrations, { requireBaseline })
    return {
      dryRun: false,
      appliedNow,
      alreadyApplied: rows
        .filter((row) => row.status === 'APPLIED' && !appliedNow.includes(row.id))
        .map((row) => row.id),
    }
  }, lockName)
}

async function migrationStatus({
  connection,
  migrations,
  buildManifest = buildSchemaManifest,
}) {
  const exists = await ledgerExists(connection)
  if (!exists) {
    return { ledgerExists: false, rows: [], pending: migrations.map((migration) => migration.id) }
  }

  const rows = await getLedgerRows(connection)
  const latest = schemaStateRows(rows, migrations).at(-1)
  const current = await buildManifest(connection)
  const known = new Set(rows.map((row) => row.id))
  return {
    ledgerExists: true,
    rows,
    pending: migrations.filter((migration) => !known.has(migration.id)).map((migration) => migration.id),
    currentSchemaFingerprint: current.schemaFingerprint,
    expectedSchemaFingerprint: latest?.schemaFingerprint || null,
    schemaDrift: Boolean(latest?.schemaFingerprint) &&
      latest.schemaFingerprint !== current.schemaFingerprint,
  }
}

module.exports = {
  BASELINE_CONFIRMATION,
  FAILED_RECOVERY_CONFIRMATION,
  DEFAULT_LOCK_NAME,
  acknowledgeFailedMigration,
  assertLedgerHistory,
  baselineDatabase,
  migrationStatus,
  runManagedMigrations,
  withMigrationLock,
}
