const db = require('../../utils/db')
const { ContractDomainError } = require('./domainError')
const { parseJson, sha256, toId } = require('./helpers')
const { requiredSignatureRoles } = require('./policy')

const JSON_FIELDS = {
  revision: ['commercial_snapshot_json','client_snapshot_json','client_contact_snapshot_json','billing_address_snapshot_json','shipping_address_snapshot_json','client_bank_snapshot_json','company_legal_snapshot_json'],
  line: ['identity_snapshot_json','execution_snapshot_json','client_representation_snapshot_json','upstream_trace_snapshot_json'],
  term: ['value_json','baseline_json'],
  deviation: ['baseline_json','proposed_json','affected_domains_json','reason_codes_json'],
  approval: ['requested_value_json','baseline_value_json','risk_snapshot_json'],
  send: ['recipients_json'],
  commitment: ['party_snapshot_json','subject_snapshot_json','delivery_snapshot_json','payment_snapshot_json','legal_terms_snapshot_json','upstream_trace_snapshot_json','readiness_reasons_json'],
  event: ['payload_json'],
}

const parseFields = (row, fields = []) => fields.reduce((result, field) => {
  result[field] = parseJson(row[field], {})
  return result
}, { ...row })

async function loadRevision(revisionIdInput, executor = db, lock = false) {
  const revisionId = toId(revisionIdInput)
  const [[revision]] = await executor.execute(
    `SELECT r.*,c.contract_number,c.aggregate_status,c.current_revision_id,c.client_id,c.owner_user_id
       FROM contract_revisions r JOIN contract_cases c ON c.id=r.contract_case_id
      WHERE r.id=?${lock ? ' FOR UPDATE' : ''}`, [revisionId]
  )
  if (!revision) throw new ContractDomainError('REVISION_NOT_FOUND', 'Contract Revision не найдена', 404)
  return parseFields(revision, JSON_FIELDS.revision)
}

async function loadRevisionParts(revisionId, executor = db) {
  const [lines,terms,clauses,deviations,approvals,documents,sends,signatures] = await Promise.all([
    executor.execute('SELECT * FROM contract_lines WHERE contract_revision_id=? ORDER BY sort_order,line_number,id', [revisionId]).then(([rows]) => rows.map((row) => parseFields(row,JSON_FIELDS.line))),
    executor.execute('SELECT * FROM contract_terms WHERE contract_revision_id=? ORDER BY term_type,id', [revisionId]).then(([rows]) => rows.map((row) => parseFields(row,JSON_FIELDS.term))),
    executor.execute('SELECT * FROM contract_clauses WHERE contract_revision_id=? ORDER BY sort_order,id', [revisionId]).then(([rows]) => rows),
    executor.execute('SELECT * FROM contract_deviations WHERE contract_revision_id=? ORDER BY created_at,id', [revisionId]).then(([rows]) => rows.map((row) => parseFields(row,JSON_FIELDS.deviation))),
    executor.execute('SELECT * FROM contract_approvals WHERE contract_revision_id=? ORDER BY submitted_at,id', [revisionId]).then(([rows]) => rows.map((row) => parseFields(row,JSON_FIELDS.approval))),
    executor.execute('SELECT id,contract_revision_id,document_type,generation_number,format,template_reference,template_version,file_reference,document_hash,evidence_reference,idempotency_key,registered_by_user_id,registered_at FROM contract_documents WHERE contract_revision_id=? ORDER BY registered_at,id', [revisionId]).then(([rows]) => rows),
    executor.execute('SELECT * FROM contract_external_sends WHERE contract_revision_id=? ORDER BY sent_at,id', [revisionId]).then(([rows]) => rows.map((row) => parseFields(row,JSON_FIELDS.send))),
    executor.execute('SELECT * FROM contract_signatures WHERE contract_revision_id=? ORDER BY signed_at,id', [revisionId]).then(([rows]) => rows),
  ])
  return { lines,terms,clauses,deviations,approvals,documents,sends,signatures }
}

function buildPreviewPayload(revision, parts) {
  const termMap = Object.fromEntries(parts.terms.map((term) => [term.term_type,term.value_json]))
  return {
    contract_number: revision.contract_number,
    revision_number: revision.revision_number,
    legal_form: revision.legal_form,
    template: { reference: revision.template_reference, version: revision.template_version },
    company: revision.company_legal_snapshot_json,
    client: revision.client_snapshot_json,
    client_contact: revision.client_contact_snapshot_json,
    billing_address: revision.billing_address_snapshot_json,
    shipping_address: revision.shipping_address_snapshot_json,
    client_bank: revision.client_bank_snapshot_json,
    subject: parts.lines.filter((line) => line.line_status === 'ACTIVE').map((line) => ({
      line_number: line.line_number,
      identity: line.identity_snapshot_json,
      client_representation: line.client_representation_snapshot_json,
      quantity: line.quantity,
      uom: line.uom,
      unit_price: line.unit_price,
      currency: line.currency,
      line_total: line.line_total,
      delivery_commitment_days: line.delivery_commitment_days,
    })),
    commercial_terms: termMap,
    legal_clauses: parts.clauses.filter((clause) => clause.clause_status === 'ACTIVE').map((clause) => ({
      type: clause.clause_type,title: clause.title,text: clause.clause_text,risk_level: clause.risk_level,is_material: Boolean(clause.is_material),
    })),
  }
}

