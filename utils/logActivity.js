const db = require('./db')

/**
 * Записать действие в таблицу activity_logs
 * @param {Object} options - параметры лога
 * @param {Object} options.req - объект запроса (нужен для user_id)
 * @param {string} options.action - тип действия: 'create', 'update', 'delete', 'price_change' и т.д.
 * @param {string} options.entity_type - сущность: 'supplier_part', 'original_part', 'order' и т.д.
 * @param {number} options.entity_id - ID объекта
 * @param {string} [options.field_changed] - название поля (если применимо)
 * @param {string|number|null} [options.old_value] - старое значение
 * @param {string|number|null} [options.new_value] - новое значение
 * @param {string|null} [options.comment] - пояснение к действию
 */
async function logActivity({
  req,
  action,
  entity_type,
  entity_id,
  field_changed = null,
  old_value = null,
  new_value = null,
  comment = null
}) {
  try {
    const user_id = req?.user?.id || null

    await db.execute(
      `
      INSERT INTO activity_logs
        (user_id, action, entity_type, entity_id, field_changed, old_value, new_value, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        user_id,
        action,
        entity_type,
        entity_id,
        field_changed,
        old_value,
        new_value,
        comment
      ]
    )
  } catch (err) {
    console.error('Ошибка логирования активности:', err.message)
  }
}

module.exports = logActivity
