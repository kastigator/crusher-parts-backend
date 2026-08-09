const ACTIVE_ITEM_STATUS = new Set(['active'])
const READY_IDENTIFICATION_STATUS = new Set(['confirmed', 'not_required'])

function evaluateItemReadiness(item) {
  const blockers = []
  const warnings = []
  const quantity = Number(item.requested_qty)
  const itemStatus = String(item.item_status || 'active').toLowerCase()
  const identificationStatus = String(item.identification_status || 'unprocessed').toLowerCase()
  const substitutionPolicy = String(item.substitution_policy || 'unspecified').toLowerCase()

  if (!ACTIVE_ITEM_STATUS.has(itemStatus)) blockers.push('ITEM_NOT_ACTIVE')
  if (!Number.isFinite(quantity) || quantity <= 0) blockers.push('INVALID_QUANTITY')
  if (!String(item.uom || '').trim()) blockers.push('MISSING_UOM')
  if (!READY_IDENTIFICATION_STATUS.has(identificationStatus)) {
    blockers.push('IDENTIFICATION_NOT_CONFIRMED')
  }
  if (identificationStatus === 'confirmed' && !Number(item.identification_catalog_position_id)) {
    blockers.push('CATALOG_POSITION_MISSING')
  }
  if (substitutionPolicy === 'unspecified') blockers.push('SUBSTITUTION_POLICY_UNSPECIFIED')
  if (Number(item.already_released_count || 0) > 0) blockers.push('ALREADY_RELEASED')
  if (item.required_documents_json && !Array.isArray(item.required_documents_json)) {
    warnings.push('REQUIRED_DOCUMENTS_REVIEW')
  }

  return {
    ready: blockers.length === 0,
    readiness_status: blockers.length === 0 ? 'ready' : 'blocked',
    blocker_codes: blockers,
    warning_codes: warnings,
  }
}

module.exports = { evaluateItemReadiness }
