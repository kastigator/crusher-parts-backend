const db = require('../../utils/db')
const { ContractDomainError } = require('./domainError')
const { addEvent, cleanText, parseJson, requireActor, requireIdempotencyKey, sha256, toId } = require('./helpers')
const { assertDraftEditable, requiredSignatureRoles, resolveChangeImpact } = require('./policy')
const { buildPreview, evaluateReadiness, loadRevision, loadRevisionParts } = require('./readModel')

const LEGAL_FORMS = new Set(['ONE_OFF_CONTRACT','FRAMEWORK_AGREEMENT','PURCHASE_ORDER_ACCEPTANCE','SIGNED_QUOTATION','OTHER'])
const LOCAL_LEGAL_TERMS = new Set(['GOVERNING_LAW','DISPUTE_RESOLUTION','LIABILITY','FORCE_MAJEURE','CONFIDENTIALITY','TERMINATION','GENERAL_LEGAL'])
const UPSTREAM_TERM_IMPACTS = {
  PAYMENT: 'PAYMENT',DELIVERY: 'DELIVERY',DESTINATION: 'DESTINATION',INCOTERMS: 'DELIVERY',PRICE: 'PRICE',QUANTITY: 'QUANTITY',EXECUTION: 'EXECUTION',
}
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g,(character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[character])

function snapshotOrUnavailable(value,source) {
  return value ? { available:true,source,...value } : { available:false,source }
}

async function withTransaction(fn) {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally { conn.release() }
}

