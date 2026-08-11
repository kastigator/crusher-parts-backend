const fs = require('node:fs')
const path = require('node:path')

const dotenv = require('dotenv')

const { UNKNOWN, commandResult, listWorktrees, sanitizeError } = require('./common')

function loadLocalDatabaseEnvironment(backendRoot, env = process.env) {
  const candidates = [path.join(backendRoot, '.env.local')]
  for (const worktree of listWorktrees(backendRoot)) {
    if (worktree.branch === 'refs/heads/main') candidates.push(path.join(worktree.path, '.env.local'))
  }
  const localPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!localPath) return { ...env }
  const parsed = dotenv.parse(fs.readFileSync(localPath))
  const merged = { ...env }
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('DB_') && !merged[key]) merged[key] = value
  }
  return merged
}

function ledgerSummary(rows) {
  const summary = {
    rows: rows.length,
    baseline: 0,
    applied: 0,
    historical_failed_with_acknowledged_forward_fix: 0,
    unresolved_failed: 0,
    running: 0,
  }
  for (const row of rows) {
    if (row.status === 'BASELINE') summary.baseline += 1
    else if (row.status === 'APPLIED') summary.applied += 1
    else if (row.status === 'RUNNING') summary.running += 1
    else if (row.status === 'FAILED' && row.metadata?.recovery?.kind === 'FORWARD_FIX') {
      summary.historical_failed_with_acknowledged_forward_fix += 1
    } else if (row.status === 'FAILED') summary.unresolved_failed += 1
  }
  return summary
}

async function collectDatabaseState(backendRoot, { offline = false, env = process.env } = {}) {
  if (offline) return { availability: UNKNOWN, reason: 'offline mode' }
  const databaseEnv = loadLocalDatabaseEnvironment(backendRoot, env)
  const previous = {}
  for (const [key, value] of Object.entries(databaseEnv)) {
    if (!key.startsWith('DB_')) continue
    previous[key] = process.env[key]
    process.env[key] = value
  }
  let connection
  try {
    const { createMigrationConnection } = require(path.join(backendRoot, 'migrations/lib/database'))
    const { loadManagedMigrations } = require(path.join(backendRoot, 'migrations/lib/migrationFiles'))
    const { migrationStatus } = require(path.join(backendRoot, 'migrations/lib/runner'))
    connection = await createMigrationConnection(databaseEnv)
    const migrations = loadManagedMigrations(path.join(backendRoot, 'migrations/managed'))
    const status = await migrationStatus({ connection, migrations })
    const [engineRows] = await connection.execute('SELECT VERSION() AS engineVersion, DATABASE() AS databaseName')
    const [inventoryRows] = await connection.execute(`
      SELECT TABLE_TYPE AS tableType, TABLE_NAME AS tableName
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_TYPE, TABLE_NAME
    `)
    const [columnRows] = await connection.execute(`
      SELECT COUNT(*) AS columnCount
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
    `)
    const tables = inventoryRows.filter((row) => row.tableType === 'BASE TABLE').map((row) => row.tableName)
    const views = inventoryRows.filter((row) => row.tableType === 'VIEW').map((row) => row.tableName)
    const applied = status.rows
      .filter((row) => row.status === 'APPLIED')
      .sort((left, right) => left.version - right.version)
    return {
      availability: 'AVAILABLE',
      platform: 'Google Cloud SQL for MySQL',
      instance: 'partsfinsad:europe-west4:parts',
      database: engineRows[0]?.databaseName || databaseEnv.DB_NAME || UNKNOWN,
      engine_version: engineRows[0]?.engineVersion || UNKNOWN,
      schema_fingerprint: status.currentSchemaFingerprint || UNKNOWN,
      expected_schema_fingerprint: status.expectedSchemaFingerprint || UNKNOWN,
      schema_drift: status.schemaDrift,
      pending_migrations: [...status.pending],
      latest_applied_migration: applied.at(-1)?.id || UNKNOWN,
      migration_ledger: ledgerSummary(status.rows),
      inventory: {
        base_tables: tables.length,
        views: views.length,
        columns: Number(columnRows[0]?.columnCount || 0),
        table_names: tables,
        view_names: views,
      },
      contains_business_rows: false,
    }
  } catch (error) {
    return { availability: UNKNOWN, reason: sanitizeError(error) }
  } finally {
    if (connection) await connection.end().catch(() => {})
    for (const key of Object.keys(databaseEnv).filter((item) => item.startsWith('DB_'))) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function parseJsonResult(result) {
  if (!result.ok || !result.stdout) return null
  try {
    return JSON.parse(result.stdout)
  } catch (_error) {
    return null
  }
}

function collectDeploymentState({ offline = false } = {}) {
  if (offline) return { availability: UNKNOWN, reason: 'offline mode' }
  const backendResult = commandResult('gcloud', [
    'run', 'services', 'describe', 'crusher-backend',
    '--region=europe-west4', '--project=partsfinsad',
    '--format=json(status.url,status.latestReadyRevisionName,status.traffic,metadata.labels)',
  ], { allowFailure: true })
  const frontendResult = commandResult('gcloud', [
    'storage', 'objects', 'describe', 'gs://frontend-parts-site/index.html',
    '--format=json(name,size,generation,updateTime,md5Hash)',
  ], { allowFailure: true })
  const backend = parseJsonResult(backendResult)
  const frontend = parseJsonResult(frontendResult)
  if (!backend && !frontend) {
    return {
      availability: UNKNOWN,
      reason: sanitizeError(backendResult.stderr || frontendResult.stderr || 'GCP state unavailable'),
    }
  }
  const labels = backend?.metadata?.labels || {}
  const traffic = Array.isArray(backend?.status?.traffic) ? backend.status.traffic : []
  const liveTraffic = traffic.find((item) => Number(item.percent) > 0) || {}
  return {
    availability: 'AVAILABLE',
    backend: backend ? {
      service: 'crusher-backend',
      region: 'europe-west4',
      revision: backend.status?.latestReadyRevisionName || liveTraffic.revisionName || UNKNOWN,
      traffic_percent: Number(liveTraffic.percent || 0),
      release_commit: labels['release-commit'] || UNKNOWN,
      release_build: labels['release-build'] || UNKNOWN,
      url: backend.status?.url || UNKNOWN,
    } : { availability: UNKNOWN },
    frontend: frontend ? {
      bucket: 'frontend-parts-site',
      object: frontend.name || 'index.html',
      object_generation: String(frontend.generation || UNKNOWN),
      object_updated_at: frontend.updateTime || UNKNOWN,
      verified_source_commit: UNKNOWN,
      url: 'https://storage.googleapis.com/frontend-parts-site/index.html',
    } : { availability: UNKNOWN },
    deployment_trigger_branches: { backend: 'main', frontend: 'main' },
  }
}

function featureDeploymentStatus(repositoryState, deploymentState) {
  if (deploymentState.availability !== 'AVAILABLE') return UNKNOWN
  const releaseCommit = deploymentState.backend?.release_commit
  if (!releaseCommit || releaseCommit === UNKNOWN) return UNKNOWN
  const matches = (sha) => sha !== UNKNOWN && (sha.startsWith(releaseCommit) || releaseCommit.startsWith(sha))
  if (matches(repositoryState.head_sha)) {
    return repositoryState.current_branch === 'main' ? 'DEPLOYED_CANONICAL' : 'DEPLOYED_FEATURE'
  }
  return 'NOT_DEPLOYED'
}

module.exports = {
  collectDatabaseState,
  collectDeploymentState,
  featureDeploymentStatus,
  ledgerSummary,
  loadLocalDatabaseEnvironment,
}
