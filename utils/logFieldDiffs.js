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
async function logFieldDiffs({ req, oldData, newData, entity_type, entity_id }) {
  // 🔢 жёстко приводим entity_id к числу
  const idNum =
    entity_id === undefined || entity_id === null || entity_id === ''
      ? null
      : Number(entity_id)

  if (idNum === null || Number.isNaN(idNum)) {
    console.error("❌ logFieldDiffs: invalid entity_id:", entity_id)
    return
  }

  const client_id = oldData?.client_id ?? null

  for (const key in newData) {
    if (!Object.prototype.hasOwnProperty.call(oldData, key)) continue

    const oldVal = oldData[key]
    const newVal = newData[key]

    // сравниваем как строки, но безопасно обрабатываем null/undefined
    const oldStr = oldVal == null ? "" : String(oldVal)
    const newStr = newVal == null ? "" : String(newVal)

    if (oldStr !== newStr) {
      await logActivity({
        req,
        action: "update",
        entity_type,
        entity_id: idNum,     // ✅ гарантированно число
        field_changed: key,
        old_value: oldVal,
        new_value: newVal,
        client_id
      })
    }
  }
}

module.exports = logFieldDiffs
