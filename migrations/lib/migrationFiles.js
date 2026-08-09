const fs = require('node:fs')
const path = require('node:path')

const { migrationChecksum, normalizeSql } = require('./checksum')

const MIGRATION_FILE = /^(\d{12})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/

function parseMigrationFile(fileName, sql) {
  const match = MIGRATION_FILE.exec(fileName)
  if (!match) {
    throw new Error(
      `Invalid migration filename ${fileName}; expected YYYYMMDDNNNN_description.sql`
    )
  }

  const version = Number(match[1])
  if (!Number.isSafeInteger(version)) {
    throw new Error(`Migration version is not a safe integer: ${match[1]}`)
  }

  const normalizedSql = normalizeSql(sql)
  return Object.freeze({
    id: fileName.slice(0, -4),
    version,
    description: match[2].replaceAll('_', ' '),
    fileName,
    sql: normalizedSql,
    checksum: migrationChecksum(normalizedSql),
  })
}

function validateMigrationSequence(migrations) {
  const ids = new Set()
  const versions = new Set()
  let previousVersion = -1

  for (const migration of migrations) {
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate migration ID: ${migration.id}`)
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`)
    }
    if (migration.version <= previousVersion) {
      throw new Error(
        `Out-of-order migration version ${migration.version}; expected greater than ${previousVersion}`
      )
    }
    ids.add(migration.id)
    versions.add(migration.version)
    previousVersion = migration.version
  }

  return migrations
}

function loadManagedMigrations(directory) {
  if (!fs.existsSync(directory)) return []

  const fileNames = fs.readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'))

  const migrations = fileNames.map((fileName) => parseMigrationFile(
    fileName,
    fs.readFileSync(path.join(directory, fileName), 'utf8')
  ))

  return validateMigrationSequence(migrations)
}

module.exports = {
  MIGRATION_FILE,
  loadManagedMigrations,
  parseMigrationFile,
  validateMigrationSequence,
}