async function buildPreview(revisionIdInput, executor = db) {
  const revision = await loadRevision(revisionIdInput,executor)
  const parts = await loadRevisionParts(revision.id,executor)
  const payload = buildPreviewPayload(revision,parts)
  return { revision,parts,payload,content_hash: sha256(payload) }
}

async function evaluateReadiness(revisionIdInput, executor = db) {
  const preview = await buildPreview(revisionIdInput,executor)
  const { revision,parts } = preview
  const blockers = []
  const warnings = []
  const activeLines = parts.lines.filter((line) => line.line_status === 'ACTIVE')
  if (!activeLines.length) blockers.push({ code: 'NO_ACTIVE_CONTRACT_LINES' })
  if (revision.client_snapshot_json?.available !== true || !revision.client_snapshot_json?.company_name) blockers.push({ code: 'CLIENT_LEGAL_IDENTITY_MISSING' })
  if (revision.company_legal_snapshot_json?.available !== true || !(revision.company_legal_snapshot_json?.full_name_ru || revision.company_legal_snapshot_json?.short_name_ru)) blockers.push({ code: 'COMPANY_LEGAL_IDENTITY_MISSING' })
  const termTypes = new Set(parts.terms.filter((term) => {
    const value = term.value_json || {}
    if (value.value != null && String(value.value).trim()) return true
    return term.term_type === 'PAYMENT' && Boolean(value.due_date || value.mode || value.display_terms)
  }).map((term) => term.term_type))
  for (const type of ['PAYMENT','INCOTERMS','DESTINATION','DELIVERY']) if (!termTypes.has(type)) blockers.push({ code: 'MANDATORY_TERM_MISSING',term_type: type })
  if (!parts.clauses.some((clause) => clause.clause_status === 'ACTIVE')) blockers.push({ code: 'NO_ACTIVE_LEGAL_CLAUSES' })
  if (parts.deviations.some((item) => Boolean(item.is_blocking) && !['APPROVED','RESOLVED','WITHDRAWN'].includes(item.status))) blockers.push({ code: 'BLOCKING_DEVIATION' })
  if (parts.approvals.some((item) => ['SUBMITTED','RETURNED'].includes(item.status))) blockers.push({ code: 'UNRESOLVED_APPROVALS' })
  if (parts.approvals.some((item) => item.status === 'REJECTED')) blockers.push({ code: 'REJECTED_APPROVAL_PRESENT' })
  if (activeLines.some((line) => line.uom === 'UNSPECIFIED')) warnings.push({ code: 'UOM_UNAVAILABLE_IN_ACCEPTED_INPUT' })
  if (revision.client_contact_snapshot_json?.available !== true) warnings.push({ code: 'CLIENT_CONTACT_UNAVAILABLE' })
  if (revision.client_bank_snapshot_json?.available !== true) warnings.push({ code: 'CLIENT_BANK_UNAVAILABLE' })
  const requiredRoles = requiredSignatureRoles(revision.legal_form)
  const verifiedRoles = new Set(parts.signatures.filter((item) => item.verification_state === 'VERIFIED').map((item) => item.party_role))
  return {
    ready: blockers.length === 0,
    blockers,warnings,
    checks: {
      active_lines: activeLines.length,
      active_clauses: parts.clauses.filter((clause) => clause.clause_status === 'ACTIVE').length,
      required_signature_roles: requiredRoles,
      verified_signature_roles: [...verifiedRoles],
      signed_document_present: parts.documents.some((item) => item.document_type === 'SIGNED_EXECUTED'),
    },
    content_hash: preview.content_hash,
  }
}

function nextAction(status) {
  return ({
    DRAFT: 'COMPLETE_DRAFT',INTERNAL_REVIEW: 'GENERATE_AND_SEND',EXTERNAL_REVIEW: 'CONFIRM_SIGNATURE_READINESS',
    READY_FOR_SIGNATURE: 'REGISTER_SIGNATURES',PARTIALLY_SIGNED: 'REGISTER_REMAINING_SIGNATURES',SIGNED: 'MAKE_EFFECTIVE',
    EFFECTIVE: 'HANDOFF_COMMITMENTS',
  })[status] || null
}

