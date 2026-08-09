const crypto = require('crypto')
const { SourcingDomainError } = require('./domainError')

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const toPositiveNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

const json = (value, fallback = {}) => JSON.stringify(value ?? fallback)

const cleanText = (value) => {
  const text = String(value ?? '').trim()
  return text || null
}

const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function requireActor(actorUserId) {
  const actorId = toId(actorUserId)
  if (!actorId) throw new SourcingDomainError('ACTOR_REQUIRED', 'Не определён пользователь операции', 401)
  return actorId
}

async function addEvent(executor, caseId, eventType, entityType, entityId, actorUserId, payload = {}) {
  await executor.execute(
    `INSERT INTO sourcing_case_events
      (sourcing_case_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [caseId, eventType, entityType, entityId, actorUserId, json(payload)]
  )
}

module.exports = {
  addEvent,
  cleanText,
  json,
  requireActor,
  sha256,
  toId,
  toPositiveNumber,
}