async function createFromAcceptedCommercial(payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const acceptanceId = toId(payload.accepted_commercial_revision_id)
  const requestKey = requireIdempotencyKey(payload.request_key)
  if (!acceptanceId) throw new ContractDomainError('VALIDATION_ERROR','Укажите immutable Accepted Commercial Revision')
  const legalForm = String(payload.legal_form || 'ONE_OFF_CONTRACT').trim().toUpperCase()
  if (!LEGAL_FORMS.has(legalForm)) throw new ContractDomainError('LEGAL_FORM_INVALID','Недопустимая legal form')
  const templateReference = cleanText(payload.template_reference)
  const templateVersion = cleanText(payload.template_version)
  if (!templateReference || !templateVersion) throw new ContractDomainError('TEMPLATE_REQUIRED','Укажите template_reference и template_version')

  return withTransaction(async (conn) => {
    const [[existing]] = await conn.execute('SELECT id,contract_number,current_revision_id FROM contract_cases WHERE request_key=? FOR UPDATE',[requestKey])
    if (existing) return { contract_case_id:existing.id,contract_number:existing.contract_number,revision_id:existing.current_revision_id,already_exists:true }
    const [[accepted]] = await conn.execute(
      `SELECT ar.*,o.client_id
         FROM commercial_accepted_revisions ar JOIN commercial_offers o ON o.id=ar.commercial_offer_id
        WHERE ar.id=? FOR UPDATE`,[acceptanceId]
    )
    if (!accepted) throw new ContractDomainError('ACCEPTED_RESULT_NOT_FOUND','Accepted Commercial Revision не найдена',404)
    if (accepted.status !== 'FIXED' || !accepted.acceptance_hash) throw new ContractDomainError('ACCEPTED_RESULT_NOT_FIXED','Contract принимает только FIXED Accepted Commercial Revision',409)
    const [acceptedLines] = await conn.execute('SELECT * FROM commercial_accepted_lines WHERE accepted_commercial_revision_id=? ORDER BY id FOR UPDATE',[acceptanceId])
    if (!acceptedLines.length) throw new ContractDomainError('ACCEPTED_RESULT_EMPTY','Accepted Commercial Revision не содержит строк',409)
    const terms = parseJson(accepted.terms_snapshot_json)
    const [[bank]] = await conn.execute('SELECT * FROM client_bank_details WHERE client_id=? ORDER BY created_at DESC,id DESC LIMIT 1',[accepted.client_id])
    const allocationMap = new Map((Array.isArray(payload.allocations) ? payload.allocations : []).map((item) => [toId(item.accepted_line_id),Number(item.quantity)]))
    const selected = acceptedLines.map((line) => ({
      source:line,
      quantity:allocationMap.has(Number(line.id)) ? allocationMap.get(Number(line.id)) : Number(line.accepted_quantity),
    })).filter((item) => item.quantity > 0)
    if (!selected.length) throw new ContractDomainError('ALLOCATION_REQUIRED','Contract должен содержать хотя бы одну принятую строку')
    for (const item of selected) {
      const [[used]] = await conn.execute(
        `SELECT COALESCE(SUM(cl.quantity),0) AS allocated
           FROM contract_lines cl JOIN contract_revisions cr ON cr.id=cl.contract_revision_id
          WHERE cl.source_accepted_line_id=? AND cl.line_status='ACTIVE'`,[item.source.id]
      )
      if (Number(used.allocated) + item.quantity > Number(item.source.accepted_quantity) + 0.000001) {
        throw new ContractDomainError('ACCEPTED_QUANTITY_OVERALLOCATED','Contract allocation превышает accepted quantity',409,{ accepted_line_id:item.source.id,accepted_quantity:item.source.accepted_quantity,already_allocated:used.allocated,requested:item.quantity })
      }
    }
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(id),0)+1 AS next_number FROM contract_cases FOR UPDATE')
    const contractNumber = cleanText(payload.contract_number) || `CT-${String(sequence.next_number).padStart(6,'0')}`
    const [caseInsert] = await conn.execute(
      `INSERT INTO contract_cases
        (contract_number,client_id,source_commercial_acceptance_id,legal_form,template_reference,template_version,owner_user_id,request_key,created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [contractNumber,accepted.client_id,acceptanceId,legalForm,templateReference,templateVersion,toId(payload.owner_user_id) || actorId,requestKey,actorId]
    )
    const caseId = caseInsert.insertId
    const commercialSnapshot = {
      accepted_commercial_revision_id:accepted.id,commercial_offer_id:accepted.commercial_offer_id,
      accepted_offer_revision_id:accepted.accepted_offer_revision_id,accepted_sent_snapshot_id:accepted.accepted_sent_snapshot_id,
      client_feedback_id:accepted.client_feedback_id,acceptance_evidence_reference:accepted.acceptance_evidence_reference,
      accepted_at:accepted.accepted_at,accepted_by_external_text:accepted.accepted_by_external_text,
      aggregate_total:accepted.aggregate_total,currency:accepted.currency,terms_snapshot:terms,acceptance_hash:accepted.acceptance_hash,
    }
    const [revisionInsert] = await conn.execute(
      `INSERT INTO contract_revisions
        (contract_case_id,revision_number,source_commercial_acceptance_id,source_acceptance_hash,status,legal_form,
         template_reference,template_version,commercial_snapshot_json,client_snapshot_json,client_contact_snapshot_json,
         billing_address_snapshot_json,shipping_address_snapshot_json,client_bank_snapshot_json,company_legal_snapshot_json,created_by_user_id)
       VALUES (?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId,1,acceptanceId,accepted.acceptance_hash,legalForm,templateReference,templateVersion,JSON.stringify(commercialSnapshot),
        JSON.stringify(terms.client_snapshot || { available:false,source:'accepted_commercial_revision' }),
        JSON.stringify(terms.client_contact_snapshot || { available:false,source:'accepted_commercial_revision' }),
        JSON.stringify(terms.billing_address_snapshot || { available:false,source:'accepted_commercial_revision' }),
        JSON.stringify(terms.shipping_address_snapshot || { available:false,source:'accepted_commercial_revision' }),
        JSON.stringify(snapshotOrUnavailable(bank || null,'client_bank_details_at_contract_creation')),
        JSON.stringify(terms.company_legal_snapshot || { available:false,source:'accepted_commercial_revision' }),actorId]
    )
    const revisionId = revisionInsert.insertId
    for (let index=0;index<selected.length;index+=1) {
      const { source,quantity } = selected[index]
      const execution = parseJson(source.accepted_execution_snapshot_json)
      const representation = parseJson(source.client_representation_snapshot_json)
      const unitPrice = Number(source.accepted_unit_price)
      await conn.execute(
        `INSERT INTO contract_lines
          (contract_revision_id,source_accepted_line_id,line_number,identity_snapshot_json,execution_snapshot_json,
           client_representation_snapshot_json,upstream_trace_snapshot_json,quantity,uom,unit_price,currency,line_total,
           delivery_commitment_days,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [revisionId,source.id,index+1,JSON.stringify(execution.technical_identity || {}),JSON.stringify(execution),JSON.stringify(representation),
          JSON.stringify({ accepted_commercial_revision_id:accepted.id,acceptance_hash:accepted.acceptance_hash,accepted_line_id:source.id,source_offer_line_id:source.source_offer_line_id,source_pricing_decision_line_id:source.source_pricing_decision_line_id }),
          quantity,'UNSPECIFIED',unitPrice,source.currency,(quantity*unitPrice).toFixed(4),source.delivery_commitment_days,index+1]
      )
    }
    const baselineTerms = [
      ['PAYMENT',terms.payment_policy ? { ...terms.payment_policy, value: terms.payment_terms, display_terms: terms.payment_terms } : terms.payment_terms],['INCOTERMS',terms.incoterms],['DESTINATION',terms.destination],
      ['DELIVERY',terms.delivery_commitment_days],['WARRANTY',terms.warranty_terms],['PACKAGING',terms.packaging_terms],
      ['PARTIAL_DELIVERY',terms.partial_delivery_terms],['VALIDITY',terms.validity_until],
    ]
    for (const [type,value] of baselineTerms) {
      if (value == null || String(value).trim() === '') continue
      const snapshot = type === 'PAYMENT' && value && typeof value === 'object' ? value : { value }
      await conn.execute(
        `INSERT INTO contract_terms
          (contract_revision_id,term_type,value_json,baseline_json,source_type,source_reference)
         VALUES (?,?,?,?,?,?)`,[revisionId,type,JSON.stringify(snapshot),JSON.stringify(snapshot),'ACCEPTED_COMMERCIAL_REVISION',String(accepted.id)]
      )
    }
    for (const [index,clause] of (Array.isArray(payload.initial_clauses) ? payload.initial_clauses : []).entries()) {
      const text = cleanText(clause.text)
      if (!text) continue
      await conn.execute(
        `INSERT INTO contract_clauses
          (contract_revision_id,clause_type,title,template_clause_reference,template_clause_version,clause_text,risk_level,is_material,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [revisionId,cleanText(clause.type) || 'GENERAL',cleanText(clause.title) || `Clause ${index+1}`,cleanText(clause.template_clause_reference),cleanText(clause.template_clause_version),text,String(clause.risk_level || 'STANDARD').toUpperCase(),clause.is_material ? 1:0,index+1]
      )
    }
    await conn.execute('UPDATE contract_cases SET current_revision_id=? WHERE id=?',[revisionId,caseId])
    await addEvent(conn,caseId,'contract_case_created','commercial_accepted_revision',accepted.id,actorId,{ revision_id:revisionId,acceptance_hash:accepted.acceptance_hash,line_count:selected.length,legal_form:legalForm })
    return { contract_case_id:caseId,contract_number:contractNumber,revision_id:revisionId,revision_number:1,status:'DRAFT',line_count:selected.length,acceptance_hash:accepted.acceptance_hash }
  })
}

