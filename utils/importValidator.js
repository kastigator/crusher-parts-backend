// utils/importValidator.js
const db = require('./db')
const logActivity = require('./logActivity')

// лог диффов опционально (если есть утилита в проекте)
let logFieldDiffs = null
try { logFieldDiffs = require('./logFieldDiffs') } catch { /* noop */ }

/**
 * Универсальный валидатор/импортёр строк из Excel/CSV.
 *
 * @param {Array<Object>} rows - массив ПРЕОБРАЗОВАННЫХ объектов (после headerMap + transform)
 * @param {Object} options
 * @param {string} options.table - имя таблицы
 * @param {string[]} [options.uniqueBy] - список уникальных полей по приоритету (берётся первое непустое)
 * @param {string} [options.uniqueField] - одиночное уникальное поле (для совместимости)
 * @param {string[]} [options.requiredFields=[]] - обязательные поля (например: ["name"])
 * @param {Object} [options.req] - Express req (для user_id в логах)
 * @param {string} [options.logType] - тип сущности для логов (например: "suppliers")
 * @param {"upsert"|"insert"} [options.mode="upsert"] - стратегия при совпадении
 * @returns {Promise<{inserted: string[], updated: string[], errors: string[]}>}
 */
async function validateImportRows(rows, options) {
  const {
    table,
    uniqueBy = [],
    uniqueField,
    requiredFields = [],
    req,
    logType,
    mode = 'upsert'
  } = options

  if (!table) throw new Error('importValidator: options.table is required')

  // Поддержка старого варианта с uniqueField
  const uniqueKeys = Array.isArray(uniqueBy) && uniqueBy.length > 0
    ? uniqueBy
    : uniqueField
      ? [uniqueField]
      : []

  if (uniqueKeys.length === 0) {
    throw new Error('importValidator: provide uniqueBy (array) or uniqueField (string)')
  }

  const errors = []
  const inserted = []
  const updated = []
  const seen = new Set() // для детекта дублей внутри файла

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {}

      // нормализуем пробелы у строк
      const row = {}
      for (const k of Object.keys(raw)) {
        row[k] = typeof raw[k] === 'string' ? raw[k].trim() : raw[k]
      }

      const rowNumber = i + 2 // предполагаем 1-ю строку — заголовки

      // 1) Проверка обязательных полей
      const missing = requiredFields.find((f) => {
        const v = row[f]
        return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
      })
      if (missing) {
        errors.push(`Строка ${rowNumber}: поле «${missing}» обязательно`)
        continue
      }

      // 2) Выбор идентификатора по uniqueBy (первое непустое поле)
      let idField = null
      let idValue = null
      for (const key of uniqueKeys) {
        const v = row[key]
        if (!(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))) {
          idField = key
          idValue = typeof v === 'string' ? v.trim() : v
          break
        }
      }
      if (!idField || !idValue) {
        const label = uniqueKeys.join(' | ')
        errors.push(`Строка ${rowNumber}: не заполнено ни одно из уникальных полей (${label})`)
        continue
      }

      // 3) Дубликат внутри текущего файла
      const seenKey = `${idField}:${String(idValue)}`
      if (seen.has(seenKey)) {
        errors.push(`Строка ${rowNumber}: значение «${idValue}» по полю «${idField}» дублируется в файле`)
        continue
      }
      seen.add(seenKey)

      try {
        // 4) Проверка наличия записи в БД
        const [exist] = await conn.execute(
          `SELECT * FROM \`${table}\` WHERE \`${idField}\` = ? LIMIT 1`,
          [idValue]
        )

        if (exist.length > 0) {
          // Уже есть
          if (mode === 'insert') {
            errors.push(`Строка ${rowNumber}: значение «${idValue}» уже существует (поле ${idField})`)
            continue
          }

          // UPSERT → UPDATE (только реально присланные поля, без техполей)
          const before = exist[0]
          const keys = Object.keys(row).filter(
            (k) =>
              row[k] !== undefined &&
              !['id', 'version', 'created_at', 'updated_at'].includes(k)
          )

          if (keys.length > 0) {
            const setPairs = keys.map((k) => `\`${k}\` = ?`)
            const values = keys.map((k) => row[k])

            // аккуратно поднимем техполя, если есть в таблице
            const hasVersion   = Object.prototype.hasOwnProperty.call(before, 'version')
            const hasUpdatedAt = Object.prototype.hasOwnProperty.call(before, 'updated_at')
            if (hasVersion)   setPairs.push('version = version + 1')
            if (hasUpdatedAt) setPairs.push('updated_at = NOW()')

            await conn.execute(
              `UPDATE \`${table}\`
               SET ${setPairs.join(', ')}
               WHERE \`${idField}\` = ?`,
              [...values, idValue]
            )
          } else {
            // если прислали только уникальный ключ без данных — считаем, что нет изменений
            continue
          }

          // Логирование
          if (logType && req) {
            if (logFieldDiffs) {
              const [afterRows] = await conn.execute(
                `SELECT * FROM \`${table}\` WHERE \`${idField}\` = ?`,
                [idValue]
              )
              await logFieldDiffs({
                req,
                entity_type: logType,
                entity_id: afterRows[0]?.id || before.id,
                oldData: before,
                newData: afterRows[0],
                comment: 'Импорт (обновление)'
              })
            } else {
              await logActivity({
                req,
                action: 'update',
                entity_type: logType,
                entity_id: before.id,
                comment: `Импорт: обновление по ${idField}=${idValue}`
              })
            }
          }

          updated.push(String(idValue))
        } else {
          // Нет записи → INSERT (без техполей; version/updated_at выставятся по умолчанию)
          const keys = Object.keys(row).filter(
            (k) => row[k] !== undefined && !['id', 'version', 'created_at', 'updated_at'].includes(k)
          )
          if (!keys.length) {
            errors.push(`Строка ${rowNumber}: нет данных для вставки`)
            continue
          }

          const values = keys.map((k) => row[k])
          const placeholders = keys.map(() => '?').join(', ')

          const [ins] = await conn.execute(
            `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${placeholders})`,
            values
          )

          if (logType && req) {
            await logActivity({
              req,
              action: 'create',
              entity_type: logType,
              entity_id: ins.insertId,
              comment: `Импорт: создано по ${idField}=${idValue}`
            })
          }

          inserted.push(String(idValue))
        }
      } catch (err) {
        console.error(`❌ Ошибка в строке ${rowNumber}:`, err)
        if (err && err.code === 'ER_DUP_ENTRY') {
          errors.push(`Строка ${rowNumber}: конфликт уникальности (дубликат ключа)`)
        } else {
          errors.push(`Строка ${rowNumber}: ошибка сервера при обработке`)
        }
      }
    }

    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  return { inserted, updated, errors }
}

module.exports = { validateImportRows }
