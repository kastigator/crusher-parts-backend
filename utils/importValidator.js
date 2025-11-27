// utils/importValidator.js
//
// Универсальный валидатор/импортёр строк из Excel/CSV.
// Работает по схеме, которую задаём в utils/entitySchemas.js.
//
// Ключевые опции:
//   - table:          имя таблицы
//   - uniqueField:    одно уникальное поле (строка)
//   - uniqueBy:       массив полей (берётся первое непустое)
//   - requiredFields: обязательные поля
//   - mode:
//       "upsert" (по умолчанию): если запись найдена → UPDATE, иначе INSERT
//       "insert": всегда INSERT, если запись найдена → ошибка
//   - disableExistingCheck:
//       false (дефолт): делаем SELECT по уникальному полю
//       true: не делаем SELECT, сразу пытаемся INSERT (полагаться на UNIQUE в БД)
//                — полезно для искусственных ключей типа "_file_key".
//

const db = require("./db")
const logActivity = require("./logActivity")

let logFieldDiffs = null
try {
  logFieldDiffs = require("./logFieldDiffs")
} catch {
  /* noop */
}

/**
 * @param {Array<Object>} rows - массив ПРЕОБРАЗОВАННЫХ объектов
 * @param {Object} options
 * @param {string} options.table
 * @param {string[]} [options.uniqueBy]
 * @param {string} [options.uniqueField]
 * @param {string[]} [options.requiredFields=[]]
 * @param {Object} [options.req]
 * @param {string} [options.logType]
 * @param {"upsert"|"insert"} [options.mode="upsert"]
 * @param {boolean} [options.disableExistingCheck=false]
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
    mode = "upsert",
    disableExistingCheck = false,
  } = options

  if (!table) throw new Error("importValidator: options.table is required")

  const uniqueKeys =
    Array.isArray(uniqueBy) && uniqueBy.length > 0
      ? uniqueBy
      : uniqueField
      ? [uniqueField]
      : []

  if (uniqueKeys.length === 0) {
    throw new Error(
      "importValidator: provide uniqueBy (array) or uniqueField (string)"
    )
  }

  const errors = []
  const inserted = []
  const updated = []
  const seen = new Set() // дубликаты внутри файла

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {}

      // нормализуем строки
      const row = {}
      for (const k of Object.keys(raw)) {
        row[k] = typeof raw[k] === "string" ? raw[k].trim() : raw[k]
      }

      const rowNumber = i + 2 // предполагаем, что 1-я строка — заголовки

      // 1) Проверка requiredFields
      const missing = requiredFields.find((f) => {
        const v = row[f]
        return (
          v === undefined ||
          v === null ||
          (typeof v === "string" && v.trim() === "")
        )
      })
      if (missing) {
        errors.push(`Строка ${rowNumber}: поле «${missing}» обязательно`)
        continue
      }

      // 2) Выбор идентификатора по uniqueKeys (первое непустое)
      let idField = null
      let idValue = null
      for (const key of uniqueKeys) {
        const v = row[key]
        if (
          !(
            v === undefined ||
            v === null ||
            (typeof v === "string" && v.trim() === "")
          )
        ) {
          idField = key
          idValue = typeof v === "string" ? v.trim() : v
          break
        }
      }
      if (!idField || !idValue) {
        const label = uniqueKeys.join(" | ")
        errors.push(
          `Строка ${rowNumber}: не заполнено ни одно из уникальных полей (${label})`
        )
        continue
      }

      // 3) Дубликат внутри импортируемого файла
      const seenKey = `${idField}:${String(idValue)}`
      if (seen.has(seenKey)) {
        errors.push(
          `Строка ${rowNumber}: значение «${idValue}» по полю «${idField}» дублируется в файле`
        )
        continue
      }
      seen.add(seenKey)

      try {
        let exist = []

        // 4) Проверка наличия в БД (если не отключена)
        if (!disableExistingCheck) {
          const [ex] = await conn.execute(
            `SELECT * FROM \`${table}\` WHERE \`${idField}\` = ? LIMIT 1`,
            [idValue]
          )
          exist = ex
        }

        if (!disableExistingCheck && exist.length > 0) {
          // ====== UPSERT-ветка (UPDATE) ======
          if (mode === "insert") {
            errors.push(
              `Строка ${rowNumber}: значение «${idValue}» уже существует (поле ${idField})`
            )
            continue
          }

          const before = exist[0]
          const keys = Object.keys(row).filter(
            (k) =>
              row[k] !== undefined &&
              !["id", "version", "created_at", "updated_at"].includes(k) &&
              !k.startsWith("_") // техполя (типа _file_key) не пишем в таблицу
          )

          if (keys.length > 0) {
            const setPairs = keys.map((k) => `\`${k}\` = ?`)
            const values = keys.map((k) => row[k])

            const hasVersion = Object.prototype.hasOwnProperty.call(
              before,
              "version"
            )
            const hasUpdatedAt = Object.prototype.hasOwnProperty.call(
              before,
              "updated_at"
            )
            if (hasVersion) setPairs.push("version = version + 1")
            if (hasUpdatedAt) setPairs.push("updated_at = NOW()")

            await conn.execute(
              `UPDATE \`${table}\`
               SET ${setPairs.join(", ")}
               WHERE \`${idField}\` = ?`,
              [...values, idValue]
            )
          } else {
            // Прислали только уникальный ключ без других полей — нет изменений
            continue
          }

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
                comment: "Импорт (обновление)",
              })
            } else {
              await logActivity({
                req,
                action: "update",
                entity_type: logType,
                entity_id: before.id,
                comment: `Импорт: обновление по ${idField}=${idValue}`,
              })
            }
          }

          updated.push(String(idValue))
        } else {
          // ====== INSERT ======
          const keys = Object.keys(row).filter(
            (k) =>
              row[k] !== undefined &&
              !["id", "version", "created_at", "updated_at"].includes(k) &&
              !k.startsWith("_") // техполя не пишем
          )

          if (!keys.length) {
            errors.push(`Строка ${rowNumber}: нет данных для вставки`)
            continue
          }

          const values = keys.map((k) => row[k])
          const placeholders = keys.map(() => "?").join(", ")

          const [ins] = await conn.execute(
            `INSERT INTO \`${table}\` (${keys
              .map((k) => `\`${k}\``)
              .join(", ")}) VALUES (${placeholders})`,
            values
          )

          if (logType && req) {
            await logActivity({
              req,
              action: "create",
              entity_type: logType,
              entity_id: ins.insertId,
              comment: `Импорт: создано по ${idField}=${idValue}`,
            })
          }

          inserted.push(String(idValue))
        }
      } catch (err) {
        console.error(`❌ Ошибка в строке ${rowNumber}:`, err)
        if (err && err.code === "ER_DUP_ENTRY") {
          errors.push(
            `Строка ${rowNumber}: конфликт уникальности (дубликат ключа)`
          )
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
