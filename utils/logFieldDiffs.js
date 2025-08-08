// utils/logFieldDiffs.js

const logActivity = require("./logActivity")

/**
 * Универсальное логирование изменений по полям.
 *
 * @param {Object} options
 * @param {Object} options.req               - Express req (для user_id)
 * @param {Object} options.oldData           - предыдущее состояние объекта
 * @param {Object} options.newData           - новое состояние объекта
 * @param {string} options.entity_type       - тип сущности, напр. 'clients'
 * @param {number|string} options.entity_id  - ID сущности
 * @param {number|null} [options.client_id]  - ID клиента (опционально)
 */
async function logFieldDiffs({
  req,
  oldData = {},
  newData = {},
  entity_type,
  entity_id,
  client_id = null
}) {
  // авто-детект client_id, если его не передали явно
  const inferredClientId =
    client_id ??
    oldData?.client_id ??
    newData?.client_id ??
    null

  const skipFields = new Set(["id", "created_at", "updated_at"])

  for (const key of Object.keys(newData)) {
    if (skipFields.has(key)) continue
    if (!Object.prototype.hasOwnProperty.call(oldData, key)) continue

    const oldVal = oldData[key]
    const newVal = newData[key]

    const oldStr = oldVal == null ? "" : String(oldVal)
    const newStr = newVal == null ? "" : String(newVal)

    if (oldStr !== newStr) {
      await logActivity({
        req,
        action: "update",
        entity_type,
        entity_id,
        field_changed: key,
        old_value: oldVal,
        new_value: newVal,
        client_id: inferredClientId // <- безопасно для всех сущностей
      })
    }
  }
}

module.exports = logFieldDiffs
