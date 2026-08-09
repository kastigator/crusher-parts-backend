const quoteId = (value) => {
  if (!/^[A-Za-z0-9_$]+$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`)
  return `\`${value}\``
}

class MysqlMaskingAdapter {
  constructor(connection, database) {
    this.connection = connection
    this.database = database
    this.schema = null
  }

  async discoverSchema() {
    const [columns] = await this.connection.execute(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
              DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
              IS_NULLABLE AS is_nullable, COLUMN_KEY AS column_key,
              ORDINAL_POSITION AS ordinal_position
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [this.database]
    )
    const [foreignKeys] = await this.connection.execute(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
              REFERENCED_TABLE_NAME AS referenced_table_name,
              REFERENCED_COLUMN_NAME AS referenced_column_name
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [this.database]
    )
    const foreignSet = new Set(foreignKeys.map((row) => `${row.table_name}.${row.column_name}`))
    const byTable = new Map()
    columns.forEach((row) => {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, [])
      byTable.get(row.table_name).push({
        name: row.column_name,
        dataType: row.data_type,
        columnType: row.column_type,
        isNullable: row.is_nullable === 'YES',
        isPrimary: row.column_key === 'PRI',
        isForeign: foreignSet.has(`${row.table_name}.${row.column_name}`),
      })
    })
    this.schema = {
      tables: [...byTable.entries()].map(([name, tableColumns]) => ({
        name,
        columns: tableColumns,
        primaryKey: tableColumns.filter(({ isPrimary }) => isPrimary).map(({ name: column }) => column),
      })),
      foreignKeys,
    }
    return this.schema
  }

  async countRows(table) {
    const [rows] = await this.connection.query(`SELECT COUNT(*) AS count FROM ${quoteId(table)}`)
    return Number(rows[0].count)
  }

  async readRows(table, columns) {
    if (!columns.length) return []
    const sqlColumns = columns.map(quoteId).join(', ')
    const [rows] = await this.connection.query(`SELECT ${sqlColumns} FROM ${quoteId(table)}`)
    return rows
  }

  async updateRow(table, primaryKey, before, after, changedColumns) {
    if (!primaryKey.length || !changedColumns.length) return
    const setSql = changedColumns.map((column) => `${quoteId(column)} = ?`).join(', ')
    const whereSql = primaryKey.map((column) => `${quoteId(column)} <=> ?`).join(' AND ')
    const params = [
      ...changedColumns.map((column) => after[column]),
      ...primaryKey.map((column) => before[column]),
    ]
    await this.connection.execute(`UPDATE ${quoteId(table)} SET ${setSql} WHERE ${whereSql}`, params)
  }

  async purgeTable(table) {
    await this.connection.query(`DELETE FROM ${quoteId(table)}`)
  }

  async foreignKeyViolations() {
    const schema = this.schema || await this.discoverSchema()
    const violations = []
    for (const fk of schema.foreignKeys) {
      const [rows] = await this.connection.query(
        `SELECT COUNT(*) AS count
           FROM ${quoteId(fk.table_name)} child
           LEFT JOIN ${quoteId(fk.referenced_table_name)} parent
             ON child.${quoteId(fk.column_name)} = parent.${quoteId(fk.referenced_column_name)}
          WHERE child.${quoteId(fk.column_name)} IS NOT NULL
            AND parent.${quoteId(fk.referenced_column_name)} IS NULL`
      )
      if (Number(rows[0].count)) {
        violations.push({
          table: fk.table_name,
          column: fk.column_name,
          referencedTable: fk.referenced_table_name,
          count: Number(rows[0].count),
        })
      }
    }
    return violations
  }
}

module.exports = { MysqlMaskingAdapter, quoteId }
