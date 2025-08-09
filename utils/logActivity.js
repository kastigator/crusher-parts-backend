// utils/logActivity.js
const db = require('./db')

/**
 * Записать действие в таблицу activity_logs
 * @param {Object} options
 * @param {Object} options.req
 * @param {'create'|'update'|'delete'} options.action
 * @param {string} options.entity_type
 * @param {number|string|null} options.entity_id
 * @param {string|null} [options.field_changed]
 * @param {string|number|null} [options.old_value]
 * @param {string|number|null} [options.new_value]
 * @param {string|null} [options.comment]
 * @param {number|null} [options.client_id]
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

    // 🔒 Нормализуем и валидируем action
    const act = String(action || '').trim().toLowerCase()
    const allowed = new Set(['create', 'update', 'delete'])
    if (!allowed.has(act)) {
      console.error('❌ logActivity: invalid action:', action)
      return
    }

    // 🔢 Приводим entity_id к числу или null
    let idNum = null
    if (entity_id !== undefined && entity_id !== null && entity_id !== '') {
      idNum = Number(entity_id)
      if (Number.isNaN(idNum)) {
        console.error('❌ logActivity: entity_id is not numeric:', entity_id)
        return
      }
    }

    // ✅ Авто client_id для таблицы clients
    if (!client_id && entity_type === 'clients') {
      client_id = idNum
    }

    // 🧪 Диагностика (по желанию можно убрать позже)
    console.log('📝 logActivity payload:', {
      user_id, act, entity_type, entity_id: idNum, field_changed, old_value, new_value, comment, client_id
    })

    await db.execute(
      `
      INSERT INTO activity_logs
        (user_id, action, entity_type, entity_id, field_changed, old_value, new_value, comment, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        user_id,
        act,
        entity_type,
        idNum,
        field_changed ?? null,
        old_value ?? null,
        new_value ?? null,
        comment ?? null,
        client_id ?? null
      ]
    )
  } catch (err) {
    console.error('❌ Ошибка логирования активности:', err.message)
  }
}

module.exports = logActivity
