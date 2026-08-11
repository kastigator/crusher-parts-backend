const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

const normalizeTaskPriority = (value) => {
  const normalized = String(value || '').toLowerCase()
  return TASK_PRIORITIES.has(normalized) ? normalized : 'normal'
}

const buildClientRequestTaskSourceSnapshot = (source, extra = {}) => ({
  source_type: 'client_request',
  client_request_number: source.client_request_number,
  client_reference: source.client_reference || null,
  client_name: source.client_name,
  revision_number: Number(source.revision_number),
  line_number: Number(source.line_number),
  stable_item_key: source.stable_item_key,
  client_description: source.client_description || null,
  client_line_text: source.client_line_text || null,
  client_catalog_number: source.client_catalog_number || null,
  client_manufacturer_text: source.client_manufacturer_text || null,
  client_equipment_model_text: source.client_equipment_model_text || null,
  requested_qty: source.requested_qty === null ? null : Number(source.requested_qty),
  uom: source.uom || null,
  required_date: source.required_date || null,
  client_comment: source.client_comment || null,
  source_payload: source.source_payload || null,
  ...extra,
})

const buildTaskCreatedEventPayload = ({ priority, assignedToUserId = null, dueAt = null, ...extra }) => ({
  priority: normalizeTaskPriority(priority),
  assigned_to_user_id: assignedToUserId || null,
  due_at: dueAt || null,
  ...extra,
})

const buildTechnicalTaskOpenIdentification = (task) => ({
  catalog_position_id: null,
  identification_status: 'technical_task_open',
  match_method: 'technical_task',
  confidence: null,
  basis_note: `Открыта задача ${task.task_number}`,
  confirmed_by_user_id: null,
  confirmed_at: null,
  provenance: {
    technical_identification_task_id: Number(task.id),
    task_number: task.task_number,
  },
})

module.exports = {
  buildClientRequestTaskSourceSnapshot,
  buildTaskCreatedEventPayload,
  buildTechnicalTaskOpenIdentification,
  normalizeTaskPriority,
}