async function createRevision(caseIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const caseId = toId(caseIdInput)
  return withTransaction(async (conn) => {
    const [[contractCase]] = await conn.execute('SELECT * FROM contract_cases WHERE id=? FOR UPDATE',[caseId])
    if (!contractCase) throw new ContractDomainError('CONTRACT_CASE_NOT_FOUND','Contract Case не найден',404)
    const current = await loadRevision(contractCase.current_revision_id,conn,true)
    if (current.status === 'DRAFT') throw new ContractDomainError('DRAFT_ALREADY_CURRENT','Текущая revision уже редактируема',409)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(revision_number),0)+1 AS next_number FROM contract_revisions WHERE contract_case_id=? FOR UPDATE',[caseId])
    const [insert] = await conn.execute(
      `INSERT INTO contract_revisions
        (contract_case_id,revision_number,source_commercial_acceptance_id,source_acceptance_hash,supersedes_revision_id,status,
         legal_form,template_reference,template_version,commercial_snapshot_json,client_snapshot_json,client_contact_snapshot_json,
         billing_address_snapshot_json,shipping_address_snapshot_json,client_bank_snapshot_json,company_legal_snapshot_json,created_by_user_id)
       VALUES (?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId,sequence.next_number,current.source_commercial_acceptance_id,current.source_acceptance_hash,current.id,
        current.legal_form,cleanText(payload.template_reference) || current.template_reference,cleanText(payload.template_version) || current.template_version,
        JSON.stringify(current.commercial_snapshot_json),JSON.stringify(current.client_snapshot_json),JSON.stringify(current.client_contact_snapshot_json),
        JSON.stringify(current.billing_address_snapshot_json),JSON.stringify(current.shipping_address_snapshot_json),JSON.stringify(current.client_bank_snapshot_json),JSON.stringify(current.company_legal_snapshot_json),actorId]
    )
    const revisionId = insert.insertId
    await conn.execute(
      `INSERT INTO contract_lines
        (contract_revision_id,source_accepted_line_id,line_number,identity_snapshot_json,execution_snapshot_json,client_representation_snapshot_json,
         upstream_trace_snapshot_json,quantity,uom,unit_price,currency,line_total,delivery_commitment_days,line_status,sort_order)
       SELECT ?,source_accepted_line_id,line_number,identity_snapshot_json,execution_snapshot_json,client_representation_snapshot_json,
              upstream_trace_snapshot_json,quantity,uom,unit_price,currency,line_total,delivery_commitment_days,line_status,sort_order
         FROM contract_lines WHERE contract_revision_id=?`,[revisionId,current.id]
    )
    await conn.execute(
      `INSERT INTO contract_terms
        (contract_revision_id,term_type,value_json,baseline_json,source_type,source_reference,deviation_state,approval_state)
       SELECT ?,term_type,value_json,value_json,'PRIOR_CONTRACT_REVISION',?, 'UNCHANGED','NOT_REQUIRED'
         FROM contract_terms WHERE contract_revision_id=?`,[revisionId,String(current.id),current.id]
    )
    await conn.execute(
      `INSERT INTO contract_clauses
        (contract_revision_id,clause_type,title,template_clause_reference,template_clause_version,clause_text,risk_level,is_material,clause_status,sort_order)
       SELECT ?,clause_type,title,template_clause_reference,template_clause_version,clause_text,risk_level,is_material,clause_status,sort_order
         FROM contract_clauses WHERE contract_revision_id=?`,[revisionId,current.id]
    )
    await conn.execute("UPDATE contract_cases SET current_revision_id=?,aggregate_status='DRAFT',row_version=row_version+1 WHERE id=?",[revisionId,caseId])
    await addEvent(conn,caseId,'contract_revision_created','contract_revision',revisionId,actorId,{ supersedes_revision_id:current.id,reason:cleanText(payload.reason) })
    return { contract_case_id:caseId,revision_id:revisionId,revision_number:Number(sequence.next_number),status:'DRAFT' }
  })
}

async function patchRevision(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    assertDraftEditable(revision)
    if (payload.row_version != null && Number(payload.row_version) !== Number(revision.row_version)) throw new ContractDomainError('REVISION_CONFLICT','Revision была изменена другим пользователем',409)
    const fields=[]; const values=[]
    for (const field of ['template_reference','template_version']) if (Object.prototype.hasOwnProperty.call(payload,field)) { const value=cleanText(payload[field]); if (!value) throw new ContractDomainError('VALIDATION_ERROR',`${field} не может быть пустым`); fields.push(`${field}=?`); values.push(value) }
    if (!fields.length) throw new ContractDomainError('NO_CHANGES','Нет разрешённых изменений')
    await conn.execute(`UPDATE contract_revisions SET ${fields.join(',')},row_version=row_version+1 WHERE id=?`,[...values,revision.id])
    await addEvent(conn,revision.contract_case_id,'contract_revision_updated','contract_revision',revision.id,actorId,{ fields:fields.map((field) => field.split('=')[0]) })
    return { revision_id:revision.id,updated:true,row_version:Number(revision.row_version)+1 }
  })
}

async function upsertTerm(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const termType = String(payload.term_type || '').trim().toUpperCase()
  if (!termType) throw new ContractDomainError('TERM_TYPE_REQUIRED','Укажите term_type')
  if (UPSTREAM_TERM_IMPACTS[termType]) {
    const impact = resolveChangeImpact({ change_type:UPSTREAM_TERM_IMPACTS[termType] })
    throw new ContractDomainError('UPSTREAM_REVISION_REQUIRED','Коммерческое условие нельзя переписать внутри Contract',409,impact)
  }
  if (!LOCAL_LEGAL_TERMS.has(termType)) throw new ContractDomainError('TERM_TYPE_UNSUPPORTED','Используйте поддерживаемый legal term_type')
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    assertDraftEditable(revision)
    const value = { value:payload.value ?? null }
    const [[current]] = await conn.execute('SELECT * FROM contract_terms WHERE contract_revision_id=? AND term_type=? FOR UPDATE',[revision.id,termType])
    if (current) {
      const baseline = parseJson(current.baseline_json)
      await conn.execute("UPDATE contract_terms SET value_json=?,deviation_state='CHANGED',approval_state='REQUIRED' WHERE id=?",[JSON.stringify(value),current.id])
      await createDeviationRecord(conn,revision,actorId,{ object_type:'TERM',object_id:current.id,category:termType,baseline,proposed:value,...resolveChangeImpact({ change_type:'LEGAL_TEXT' }),evidence_reference:payload.evidence_reference })
      await addEvent(conn,revision.contract_case_id,'contract_term_changed','contract_term',current.id,actorId,{ term_type:termType })
      return { term_id:current.id,created:false,approval_required:true }
    }
    const [insert] = await conn.execute(
      `INSERT INTO contract_terms
        (contract_revision_id,term_type,value_json,baseline_json,source_type,source_reference,deviation_state,approval_state)
       VALUES (?,?,?,?,? ,?,'ADDED','REQUIRED')`,[revision.id,termType,JSON.stringify(value),JSON.stringify({}), 'CONTRACT_LEGAL_DRAFT',cleanText(payload.source_reference)]
    )
    await createDeviationRecord(conn,revision,actorId,{ object_type:'TERM',object_id:insert.insertId,category:termType,baseline:{},proposed:value,...resolveChangeImpact({ change_type:'LEGAL_TEXT' }),evidence_reference:payload.evidence_reference })
    await addEvent(conn,revision.contract_case_id,'contract_term_added','contract_term',insert.insertId,actorId,{ term_type:termType })
    return { term_id:insert.insertId,created:true,approval_required:true }
  })
}

async function addClause(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const text = cleanText(payload.text)
  if (!text) throw new ContractDomainError('CLAUSE_TEXT_REQUIRED','Текст clause обязателен')
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    assertDraftEditable(revision)
    const risk = String(payload.risk_level || 'STANDARD').toUpperCase()
    const [insert] = await conn.execute(
      `INSERT INTO contract_clauses
        (contract_revision_id,clause_type,title,template_clause_reference,template_clause_version,clause_text,risk_level,is_material,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [revision.id,cleanText(payload.clause_type) || 'GENERAL',cleanText(payload.title) || 'General clause',cleanText(payload.template_clause_reference),cleanText(payload.template_clause_version),text,risk,payload.is_material?1:0,Number(payload.sort_order)||0]
    )
    const requiresApproval = Boolean(payload.is_material) || !['STANDARD','LOW'].includes(risk)
    if (requiresApproval) await createDeviationRecord(conn,revision,actorId,{ object_type:'CLAUSE',object_id:insert.insertId,category:'CLAUSE',baseline:{},proposed:{ text,risk_level:risk },...resolveChangeImpact({ change_type:'CLAUSE' }),evidence_reference:payload.evidence_reference })
    await addEvent(conn,revision.contract_case_id,'contract_clause_added','contract_clause',insert.insertId,actorId,{ risk_level:risk,approval_required:requiresApproval })
    return { clause_id:insert.insertId,approval_required:requiresApproval }
  })
}

