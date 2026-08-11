const db = require('../../utils/db')

const clamp = (value, fallback, maximum) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback
}

const AGGREGATE_SQL = `
  SELECT cr.id, cr.internal_number, cr.client_reference, cr.status, cr.lifecycle_stage,
         cr.received_at, cr.processing_deadline, cr.assigned_to_user_id, cr.current_revision_id,
         c.company_name AS client_name,
         COALESCE(u.full_name, u.username) AS owner_name,
         COUNT(DISTINCT CASE WHEN i.item_status = 'active' THEN i.id END) AS total_lines,
         COUNT(DISTINCT CASE WHEN i.item_status = 'active' AND ident.identification_status = 'confirmed'
           AND ident.catalog_position_id IS NOT NULL THEN i.id END) AS confirmed_lines,
         COUNT(DISTINCT CASE WHEN i.item_status = 'active' AND t.status IN ('new','in_progress') THEN i.id END) AS open_task_lines,
         COUNT(DISTINCT CASE WHEN i.item_status = 'active' AND t.status = 'waiting_client' THEN i.id END) AS waiting_client_lines,
         COUNT(DISTINCT CASE WHEN i.item_status = 'active'
           AND ident.identification_status = 'confirmed' AND ident.catalog_position_id IS NOT NULL
           AND reqs.substitution_policy IS NOT NULL AND reqs.substitution_policy <> 'unspecified'
           AND i.requested_qty > 0 AND i.uom IS NOT NULL AND TRIM(i.uom) <> ''
           AND released.client_request_revision_item_id IS NULL THEN i.id END) AS ready_for_release_lines,
         COUNT(DISTINCT CASE WHEN i.item_status = 'active' AND released.client_request_revision_item_id IS NOT NULL THEN i.id END) AS released_lines
    FROM client_requests cr
    JOIN clients c ON c.id = cr.client_id
    LEFT JOIN users u ON u.id = cr.assigned_to_user_id
    LEFT JOIN client_request_revisions r ON r.id = cr.current_revision_id
    LEFT JOIN client_request_revision_items i ON i.client_request_revision_id = r.id
    LEFT JOIN client_request_item_identifications ident ON ident.client_request_revision_item_id = i.id
    LEFT JOIN client_request_item_requirements reqs ON reqs.client_request_revision_item_id = i.id
    LEFT JOIN technical_identification_tasks t
      ON t.client_request_revision_item_id = i.id AND t.status IN ('new','in_progress','waiting_client')
    LEFT JOIN (
      SELECT DISTINCT pri.client_request_revision_item_id
        FROM procurement_release_items pri
        JOIN procurement_releases pr ON pr.id = pri.procurement_release_id AND pr.status = 'released'
    ) released ON released.client_request_revision_item_id = i.id
   GROUP BY cr.id, c.company_name, u.full_name, u.username`

const viewPredicate = (view) => {
  if (view === 'archive') return "(status = 'archived' OR lifecycle_stage = 'archived')"
  if (view === 'attention') return "(status <> 'archived' AND lifecycle_stage <> 'archived' AND (total_lines > confirmed_lines OR waiting_client_lines > 0))"
  if (view === 'identification') return "(status <> 'archived' AND lifecycle_stage <> 'archived' AND open_task_lines > 0)"
  if (view === 'client') return "(status <> 'archived' AND lifecycle_stage <> 'archived' AND waiting_client_lines > 0)"
  if (view === 'ready') return "(status <> 'archived' AND lifecycle_stage <> 'archived' AND ready_for_release_lines > 0)"
  return "(status <> 'archived' AND lifecycle_stage <> 'archived')"
}

async function getRegistry(query = {}, executor = db) {
  const page = clamp(query.page, 1, 100000)
  const pageSize = clamp(query.page_size, 25, 100)
  const params = []
  const where = [viewPredicate(query.view)]
  if (query.q) {
    const pattern = `%${String(query.q).trim()}%`
    where.push('(internal_number LIKE ? OR client_name LIKE ? OR client_reference LIKE ?)')
    params.push(pattern, pattern, pattern)
  }
  const filteredSql = `SELECT * FROM (${AGGREGATE_SQL}) registry WHERE ${where.join(' AND ')}`
  const [[count]] = await executor.execute(`SELECT COUNT(*) AS total FROM (${filteredSql}) filtered`, params)
  const [rows] = await executor.execute(
    `${filteredSql} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  )
  const [[views]] = await executor.execute(
    `SELECT COUNT(*) AS all_count,
            SUM(${viewPredicate('attention')}) AS attention_count,
            SUM(${viewPredicate('identification')}) AS identification_count,
            SUM(${viewPredicate('client')}) AS client_count,
            SUM(${viewPredicate('ready')}) AS ready_count,
            SUM(${viewPredicate('archive')}) AS archive_count
       FROM (${AGGREGATE_SQL}) registry`
  )
  const numericRows = rows.map((row) => ({
    ...row,
    total_lines: Number(row.total_lines || 0),
    confirmed_lines: Number(row.confirmed_lines || 0),
    open_task_lines: Number(row.open_task_lines || 0),
    waiting_client_lines: Number(row.waiting_client_lines || 0),
    ready_for_release_lines: Number(row.ready_for_release_lines || 0),
    released_lines: Number(row.released_lines || 0),
  }))
  return {
    items: numericRows,
    pagination: { page, page_size: pageSize, total: Number(count.total || 0) },
    view_counts: Object.fromEntries(Object.entries(views || {}).map(([key, value]) => [key, Number(value || 0)])),
  }
}

module.exports = { getRegistry }
