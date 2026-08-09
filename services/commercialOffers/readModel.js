const db = require('../../utils/db')
const { CommercialOfferDomainError } = require('./domainError')
const { parseJson, sha256, toId } = require('./helpers')
const { findRestrictedClientPayload, priceAuthority } = require('./policy')

const JSON_FIELDS = {
  revision: ['payment_policy_snapshot_json','client_snapshot_json','client_contact_snapshot_json','billing_address_snapshot_json','shipping_address_snapshot_json','company_legal_snapshot_json'],
  line: ['requested_identity_snapshot_json','offered_execution_snapshot_json','pricing_client_projection_snapshot_json','source_trace_snapshot_json'],
  approval: ['requested_value_json','baseline_value_json','threshold_value_json'],
  document: ['client_payload_json'],
  sent: ['snapshot_payload_json','recipients_json'],
  impact: ['affected_domains_json','reason_codes_json','input_change_snapshot_json'],
  accepted: ['terms_snapshot_json'],
  acceptedLine: ['accepted_execution_snapshot_json','client_representation_snapshot_json'],
}

const parseFields = (row, fields) => fields.reduce((result, field) => {
  result[field] = parseJson(row[field], {})
  return result
}, { ...row })

async function listOffers(query = {}) {
  const conditions = []
  const params = []
  if (query.status) { conditions.push('o.aggregate_status=?'); params.push(query.status) }
  if (query.owner_user_id) { conditions.push('o.owner_user_id=?'); params.push(toId(query.owner_user_id)) }
  const [rows] = await db.execute(
    `SELECT o.*, c.company_name AS client_name, r.revision_number AS current_revision_number,
            r.status AS current_revision_status, r.currency,
            COUNT(DISTINCT l.id) AS line_count,
            COALESCE(SUM(CASE WHEN l.line_status='ACTIVE' THEN l.offered_quantity*l.offered_unit_price ELSE 0 END),0) AS aggregate_total,
            COUNT(DISTINCT CASE WHEN a.status='SUBMITTED' THEN a.id END) AS pending_approval_count
       FROM commercial_offers o
       JOIN clients c ON c.id=o.client_id
       LEFT JOIN commercial_offer_revisions r ON r.id=o.current_revision_id
       LEFT JOIN commercial_offer_lines l ON l.commercial_offer_revision_id=r.id
       LEFT JOIN commercial_approval_requests a ON a.commercial_offer_revision_id=r.id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      GROUP BY o.id ORDER BY o.updated_at DESC,o.id DESC`, params
  )
  return rows.map((row) => ({ ...row, next_action: nextAction(row) }))
}

async function listPricingDecisionIntake() {
  const [rows] = await db.execute(
    `SELECT pd.id, pd.revision_number, pd.created_at, pc.case_number AS pricing_case_number,
            cr.internal_number AS request_number, c.company_name AS client_name,
            COUNT(pdl.id) AS line_count, o.offer_number
       FROM pricing_decisions pd
       JOIN pricing_cases pc ON pc.id=pd.pricing_case_id
       JOIN client_requests cr ON cr.id=pc.client_request_id
       JOIN clients c ON c.id=cr.client_id
       LEFT JOIN pricing_decision_lines pdl ON pdl.pricing_decision_id=pd.id
       LEFT JOIN commercial_offers o ON o.source_pricing_decision_id=pd.id
      WHERE pd.status='FIXED'
      GROUP BY pd.id,pc.case_number,cr.internal_number,c.company_name,o.offer_number
      ORDER BY pd.created_at DESC,pd.id DESC`
  )
  return rows
}

function nextAction(row) {
  if (Number(row.pending_approval_count) > 0) return 'DECIDE_APPROVAL'
  if (row.aggregate_status === 'DRAFT') return 'COMPLETE_DRAFT'
  if (row.aggregate_status === 'INTERNAL_REVIEW') return 'RESOLVE_READINESS'
  if (row.aggregate_status === 'READY_TO_SEND') return 'ISSUE_OFFER'
  if (row.aggregate_status === 'AWAITING_CLIENT') return 'REGISTER_CLIENT_FEEDBACK'
  if (row.aggregate_status === 'CHANGE_REQUESTED') return 'ASSESS_CHANGE_IMPACT'
  if (row.aggregate_status === 'PARTIALLY_ACCEPTED') return 'CONTINUE_NEGOTIATION_OR_CONTRACT'
  if (row.aggregate_status === 'ACCEPTED') return 'HANDOFF_TO_CONTRACT'
  return null
}