async function patchClause(clauseIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const clauseId = toId(clauseIdInput)
  return withTransaction(async (conn) => {
    const [[clause]] = await conn.execute('SELECT * FROM contract_clauses WHERE id=? FOR UPDATE',[clauseId])
    if (!clause) throw new ContractDomainError('CLAUSE_NOT_FOUND','Clause не найден',404)
    const revision = await loadRevision(clause.contract_revision_id,conn,true)
    assertDraftEditable(revision)
    const next = {
      title:Object.prototype.hasOwnProperty.call(payload,'title') ? cleanText(payload.title) : clause.title,
      text:Object.prototype.hasOwnProperty.call(payload,'text') ? cleanText(payload.text) : clause.clause_text,
      risk:String(payload.risk_level || clause.risk_level).toUpperCase(),
      material:Object.prototype.hasOwnProperty.call(payload,'is_material') ? Boolean(payload.is_material) : Boolean(clause.is_material),
      status:payload.clause_status || clause.clause_status,
    }
    if (!next.title || !next.text) throw new ContractDomainError('VALIDATION_ERROR','Title и clause text обязательны')
    await conn.execute('UPDATE contract_clauses SET title=?,clause_text=?,risk_level=?,is_material=?,clause_status=? WHERE id=?',[next.title,next.text,next.risk,next.material?1:0,next.status,clause.id])
    await createDeviationRecord(conn,revision,actorId,{ object_type:'CLAUSE',object_id:clause.id,category:'CLAUSE',baseline:{ title:clause.title,text:clause.clause_text,risk_level:clause.risk_level },proposed:next,...resolveChangeImpact({ change_type:'CLAUSE' }),evidence_reference:payload.evidence_reference })
    await addEvent(conn,revision.contract_case_id,'contract_clause_changed','contract_clause',clause.id,actorId,{})
    return { clause_id:clause.id,updated:true,approval_required:true }
  })
}

