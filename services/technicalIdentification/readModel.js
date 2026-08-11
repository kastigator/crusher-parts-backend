const db = require('../../utils/db')
const { ClientRequestDomainError } = require('../clientRequests/domainError')

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}
const clamp = (value, fallback, maximum) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback
}
const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

const TASK_SELECT = `
  SELECT t.*,
         cr.internal_number AS client_request_number,
         cr.client_reference, c.company_name AS client_name,
         r.rev_number AS revision_number, i.line_number,
         i.client_description, i.client_line_text, i.client_catalog_number,
         i.client_manufacturer_text, i.client_equipment_model_text,
         i.requested_qty, i.uom, i.required_date, i.client_comment,
         assignee.full_name AS assignee_name, assignee.username AS assignee_username,
         creator.full_name AS creator_name,
         cp.position_code AS result_position_code,
         cp.manufacturer_part_number AS result_manufacturer_part_number,
         COALESCE(cp.display_name_ru, cp.display_name, cp.display_name_en) AS result_position_name
    FROM technical_identification_tasks t
    JOIN client_requests cr ON cr.id = t.client_request_id
    JOIN clients c ON c.id = cr.client_id
    JOIN client_request_revisions r ON r.id = t.client_request_revision_id
    JOIN client_request_revision_items i ON i.id = t.client_request_revision_item_id
    LEFT JOIN users assignee ON assignee.id = t.assigned_to_user_id
    LEFT JOIN users creator ON creator.id = t.created_by_user_id
    LEFT JOIN catalog_positions cp ON cp.id = t.result_catalog_position_id`

const projectTask = (row) => ({
  ...row,
  source_snapshot: parseJson(row.source_snapshot_json, {}),
  candidates: parseJson(row.candidate_snapshot_json, []),
  source_snapshot_json: undefined,
  candidate_snapshot_json: undefined,
})

async function listTasks(query = {}, executor = db) {
  const page = clamp(query.page, 1, 100000)
  const pageSize = clamp(query.page_size, 25, 100)
  const where = []
  const params = []
  const statuses = String(query.status || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (statuses.length) {
    where.push(`t.status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (query.view === 'open') where.push("t.status IN ('new', 'in_progress', 'waiting_client')")
  if (query.view === 'unassigned') where.push("t.status IN ('new', 'in_progress') AND t.assigned_to_user_id IS NULL")
  if (query.view === 'mine') {
    const userId = toId(query.user_id)
    if (userId) { where.push("t.status IN ('new', 'in_progress', 'waiting_client') AND t.assigned_to_user_id = ?"); params.push(userId) }
  }
  if (query.view === 'overdue') where.push("t.status IN ('new', 'in_progress', 'waiting_client') AND t.due_at < CURRENT_TIMESTAMP(6)")
  if (query.view === 'waiting_client') where.push("t.status = 'waiting_client'")
  if (query.view === 'resolved') where.push("t.status IN ('resolved', 'cancelled', 'superseded')")
  if (query.assigned_to_user_id !== undefined) {
    const assigneeId = toId(query.assigned_to_user_id)
    if (assigneeId) { where.push('t.assigned_to_user_id = ?'); params.push(assigneeId) }
  }
  if (query.client_request_id !== undefined) {
    const requestId = toId(query.client_request_id)
    if (requestId) { where.push('t.client_request_id = ?'); params.push(requestId) }
  }
  if (query.q) {
    const pattern = `%${String(query.q).trim()}%`
    where.push(`(t.task_number LIKE ? OR cr.internal_number LIKE ? OR c.company_name LIKE ?
      OR i.client_description LIKE ? OR i.client_catalog_number LIKE ?
      OR i.client_manufacturer_text LIKE ? OR i.client_equipment_model_text LIKE ?)`)
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [[count]] = await executor.execute(
    `SELECT COUNT(*) AS total
       FROM technical_identification_tasks t
       JOIN client_requests cr ON cr.id = t.client_request_id
       JOIN clients c ON c.id = cr.client_id
       JOIN client_request_revision_items i ON i.id = t.client_request_revision_item_id
      ${whereSql}`,
    params
  )
  const [rows] = await executor.execute(
    `${TASK_SELECT} ${whereSql}
     ORDER BY FIELD(t.priority, 'urgent', 'high', 'normal', 'low'),
              CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.id
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  )
  const [[counts]] = await executor.execute(
    `SELECT COUNT(*) AS total,
            SUM(status = 'new') AS new_count,
            SUM(status = 'in_progress') AS in_progress_count,
            SUM(status = 'waiting_client') AS waiting_client_count,
            SUM(status = 'resolved') AS resolved_count,
            SUM(status IN ('new','in_progress','waiting_client') AND assigned_to_user_id IS NULL) AS unassigned_count,
            SUM(status IN ('new','in_progress','waiting_client') AND due_at < CURRENT_TIMESTAMP(6)) AS overdue_count
       FROM technical_identification_tasks`
  )
  return {
    items: rows.map(projectTask),
    pagination: { page, page_size: pageSize, total: Number(count.total || 0) },
    counts: Object.fromEntries(Object.entries(counts || {}).map(([key, value]) => [key, Number(value || 0)])),
  }
}

async function getTaskDetail(taskIdInput, executor = db) {
  const taskId = toId(taskIdInput)
  if (!taskId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректная задача')
  const [[row]] = await executor.execute(`${TASK_SELECT} WHERE t.id = ?`, [taskId])
  if (!row) throw new ClientRequestDomainError('TASK_NOT_FOUND', 'Задача идентификации не найдена', 404)
  const [events] = await executor.execute(
    `SELECT e.*, u.full_name AS actor_name, u.username AS actor_username
       FROM technical_identification_task_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.task_id = ? ORDER BY e.sequence_no`,
    [taskId]
  )
  return {
    ...projectTask(row),
    events: events.map((event) => ({ ...event, payload: parseJson(event.payload_json, {}), payload_json: undefined })),
  }
}

module.exports = { getTaskDetail, listTasks }
