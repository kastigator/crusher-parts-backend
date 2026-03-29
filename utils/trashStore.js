async function createTrashEntry({
  executor,
  req,
  entityType,
  entityId,
  rootEntityType,
  rootEntityId,
  deleteMode = 'trash',
  title,
  subtitle = null,
  snapshot = null,
  context = null,
  purgeAfterDays = 30,
}) {
  if (!executor || typeof executor.execute !== 'function') {
    throw new Error('executor with execute() is required')
  }

  const deletedByUserId = req?.user?.id ? Number(req.user.id) : null
  const purgeAfterAt =
    Number.isFinite(Number(purgeAfterDays)) && Number(purgeAfterDays) > 0
      ? new Date(Date.now() + Number(purgeAfterDays) * 24 * 60 * 60 * 1000)
      : null

  const [result] = await executor.execute(
    `
    INSERT INTO trash_entries
      (
        entity_type,
        entity_id,
        root_entity_type,
        root_entity_id,
        delete_mode,
        title,
        subtitle,
        snapshot_json,
        context_json,
        deleted_by_user_id,
        purge_after_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      entityType,
      entityId,
      rootEntityType,
      rootEntityId,
      deleteMode,
      title,
      subtitle,
      snapshot == null ? null : JSON.stringify(snapshot),
      context == null ? null : JSON.stringify(context),
      deletedByUserId,
      purgeAfterAt,
    ]
  )

  return result.insertId
}

async function createTrashEntryItem({
  executor,
  trashEntryId,
  itemType,
  itemId = null,
  itemRole = null,
  title = null,
  snapshot = null,
  sortOrder = 0,
}) {
  if (!executor || typeof executor.execute !== 'function') {
    throw new Error('executor with execute() is required')
  }

  const [result] = await executor.execute(
    `
    INSERT INTO trash_entry_items
      (trash_entry_id, item_type, item_id, item_role, title, snapshot_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      trashEntryId,
      itemType,
      itemId,
      itemRole,
      title,
      snapshot == null ? null : JSON.stringify(snapshot),
      sortOrder,
    ]
  )

  return result.insertId
}

module.exports = {
  createTrashEntry,
  createTrashEntryItem,
}
