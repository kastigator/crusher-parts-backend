const db = require('./db')
const logActivity = require('./logActivity')

/**
 * Универсальная функция для валидации и импорта строк
 * @param {Array} rows - массив объектов для импорта
 * @param {Object} options - конфигурация импорта
 * @param {string} options.table - имя таблицы
 * @param {string} options.uniqueField - имя поля, по которому проверяются дубликаты
 * @param {Array} options.requiredFields - список обязательных полей
 * @param {Object} options.req - req из Express (для логов)
 * @param {string} options.logType - тип сущности для логов
 * @returns {{inserted: Array, errors: Array}}
 */
async function validateImportRows(rows, options) {
  const {
    table,
    uniqueField,
    requiredFields = [],
    req,
    logType
  } = options

  const errors = []
  const inserted = []
  const seen = new Set()

  for (const [index, item] of rows.entries()) {
    const row = {}
    for (const key in item) {
      row[key] = typeof item[key] === 'string' ? item[key].trim() : item[key]
    }

    const value = String(row[uniqueField] || '').trim()
    const rowNumber = index + 1

    if (!value) {
      errors.push(`Строка ${rowNumber}: значение поля «${uniqueField}» отсутствует`)
      continue
    }

    if (seen.has(value)) {
      errors.push(`Строка ${rowNumber}: значение «${value}» дублируется в Excel`)
      continue
    }
    seen.add(value)

    let missingField = requiredFields.find(field => !String(row[field] || '').trim())
    if (missingField) {
      errors.push(`Строка ${rowNumber}: поле «${missingField}» обязательно для заполнения`)
      continue
    }

    try {
      const [existing] = await db.execute(
        `SELECT id FROM ${table} WHERE ${uniqueField} = ?`,
        [value]
      )
      if (existing.length > 0) {
        errors.push(`Строка ${rowNumber}: значение «${value}» уже существует в базе`)
        continue
      }

      const keys = Object.keys(row)
      const values = keys.map(k => row[k])
      const placeholders = keys.map(() => '?').join(', ')

      const [result] = await db.execute(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
        values
      )

      if (logType && req) {
        await logActivity({
          req,
          action: 'create',
          entity_type: logType,
          entity_id: result.insertId,
          comment: `Импортировано значение: ${value}`
        })
      }

      inserted.push(value)
    } catch (err) {
      console.error(`Ошибка при вставке строки ${rowNumber}:`, err)
      errors.push(`Строка ${rowNumber}: ошибка сервера при добавлении значения «${value}»`)
    }
  }

  return { inserted, errors }
}

module.exports = { validateImportRows }
