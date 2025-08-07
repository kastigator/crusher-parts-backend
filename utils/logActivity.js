const db = require('./db')

/**
 * Записать действие в таблицу activity_logs
 * @param {Object} options - параметры лога
 * @param {Object} options.req - объект запроса (нужен для user_id)
 * @param {string} options.action - тип действия: 'create', 'update', 'delete'
 * @param {string} options.entity_type - название таблицы (например, 'clients')
 * @param {number} options.entity_id - ID записи, которая была изменена
 * @param {string|null} [options.field_changed] - изменённое поле (если применимо)
 * @param {string|number|null} [options.old_value]
 * @param {string|number|null} [options.new_value]
 * @param {string|null} [options.comment]
 * @param {number|null} [options.client_id] - ID клиента (можно не передавать для clients)
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
  client_id = null
}) {
  try {
    const user_id = req?.user?.id || null

    // ✅ Автоопределение client_id для таблицы clients
    if (!client_id && entity_type === 'clients') {
      client_id = entity_id
    }

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
    console.error('❌ Ошибка логирования активности:', err.message)
  }
}

module.exports = logActivity
