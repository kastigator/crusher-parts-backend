#!/usr/bin/env node

const path = require('node:path')

const {
  collectRepositoryState,
  isoTimestamp,
  parseArguments,
  resolveBackendRoot,
  resolveContextDirectory,
  resolveFrontendRepository,
  secretFindings,
  writeFileAtomic,
} = require('./common')
const {
  collectDatabaseState,
  collectDeploymentState,
  featureDeploymentStatus,
} = require('./collectors')
const { buildSystemState, renderDatabaseState, renderSystemState } = require('./render')

async function generateContext({ argv = process.argv.slice(2), env = process.env } = {}) {
  const options = parseArguments(argv)
  const backendRoot = resolveBackendRoot(__dirname)
  const frontendRoot = resolveFrontendRepository(backendRoot, options, env)
  const contextDirectory = resolveContextDirectory(backendRoot, options, env)
  const generatedAt = isoTimestamp(options.now || env.AI_CONTEXT_NOW || new Date())
  const offline = options.offline === true

  const backend = collectRepositoryState(backendRoot)
  const frontend = collectRepositoryState(frontendRoot)
  const [database, deployment] = await Promise.all([
    collectDatabaseState(backendRoot, { offline, env }),
    Promise.resolve(collectDeploymentState({ offline })),
  ])

  if (options['require-db'] === true && database.availability !== 'AVAILABLE') {
    throw new Error(`Live database metadata is required but unavailable: ${database.reason}`)
  }
  if (options['require-gcp'] === true && deployment.availability !== 'AVAILABLE') {
    throw new Error(`Live GCP deployment metadata is required but unavailable: ${deployment.reason}`)
  }

  const systemState = buildSystemState({
    generatedAt,
    backend,
    frontend,
    database,
    deployment,
    featureDeployment: featureDeploymentStatus(backend, deployment),
  })
  const systemContent = renderSystemState(systemState)
  const databaseContent = renderDatabaseState(database, generatedAt)
  const findings = [
    ...secretFindings(systemContent).map((item) => `SYSTEM_STATE.json:${item}`),
    ...secretFindings(databaseContent).map((item) => `DATABASE_STATE.md:${item}`),
  ]
  if (findings.length) throw new Error(`Generated context failed secret scan: ${findings.join(', ')}`)

  writeFileAtomic(path.join(contextDirectory, 'SYSTEM_STATE.json'), systemContent)
  writeFileAtomic(path.join(contextDirectory, 'DATABASE_STATE.md'), databaseContent)

  return {
    backendRoot,
    frontendRoot,
    contextDirectory,
    systemState,
    written: ['SYSTEM_STATE.json', 'DATABASE_STATE.md'],
    secretFindings: findings,
  }
}

async function main() {
  const result = await generateContext()
  process.stdout.write(`${JSON.stringify({
    generated_at: result.systemState.generated_at,
    backend: result.systemState.repositories.backend,
    frontend: result.systemState.repositories.frontend,
    database: {
      availability: result.systemState.database.availability,
      migration_head: result.systemState.database.latest_applied_migration,
      pending: result.systemState.database.pending_migrations,
      schema_drift: result.systemState.database.schema_drift,
      schema_fingerprint: result.systemState.database.schema_fingerprint,
    },
    deployment: result.systemState.deployment,
    written: result.written,
    secret_scan: 'PASS',
  }, null, 2)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { generateContext }
