const { sha256 } = require('./checksum')

const LEDGER_TABLE = 'schema_migrations'

function normalizeValue(value) {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  return value
}

function canonicalRows(rows) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  ))
}

async function rows(connection, sql, params = []) {
  const [result] = await connection.execute(sql, params)
  return canonicalRows(result)
}

function fingerprint(value) {
  return sha256(JSON.stringify(value))
}

function groupBy(items, key) {
  const grouped = new Map()
  for (const item of items) {
    const value = item[key]
    if (!grouped.has(value)) grouped.set(value, [])
    grouped.get(value).push(item)
  }
  return grouped
}

async function collectSchemaDefinition(connection) {
  const excluded = LEDGER_TABLE
  const [schema, tables, columns, indexes, constraints, keyColumns,
    referentialConstraints, checkConstraints, views, triggers, routines,
    routineParameters] = await Promise.all([
    rows(connection, `
      SELECT DEFAULT_CHARACTER_SET_NAME AS defaultCharacterSet,
             DEFAULT_COLLATION_NAME AS defaultCollation
      FROM information_schema.SCHEMATA
      WHERE SCHEMA_NAME = DATABASE()
    `),
    rows(connection, `
      SELECT TABLE_NAME AS tableName, ENGINE AS engine,
             TABLE_COLLATION AS tableCollation, ROW_FORMAT AS rowFormat,
             CREATE_OPTIONS AS createOptions, TABLE_COMMENT AS tableComment
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME
    `, [excluded]),
    rows(connection, `
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
             ORDINAL_POSITION AS ordinalPosition, COLUMN_TYPE AS columnType,
             IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault,
             EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression,
             CHARACTER_SET_NAME AS characterSetName,
             COLLATION_NAME AS collationName, COLUMN_COMMENT AS columnComment
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, [excluded]),
    rows(connection, `
      SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
             NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seqInIndex,
             COLUMN_NAME AS columnName, COLLATION AS collation,
             CARDINALITY IS NULL AS cardinalityUnknown,
             SUB_PART AS subPart, NULLABLE AS nullable,
             INDEX_TYPE AS indexType, INDEX_COMMENT AS indexComment,
             IS_VISIBLE AS isVisible, EXPRESSION AS expression
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    `, [excluded]),
    rows(connection, `
      SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
             CONSTRAINT_TYPE AS constraintType, ENFORCED AS enforced
      FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, CONSTRAINT_NAME
    `, [excluded]),
    rows(connection, `
      SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
             COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition,
             POSITION_IN_UNIQUE_CONSTRAINT AS positionInUniqueConstraint,
             REFERENCED_TABLE_NAME AS referencedTableName,
             REFERENCED_COLUMN_NAME AS referencedColumnName
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
    `, [excluded]),
    rows(connection, `
      SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
             UNIQUE_CONSTRAINT_NAME AS uniqueConstraintName,
             MATCH_OPTION AS matchOption, UPDATE_RULE AS updateRule,
             DELETE_RULE AS deleteRule
      FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, CONSTRAINT_NAME
    `, [excluded]),
    rows(connection, `
      SELECT tc.TABLE_NAME AS tableName, cc.CONSTRAINT_NAME AS constraintName,
             cc.CHECK_CLAUSE AS checkClause
      FROM information_schema.CHECK_CONSTRAINTS cc
      JOIN information_schema.TABLE_CONSTRAINTS tc
        ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
       AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE cc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME <> ?
      ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME
    `, [excluded]),
    rows(connection, `
      SELECT TABLE_NAME AS viewName, VIEW_DEFINITION AS viewDefinition,
             CHECK_OPTION AS checkOption, IS_UPDATABLE AS isUpdatable,
             SECURITY_TYPE AS securityType,
             CHARACTER_SET_CLIENT AS characterSetClient,
             COLLATION_CONNECTION AS collationConnection
      FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME
    `),
    rows(connection, `
      SELECT TRIGGER_NAME AS triggerName,
             EVENT_MANIPULATION AS eventManipulation,
             EVENT_OBJECT_TABLE AS eventObjectTable,
             ACTION_ORDER AS actionOrder, ACTION_CONDITION AS actionCondition,
             ACTION_STATEMENT AS actionStatement,
             ACTION_ORIENTATION AS actionOrientation,
             ACTION_TIMING AS actionTiming,
             SQL_MODE AS sqlMode,
             CHARACTER_SET_CLIENT AS characterSetClient,
             COLLATION_CONNECTION AS collationConnection,
             DATABASE_COLLATION AS databaseCollation
      FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
      ORDER BY TRIGGER_NAME
    `),
    rows(connection, `
      SELECT ROUTINE_NAME AS routineName, ROUTINE_TYPE AS routineType,
             DATA_TYPE AS dataType, ROUTINE_DEFINITION AS routineDefinition,
             IS_DETERMINISTIC AS isDeterministic,
             SQL_DATA_ACCESS AS sqlDataAccess, SECURITY_TYPE AS securityType,
             SQL_MODE AS sqlMode, CHARACTER_SET_CLIENT AS characterSetClient,
             COLLATION_CONNECTION AS collationConnection,
             DATABASE_COLLATION AS databaseCollation
      FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = DATABASE()
      ORDER BY ROUTINE_TYPE, ROUTINE_NAME
    `),
    rows(connection, `
      SELECT SPECIFIC_NAME AS routineName, ORDINAL_POSITION AS ordinalPosition,
             PARAMETER_MODE AS parameterMode, PARAMETER_NAME AS parameterName,
             DATA_TYPE AS dataType, DTD_IDENTIFIER AS dtdIdentifier,
             CHARACTER_SET_NAME AS characterSetName,
             COLLATION_NAME AS collationName
      FROM information_schema.PARAMETERS
      WHERE SPECIFIC_SCHEMA = DATABASE()
      ORDER BY SPECIFIC_NAME, ORDINAL_POSITION
    `),
  ])

  return {
    schema: schema[0] || {},
    tables,
    columns,
    indexes,
    constraints,
    keyColumns,
    referentialConstraints,
    checkConstraints,
    views,
    triggers,
    routines,
    routineParameters,
  }
}

function summarizeSchema(definition) {
  const columnsByTable = groupBy(definition.columns, 'tableName')
  const indexesByTable = groupBy(definition.indexes, 'tableName')
  const constraintsByTable = groupBy(definition.constraints, 'tableName')
  const keyColumnsByTable = groupBy(definition.keyColumns, 'tableName')
  const referencesByTable = groupBy(definition.referentialConstraints, 'tableName')
  const checksByTable = groupBy(definition.checkConstraints, 'tableName')
  const parametersByRoutine = groupBy(definition.routineParameters, 'routineName')

  return {
    tables: definition.tables.map((table) => {
      const tableDefinition = {
        table,
        columns: columnsByTable.get(table.tableName) || [],
        indexes: indexesByTable.get(table.tableName) || [],
        constraints: constraintsByTable.get(table.tableName) || [],
        keyColumns: keyColumnsByTable.get(table.tableName) || [],
        referentialConstraints: referencesByTable.get(table.tableName) || [],
        checkConstraints: checksByTable.get(table.tableName) || [],
      }
      return {
        name: table.tableName,
        columnCount: tableDefinition.columns.length,
        indexEntryCount: tableDefinition.indexes.length,
        constraintCount: tableDefinition.constraints.length,
        fingerprint: fingerprint(tableDefinition),
      }
    }),
    views: definition.views.map((view) => ({
      name: view.viewName,
      fingerprint: fingerprint(view),
    })),
    triggers: definition.triggers.map((trigger) => ({
      name: trigger.triggerName,
      fingerprint: fingerprint(trigger),
    })),
    routines: definition.routines.map((routine) => ({
      name: routine.routineName,
      type: routine.routineType,
      fingerprint: fingerprint({
        routine,
        parameters: parametersByRoutine.get(routine.routineName) || [],
      }),
    })),
  }
}

async function buildSchemaManifest(connection, metadata = {}) {
  const definition = await collectSchemaDefinition(connection)
  const objects = summarizeSchema(definition)
  return {
    manifestVersion: 1,
    fingerprintAlgorithm: 'sha256(canonical-information-schema-v1)',
    excludedObjects: [LEDGER_TABLE],
    schemaFingerprint: fingerprint(definition),
    counts: {
      tables: definition.tables.length,
      columns: definition.columns.length,
      indexEntries: definition.indexes.length,
      constraints: definition.constraints.length,
      views: definition.views.length,
      triggers: definition.triggers.length,
      routines: definition.routines.length,
    },
    objects,
    ...metadata,
  }
}

function compareSchemaManifests(expected, actual) {
  if (expected.schemaFingerprint === actual.schemaFingerprint) return []

  const differences = []
  for (const type of ['tables', 'views', 'triggers', 'routines']) {
    const expectedObjects = new Map((expected.objects?.[type] || []).map((item) => [item.name, item]))
    const actualObjects = new Map((actual.objects?.[type] || []).map((item) => [item.name, item]))
    const names = [...new Set([...expectedObjects.keys(), ...actualObjects.keys()])].sort()
    for (const name of names) {
      const before = expectedObjects.get(name)
      const after = actualObjects.get(name)
      if (!before) differences.push(`${type}:${name}:unexpected`)
      else if (!after) differences.push(`${type}:${name}:missing`)
      else if (before.fingerprint !== after.fingerprint) differences.push(`${type}:${name}:changed`)
    }
  }
  return differences
}

module.exports = {
  LEDGER_TABLE,
  buildSchemaManifest,
  collectSchemaDefinition,
  compareSchemaManifests,
  summarizeSchema,
}
