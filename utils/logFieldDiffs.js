// utils/logFieldDiffs.js

const logActivity = require("./logActivity")

async function logFieldDiffs({ req, oldData, newData, entity_type, entity_id }) {
  for (const key in newData) {
    if (!(key in oldData)) continue
    const oldVal = oldData[key]
    const newVal = newData[key]
    if (String(oldVal ?? '') !== String(newVal ?? '')) {
      await logActivity({
        req,
        action: 'update',
        entity_type,
        entity_id,
        field_changed: key,
        old_value: oldVal,
        new_value: newVal
      })
    }
  }
}

module.exports = logFieldDiffs
