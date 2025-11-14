// utils/optimisticUpdate.js
// Универсальный апдейтер с проверкой version (оптимистическая блокировка)

module.exports = async function optimisticUpdate({
  conn,
  table,
  id,
  version,
  fields,
}) {
  await conn.beginTransaction();

  // 1) Берём текущую версию под FOR UPDATE
  const [rows] = await conn.execute(
    `SELECT version FROM ${table} WHERE id = ? FOR UPDATE`,
    [id]
  );

  if (!rows.length) {
    await conn.rollback();
    return { notFound: true };
  }

  const dbVersion = Number(rows[0].version);
  const bodyVersion = Number(version);

  // Если в теле пришла ерунда — сразу ошибка
  if (!Number.isFinite(bodyVersion)) {
    await conn.rollback();
    return {
      badVersion: true,
      message: 'Missing or invalid "version" in request body',
    };
  }

  // 2) Проверяем конфликт версий по значению
  if (dbVersion !== bodyVersion) {
    await conn.rollback();
    return { conflict: true, dbVersion };
  }

  // 3) Готовим SET-часть
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);

  if (!keys.length) {
    // Нечего обновлять — просто выходим без изменения версии
    await conn.rollback();
    return { ok: false, noChanges: true };
  }

  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k]);

  // 4) Обновляем запись и инкрементим версию
  await conn.execute(
    `UPDATE ${table}
        SET ${setClause}, version = version + 1
      WHERE id = ?`,
    [...values, id]
  );

  await conn.commit();
  return { ok: true };
};
