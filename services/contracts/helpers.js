const crypto = require('crypto')
const { ContractDomainError } = require('./domainError')

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const cleanText = (value) => {
  const text = String(value ?? '').trim()
  return text || null
}

const parseJson = (value, fallback = {}) => {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key])
      return result
    }, {})
  }
  return value
}

const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')

const requireActor = (value) => {
  const actorId = toId(value)
  if (!actorId) throw new ContractDomainError('ACTOR_REQUIRED', 'Не определён пользователь операции', 401)
  return actorId
}

async function addEvent(executor, caseId, eventType, entityType, entityId, actorUserId, payload = {}) {
  await executor.execute(
    `INSERT INTO contract_events
      (contract_case_id,event_type,entity_type,entity_id,actor_user_id,payload_json)
     VALUES (?,?,?,?,?,?)`,
    [caseId,eventType,entityType,entityId || null,actorUserId || null,JSON.stringify(payload || {})]
  )
}

const requireIdempotencyKey = (value) => {
  const key = cleanText(value)
  if (!key || key.length > 128) throw new ContractDomainError('IDEMPOTENCY_KEY_REQUIRED', 'Требуется idempotency_key длиной до 128 символов')
  return key
}

module.exports = { addEvent, cleanText, parseJson, requireActor, requireIdempotencyKey, sha256, stableValue, toId }
