const db = require('./db')

/**
 * Записать действие в таблицу activity_logs
 * @param {Object} options - параметры лога
 * @param {Object} options.req - объект запроса (нужен для user_id)
 * @param {string} options.action - тип действия: 'create', 'update', 'delete' и т.д.
 * @param {string} options.entity_type - сущность: 'supplier_part', 'client_billing_addresses', и т.д.
 * @param {number} options.entity_id - ID объекта
 * @param {string} [options.field_changed] - поле, которое было изменено (если применимо)
 * @param {string|number|null} [options.old_value]
 * @param {string|number|null} [options.new_value]
 * @param {string|null} [options.comment]
 * @param {number|null} [options.client_id] - ID клиента, если доступен
 */
async function logActivity({
  req,
  action,
  entity_type,
  entity_id,
  field_changed = null,
  old_value = null,
  new_value = null,
  comment = null,
  client_id = null // ✅ новое поле
}) {
  try {
    const user_id = req?.user?.id || null

    await db.execute(
      `
      INSERT INTO activity_logs
        (user_id, action, entity_type, entity_id, field_changed, old_value, new_value, comment, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        user_id,
        action,
        entity_type,
        entity_id,
        field_changed,
        old_value,
        new_value,
        comment,
        client_id
      ]
    )
  } catch (err) {
    console.error('Ошибка логирования активности:', err.message)
  }
}

module.exports = logActivity
