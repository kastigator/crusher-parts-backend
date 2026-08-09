const crypto = require('crypto')
const { FinancialOperationsError } = require('./domainError')

const toId = (value) => {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
const actor = (value) => {
  const id = toId(value)
  if (!id) throw new FinancialOperationsError('ACTOR_REQUIRED', 'Не определён пользователь операции', 401)
  return id
}
const cleanText = (value, max = 1000) => {
  const text = String(value ?? '').trim()
  return text && text.length <= max ? text : null
}
const requiredText = (value, field, max = 1000) => {
  const text = cleanText(value, max)
  if (!text) throw new FinancialOperationsError('FIELD_REQUIRED', `Требуется ${field}`, 400, { field })
  return text
}
const parseJson = (value, fallback = {}) => {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}
const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.keys(value).sort().reduce((out, key) => ({ ...out, [key]: stable(value[key]) }), {})
    : value
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const requestKey = (value) => requiredText(value, 'request_key', 128)
const isoDate = (value, field, { nullable = false } = {}) => {
  if (value == null || value === '') {
    if (nullable) return null
    throw new FinancialOperationsError('DATE_REQUIRED', `Требуется ${field}`, 400, { field })
  }
  const text = String(value).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new FinancialOperationsError('INVALID_DATE', `Некорректная дата ${field}`, 400, { field })
  }
  return text
}
const currency = (value) => {
  const code = String(value || '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new FinancialOperationsError('INVALID_CURRENCY', 'Требуется ISO currency code')
  return code
}
async function event(executor, type, aggregateType, aggregateId, userId, payload = {}, source = {}) {
  const normalized = { type, aggregateType, aggregateId, payload, source }
  await executor.execute(
    `INSERT INTO financial_events
      (event_type,aggregate_type,aggregate_id,source_domain,source_entity_type,source_entity_id,actor_user_id,payload_json,event_hash)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [type, aggregateType, aggregateId || null, source.domain || null, source.entity_type || null,
      source.entity_id || null, userId || null, JSON.stringify(payload), sha256(normalized)]
  )
}

module.exports = { actor, cleanText, currency, event, isoDate, parseJson, requestKey, requiredText, sha256, stable, toId }
