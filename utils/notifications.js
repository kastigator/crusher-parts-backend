const createNotification = async (
  conn,
  { userId, type, title, message, entityType, entityId }
) => {
  if (!userId) return
  try {
    if (type === 'assignment' && entityType && entityId) {
      // Не копим дубли уведомлений на одно и то же назначение.
      await conn.execute(
        `DELETE FROM notifications
         WHERE user_id = ?
           AND type = 'assignment'
           AND entity_type = ?
           AND entity_id = ?`,
        [userId, entityType, entityId]
      )
    }

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