async function loadRevision(revisionIdInput, executor = db, lock = false) {
  const revisionId = toId(revisionIdInput)
  const [[revision]] = await executor.execute(
    `SELECT r.*,o.offer_number,o.aggregate_status,o.client_id,o.client_request_id,o.current_revision_id
       FROM commercial_offer_revisions r JOIN commercial_offers o ON o.id=r.commercial_offer_id
      WHERE r.id=?${lock ? ' FOR UPDATE' : ''}`, [revisionId]
  )
  if (!revision) throw new CommercialOfferDomainError('REVISION_NOT_FOUND', 'Commercial Offer Revision не найдена', 404)
  return parseFields(revision, JSON_FIELDS.revision)
}

async function buildClientPreview(revisionIdInput, executor = db) {
  const revision = await loadRevision(revisionIdInput, executor)
  const [rows] = await executor.execute(
    `SELECT * FROM commercial_offer_lines
      WHERE commercial_offer_revision_id=? AND line_status='ACTIVE'
      ORDER BY sort_order,line_number,id`, [revision.id]
  )
  const lines = rows.map((row) => parseFields(row, JSON_FIELDS.line))
  const payload = {
    offer_number: revision.offer_number,
    revision_number: revision.revision_number,
    issuer_legal: revision.company_legal_snapshot_json,
    client: revision.client_snapshot_json,
    contact: revision.client_contact_snapshot_json,
    billing_address: revision.billing_address_snapshot_json,
    shipping_address: revision.shipping_address_snapshot_json,
    currency: revision.currency,
    validity_until: revision.validity_until,
    payment_terms: revision.payment_terms,
    payment_due_date: revision.payment_policy_snapshot_json?.due_date || null,
    incoterms: revision.incoterms,
    destination: revision.destination,
    delivery_commitment_days: revision.client_delivery_commitment_days,
    warranty_terms: revision.warranty_terms,
    packaging_terms: revision.packaging_terms,
    partial_delivery_terms: revision.partial_delivery_terms,
    general_text: revision.general_text,
    lines: lines.map((line) => ({
      line_number: line.line_number,
      part_number: line.client_display_part_number,
      description: line.client_display_description,
      fulfillment_type: line.fulfillment_type,
      disclosure_policy: line.disclosure_policy,
      quantity: line.offered_quantity,
      uom: line.uom,
      unit_price: line.offered_unit_price,
      line_total: (Number(line.offered_quantity) * Number(line.offered_unit_price)).toFixed(4),
      currency: revision.currency,
      delivery_commitment_days: line.client_delivery_commitment_days ?? revision.client_delivery_commitment_days,
    })),
  }
  const confidentialityFindings = findRestrictedClientPayload(payload)
  return { revision, lines, payload, payload_hash: sha256(payload), confidentiality_findings: confidentialityFindings }
}

