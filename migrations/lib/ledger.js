const LEDGER_TABLE = 'schema_migrations'
const BASELINE_ID = '000000000000_BASELINE'
const BASELINE_VERSION = 0

const CREATE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id VARCHAR(128) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    description VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    attempted_at DATETIME(6) NOT NULL,
    applied_at DATETIME(6) NULL,
    actor VARCHAR(255) NOT NULL,
    release_identity VARCHAR(255) NOT NULL,
    duration_ms BIGINT UNSIGNED NULL,
    error_summary VARCHAR(1000) NULL,
    schema_fingerprint CHAR(64) NULL,
    metadata JSON NULL,
    baseline_guard TINYINT
      GENERATED ALWAYS AS (CASE WHEN status = 'BASELINE' THEN 1 ELSE NULL END) STORED,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (migration_id),
    UNIQUE KEY uq_schema_migrations_version (version),
    UNIQUE KEY uq_schema_migrations_one_baseline (baseline_guard),
    KEY ix_schema_migrations_status (status),
    CONSTRAINT chk_schema_migrations_status
      CHECK (status IN ('BASELINE', 'RUNNING', 'APPLIED', 'FAILED')),
    CONSTRAINT chk_schema_migrations_checksum
      CHECK (checksum REGEXP '^[0-9a-f]{64}$'),
    CONSTRAINT chk_schema_migrations_schema_fingerprint
      CHECK (schema_fingerprint IS NULL OR schema_fingerprint REGEXP '^[0-9a-f]{64}$')
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`

const REQUIRED_COLUMNS = [
  'migration_id',
  'version',
  'description',
  'checksum',
  'status',
  'attempted_at',
  'applied_at',
  'actor',
  'release_identity',
  'duration_ms',
  'error_summary',
  'schema_fingerprint',
  'metadata',
  'baseline_guard',
  'created_at',
  'updated_at',
]

function safeErrorSummary(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/([?&](?:password|token|secret|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
}

async function ledgerExists(connection) {
  const [rows] = await connection.execute(`
    SELECT COUNT(*) AS count
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'
  `, [LEDGER_TABLE])
  return Number(rows[0]?.count || 0) === 1
}

async function assertLedgerShape(connection) {
  const [rows] = await connection.execute(`
    SELECT COLUMN_NAME AS columnName
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION
  `, [LEDGER_TABLE])
  const actual = rows.map((row) => row.columnName)
  if (JSON.stringify(actual) !== JSON.stringify(REQUIRED_COLUMNS)) {
    throw new Error(
      `schema_migrations shape drift: expected ${REQUIRED_COLUMNS.join(',')}; actual ${actual.join(',')}`
    )
  }
}

async function ensureLedger(connection) {
  await connection.query(CREATE_LEDGER_SQL)
  await assertLedgerShape(connection)
}

async function getLedgerRows(connection) {
  if (!(await ledgerExists(connection))) return []
  await assertLedgerShape(connection)
  const [rows] = await connection.execute(`
    SELECT migration_id AS id, version, description, checksum, status,
           attempted_at AS attemptedAt, applied_at AS appliedAt,
           actor, release_identity AS releaseIdentity,
           duration_ms AS durationMs, error_summary AS errorSummary,
           schema_fingerprint AS schemaFingerprint, metadata
    FROM schema_migrations
    ORDER BY version, migration_id
  `)
  return rows.map((row) => ({ ...row, version: Number(row.version) }))
}

async function insertBaseline(connection, {
  checksum,
  actor,
  releaseIdentity,
  durationMs,
  metadata,
}) {
  await connection.execute(`
    INSERT INTO schema_migrations (
      migration_id, version, description, checksum, status,
      attempted_at, applied_at, actor, release_identity, duration_ms,
      error_summary, schema_fingerprint, metadata
    ) VALUES (?, ?, ?, ?, 'BASELINE', NOW(6), NOW(6), ?, ?, ?, NULL, ?, ?)
  `, [
    BASELINE_ID,
    BASELINE_VERSION,
    'Accepted legacy schema baseline; historical SQL was not replayed',
    checksum,
    actor,
    releaseIdentity,
    durationMs,
    checksum,
    JSON.stringify(metadata),
  ])
}

async function beginMigration(connection, migration, context) {
  await connection.execute(`
    INSERT INTO schema_migrations (
      migration_id, version, description, checksum, status,
      attempted_at, applied_at, actor, release_identity, duration_ms,
      error_summary, schema_fingerprint, metadata
    ) VALUES (?, ?, ?, ?, 'RUNNING', NOW(6), NULL, ?, ?, NULL, NULL, NULL, ?)
  `, [
    migration.id,
    migration.version,
    migration.description,
    migration.checksum,
    context.actor,
    context.releaseIdentity,
    JSON.stringify({ fileName: migration.fileName }),
  ])
}

async function completeMigration(connection, migration, durationMs, schemaFingerprint) {
  await connection.execute(`
    UPDATE schema_migrations
    SET status = 'APPLIED', applied_at = NOW(6), duration_ms = ?,
        error_summary = NULL, schema_fingerprint = ?
    WHERE migration_id = ? AND status = 'RUNNING'
  `, [durationMs, schemaFingerprint, migration.id])
}

async function failMigration(connection, migration, durationMs, error, schemaFingerprint) {
  await connection.execute(`
    UPDATE schema_migrations
    SET status = 'FAILED', duration_ms = ?, error_summary = ?,
        schema_fingerprint = ?
    WHERE migration_id = ? AND status = 'RUNNING'
  `, [durationMs, safeErrorSummary(error), schemaFingerprint, migration.id])
}

module.exports = {
  BASELINE_ID,
  BASELINE_VERSION,
  CREATE_LEDGER_SQL,
  LEDGER_TABLE,
  assertLedgerShape,
  beginMigration,
  completeMigration,
  ensureLedger,
  failMigration,
  getLedgerRows,
  insertBaseline,
  ledgerExists,
  safeErrorSummary,
}
