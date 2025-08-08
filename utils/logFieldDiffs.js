// utils/logFieldDiffs.js

const logActivity = require("./logActivity")

/**
 * Логирование изменений по полям
 * @param {Object} options
 * @param {Object} options.req - Express req с user
 * @param {Object} options.oldData - предыдущее состояние объекта
 * @param {Object} options.newData - новое состояние объекта
 * @param {string} options.entity_type - тип сущности, например 'clients'
 * @param {number|string} options.entity_id - ID сущности
 */
async function logFieldDiffs({ req, oldData, newData, entity_type, entity_id }) {
  const client_id = oldData?.client_id ?? null // ✅ берём client_id, если есть

  for (const key in newData) {
    if (!Object.prototype.hasOwnProperty.call(oldData, key)) continue

    const oldVal = oldData[key]
    const newVal = newData[key]

    const oldStr = oldVal === null || oldVal === undefined ? '' : String(oldVal)
    const newStr = newVal === null || newVal === undefined ? '' : String(newVal)

    if (oldStr !== newStr) {
      await logActivity({
        req,
        action: "update",
        entity_type,
        entity_id,
        field_changed: key,
        old_value: oldVal,
        new_value: newVal,
        client_id // ✅ теперь client_id попадёт в запись лога
      })
    }
  }
}

module.exports = logFieldDiffs