async function listCases(query = {}) {
  const conditions = []
  const params = []
  if (query.status) { conditions.push('c.aggregate_status=?'); params.push(String(query.status)) }
  if (query.owner_user_id) { conditions.push('c.owner_user_id=?'); params.push(toId(query.owner_user_id)) }
  const [rows] = await db.execute(
    `SELECT c.*,cl.company_name AS client_name,r.revision_number AS current_revision_number,r.status AS current_revision_status,
            COUNT(DISTINCT l.id) AS line_count,COUNT(DISTINCT CASE WHEN a.status='SUBMITTED' THEN a.id END) AS pending_approval_count
       FROM contract_cases c JOIN clients cl ON cl.id=c.client_id
       LEFT JOIN contract_revisions r ON r.id=c.current_revision_id
       LEFT JOIN contract_lines l ON l.contract_revision_id=r.id AND l.line_status='ACTIVE'
       LEFT JOIN contract_approvals a ON a.contract_revision_id=r.id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC`,params
  )
  return rows.map((row) => ({ ...row,next_action: nextAction(row.aggregate_status) }))
}

async function getWorkspace(caseIdInput) {
  const caseId = toId(caseIdInput)
  const [[contractCase]] = await db.execute(
    `SELECT c.*,cl.company_name AS client_name,u.full_name AS owner_name,ar.acceptance_hash,ar.acceptance_evidence_reference,ar.accepted_at
       FROM contract_cases c JOIN clients cl ON cl.id=c.client_id
       JOIN commercial_accepted_revisions ar ON ar.id=c.source_commercial_acceptance_id
       LEFT JOIN users u ON u.id=c.owner_user_id WHERE c.id=?`,[caseId]
  )
  if (!contractCase) throw new ContractDomainError('CONTRACT_CASE_NOT_FOUND','Contract Case не найден',404)
  const [revisions,commitments,events] = await Promise.all([
    db.execute('SELECT id FROM contract_revisions WHERE contract_case_id=? ORDER BY revision_number',[caseId]).then(([rows]) => Promise.all(rows.map(async ({ id }) => {
      const revision = await loadRevision(id)
      return { ...revision,...await loadRevisionParts(id) }
    }))),
    db.execute('SELECT * FROM contract_commitments WHERE contract_case_id=? ORDER BY id',[caseId]).then(([rows]) => rows.map((row) => parseFields(row,JSON_FIELDS.commitment))),
    db.execute('SELECT e.*,u.full_name AS actor_name FROM contract_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.contract_case_id=? ORDER BY e.created_at,e.id',[caseId]).then(([rows]) => rows.map((row) => parseFields(row,JSON_FIELDS.event))),
  ])
  return {
    contract_case: { ...contractCase,next_action: nextAction(contractCase.aggregate_status) },
    revisions,commitments,history: events,
    boundaries: { canonical_input: 'commercial_accepted_revisions',supplier_execution: 'not_loaded',accounting: 'not_owned',commitments_are_handoff: true },
  }
}

async function compareRevisions(caseIdInput,fromInput,toInput) {
  const caseId = toId(caseIdInput)
  const [from,to] = await Promise.all([buildPreview(fromInput),buildPreview(toInput)])
  if (Number(from.revision.contract_case_id) !== caseId || Number(to.revision.contract_case_id) !== caseId) throw new ContractDomainError('REVISION_SCOPE_MISMATCH','Revision не принадлежит Contract Case',409)
  const keys = new Set([...Object.keys(from.payload.commercial_terms),...Object.keys(to.payload.commercial_terms)])
  const termChanges = [...keys].filter((key) => JSON.stringify(from.payload.commercial_terms[key]) !== JSON.stringify(to.payload.commercial_terms[key])).map((key) => ({ term_type:key,from:from.payload.commercial_terms[key] ?? null,to:to.payload.commercial_terms[key] ?? null }))
  return { from_revision_id:from.revision.id,to_revision_id:to.revision.id,from_hash:from.content_hash,to_hash:to.content_hash,changed:from.content_hash !== to.content_hash,term_changes }
}

async function listCommitments(caseIdInput) {
  const caseId = toId(caseIdInput)
  const [rows] = await db.execute('SELECT * FROM contract_commitments WHERE contract_case_id=? ORDER BY id',[caseId])
  return rows.map((row) => parseFields(row,JSON_FIELDS.commitment))
}

async function listAcceptedCommercialIntake() {
  const [rows] = await db.execute(
    `SELECT ar.id, ar.accepted_at, ar.aggregate_total, ar.currency,
            o.offer_number, c.company_name AS client_name, cr.internal_number AS request_number,
            COUNT(al.id) AS line_count, cc.contract_number
       FROM commercial_accepted_revisions ar
       JOIN commercial_offers o ON o.id=ar.commercial_offer_id
       JOIN clients c ON c.id=o.client_id
       JOIN client_requests cr ON cr.id=o.client_request_id
       LEFT JOIN commercial_accepted_lines al ON al.accepted_commercial_revision_id=ar.id
       LEFT JOIN contract_cases cc ON cc.source_commercial_acceptance_id=ar.id
      WHERE ar.status='FIXED'
      GROUP BY ar.id,o.offer_number,c.company_name,cr.internal_number,cc.contract_number
      ORDER BY ar.accepted_at DESC,ar.id DESC`
  )
  return rows
}

module.exports = { buildPreview, compareRevisions, evaluateReadiness, getWorkspace, listAcceptedCommercialIntake, listCases, listCommitments, loadRevision, loadRevisionParts }
