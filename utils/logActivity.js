// utils/logActivity.js
const db = require('./db');

/**
 * Записать действие в таблицу activity_logs
 * @param {Object} options
 * @param {Object} options.req - Express req (для user_id)
 * @param {'create'|'update'|'delete'} options.action
 * @param {string} options.entity_type
 * @param {number|string|null} options.entity_id
 * @param {string|null} [options.field_changed]
 * @param {string|number|null} [options.old_value]
 * @param {string|number|null} [options.new_value]
 * @param {string|null} [options.comment]
 * @param {number|string|null} [options.client_id] - для объединённых логов клиентов
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
  client_id = null,
}) {
  try {
    const user_id = req?.user?.id ?? null;

    // 1) action
    const act = String(action || '').trim().toLowerCase();
    const allowed = new Set(['create', 'update', 'delete']);
    if (!allowed.has(act)) {
      console.error('❌ logActivity: invalid action:', action);
      return;
    }

    // 2) entity_type
    const et = String(entity_type || '').trim();
    if (!et) {
      console.error('❌ logActivity: empty entity_type');
      return;
    }

    // 3) entity_id -> number|null
    let idNum = null;
    if (entity_id !== undefined && entity_id !== null && entity_id !== '') {
      idNum = Number(entity_id);
      if (Number.isNaN(idNum)) {
        console.error('❌ logActivity: entity_id is not numeric:', entity_id);
        return;
      }
    }

    // 4) client_id -> number|null + авто для клиентов
    let clientIdNum = null;
    if (client_id !== undefined && client_id !== null && client_id !== '') {
      const tmp = Number(client_id);
      if (!Number.isNaN(tmp)) clientIdNum = tmp;
    }
    if (!clientIdNum && et === 'clients' && idNum != null) {
      // для записей по самим клиентам
      clientIdNum = idNum;
    }

    // 5) формируем INSERT динамически (без лишних столбцов)
    const cols = ['user_id', 'action', 'entity_type', 'entity_id', 'field_changed', 'old_value', 'new_value', 'comment'];
    const vals = [user_id ?? null, act, et, idNum, field_changed ?? null, old_value ?? null, new_value ?? null, comment ?? null];

    // добавим client_id только если он вычислился — чтобы не упираться в схему
    if (clientIdNum != null) {
      cols.push('client_id');
      vals.push(clientIdNum);
    }

    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO activity_logs (${cols.join(', ')}) VALUES (${placeholders})`;

    // при отладке можно включить подробный лог
    if (process.env.DEBUG_LOG_ACTIVITY === '1') {
      console.log('📝 logActivity SQL:', sql, 'VALS:', vals);
    }

    await db.execute(sql, vals);
  } catch (err) {
    console.error('❌ Ошибка логирования активности:', err);
  }
}

module.exports = logActivity;