async function evaluateReadiness(revisionIdInput, executor = db) {
  const preview = await buildClientPreview(revisionIdInput, executor)
  const { revision, lines } = preview
  const [approvalRows] = await executor.execute(
    'SELECT * FROM commercial_approval_requests WHERE commercial_offer_revision_id=? ORDER BY submitted_at,id',
    [revision.id]
  )
  const approvals = approvalRows.map((row) => parseFields(row, JSON_FIELDS.approval))
  const blockers = []
  const warnings = []
  if (!lines.length) blockers.push({ code: 'NO_ACTIVE_LINES' })
  for (const line of lines) {
    if (!String(line.client_display_description || '').trim()) blockers.push({ code: 'CLIENT_DESCRIPTION_MISSING', line_id: line.id })
    if (!(Number(line.offered_quantity) > 0)) blockers.push({ code: 'QUANTITY_INVALID', line_id: line.id })
    if (!(Number(line.offered_unit_price) >= 0)) blockers.push({ code: 'PRICE_INVALID', line_id: line.id })
    if (line.fulfillment_type !== 'EXACT_REQUESTED_ITEM' && line.disclosure_policy === 'SHOW_EXACT_EXECUTION') {
      blockers.push({ code: 'EQUIVALENT_DISCLOSURE_INVALID', line_id: line.id })
    }
    const authority = priceAuthority(line, line.offered_unit_price)
    const matchingApproval = approvals.find((approval) =>
      Number(approval.commercial_offer_line_id) === Number(line.id) &&
      approval.approval_type === 'PRICE' && approval.status === 'APPROVED' &&
      Number(approval.requested_value_json?.offered_unit_price) === Number(line.offered_unit_price)
    )
    if (authority === 'PRICING_REEVALUATION_REQUIRED') blockers.push({ code: 'PRICING_REEVALUATION_REQUIRED', line_id: line.id })
    if (authority === 'APPROVAL_REQUIRED' && !matchingApproval) blockers.push({ code: 'PRICE_APPROVAL_REQUIRED', line_id: line.id })
    if (line.disclosure_policy === 'CUSTOM_APPROVED_PRESENTATION') {
      const disclosureApproval = approvals.find((approval) => Number(approval.commercial_offer_line_id) === Number(line.id) && approval.approval_type === 'DISCLOSURE' && approval.status === 'APPROVED')
      if (!disclosureApproval) blockers.push({ code: 'DISCLOSURE_APPROVAL_REQUIRED', line_id: line.id })
    }
  }
  for (const field of ['validity_until','payment_terms','incoterms','destination','warranty_terms','partial_delivery_terms']) {
    if (!revision[field]) blockers.push({ code: 'TERM_REQUIRED', field })
  }
  if (!revision.payment_policy_snapshot_json?.due_date) blockers.push({ code: 'TERM_REQUIRED', field: 'payment_due_date' })
  if (revision.client_delivery_commitment_days == null) blockers.push({ code: 'DELIVERY_COMMITMENT_REQUIRED' })
  if (approvals.some((approval) => ['DRAFT','SUBMITTED','RETURNED'].includes(approval.status))) blockers.push({ code: 'UNRESOLVED_APPROVALS' })
  if (approvals.some((approval) => approval.status === 'REJECTED')) blockers.push({ code: 'REJECTED_APPROVAL_PRESENT' })
  blockers.push(...preview.confidentiality_findings.map((finding) => ({ code: 'CONFIDENTIALITY_VIOLATION', ...finding })))
  if (revision.company_legal_snapshot_json?.available === false) warnings.push({ code: 'COMPANY_LEGAL_PROFILE_UNAVAILABLE' })
  if (revision.client_contact_snapshot_json?.available === false) warnings.push({ code: 'CLIENT_CONTACT_UNAVAILABLE' })
  return { ready: blockers.length === 0, blockers, warnings, checks: {
    active_lines: lines.length,
    client_representation: lines.filter((line) => String(line.client_display_description || '').trim()).length,
    approvals_resolved: !approvals.some((approval) => ['DRAFT','SUBMITTED','RETURNED'].includes(approval.status)),
    confidentiality_findings: preview.confidentiality_findings.length,
  }, preview_hash: preview.payload_hash }
}

