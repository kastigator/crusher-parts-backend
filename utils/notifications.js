const createNotification = async (
  conn,
  { userId, type, title, message, entityType, entityId }
) => {
  if (!userId) return
  try {
    await conn.execute(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES (?,?,?,?,?,?)`,
      [userId, type, title, message, entityType, entityId]
    )
  } catch (e) {
    console.error('createNotification error:', e)
  }
}

module.exports = {
  createNotification,
}
