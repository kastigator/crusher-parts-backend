const crypto = require('crypto')
const { CommercialOfferDomainError } = require('./domainError')

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
  if (!actorId) throw new CommercialOfferDomainError('ACTOR_REQUIRED', 'Не определён пользователь операции', 401)
  return actorId
}

async function addEvent(executor, offerId, eventType, entityType, entityId, actorUserId, payload = {}) {
  await executor.execute(
    `INSERT INTO commercial_offer_events
      (commercial_offer_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [offerId, eventType, entityType, entityId || null, actorUserId || null, JSON.stringify(payload || {})]
  )
}

module.exports = { addEvent, cleanText, parseJson, requireActor, sha256, toId }