async function getWorkspace(offerIdInput) {
  const offerId = toId(offerIdInput)
  const [[offer]] = await db.execute(
    `SELECT o.*,c.company_name AS client_name,u.full_name AS owner_name,
            pd.revision_number AS pricing_decision_revision,pd.decision_hash AS pricing_decision_hash
       FROM commercial_offers o JOIN clients c ON c.id=o.client_id
       JOIN pricing_decisions pd ON pd.id=o.source_pricing_decision_id
       LEFT JOIN users u ON u.id=o.owner_user_id WHERE o.id=?`, [offerId]
  )
  if (!offer) throw new CommercialOfferDomainError('OFFER_NOT_FOUND', 'Commercial Offer не найден', 404)
  const [revisions, lines, approvals, documents, sent, feedback, feedbackLines, impacts, accepted, acceptedLines, history] = await Promise.all([
    db.execute('SELECT * FROM commercial_offer_revisions WHERE commercial_offer_id=? ORDER BY revision_number', [offerId]).then(([r]) => r.map((x) => parseFields(x, JSON_FIELDS.revision))),
    db.execute('SELECT l.* FROM commercial_offer_lines l JOIN commercial_offer_revisions r ON r.id=l.commercial_offer_revision_id WHERE r.commercial_offer_id=? ORDER BY r.revision_number,l.sort_order,l.line_number', [offerId]).then(([r]) => r.map((x) => parseFields(x, JSON_FIELDS.line))),
    db.execute('SELECT a.* FROM commercial_approval_requests a JOIN commercial_offer_revisions r ON r.id=a.commercial_offer_revision_id WHERE r.commercial_offer_id=? ORDER BY a.submitted_at,a.id', [offerId]).then(([r]) => r.map((x) => parseFields(x, JSON_FIELDS.approval))),
    db.execute('SELECT d.* FROM commercial_offer_document_generations d JOIN commercial_offer_revisions r ON r.id=d.commercial_offer_revision_id WHERE r.commercial_offer_id=? ORDER BY d.generated_at,d.id', [offerId]).then(([r]) => r.map((x) => { const safe = parseFields(x, JSON_FIELDS.document); delete safe.rendered_content; return safe })),
    db.execute('SELECT s.* FROM commercial_sent_offer_snapshots s JOIN commercial_offer_revisions r ON r.id=s.commercial_offer_revision_id WHERE r.commercial_offer_id=? ORDER BY s.sent_at,s.id', [offerId]).then(([r]) => r.map((x) => parseFields(x, JSON_FIELDS.sent))),
    db.execute('SELECT * FROM commercial_client_feedback WHERE commercial_offer_id=? ORDER BY received_at,id', [offerId]).then(([r]) => r),
    db.execute('SELECT fl.* FROM commercial_client_feedback_lines fl JOIN commercial_client_feedback f ON f.id=fl.client_feedback_id WHERE f.commercial_offer_id=? ORDER BY fl.id', [offerId]).then(([r]) => r),
    db.execute('SELECT i.* FROM commercial_change_impact_assessments i JOIN commercial_client_feedback f ON f.id=i.client_feedback_id WHERE f.commercial_offer_id=? ORDER BY i.assessed_at,i.id', [offerId]).then(([r]) => r.map((x) => parseFields(x, JSON_FIELDS.impact))),
    db.execute('SELECT * FROM commercial_accepted_revisions WHERE commercial_offer_id=? ORDER BY accepted_at,id', [offerId]).then(([r]) => r.map((x) => parseFields(x, JSON_FIELDS.accepted))),
    db.execute('SELECT al.* FROM commercial_accepted_lines al JOIN commercial_accepted_revisions ar ON ar.id=al.accepted_commercial_revision_id WHERE ar.commercial_offer_id=? ORDER BY al.id', [offerId]).then(([r]) => r.map((x) => parseFields(x, JSON_FIELDS.acceptedLine))),
    db.execute('SELECT e.*,u.full_name AS actor_name FROM commercial_offer_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.commercial_offer_id=? ORDER BY e.created_at,e.id', [offerId]).then(([r]) => r),
  ])
  return {
    offer: { ...offer, next_action: nextAction(offer) },
    revisions: revisions.map((revision) => ({ ...revision,
      lines: lines.filter((line) => Number(line.commercial_offer_revision_id) === Number(revision.id)),
      approvals: approvals.filter((approval) => Number(approval.commercial_offer_revision_id) === Number(revision.id)),
      documents: documents.filter((document) => Number(document.commercial_offer_revision_id) === Number(revision.id)),
      sent_snapshots: sent.filter((snapshot) => Number(snapshot.commercial_offer_revision_id) === Number(revision.id)),
    })),
    feedback: feedback.map((item) => ({ ...item,
      lines: feedbackLines.filter((line) => Number(line.client_feedback_id) === Number(item.id)),
      assessments: impacts.filter((impact) => Number(impact.client_feedback_id) === Number(item.id)),
    })),
    accepted_results: accepted.map((item) => ({ ...item, lines: acceptedLines.filter((line) => Number(line.accepted_commercial_revision_id) === Number(item.id)) })),
    history,
    projection: { supplier_identity: 'never_loaded', procurement_economics: 'never_loaded', client_preview: 'server_generated' },
  }
}

async function getAcceptedResult(offerIdInput) {
  const offerId = toId(offerIdInput)
  const [[accepted]] = await db.execute(
    `SELECT ar.*,o.offer_number FROM commercial_accepted_revisions ar
     JOIN commercial_offers o ON o.id=ar.commercial_offer_id
     WHERE ar.commercial_offer_id=? AND ar.status='FIXED' ORDER BY ar.accepted_at DESC,ar.id DESC LIMIT 1`, [offerId]
  )
  if (!accepted) throw new CommercialOfferDomainError('ACCEPTED_RESULT_NOT_FOUND', 'Accepted Commercial Revision не найдена', 404)
  const [lineRows] = await db.execute('SELECT * FROM commercial_accepted_lines WHERE accepted_commercial_revision_id=? ORDER BY id', [accepted.id])
  return {
    ...parseFields(accepted, JSON_FIELDS.accepted),
    lines: lineRows.map((row) => parseFields(row, JSON_FIELDS.acceptedLine)),
    contract_input: true,
    supplier_identity_included: false,
  }
}

module.exports = { buildClientPreview, evaluateReadiness, getAcceptedResult, getWorkspace, listOffers, listPricingDecisionIntake, loadRevision }
