#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const { createMigrationConnection } = require('./lib/database')
const { loadManagedMigrations } = require('./lib/migrationFiles')
const { buildSchemaManifest } = require('./lib/schemaManifest')
const {
  BASELINE_CONFIRMATION,
  FAILED_RECOVERY_CONFIRMATION,
  acknowledgeFailedMigration,
  baselineDatabase,
  migrationStatus,
  runManagedMigrations,
} = require('./lib/runner')

const managedDirectory = path.join(__dirname, 'managed')
const baselineManifestPath = path.join(__dirname, 'baseline', 'schema-manifest.json')

function parseArguments(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const equals = argument.indexOf('=')
    if (equals !== -1) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1)
    } else if (rest[index + 1] && !rest[index + 1].startsWith('--')) {
      options[argument.slice(2)] = rest[index + 1]
      index += 1
    } else {
      options[argument.slice(2)] = true
    }
  }
  return { command, options }
}

function safeIdentity(value, fallback) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 255 || /[\r\n\0]/.test(normalized)) return fallback
  return normalized
}

function runtimeIdentity(env = process.env) {
  return {
    actor: safeIdentity(env.MIGRATION_ACTOR || env.USER || env.LOGNAME, 'unknown'),
    releaseIdentity: safeIdentity(
      env.MIGRATION_RELEASE_ID || env.RELEASE_COMMIT_SHA || env.GIT_COMMIT,
      'local-unversioned'
    ),
  }
}

function readBaselineManifest() {
  if (!fs.existsSync(baselineManifestPath)) {
    throw new Error(`Baseline manifest is missing: ${baselineManifestPath}`)
  }
  return JSON.parse(fs.readFileSync(baselineManifestPath, 'utf8'))
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function help() {
  process.stdout.write(`Migration commands (explicit; application startup never runs them):
  npm run migrate -- manifest
  npm run migrate -- list
  npm run migrate -- status
  npm run migrate -- run --dry-run
  npm run migrate -- run
  npm run migrate -- baseline --confirm ${BASELINE_CONFIRMATION}
  npm run migrate -- recover --migration <failed-id> --forward-fix <later-id> --confirm ${FAILED_RECOVERY_CONFIRMATION}
`)
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2))
  if (command === 'help') return help()

  const migrations = loadManagedMigrations(managedDirectory)
  if (command === 'list') {
    return print(migrations.map(({ id, version, description, fileName, checksum }) => ({
      id,
      version,
      description,
      fileName,
      checksum,
    })))
  }

  const connection = await createMigrationConnection()
  try {
    if (command === 'manifest') {
      const [versionRows] = await connection.execute('SELECT VERSION() AS engineVersion')
      const manifest = await buildSchemaManifest(connection, {
        generatedAt: new Date().toISOString(),
        database: {
          name: process.env.DB_NAME || 'crusher_parts_db',
          engineVersion: versionRows[0].engineVersion,
        },
      })
      return print(manifest)
    }

    if (command === 'status') {
      return print(await migrationStatus({ connection, migrations }))
    }

    if (command === 'run') {
      return print(await runManagedMigrations({
        connection,
        migrations,
        ...runtimeIdentity(),
        dryRun: options['dry-run'] === true,
      }))
    }

    if (command === 'baseline') {
      const expectedManifest = readBaselineManifest()
      return print(await baselineDatabase({
        connection,
        expectedManifest,
        ...runtimeIdentity(),
        confirmation: options.confirm,
        evidence: {
          acceptedDump: expectedManifest.acceptedDump,
          cloudSqlBackup: expectedManifest.cloudSqlBackup,
        },
      }))
    }

    if (command === 'recover') {
      return print(await acknowledgeFailedMigration({
        connection,
        migrations,
        ...runtimeIdentity(),
        migrationId: options.migration,
        forwardFixId: options['forward-fix'],
        confirmation: options.confirm,
      }))
    }

    throw new Error(`Unknown migration command: ${command}`)
  } finally {
    await connection.end()
  }
}

main().catch((error) => {
  process.stderr.write(`Migration command failed: ${error.message}\n`)
  process.exitCode = 1
})

module.exports = {
  parseArguments,
  runtimeIdentity,
}
