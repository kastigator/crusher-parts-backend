const crypto = require('node:crypto')
const { WarehouseInventoryError } = require('./domainError')

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out }, {})
  return value
}
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const toId = (value) => { const id = Number(value); return Number.isInteger(id) && id > 0 ? id : null }
const actor = (value) => toId(value)
const text = (value, field, max = 255) => {
  const result = String(value || '').trim()
  if (!result) throw new WarehouseInventoryError('REQUIRED_FIELD', `${field} обязателен`)
  return result.slice(0, max)
}
const positiveQty = (value, field = 'quantity') => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new WarehouseInventoryError('INVALID_QUANTITY', `${field} должен быть больше нуля`)
  return Number(number.toFixed(3))
}
const nonNegativeQty = (value, field = 'quantity') => {
  const number = Number(value || 0)
  if (!Number.isFinite(number) || number < 0) throw new WarehouseInventoryError('INVALID_QUANTITY', `${field} не может быть отрицательным`)
  return Number(number.toFixed(3))
}
const key = (value, field = 'idempotency_key') => text(value, field, 128)
const json = (value) => JSON.stringify(value || {})
async function event(conn, type, aggregateType, aggregateId, userId, payload, source = {}) {
  await conn.execute(`INSERT INTO warehouse_inventory_events
    (event_type,aggregate_type,aggregate_id,source_domain,source_entity_type,source_entity_id,actor_user_id,payload_json,event_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`, [type, aggregateType, aggregateId || null, source.domain || null, source.entity_type || null,
    source.entity_id || null, actor(userId), json(payload), sha256({ type, aggregateType, aggregateId, payload, source })])
}

module.exports = { actor, event, json, key, nonNegativeQty, positiveQty, sha256, text, toId }