async function createDeviationRecord(conn,revision,actorId,input) {
  const [insert] = await conn.execute(
    `INSERT INTO contract_deviations
      (contract_revision_id,object_type,object_id,category,baseline_json,proposed_json,affected_domains_json,reason_codes_json,
       required_action,status,is_blocking,approval_required,evidence_reference,resolver_version,created_by_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?)`,
    [revision.id,input.object_type || 'REVISION',toId(input.object_id),input.category || 'UNCLASSIFIED',JSON.stringify(input.baseline || {}),JSON.stringify(input.proposed || {}),
      JSON.stringify(input.affected_domains || []),JSON.stringify(input.reason_codes || []),input.required_action,input.required_action === 'UPSTREAM_REVISION_REQUIRED' ? 1:1,
      input.approval_required?1:0,cleanText(input.evidence_reference),'contract-impact-v1',actorId]
  )
  return insert.insertId
}

async function analyzeImpact(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    assertDraftEditable(revision)
    const impact = resolveChangeImpact(payload)
    const deviationId = await createDeviationRecord(conn,revision,actorId,{ object_type:payload.object_type || 'REVISION',object_id:payload.object_id,category:String(payload.change_type || 'UNCLASSIFIED').toUpperCase(),baseline:payload.baseline,proposed:payload.proposed,...impact,evidence_reference:payload.evidence_reference })
    await addEvent(conn,revision.contract_case_id,'contract_change_impact_assessed','contract_deviation',deviationId,actorId,impact)
    return { deviation_id:deviationId,...impact }
  })
}

async function requestApproval(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const deviationId = toId(payload.deviation_id)
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    assertDraftEditable(revision)
    const [[deviation]] = await conn.execute('SELECT * FROM contract_deviations WHERE id=? AND contract_revision_id=? FOR UPDATE',[deviationId,revision.id])
    if (!deviation) throw new ContractDomainError('DEVIATION_NOT_FOUND','Deviation не найден',404)
    if (deviation.required_action === 'UPSTREAM_REVISION_REQUIRED') throw new ContractDomainError('UPSTREAM_REVISION_REQUIRED','Это изменение нельзя согласовать локально в Contract',409)
    const reason = cleanText(payload.reason)
    if (!reason) throw new ContractDomainError('APPROVAL_REASON_REQUIRED','Укажите основание approval')
    const [insert] = await conn.execute(
      `INSERT INTO contract_approvals
        (contract_revision_id,contract_deviation_id,approval_type,status,requested_value_json,baseline_value_json,risk_snapshot_json,reason,requester_user_id)
       VALUES (?,?,?,'SUBMITTED',?,?,?,?,?)`,
      [revision.id,deviation.id,cleanText(payload.approval_type) || 'LEGAL_DEVIATION',deviation.proposed_json,deviation.baseline_json,JSON.stringify({ category:deviation.category,required_action:deviation.required_action }),reason,actorId]
    )
    await conn.execute("UPDATE contract_deviations SET status='SUBMITTED' WHERE id=?",[deviation.id])
    await addEvent(conn,revision.contract_case_id,'contract_approval_requested','contract_approval',insert.insertId,actorId,{ deviation_id:deviation.id })
    return { approval_id:insert.insertId,status:'SUBMITTED' }
  })
}

async function decideApproval(approvalIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const approvalId = toId(approvalIdInput)
  const decision = String(payload.decision || '').toUpperCase()
  if (!['APPROVED','REJECTED','RETURNED'].includes(decision)) throw new ContractDomainError('DECISION_INVALID','Допустимы APPROVED, REJECTED или RETURNED')
  return withTransaction(async (conn) => {
    const [[approval]] = await conn.execute('SELECT * FROM contract_approvals WHERE id=? FOR UPDATE',[approvalId])
    if (!approval) throw new ContractDomainError('APPROVAL_NOT_FOUND','Approval не найден',404)
    if (approval.status !== 'SUBMITTED') throw new ContractDomainError('APPROVAL_NOT_PENDING','Approval уже обработан',409)
    const revision = await loadRevision(approval.contract_revision_id,conn,true)
    assertDraftEditable(revision)
    await conn.execute('UPDATE contract_approvals SET status=?,approver_user_id=?,decision_comment=?,decided_at=NOW(6) WHERE id=?',[decision,actorId,cleanText(payload.comment),approval.id])
    if (approval.contract_deviation_id) await conn.execute('UPDATE contract_deviations SET status=?,resolved_by_user_id=?,resolved_at=IF(? IN (\'APPROVED\',\'REJECTED\'),NOW(6),NULL) WHERE id=?',[decision,actorId,decision,approval.contract_deviation_id])
    await addEvent(conn,revision.contract_case_id,'contract_approval_decided','contract_approval',approval.id,actorId,{ decision })
    return { approval_id:approval.id,status:decision }
  })
}

async function submitReview(revisionIdInput,actorUserId) {
  const actorId = requireActor(actorUserId)
  const readiness = await evaluateReadiness(revisionIdInput)
  if (!readiness.ready) throw new ContractDomainError('CONTRACT_NOT_READY','Contract draft не готов к review',409,readiness)
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    assertDraftEditable(revision)
    await conn.execute("UPDATE contract_revisions SET status='INTERNAL_REVIEW',row_version=row_version+1 WHERE id=?",[revision.id])
    await conn.execute("UPDATE contract_cases SET aggregate_status='INTERNAL_REVIEW',row_version=row_version+1 WHERE id=?",[revision.contract_case_id])
    await addEvent(conn,revision.contract_case_id,'contract_submitted_for_review','contract_revision',revision.id,actorId,{ content_hash:readiness.content_hash })
    return { revision_id:revision.id,status:'INTERNAL_REVIEW',content_hash:readiness.content_hash }
  })
}

