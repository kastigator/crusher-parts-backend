const db = require('../utils/db')

function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

async function recordSecurityEvent({
  executor = db,
  eventType,
  actorUserId = null,
  targetUserId = null,
  entityType = null,
  entityId = null,
  before = null,
  after = null,
  metadata = null,
}) {
  if (!eventType) throw new Error('eventType is required')
  await executor.execute(
    `
    INSERT INTO security_audit_events (
      event_type, actor_user_id, target_user_id, entity_type, entity_id,
      before_json, after_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      eventType,
      actorUserId || null,
      targetUserId || null,
      entityType || null,
      entityId === undefined || entityId === null ? null : String(entityId),
      toJson(before),
      toJson(after),
      toJson(metadata),
    ]
  )
}

module.exports = { recordSecurityEvent }
