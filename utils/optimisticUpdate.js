// Универсальный апдейтер с проверкой version
module.exports = async function optimisticUpdate({ conn, table, id, version, fields }) {
  await conn.beginTransaction()
  const [rows] = await conn.execute(
    `SELECT version FROM ${table} WHERE id=? FOR UPDATE`, [id]
  )
  if (!rows.length) {
    await conn.rollback()
    return { notFound: true }
  }
  if (rows[0].version !== version) {
    await conn.rollback()
    return { conflict: true }
  }

  const keys = Object.keys(fields).filter(k => fields[k] !== undefined)
  const setClause = keys.map(k => `${k}=?`).join(', ')
  const values = keys.map(k => fields[k])

  await conn.execute(
    `UPDATE ${table} SET ${setClause}, version=version+1 WHERE id=?`,
    [...values, id]
  )
  await conn.commit()
  return { ok: true }
}
