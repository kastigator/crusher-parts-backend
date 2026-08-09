const DISCLOSURE_POLICIES = new Set([
  'SHOW_EXACT_EXECUTION',
  'SHOW_REQUESTED_AND_OFFERED',
  'SHOW_EQUIVALENT_WITHOUT_SOURCE',
  'CUSTOM_APPROVED_PRESENTATION',
])

const RESTRICTED_KEY = /(supplier|procurement|purchase|landed|margin|internal[_-]?cost|source[_-]?alias|pricing[_-]?(case|input|calculation|client_price))/i
const RESTRICTED_TEXT = /(supplier\s*(name|code|alias)|поставщик|source\s+[a-z]\b|procurement|purchase\s+price|landed\s+cost|gross\s+margin)/i

function defaultDisclosurePolicy(fulfillmentType) {
  return fulfillmentType === 'EXACT_REQUESTED_ITEM'
    ? 'SHOW_EXACT_EXECUTION'
    : 'SHOW_EQUIVALENT_WITHOUT_SOURCE'
}

function findRestrictedClientPayload(value, path = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findRestrictedClientPayload(item, `${path}[${index}]`, findings))
    return findings
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (RESTRICTED_KEY.test(key)) findings.push({ code: 'RESTRICTED_KEY', path: `${path}.${key}` })
      findRestrictedClientPayload(item, `${path}.${key}`, findings)
    })
    return findings
  }
  if (typeof value === 'string' && RESTRICTED_TEXT.test(value)) findings.push({ code: 'RESTRICTED_TEXT', path })
  return findings
}

function priceAuthority(line, offeredPrice) {
  const offered = Number(offeredPrice)
  const delegated = line.delegated_floor_snapshot == null
    ? Number(line.recommended_unit_price_snapshot)
    : Number(line.delegated_floor_snapshot)
  const absolute = line.absolute_floor_snapshot == null ? null : Number(line.absolute_floor_snapshot)
  if (absolute != null && offered < absolute) return 'PRICING_REEVALUATION_REQUIRED'
  if (delegated != null && offered < delegated) return 'APPROVAL_REQUIRED'
  return 'PERMITTED'
}

function assessFeedbackChange(feedbackLine, offerLine) {
  const domains = new Set()
  const reasons = []
  let requiredAction = 'COMMERCIAL_EDIT'
  if (feedbackLine.result !== 'CHANGE_REQUESTED') {
    domains.add('COMMERCIAL_OFFER')
    reasons.push(`OUTCOME_${feedbackLine.result}`)
    return { affected_domains: [...domains], reason_codes: reasons, required_action: requiredAction }
  }
  if (feedbackLine.requested_execution_text) {
    domains.add('SOURCING'); domains.add('PRICING')
    reasons.push('EXECUTION_CHANGE')
    requiredAction = 'UPSTREAM_REVISION_REQUIRED'
  }
  if (feedbackLine.requested_quantity != null && Number(feedbackLine.requested_quantity) !== Number(offerLine.offered_quantity)) {
    domains.add('SOURCING'); domains.add('PRICING')
    reasons.push('QUANTITY_CHANGE')
    requiredAction = 'UPSTREAM_REVISION_REQUIRED'
  }
  if (feedbackLine.requested_delivery_days != null && Number(feedbackLine.requested_delivery_days) < Number(offerLine.client_delivery_commitment_days ?? Number.MAX_SAFE_INTEGER)) {
    domains.add('COMMERCIAL_OFFER')
    reasons.push('SHORTER_DELIVERY_COMMITMENT')
    if (requiredAction !== 'UPSTREAM_REVISION_REQUIRED') requiredAction = 'APPROVAL_REQUIRED'
  }
  if (feedbackLine.requested_unit_price != null) {
    domains.add('COMMERCIAL_OFFER')
    const authority = priceAuthority(offerLine, feedbackLine.requested_unit_price)
    reasons.push(`PRICE_${authority}`)
    if (authority === 'PRICING_REEVALUATION_REQUIRED') {
      domains.add('PRICING')
      requiredAction = 'UPSTREAM_REVISION_REQUIRED'
    } else if (authority === 'APPROVAL_REQUIRED' && requiredAction !== 'UPSTREAM_REVISION_REQUIRED') {
      requiredAction = 'APPROVAL_REQUIRED'
    }
  }
  if (!domains.size) {
    domains.add('COMMERCIAL_OFFER')
    reasons.push('COMMERCIAL_TEXT_OR_TERMS')
  }
  return { affected_domains: [...domains], reason_codes: reasons, required_action: requiredAction }
}

module.exports = {
  DISCLOSURE_POLICIES,
  assessFeedbackChange,
  defaultDisclosurePolicy,
  findRestrictedClientPayload,
  priceAuthority,
}