async function generateDocument(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const key = requireIdempotencyKey(payload.idempotency_key)
  const preview = await buildPreview(revisionIdInput)
  if (!['DRAFT','INTERNAL_REVIEW'].includes(preview.revision.status)) throw new ContractDomainError('DOCUMENT_GENERATION_NOT_ALLOWED','Generated draft создаётся до внешней отправки',409)
  const [[existing]] = await db.execute('SELECT * FROM contract_documents WHERE idempotency_key=?',[key])
  if (existing) return { document_id:existing.id,document_hash:existing.document_hash,already_exists:true }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(preview.revision.contract_number)}</title></head><body><h1>${escapeHtml(preview.revision.contract_number)}</h1><pre>${escapeHtml(JSON.stringify(preview.payload,null,2))}</pre></body></html>`
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (!['DRAFT','INTERNAL_REVIEW'].includes(revision.status)) throw new ContractDomainError('DOCUMENT_GENERATION_NOT_ALLOWED','Revision уже locked',409)
    const [[sequence]] = await conn.execute("SELECT COALESCE(MAX(generation_number),0)+1 AS next_number FROM contract_documents WHERE contract_revision_id=? AND document_type='GENERATED_DRAFT' FOR UPDATE",[revision.id])
    const [insert] = await conn.execute(
      `INSERT INTO contract_documents
        (contract_revision_id,document_type,generation_number,format,template_reference,template_version,rendered_content,document_hash,idempotency_key,registered_by_user_id)
       VALUES (?,'GENERATED_DRAFT',?,'HTML',?,?,?,?,?,?)`,
      [revision.id,sequence.next_number,revision.template_reference,revision.template_version,html,preview.content_hash,key,actorId]
    )
    await addEvent(conn,revision.contract_case_id,'contract_document_generated','contract_document',insert.insertId,actorId,{ document_hash:preview.content_hash,generation_number:sequence.next_number })
    return { document_id:insert.insertId,document_hash:preview.content_hash,generation_number:Number(sequence.next_number),format:'HTML' }
  })
}

async function registerDocument(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const key = requireIdempotencyKey(payload.idempotency_key)
  const documentType = String(payload.document_type || '').toUpperCase()
  if (!['CUSTOMER_DRAFT','SIGNED_EXECUTED','AMENDMENT','TERMINATION','OTHER'].includes(documentType)) throw new ContractDomainError('DOCUMENT_TYPE_INVALID','Недопустимый document_type')
  const fileReference = cleanText(payload.file_reference)
  const documentHash = cleanText(payload.document_hash)
  const evidenceReference = cleanText(payload.evidence_reference)
  if (!fileReference || !documentHash || !/^[a-f0-9]{64}$/i.test(documentHash) || !evidenceReference) throw new ContractDomainError('DOCUMENT_EVIDENCE_REQUIRED','Требуются file_reference, SHA-256 document_hash и evidence_reference')
  const [[existing]] = await db.execute('SELECT * FROM contract_documents WHERE idempotency_key=?',[key])
  if (existing) return { document_id:existing.id,document_hash:existing.document_hash,already_exists:true }
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (documentType === 'SIGNED_EXECUTED' && !['READY_FOR_SIGNATURE','PARTIALLY_SIGNED','SIGNED'].includes(revision.status)) throw new ContractDomainError('SIGNED_DOCUMENT_NOT_ALLOWED','Signed evidence регистрируется только в signature lifecycle',409)
    const [[sequence]] = await conn.execute('SELECT COALESCE(MAX(generation_number),0)+1 AS next_number FROM contract_documents WHERE contract_revision_id=? AND document_type=? FOR UPDATE',[revision.id,documentType])
    const [insert] = await conn.execute(
      `INSERT INTO contract_documents
        (contract_revision_id,document_type,generation_number,format,template_reference,template_version,file_reference,document_hash,evidence_reference,idempotency_key,registered_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [revision.id,documentType,sequence.next_number,String(payload.format || 'OTHER').toUpperCase(),revision.template_reference,revision.template_version,fileReference,documentHash,evidenceReference,key,actorId]
    )
    await addEvent(conn,revision.contract_case_id,'contract_document_registered','contract_document',insert.insertId,actorId,{ document_type:documentType,document_hash:documentHash })
    return { document_id:insert.insertId,document_hash:documentHash,document_type:documentType }
  })
}

