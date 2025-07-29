const db = require('./db')
const logActivity = require('./logActivity')

/**
 * Универсальная функция для валидации и импорта строк
 * @param {Array} rows - массив объектов (уже transform'нутых)
 * @param {Object} options
 * @param {string} options.table - имя таблицы
 * @param {string} options.uniqueField - поле для проверки дубликатов
 * @param {Array} options.requiredFields - список обязательных полей
 * @param {Object} options.req - req Express (нужен для user_id в логах)
 * @param {string} options.logType - тип сущности для логов (например: 'tnved_code')
 * @returns {{inserted: Array<string>, errors: Array<string>}}
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

  for (const [index, rawRow] of rows.entries()) {
    const row = {}
    for (const key in rawRow) {
      row[key] = typeof rawRow[key] === 'string' ? rawRow[key].trim() : rawRow[key]
    }

    const rowNumber = index + 1
    const value = String(row[uniqueField] || '').trim()

    // Проверка обязательного уникального поля
    if (!value) {
      errors.push(`Строка ${rowNumber}: значение поля «${uniqueField}» отсутствует`)
      continue
    }

    // Проверка на дубликаты внутри Excel-файла
    if (seen.has(value)) {
      errors.push(`Строка ${rowNumber}: значение «${value}» дублируется в Excel`)
      continue
    }
    seen.add(value)

    // Проверка обязательных полей
    const missingField = requiredFields.find(field => {
      const val = row[field]
      return val === undefined || val === null || (typeof val === 'string' && val.trim() === '')
    })

    if (missingField) {
      errors.push(`Строка ${rowNumber}: поле «${missingField}» обязательно для заполнения`)
      continue
    }

    try {
      // Проверка на существование в БД
      const [existing] = await db.execute(
        `SELECT id FROM \`${table}\` WHERE \`${uniqueField}\` = ?`,
        [value]
      )
      if (existing.length > 0) {
        errors.push(`Строка ${rowNumber}: значение «${value}» уже существует в базе`)
        continue
      }

      // Вставка
      const keys = Object.keys(row)
      const values = keys.map(k => row[k])
      const placeholders = keys.map(() => '?').join(', ')

      const [result] = await db.execute(
        `INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${placeholders})`,
        values
      )

      // Логирование (если задано)
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
      console.error(`❌ Ошибка при вставке строки ${rowNumber}:`, err)
      errors.push(`Строка ${rowNumber}: ошибка сервера при добавлении значения «${value}»`)
    }
  }

  return { inserted, errors }
}

module.exports = { validateImportRows }
