const { ContractDomainError } = require('./domainError')

const IMPACT_RULES = {
  LEGAL_TEXT: { affected_domains: ['CONTRACT'], reason_codes: ['LEGAL_TEXT_CHANGE'], required_action: 'LOCAL_LEGAL_REVIEW', approval_required: true },
  CLAUSE: { affected_domains: ['CONTRACT'], reason_codes: ['CLAUSE_CHANGE'], required_action: 'LOCAL_LEGAL_REVIEW', approval_required: true },
  PARTY: { affected_domains: ['CLIENT_MASTER','CONTRACT'], reason_codes: ['LEGAL_PARTY_CHANGE'], required_action: 'MASTER_DATA_RECONFIRMATION_REQUIRED', approval_required: true },
  PRICE: { affected_domains: ['COMMERCIAL_OFFER','PRICING'], reason_codes: ['PRICE_CHANGE'], required_action: 'UPSTREAM_REVISION_REQUIRED', approval_required: false },
  QUANTITY: { affected_domains: ['COMMERCIAL_OFFER','SOURCING','PRICING'], reason_codes: ['QUANTITY_CHANGE'], required_action: 'UPSTREAM_REVISION_REQUIRED', approval_required: false },
  EXECUTION: { affected_domains: ['COMMERCIAL_OFFER','SOURCING','PRICING'], reason_codes: ['EXECUTION_CHANGE'], required_action: 'UPSTREAM_REVISION_REQUIRED', approval_required: false },
  DELIVERY: { affected_domains: ['COMMERCIAL_OFFER','SOURCING','PRICING'], reason_codes: ['DELIVERY_CHANGE'], required_action: 'UPSTREAM_REVISION_REQUIRED', approval_required: false },
  DESTINATION: { affected_domains: ['COMMERCIAL_OFFER','SOURCING','PRICING'], reason_codes: ['DESTINATION_CHANGE'], required_action: 'UPSTREAM_REVISION_REQUIRED', approval_required: false },
  PAYMENT: { affected_domains: ['COMMERCIAL_OFFER','PRICING'], reason_codes: ['PAYMENT_CHANGE'], required_action: 'UPSTREAM_REVISION_REQUIRED', approval_required: false },
}

function resolveChangeImpact(change = {}) {
  const type = String(change.change_type || '').trim().toUpperCase()
  const rule = IMPACT_RULES[type]
  if (!rule) return {
    affected_domains: ['CONTRACT'],
    reason_codes: ['UNCLASSIFIED_CHANGE'],
    required_action: 'MANUAL_IMPACT_ASSESSMENT_REQUIRED',
    approval_required: true,
  }
  return { ...rule, affected_domains: [...rule.affected_domains], reason_codes: [...rule.reason_codes] }
}

function requiredSignatureRoles(legalForm) {
  return ['PURCHASE_ORDER_ACCEPTANCE','SIGNED_QUOTATION'].includes(legalForm) ? ['CLIENT'] : ['COMPANY','CLIENT']
}

function assertDraftEditable(revision) {
  if (revision.status !== 'DRAFT') {
    throw new ContractDomainError('REVISION_IMMUTABLE', 'Released, externally sent, signed and effective revisions are immutable', 409)
  }
}

module.exports = { assertDraftEditable, requiredSignatureRoles, resolveChangeImpact }