async function sendRevision(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const key = requireIdempotencyKey(payload.idempotency_key)
  const documentId = toId(payload.document_id)
  const recipients = Array.isArray(payload.recipients) ? payload.recipients.map(cleanText).filter(Boolean) : []
  if (!documentId || !recipients.length || !cleanText(payload.evidence_reference)) throw new ContractDomainError('SEND_EVIDENCE_REQUIRED','Требуются document_id, recipients и evidence_reference')
  const readiness = await evaluateReadiness(revisionIdInput)
  if (!readiness.ready) throw new ContractDomainError('CONTRACT_NOT_READY','Contract не готов к внешней отправке',409,readiness)
  return withTransaction(async (conn) => {
    const [[existing]] = await conn.execute('SELECT * FROM contract_external_sends WHERE idempotency_key=? FOR UPDATE',[key])
    if (existing) return { send_id:existing.id,status:'EXTERNAL_REVIEW',already_exists:true }
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (revision.status !== 'INTERNAL_REVIEW') throw new ContractDomainError('SEND_STATE_INVALID','Отправить можно только INTERNAL_REVIEW revision',409)
    const [[document]] = await conn.execute("SELECT * FROM contract_documents WHERE id=? AND contract_revision_id=? AND document_type='GENERATED_DRAFT' FOR UPDATE",[documentId,revision.id])
    if (!document) throw new ContractDomainError('GENERATED_DOCUMENT_REQUIRED','Нужен generated document этой revision',409)
    if (document.document_hash !== readiness.content_hash) throw new ContractDomainError('DOCUMENT_CONTENT_STALE','Document не соответствует текущему Contract content',409)
    const [insert] = await conn.execute(
      `INSERT INTO contract_external_sends
        (contract_revision_id,contract_document_id,recipients_json,channel,subject_snapshot,body_snapshot,evidence_reference,sent_content_hash,idempotency_key,sent_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [revision.id,document.id,JSON.stringify(recipients),String(payload.channel || 'MANUAL').toUpperCase(),cleanText(payload.subject),cleanText(payload.body),cleanText(payload.evidence_reference),readiness.content_hash,key,actorId]
    )
    await conn.execute("UPDATE contract_revisions SET status='EXTERNAL_REVIEW',content_hash=?,locked_at=NOW(6),row_version=row_version+1 WHERE id=?",[readiness.content_hash,revision.id])
    await conn.execute("UPDATE contract_cases SET aggregate_status='EXTERNAL_REVIEW',row_version=row_version+1 WHERE id=?",[revision.contract_case_id])
    await addEvent(conn,revision.contract_case_id,'contract_sent_external','contract_external_send',insert.insertId,actorId,{ document_id:document.id,content_hash:readiness.content_hash,channel:String(payload.channel || 'MANUAL').toUpperCase() })
    return { send_id:insert.insertId,revision_id:revision.id,status:'EXTERNAL_REVIEW',content_hash:readiness.content_hash }
  })
}

async function markReadyForSignature(revisionIdInput,actorUserId) {
  const actorId = requireActor(actorUserId)
  const readiness = await evaluateReadiness(revisionIdInput)
  if (!readiness.ready) throw new ContractDomainError('CONTRACT_NOT_READY','Contract не готов к подписанию',409,readiness)
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (revision.status !== 'EXTERNAL_REVIEW') throw new ContractDomainError('SIGNATURE_READINESS_STATE_INVALID','Ожидается EXTERNAL_REVIEW',409)
    const [[send]] = await conn.execute('SELECT id FROM contract_external_sends WHERE contract_revision_id=? ORDER BY sent_at DESC,id DESC LIMIT 1',[revision.id])
    if (!send) throw new ContractDomainError('EXTERNAL_SEND_REQUIRED','Нет evidence внешней отправки',409)
    await conn.execute("UPDATE contract_revisions SET status='READY_FOR_SIGNATURE',row_version=row_version+1 WHERE id=?",[revision.id])
    await conn.execute("UPDATE contract_cases SET aggregate_status='READY_FOR_SIGNATURE',row_version=row_version+1 WHERE id=?",[revision.contract_case_id])
    await addEvent(conn,revision.contract_case_id,'contract_ready_for_signature','contract_revision',revision.id,actorId,{ external_send_id:send.id })
    return { revision_id:revision.id,status:'READY_FOR_SIGNATURE' }
  })
}

async function registerSignature(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const key = requireIdempotencyKey(payload.idempotency_key)
  const role = String(payload.party_role || '').toUpperCase()
  const signerName = cleanText(payload.signer_name)
  const evidenceReference = cleanText(payload.evidence_reference)
  const method = String(payload.signature_method || 'MANUAL_EVIDENCE').toUpperCase()
  if (!['COMPANY','CLIENT'].includes(role) || !signerName || !evidenceReference || !payload.signed_at) throw new ContractDomainError('SIGNATURE_EVIDENCE_REQUIRED','Требуются party_role, signer_name, signed_at и evidence_reference')
  return withTransaction(async (conn) => {
    const [[existing]] = await conn.execute('SELECT * FROM contract_signatures WHERE idempotency_key=? FOR UPDATE',[key])
    if (existing) return { signature_id:existing.id,status:existing.verification_state,already_exists:true }
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (!['READY_FOR_SIGNATURE','PARTIALLY_SIGNED'].includes(revision.status)) throw new ContractDomainError('SIGNATURE_STATE_INVALID','Revision не готова к регистрации подписей',409)
    const documentId = toId(payload.evidence_document_id)
    if (documentId) {
      const [[document]] = await conn.execute("SELECT id FROM contract_documents WHERE id=? AND contract_revision_id=? AND document_type='SIGNED_EXECUTED'",[documentId,revision.id])
      if (!document) throw new ContractDomainError('SIGNED_DOCUMENT_INVALID','Evidence document должен быть SIGNED_EXECUTED этой revision',409)
    }
    try {
      const [insert] = await conn.execute(
        `INSERT INTO contract_signatures
          (contract_revision_id,party_role,signer_name,signer_role,authority_basis,signature_method,signed_at,evidence_document_id,
           evidence_reference,verification_state,idempotency_key,registered_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,'VERIFIED',?,?)`,
        [revision.id,role,signerName,cleanText(payload.signer_role),cleanText(payload.authority_basis),method,new Date(payload.signed_at),documentId,evidenceReference,key,actorId]
      )
      const [rows] = await conn.execute("SELECT party_role FROM contract_signatures WHERE contract_revision_id=? AND verification_state='VERIFIED'",[revision.id])
      const verified = new Set(rows.map((row) => row.party_role))
      const complete = requiredSignatureRoles(revision.legal_form).every((required) => verified.has(required))
      const status = complete ? 'SIGNED':'PARTIALLY_SIGNED'
      await conn.execute('UPDATE contract_revisions SET status=?,row_version=row_version+1 WHERE id=?',[status,revision.id])
      await conn.execute('UPDATE contract_cases SET aggregate_status=?,row_version=row_version+1 WHERE id=?',[status,revision.contract_case_id])
      await addEvent(conn,revision.contract_case_id,'contract_signature_registered','contract_signature',insert.insertId,actorId,{ party_role:role,signature_method:method,contract_status:status })
      return { signature_id:insert.insertId,revision_id:revision.id,status,required_roles:requiredSignatureRoles(revision.legal_form),verified_roles:[...verified] }
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new ContractDomainError('SIGNATURE_PARTY_ALREADY_REGISTERED','Подпись этой стороны уже зарегистрирована',409)
      throw error
    }
  })
}

async function makeEffective(revisionIdInput,payload,actorUserId) {
  const actorId = requireActor(actorUserId)
  const key = requireIdempotencyKey(payload.idempotency_key)
  const readiness = await evaluateReadiness(revisionIdInput)
  if (!readiness.ready) throw new ContractDomainError('CONTRACT_NOT_READY','Contract не готов к effective state',409,readiness)
  return withTransaction(async (conn) => {
    const revision = await loadRevision(revisionIdInput,conn,true)
    if (revision.status === 'EFFECTIVE') {
      const [[count]] = await conn.execute('SELECT COUNT(*) AS count FROM contract_commitments WHERE effective_contract_revision_id=?',[revision.id])
      return { revision_id:revision.id,status:'EFFECTIVE',commitment_count:Number(count.count),already_exists:true }
    }
    if (revision.status !== 'SIGNED') throw new ContractDomainError('EFFECTIVE_STATE_INVALID','Effective требует SIGNED revision',409)
    const parts = await loadRevisionParts(revision.id,conn)
    const required = requiredSignatureRoles(revision.legal_form)
    const verified = new Set(parts.signatures.filter((item) => item.verification_state === 'VERIFIED').map((item) => item.party_role))
    if (!required.every((role) => verified.has(role))) throw new ContractDomainError('SIGNATURES_INCOMPLETE','Не все обязательные подписи verified',409,{ required_roles:required,verified_roles:[...verified] })
    if (!parts.documents.some((item) => item.document_type === 'SIGNED_EXECUTED')) throw new ContractDomainError('SIGNED_DOCUMENT_REQUIRED','Требуется SIGNED_EXECUTED document evidence',409)
    const terms = Object.fromEntries(parts.terms.map((term) => [term.term_type,term.value_json]))
    const clauses = parts.clauses.filter((item) => item.clause_status === 'ACTIVE').map((item) => ({ type:item.clause_type,title:item.title,text:item.clause_text,risk_level:item.risk_level }))
    let count=0
    for (const line of parts.lines.filter((item) => item.line_status === 'ACTIVE')) {
      const commitment = {
        contract_case_id:revision.contract_case_id,effective_revision_id:revision.id,contract_line_id:line.id,
        source_accepted_line_id:line.source_accepted_line_id,subject:line.identity_snapshot_json,quantity:line.quantity,uom:line.uom,
        unit_price:line.unit_price,currency:line.currency,line_total:line.line_total,delivery:{ commitment_days:line.delivery_commitment_days,term:terms.DELIVERY || null,destination:terms.DESTINATION || null,incoterms:terms.INCOTERMS || null },
        payment:terms.PAYMENT || null,legal_terms:{ terms,clauses },upstream_trace:line.upstream_trace_snapshot_json,
      }
      const commitmentHash = sha256(commitment)
      const [insert] = await conn.execute(
        `INSERT INTO contract_commitments
          (contract_case_id,effective_contract_revision_id,contract_line_id,source_accepted_line_id,party_snapshot_json,subject_snapshot_json,
           quantity,uom,unit_price,currency,line_total,delivery_snapshot_json,payment_snapshot_json,legal_terms_snapshot_json,
           upstream_trace_snapshot_json,procurement_readiness,readiness_reasons_json,fulfillment_status,commitment_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'RECONFIRMATION_REQUIRED',?,'NOT_STARTED',?)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
        [revision.contract_case_id,revision.id,line.id,line.source_accepted_line_id,JSON.stringify({ company:revision.company_legal_snapshot_json,client:revision.client_snapshot_json }),
          JSON.stringify(line.identity_snapshot_json),line.quantity,line.uom,line.unit_price,line.currency,line.line_total,JSON.stringify(commitment.delivery),JSON.stringify(commitment.payment),
          JSON.stringify(commitment.legal_terms),JSON.stringify(line.upstream_trace_snapshot_json),JSON.stringify(['DOWNSTREAM_EXECUTION_VALIDATION_REQUIRED','NO_SUPPLIER_ORDER_CREATED']),commitmentHash]
      )
      if (insert.affectedRows) count+=1
    }
    await conn.execute("UPDATE contract_revisions SET status='EFFECTIVE',effective_at=NOW(6),row_version=row_version+1 WHERE id=?",[revision.id])
    await conn.execute("UPDATE contract_cases SET aggregate_status='EFFECTIVE',row_version=row_version+1 WHERE id=?",[revision.contract_case_id])
    await addEvent(conn,revision.contract_case_id,'contract_became_effective','contract_revision',revision.id,actorId,{ idempotency_key:key,content_hash:revision.content_hash,commitment_count:count,procurement_readiness:'RECONFIRMATION_REQUIRED' })
    return { revision_id:revision.id,status:'EFFECTIVE',commitment_count:count,procurement_readiness:'RECONFIRMATION_REQUIRED' }
  })
}

module.exports = {
  addClause,analyzeImpact,createFromAcceptedCommercial,createRevision,decideApproval,generateDocument,makeEffective,
  markReadyForSignature,patchClause,patchRevision,registerDocument,registerSignature,requestApproval,sendRevision,submitReview,upsertTerm,
}
