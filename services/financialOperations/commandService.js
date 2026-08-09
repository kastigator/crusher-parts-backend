const db = require('../../utils/db')
const { FinancialOperationsError } = require('./domainError')
const { actor, currency, event, isoDate, parseJson, requestKey, requiredText, sha256, toId } = require('./helpers')
const { fromMinor, toMinor } = require('./money')
const { normalizePolicy, TRIGGERS } = require('./policy')

const idOrThrow = (value, name) => {
  const id = toId(value)
  if (!id) throw new FinancialOperationsError('INVALID_ID', `Некорректный ${name}`)
  return id
}
const positiveMoney = (value, field = 'amount') => {
  const minor = toMinor(value, field)
  if (minor <= 0n) throw new FinancialOperationsError('INVALID_MONEY', `${field} должен быть больше нуля`)
  return { minor, value: fromMinor(minor) }
}
const addDays = (date, days) => {
  if (!date) return null
  const result = new Date(`${String(date).slice(0, 10)}T00:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

async function refreshCommitment(conn, commitmentId) {
  const [[row]] = await conn.execute(
    `SELECT c.expected_amount,c.status,c.financial_ap_case_id,
            COALESCE((SELECT SUM(a.allocated_amount) FROM financial_invoice_allocations a WHERE a.financial_commitment_id=c.id AND a.status='CONFIRMED'),0)
              - COALESCE((SELECT SUM(a.allocated_amount) FROM financial_credit_note_allocations a WHERE a.financial_commitment_id=c.id AND a.status='CONFIRMED'),0) invoiced,
            COALESCE((SELECT SUM(a.allocated_amount) FROM financial_supplier_payment_allocations a WHERE a.financial_commitment_id=c.id AND a.status='CONFIRMED'),0) paid,
            EXISTS(SELECT 1 FROM financial_disputes d WHERE d.financial_commitment_id=c.id AND d.status IN ('OPEN','UNDER_REVIEW')) disputed
       FROM financial_commitments c WHERE c.id=? FOR UPDATE`, [commitmentId]
  )
  if (!row) throw new FinancialOperationsError('COMMITMENT_NOT_FOUND', 'Financial Commitment не найден', 404)
  let status = row.status === 'WAITING_FOR_TRIGGER' ? row.status : 'ACTIVE'
  if (row.disputed) status = 'DISPUTED'
  else if (toMinor(row.paid) >= toMinor(row.expected_amount)) status = 'PAID'
  else if (toMinor(row.paid) > 0n) status = 'PARTIALLY_PAID'
  else if (toMinor(row.invoiced) >= toMinor(row.expected_amount)) status = 'INVOICED'
  else if (toMinor(row.invoiced) > 0n) status = 'PARTIALLY_INVOICED'
  await conn.execute(`UPDATE financial_commitments SET status=?,actual_payment_date=IF(?='PAID',COALESCE(actual_payment_date,CURDATE()),actual_payment_date),row_version=row_version+1 WHERE id=?`, [status, status, commitmentId])
  const [[apState]] = await conn.execute(`SELECT COUNT(*) commitment_count,
      SUM(status IN ('PAID','CANCELLED','CORRECTED')) resolved_count,
      SUM(status='DISPUTED') disputed_count
    FROM financial_commitments WHERE financial_ap_case_id=?`, [row.financial_ap_case_id])
  const apStatus = Number(apState.commitment_count) > 0 && Number(apState.commitment_count) === Number(apState.resolved_count)
    ? 'COMPLETED'
    : 'ACTIVE'
  await conn.execute(`UPDATE financial_ap_cases SET status=?,row_version=row_version+1
    WHERE id=? AND status NOT IN ('BLOCKED','CANCELLED')`, [apStatus, row.financial_ap_case_id])
  return status
}
async function refreshSupplierInvoice(conn, invoiceId) {
  const [[row]] = await conn.execute(
    `SELECT i.gross_amount,
            COALESCE((SELECT SUM(a.allocated_amount) FROM financial_invoice_allocations a WHERE a.supplier_invoice_id=i.id AND a.status='CONFIRMED'),0) matched,
            COALESCE((SELECT SUM(a.allocated_amount) FROM financial_supplier_payment_allocations a WHERE a.supplier_invoice_id=i.id AND a.status='CONFIRMED'),0) paid,
            COALESCE((SELECT SUM(a.allocated_amount) FROM financial_credit_note_allocations a JOIN financial_credit_notes n ON n.id=a.credit_note_id WHERE n.original_supplier_invoice_id=i.id AND a.status='CONFIRMED'),0) credited,
            EXISTS(SELECT 1 FROM financial_disputes d WHERE d.supplier_invoice_id=i.id AND d.status IN ('OPEN','UNDER_REVIEW')) disputed
       FROM financial_supplier_invoices i WHERE i.id=? FOR UPDATE`, [invoiceId]
  )
  if (!row) throw new FinancialOperationsError('INVOICE_NOT_FOUND', 'Supplier invoice не найден', 404)
  let status = 'RECEIVED'
  if (row.disputed) status = 'DISPUTED'
  else if (toMinor(row.paid) >= toMinor(row.gross_amount) - toMinor(row.credited)) status = 'PAID'
  else if (toMinor(row.paid) > 0n) status = 'PARTIALLY_PAID'
  else if (toMinor(row.matched) >= toMinor(row.gross_amount)) status = 'ALLOCATED'
  else if (toMinor(row.matched) > 0n) status = 'PARTIALLY_ALLOCATED'
  await conn.execute('UPDATE financial_supplier_invoices SET status=?,row_version=row_version+1 WHERE id=?', [status, invoiceId])
  return status
}
async function refreshReceivable(conn, receivableId) {
  const [[row]] = await conn.execute(
    `SELECT r.expected_amount,r.due_date,r.readiness_reasons_json,
            COALESCE((SELECT SUM(a.allocated_amount) FROM financial_customer_payment_allocations a WHERE a.customer_receivable_id=r.id AND a.status='CONFIRMED'),0) received,
            COALESCE((SELECT SUM(c.amount) FROM financial_customer_credit_adjustments c WHERE c.customer_receivable_id=r.id AND c.status='APPROVED'),0) credits
       FROM financial_customer_receivables r WHERE r.id=? FOR UPDATE`, [receivableId]
  )
  if (!row) throw new FinancialOperationsError('RECEIVABLE_NOT_FOUND', 'Customer Receivable не найден', 404)
  const expected = toMinor(row.expected_amount)
  const settled = toMinor(row.received) + toMinor(row.credits)
  let status = settled >= expected ? 'PAID' : settled > 0n ? 'PARTIALLY_PAID' : row.due_date ? 'OPEN' : 'PLANNED'
  if (status === 'OPEN' && String(row.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10)) status = 'OVERDUE'
  await conn.execute('UPDATE financial_customer_receivables SET status=?,row_version=row_version+1 WHERE id=?', [status, receivableId])
  return status
}

async function materializeApFromAcceptedConfirmation(confirmationIdInput, userId) {
  const confirmationId = idOrThrow(confirmationIdInput, 'confirmation_id')
  const user = actor(userId)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[source]] = await conn.execute(
      `SELECT c.*,r.procurement_purchase_order_id,r.status revision_status,r.content_hash,r.payment_snapshot_json,r.legal_basis_snapshot_json,
              r.supplier_snapshot_json,r.buyer_snapshot_json,r.delivery_snapshot_json,r.source_trace_snapshot_json,
              o.po_number,o.supplier_id,o.status po_status,
              COUNT(l.id) line_count,COUNT(DISTINCT l.currency) currency_count,MIN(l.currency) currency,
              CAST(SUM(l.quantity*l.unit_price) AS DECIMAL(20,4)) total_amount
         FROM procurement_supplier_confirmations c
         JOIN procurement_purchase_order_revisions r ON r.id=c.procurement_purchase_order_revision_id
         JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id
         JOIN procurement_purchase_order_lines l ON l.procurement_purchase_order_revision_id=r.id
        WHERE c.id=? GROUP BY c.id,r.id,o.id FOR UPDATE`, [confirmationId]
    )
    if (!source) throw new FinancialOperationsError('CONFIRMATION_NOT_FOUND', 'Supplier confirmation не найден', 404)
    if (source.status !== 'ACCEPTED' || !source.accepted_at || source.po_status !== 'CONFIRMED') {
      throw new FinancialOperationsError('ACCEPTED_CONFIRMATION_REQUIRED', 'AP может возникнуть только из SupplierConfirmationAccepted', 409)
    }
    if (!source.evidence_hash || !source.content_hash) throw new FinancialOperationsError('SOURCE_HASH_REQUIRED', 'Confirmation evidence hash и PO revision hash обязательны', 409)
    if (Number(source.currency_count) !== 1 || !source.currency) throw new FinancialOperationsError('SINGLE_CURRENCY_REQUIRED', 'Один AP case должен иметь одну currency', 409)
    const [[existing]] = await conn.execute('SELECT id,status FROM financial_ap_cases WHERE source_supplier_confirmation_id=?', [confirmationId])
    if (existing) { await conn.commit(); return { ap_case_id: existing.id, status: existing.status, already_exists: true } }
    const trace = {
      supplier_confirmation: { id: confirmationId, reference: source.confirmation_reference, evidence_reference: source.evidence_reference, evidence_hash: source.evidence_hash, accepted_at: source.accepted_at },
      purchase_order: { id: source.procurement_purchase_order_id, number: source.po_number, revision_id: source.procurement_purchase_order_revision_id, revision_hash: source.content_hash },
    }
    let policy
    let blockers = []
    try { policy = normalizePolicy(source.total_amount, source.payment_snapshot_json, source.legal_basis_snapshot_json) }
    catch (error) {
      if (!(error instanceof FinancialOperationsError) || error.code !== 'STRUCTURED_PAYMENT_POLICY_REQUIRED') throw error
      blockers = [error.code]
    }
    const sourceSnapshot = { ...trace, supplier: parseJson(source.supplier_snapshot_json), buyer: parseJson(source.buyer_snapshot_json), delivery: parseJson(source.delivery_snapshot_json), upstream: parseJson(source.source_trace_snapshot_json) }
    const sourceHash = sha256({ trace, payment: parseJson(source.payment_snapshot_json), legal: parseJson(source.legal_basis_snapshot_json) })
    const caseNumber = `AP-${String(confirmationId).padStart(8, '0')}`
    const [caseInsert] = await conn.execute(
      `INSERT INTO financial_ap_cases
        (case_number,source_supplier_confirmation_id,source_po_id,source_po_revision_id,supplier_id,status,currency,total_amount,source_snapshot_json,blocker_reasons_json,source_hash,created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [caseNumber, confirmationId, source.procurement_purchase_order_id, source.procurement_purchase_order_revision_id, source.supplier_id,
        policy ? 'ACTIVE' : 'BLOCKED', source.currency, source.total_amount, JSON.stringify(sourceSnapshot), JSON.stringify(blockers), sourceHash, user]
    )
    const [scheduleInsert] = await conn.execute('INSERT INTO financial_payment_schedules (financial_ap_case_id,status) VALUES (?,?)', [caseInsert.insertId, policy ? 'ACTIVE' : 'BLOCKED'])
    if (policy) {
      const [revisionInsert] = await conn.execute(
        `INSERT INTO financial_payment_schedule_revisions
          (financial_payment_schedule_id,revision_number,status,source_policy_snapshot_json,source_trace_snapshot_json,source_hash,total_amount,currency,created_by_user_id,activated_by_user_id,activated_at)
         VALUES (?,1,'ACTIVE',?,?,?,?,?,?,?,NOW(6))`,
        [scheduleInsert.insertId, JSON.stringify(policy.source), JSON.stringify(trace), sha256(policy.source), source.total_amount, source.currency, user, user]
      )
      await conn.execute('UPDATE financial_payment_schedules SET current_revision_id=? WHERE id=?', [revisionInsert.insertId, scheduleInsert.insertId])
      for (let index = 0; index < policy.stages.length; index += 1) {
        const stage = policy.stages[index]
        const immediate = stage.trigger_type === 'CONFIRMED'
        const [stageInsert] = await conn.execute(
          `INSERT INTO financial_payment_schedule_stages
            (financial_payment_schedule_revision_id,stage_number,stage_code,calculation_type,calculation_value,amount,currency,trigger_type,trigger_offset_days,invoice_required,explicit_event_date,planned_payment_date,contractual_due_date,scope_snapshot_json,blocking_effect,status,source_snapshot_json,activated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [revisionInsert.insertId,index + 1,stage.stage_code,stage.calculation_type,stage.calculation_type === 'REMAINDER' ? null : stage.value,stage.amount,
            source.currency,stage.trigger_type,stage.trigger_offset_days,stage.invoice_required ? 1 : 0,stage.explicit_event_date,stage.planned_payment_date,
            stage.contractual_due_date,JSON.stringify(stage.scope),stage.blocking_effect,immediate ? 'ACTIVE' : 'WAITING_FOR_TRIGGER',JSON.stringify(stage.source),immediate ? new Date() : null]
        )
        await conn.execute(
          `INSERT INTO financial_commitments
            (financial_ap_case_id,payment_schedule_stage_id,supplier_id,status,expected_amount,currency,contractual_due_date,planned_payment_date,source_trace_snapshot_json,commitment_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [caseInsert.insertId,stageInsert.insertId,source.supplier_id,immediate ? 'ACTIVE' : 'WAITING_FOR_TRIGGER',stage.amount,source.currency,
            stage.contractual_due_date,stage.planned_payment_date,JSON.stringify(trace),sha256({ sourceHash, stage: stage.stage_code, amount: stage.amount })]
        )
      }
    }
    await event(conn, policy ? 'FinancialScheduleMaterialized' : 'FinancialScheduleBlocked', 'financial_ap_case', caseInsert.insertId, user,
      { blockers, confirmation_id: confirmationId, schedule_id: scheduleInsert.insertId }, { domain: 'procurement_execution', entity_type: 'procurement_supplier_confirmation', entity_id: confirmationId })
    await conn.commit()
    return { ap_case_id: caseInsert.insertId, schedule_id: scheduleInsert.insertId, status: policy ? 'ACTIVE' : 'BLOCKED', blockers }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function applyTrigger(payload, userId) {
  const user = actor(userId)
  const sourceDomain = requiredText(payload.source_domain, 'source_domain', 40)
  const sourceEventKey = requiredText(payload.source_event_key, 'source_event_key', 160)
  const triggerType = String(payload.trigger_type || '').toUpperCase()
  if (!TRIGGERS.has(triggerType)) throw new FinancialOperationsError('INVALID_PAYMENT_TRIGGER', 'Неизвестный trigger_type')
  const occurredAt = new Date(payload.occurred_at)
  if (Number.isNaN(occurredAt.getTime())) throw new FinancialOperationsError('INVALID_DATE', 'Некорректный occurred_at')
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [insert] = await conn.execute(
      `INSERT IGNORE INTO financial_trigger_events
        (source_domain,source_event_key,trigger_type,source_entity_type,source_entity_id,source_revision_id,occurred_at,payload_snapshot_json,payload_hash,processed_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sourceDomain,sourceEventKey,triggerType,requiredText(payload.source_entity_type,'source_entity_type',64),toId(payload.source_entity_id),toId(payload.source_revision_id),occurredAt,JSON.stringify(payload.evidence || {}),sha256(payload.evidence || {}),user]
    )
    if (!insert.affectedRows) { await conn.commit(); return { already_exists: true, activated_stage_ids: [] } }
    const params = [triggerType]
    let scope = ''
    if (toId(payload.ap_case_id)) { scope = ' AND c.financial_ap_case_id=?'; params.push(toId(payload.ap_case_id)) }
    const [stages] = await conn.execute(
      `SELECT s.id,s.trigger_offset_days,s.invoice_required,s.contractual_due_date,s.planned_payment_date,c.id commitment_id
         FROM financial_payment_schedule_stages s JOIN financial_commitments c ON c.payment_schedule_stage_id=s.id
        WHERE s.trigger_type=? AND s.status='WAITING_FOR_TRIGGER'${scope} FOR UPDATE`, params
    )
    const eventDate = occurredAt.toISOString().slice(0, 10)
    for (const stage of stages) {
      const due = stage.contractual_due_date || addDays(eventDate, stage.trigger_offset_days)
      await conn.execute("UPDATE financial_payment_schedule_stages SET status='ACTIVE',activated_at=?,contractual_due_date=COALESCE(contractual_due_date,?),planned_payment_date=COALESCE(planned_payment_date,?) WHERE id=?", [occurredAt,due,due,stage.id])
      await conn.execute("UPDATE financial_commitments SET status='ACTIVE',contractual_due_date=COALESCE(contractual_due_date,?),planned_payment_date=COALESCE(planned_payment_date,?),row_version=row_version+1 WHERE id=?", [due,due,stage.commitment_id])
      await event(conn,'FinancialCommitmentActivated','financial_commitment',stage.commitment_id,user,{ trigger_event_id:insert.insertId,trigger_type:triggerType,due_date:due },{ domain:sourceDomain,entity_type:payload.source_entity_type,entity_id:toId(payload.source_entity_id) })
    }
    await conn.commit()
    return { trigger_event_id: insert.insertId, activated_stage_ids: stages.map((stage) => stage.id) }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function registerSupplierInvoice(payload, userId) {
  const user = actor(userId)
  const supplierId = idOrThrow(payload.supplier_id, 'supplier_id')
  const amount = positiveMoney(payload.gross_amount, 'gross_amount')
  const code = currency(payload.currency)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [insert] = await conn.execute(
      `INSERT INTO financial_supplier_invoices
        (supplier_id,own_legal_entity_key,external_invoice_number,fiscal_context,invoice_date,currency,gross_amount,net_amount,tax_amount,contractual_due_date,source_channel,evidence_reference,evidence_hash,status,created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'RECEIVED',?)`,
      [supplierId,requiredText(payload.own_legal_entity_key,'own_legal_entity_key',160),requiredText(payload.external_invoice_number,'external_invoice_number',160),
        String(payload.fiscal_context || 'DEFAULT').slice(0,80),isoDate(payload.invoice_date,'invoice_date'),code,amount.value,
        payload.net_amount == null ? null : fromMinor(toMinor(payload.net_amount,'net_amount')),payload.tax_amount == null ? null : fromMinor(toMinor(payload.tax_amount,'tax_amount')),
        isoDate(payload.contractual_due_date,'contractual_due_date',{nullable:true}),requiredText(payload.source_channel,'source_channel',32),requiredText(payload.evidence_reference,'evidence_reference',1000),
        sha256({ reference: payload.evidence_reference, evidence: payload.evidence || {} }),user]
    )
    const allocations = Array.isArray(payload.allocations) ? payload.allocations : []
    let allocated = 0n
    for (const item of allocations) {
      const commitmentId = idOrThrow(item.commitment_id,'commitment_id')
      const allocation = positiveMoney(item.amount,'allocation amount')
      const [[commitment]] = await conn.execute('SELECT supplier_id,currency,expected_amount FROM financial_commitments WHERE id=? FOR UPDATE',[commitmentId])
      if (!commitment || Number(commitment.supplier_id) !== supplierId || commitment.currency !== code) throw new FinancialOperationsError('ALLOCATION_LINEAGE_MISMATCH','Invoice allocation не соответствует supplier/currency commitment',409)
      const [[used]] = await conn.execute("SELECT COALESCE(SUM(allocated_amount),0) amount FROM financial_invoice_allocations WHERE financial_commitment_id=? AND status='CONFIRMED'",[commitmentId])
      if (toMinor(used.amount)+allocation.minor > toMinor(commitment.expected_amount)) throw new FinancialOperationsError('COMMITMENT_OVERALLOCATION','Invoice allocation превышает commitment',409)
      allocated += allocation.minor
      if (allocated > amount.minor) throw new FinancialOperationsError('INVOICE_OVERALLOCATION','Allocations превышают gross invoice amount',409)
      await conn.execute(`INSERT INTO financial_invoice_allocations (supplier_invoice_id,financial_commitment_id,allocated_amount,idempotency_key,allocation_snapshot_json,allocated_by_user_id) VALUES (?,?,?,?,?,?)`,[insert.insertId,commitmentId,allocation.value,requestKey(item.idempotency_key),JSON.stringify(item.evidence || {}),user])
      await refreshCommitment(conn,commitmentId)
    }
    const status = await refreshSupplierInvoice(conn,insert.insertId)
    await event(conn,'SupplierInvoiceRegistered','financial_supplier_invoice',insert.insertId,user,{ status,allocated_amount:fromMinor(allocated) },{ domain:'external_evidence',entity_type:'supplier_invoice' })
    await conn.commit(); return { supplier_invoice_id:insert.insertId,status,allocated_amount:fromMinor(allocated) }
  } catch(error){ await conn.rollback(); throw error } finally { conn.release() }
}

async function registerCreditNote(payload,userId){
  const user=actor(userId),supplierId=idOrThrow(payload.supplier_id,'supplier_id'),amount=positiveMoney(payload.amount),code=currency(payload.currency),invoiceId=toId(payload.original_supplier_invoice_id),conn=await db.getConnection()
  try{await conn.beginTransaction();if(invoiceId){const [[invoice]]=await conn.execute('SELECT supplier_id,currency FROM financial_supplier_invoices WHERE id=? FOR UPDATE',[invoiceId]);if(!invoice||Number(invoice.supplier_id)!==supplierId||invoice.currency!==code)throw new FinancialOperationsError('CREDIT_NOTE_LINEAGE_MISMATCH','Credit note не соответствует supplier/currency invoice',409)}const [insert]=await conn.execute(`INSERT INTO financial_credit_notes (supplier_id,original_supplier_invoice_id,external_credit_number,credit_date,currency,amount,evidence_reference,evidence_hash,status,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,'RECEIVED',?)`,[supplierId,invoiceId,requiredText(payload.external_credit_number,'external_credit_number',160),isoDate(payload.credit_date,'credit_date'),code,amount.value,requiredText(payload.evidence_reference,'evidence_reference',1000),sha256({reference:payload.evidence_reference,evidence:payload.evidence||{}}),user]);let allocated=0n;for(const item of Array.isArray(payload.allocations)?payload.allocations:[]){const commitmentId=idOrThrow(item.commitment_id,'commitment_id'),value=positiveMoney(item.amount,'allocation amount'),[[commitment]]=await conn.execute('SELECT supplier_id,currency FROM financial_commitments WHERE id=? FOR UPDATE',[commitmentId]);if(!commitment||Number(commitment.supplier_id)!==supplierId||commitment.currency!==code)throw new FinancialOperationsError('CREDIT_NOTE_LINEAGE_MISMATCH','Credit allocation не соответствует commitment',409);if(invoiceId){const [[matched]]=await conn.execute("SELECT COALESCE(SUM(allocated_amount),0) amount FROM financial_invoice_allocations WHERE supplier_invoice_id=? AND financial_commitment_id=? AND status='CONFIRMED'",[invoiceId,commitmentId]);const [[credited]]=await conn.execute("SELECT COALESCE(SUM(a.allocated_amount),0) amount FROM financial_credit_note_allocations a JOIN financial_credit_notes n ON n.id=a.credit_note_id WHERE n.original_supplier_invoice_id=? AND a.financial_commitment_id=? AND a.status='CONFIRMED'",[invoiceId,commitmentId]);if(toMinor(credited.amount)+value.minor>toMinor(matched.amount))throw new FinancialOperationsError('CREDIT_OVERALLOCATION','Credit allocation превышает matched invoice amount',409)}allocated+=value.minor;if(allocated>amount.minor)throw new FinancialOperationsError('CREDIT_OVERALLOCATION','Allocations превышают credit note amount',409);await conn.execute(`INSERT INTO financial_credit_note_allocations (credit_note_id,financial_commitment_id,allocated_amount,idempotency_key,allocated_by_user_id) VALUES (?,?,?,?,?)`,[insert.insertId,commitmentId,value.value,requestKey(item.idempotency_key),user]);await refreshCommitment(conn,commitmentId)}const status=allocated===amount.minor?'ALLOCATED':allocated>0n?'PARTIALLY_ALLOCATED':'RECEIVED';await conn.execute('UPDATE financial_credit_notes SET status=? WHERE id=?',[status,insert.insertId]);if(invoiceId)await refreshSupplierInvoice(conn,invoiceId);await event(conn,'SupplierCreditNoteRegistered','financial_credit_note',insert.insertId,user,{status,allocated_amount:fromMinor(allocated),original_invoice_id:invoiceId},{domain:'external_evidence',entity_type:'supplier_credit_note'});await conn.commit();return {credit_note_id:insert.insertId,status,allocated_amount:fromMinor(allocated)}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function createPaymentPlan(payload,userId){const user=actor(userId),invoiceId=toId(payload.supplier_invoice_id),commitmentId=toId(payload.commitment_id);if(!invoiceId&&!commitmentId)throw new FinancialOperationsError('PAYMENT_PLAN_TARGET_REQUIRED','Требуется supplier_invoice_id или commitment_id');const amount=positiveMoney(payload.amount),code=currency(payload.currency),conn=await db.getConnection();try{await conn.beginTransaction();if(invoiceId){const [[invoice]]=await conn.execute('SELECT currency FROM financial_supplier_invoices WHERE id=?',[invoiceId]);if(!invoice||invoice.currency!==code)throw new FinancialOperationsError('PAYMENT_PLAN_LINEAGE_MISMATCH','Invoice currency не соответствует plan',409)}if(commitmentId){const [[commitment]]=await conn.execute('SELECT currency FROM financial_commitments WHERE id=?',[commitmentId]);if(!commitment||commitment.currency!==code)throw new FinancialOperationsError('PAYMENT_PLAN_LINEAGE_MISMATCH','Commitment currency не соответствует plan',409)}const [insert]=await conn.execute(`INSERT INTO financial_payment_plans (supplier_invoice_id,financial_commitment_id,planned_payment_date,amount,currency,status,note,created_by_user_id) VALUES (?,?,?,?,?,'PLANNED',?,?)`,[invoiceId,commitmentId,isoDate(payload.planned_payment_date,'planned_payment_date'),amount.value,code,payload.note||null,user]);await event(conn,'SupplierPaymentPlanned','financial_payment_plan',insert.insertId,user,{invoice_id:invoiceId,commitment_id:commitmentId,date:payload.planned_payment_date,amount:amount.value,currency:code});await conn.commit();return {payment_plan_id:insert.insertId,status:'PLANNED'}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function registerSupplierPayment(payload,userId){
  const user=actor(userId),supplierId=idOrThrow(payload.supplier_id,'supplier_id'),amount=positiveMoney(payload.amount),code=currency(payload.currency),conn=await db.getConnection()
  try{await conn.beginTransaction();const [insert]=await conn.execute(`INSERT INTO financial_supplier_payments (payment_number,own_legal_entity_key,supplier_id,payment_date,currency,amount,bank_reference,source_type,evidence_snapshot_json,status,created_by_user_id,confirmed_by_user_id,confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,'CONFIRMED',?,?,NOW(6))`,[requiredText(payload.payment_number,'payment_number',100),requiredText(payload.own_legal_entity_key,'own_legal_entity_key',160),supplierId,isoDate(payload.payment_date,'payment_date'),code,amount.value,requiredText(payload.bank_reference,'bank_reference',255),requiredText(payload.source_type,'source_type',32),JSON.stringify(payload.evidence||{}),user,user]);let allocated=0n
    for(const item of Array.isArray(payload.allocations)?payload.allocations:[]){const invoiceId=idOrThrow(item.invoice_id,'invoice_id'),commitmentId=idOrThrow(item.commitment_id,'commitment_id'),value=positiveMoney(item.amount,'allocation amount');const [[lineage]]=await conn.execute(`SELECT i.supplier_id,i.currency,i.gross_amount,c.expected_amount,EXISTS(SELECT 1 FROM financial_invoice_allocations a WHERE a.supplier_invoice_id=i.id AND a.financial_commitment_id=c.id AND a.status='CONFIRMED') matched FROM financial_supplier_invoices i JOIN financial_commitments c ON c.id=? WHERE i.id=? FOR UPDATE`,[commitmentId,invoiceId]);if(!lineage||!lineage.matched||Number(lineage.supplier_id)!==supplierId||lineage.currency!==code)throw new FinancialOperationsError('PAYMENT_ALLOCATION_LINEAGE_MISMATCH','Payment allocation требует matched invoice/commitment того же supplier/currency',409);const [[invoicePaid]]=await conn.execute("SELECT COALESCE(SUM(allocated_amount),0) amount FROM financial_supplier_payment_allocations WHERE supplier_invoice_id=? AND status='CONFIRMED'",[invoiceId]);if(toMinor(invoicePaid.amount)+value.minor>toMinor(lineage.gross_amount))throw new FinancialOperationsError('INVOICE_OVERPAYMENT','Payment allocations превышают invoice',409);allocated+=value.minor;if(allocated>amount.minor)throw new FinancialOperationsError('PAYMENT_OVERALLOCATION','Allocations превышают payment amount',409);await conn.execute(`INSERT INTO financial_supplier_payment_allocations (supplier_payment_id,supplier_invoice_id,financial_commitment_id,allocated_amount,idempotency_key,allocation_snapshot_json,allocated_by_user_id) VALUES (?,?,?,?,?,?,?)`,[insert.insertId,invoiceId,commitmentId,value.value,requestKey(item.idempotency_key),JSON.stringify(item.evidence||{}),user]);await refreshCommitment(conn,commitmentId);await refreshSupplierInvoice(conn,invoiceId)}const status=allocated===amount.minor?'ALLOCATED':allocated>0n?'PARTIALLY_ALLOCATED':'CONFIRMED';await conn.execute('UPDATE financial_supplier_payments SET status=? WHERE id=?',[status,insert.insertId]);await event(conn,'SupplierPaymentRegistered','financial_supplier_payment',insert.insertId,user,{status,allocated_amount:fromMinor(allocated)});await conn.commit();return {supplier_payment_id:insert.insertId,status,allocated_amount:fromMinor(allocated)}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function openDispute(payload,userId){const user=actor(userId),invoiceId=toId(payload.supplier_invoice_id),commitmentId=toId(payload.commitment_id);if(!invoiceId&&!commitmentId)throw new FinancialOperationsError('DISPUTE_TARGET_REQUIRED','Требуется invoice или commitment');const amount=positiveMoney(payload.disputed_amount,'disputed_amount'),conn=await db.getConnection();try{await conn.beginTransaction();const [insert]=await conn.execute(`INSERT INTO financial_disputes (supplier_invoice_id,financial_commitment_id,disputed_amount,currency,reason_code,description,owner_user_id,evidence_snapshot_json,opened_by_user_id) VALUES (?,?,?,?,?,?,?,?,?)`,[invoiceId,commitmentId,amount.value,currency(payload.currency),requiredText(payload.reason_code,'reason_code',80),payload.description||null,toId(payload.owner_user_id),JSON.stringify(payload.evidence||{}),user]);if(invoiceId)await refreshSupplierInvoice(conn,invoiceId);if(commitmentId)await refreshCommitment(conn,commitmentId);await event(conn,'FinancialDisputeOpened','financial_dispute',insert.insertId,user,{invoice_id:invoiceId,commitment_id:commitmentId});await conn.commit();return {dispute_id:insert.insertId,status:'OPEN'}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function materializeReceivable(contractCommitmentIdInput,userId){
  const commitmentId=idOrThrow(contractCommitmentIdInput,'contract_commitment_id'),user=actor(userId),conn=await db.getConnection()
  try{await conn.beginTransaction();const [[source]]=await conn.execute(`SELECT cc.*,c.client_id,c.contract_number,c.aggregate_status,r.status revision_status,r.content_hash,r.client_snapshot_json,r.company_legal_snapshot_json FROM contract_commitments cc JOIN contract_cases c ON c.id=cc.contract_case_id JOIN contract_revisions r ON r.id=cc.effective_contract_revision_id WHERE cc.id=? FOR UPDATE`,[commitmentId]);if(!source)throw new FinancialOperationsError('CONTRACT_COMMITMENT_NOT_FOUND','Contract Commitment не найден',404);if(source.aggregate_status!=='EFFECTIVE'||source.revision_status!=='EFFECTIVE')throw new FinancialOperationsError('EFFECTIVE_CONTRACT_REQUIRED','AR создаётся только из EFFECTIVE Contract Commitment',409);const [[existing]]=await conn.execute('SELECT id,status FROM financial_customer_receivables WHERE contract_commitment_id=?',[commitmentId]);if(existing){await conn.commit();return {receivable_id:existing.id,status:existing.status,already_exists:true}}
    const payment=parseJson(source.payment_snapshot_json,{}),party=parseJson(source.party_snapshot_json,{}),dueCandidate=payment.due_date||payment.contractual_due_date||null,due=dueCandidate?isoDate(dueCandidate,'contract due_date'):null,reasons=due?[]:['DUE_DATE_UNSPECIFIED'];const company=parseJson(source.company_legal_snapshot_json,{}),ownKey=String(company.id||company.company_id||company.registration_number||`contract-${source.contract_case_id}`).slice(0,160),sourceSnapshot={contract_number:source.contract_number,contract_commitment_id:commitmentId,contract_revision_id:source.effective_contract_revision_id,contract_revision_hash:source.content_hash,commitment_hash:source.commitment_hash,payment};const [insert]=await conn.execute(`INSERT INTO financial_customer_receivables (receivable_number,own_legal_entity_key,client_id,contract_case_id,contract_revision_id,contract_commitment_id,source_snapshot_json,legal_entity_snapshot_json,client_snapshot_json,currency,expected_amount,due_date,status,readiness_reasons_json,source_hash,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[`AR-${String(commitmentId).padStart(8,'0')}`,ownKey,source.client_id,source.contract_case_id,source.effective_contract_revision_id,commitmentId,JSON.stringify(sourceSnapshot),JSON.stringify(company),JSON.stringify(parseJson(source.client_snapshot_json,party.client||party)),source.currency,source.line_total,due,due?'OPEN':'PLANNED',JSON.stringify(reasons),sha256(sourceSnapshot),user]);await event(conn,'CustomerReceivableMaterialized','financial_customer_receivable',insert.insertId,user,{expected_amount:source.line_total,currency:source.currency,due_date:due,readiness_reasons:reasons},{domain:'contract',entity_type:'contract_commitment',entity_id:commitmentId});await conn.commit();return {receivable_id:insert.insertId,status:due?'OPEN':'PLANNED',readiness_reasons:reasons}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function registerCustomerPayment(payload,userId){const user=actor(userId),clientId=idOrThrow(payload.client_id,'client_id'),amount=positiveMoney(payload.amount),code=currency(payload.currency),ownKey=requiredText(payload.own_legal_entity_key,'own_legal_entity_key',160),conn=await db.getConnection();try{await conn.beginTransaction();const [insert]=await conn.execute(`INSERT INTO financial_customer_payments (payment_number,own_legal_entity_key,client_id,payer_snapshot_json,payment_date,currency,amount,bank_reference,external_accounting_reference,source_type,status,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,'REGISTERED',?)`,[requiredText(payload.payment_number,'payment_number',100),ownKey,clientId,JSON.stringify(payload.payer||{}),isoDate(payload.payment_date,'payment_date'),code,amount.value,requiredText(payload.bank_reference,'bank_reference',255),payload.external_accounting_reference||null,requiredText(payload.source_type,'source_type',32),user]);let allocated=0n;for(const item of Array.isArray(payload.allocations)?payload.allocations:[]){const receivableId=idOrThrow(item.receivable_id,'receivable_id'),value=positiveMoney(item.amount,'allocation amount'),[[receivable]]=await conn.execute(`SELECT client_id,own_legal_entity_key,currency,expected_amount FROM financial_customer_receivables WHERE id=? FOR UPDATE`,[receivableId]);if(!receivable||Number(receivable.client_id)!==clientId||receivable.own_legal_entity_key!==ownKey||receivable.currency!==code)throw new FinancialOperationsError('CUSTOMER_ALLOCATION_LINEAGE_MISMATCH','Customer payment не соответствует client/legal entity/currency receivable',409);const [[settled]]=await conn.execute(`SELECT COALESCE((SELECT SUM(allocated_amount) FROM financial_customer_payment_allocations WHERE customer_receivable_id=? AND status='CONFIRMED'),0)+COALESCE((SELECT SUM(amount) FROM financial_customer_credit_adjustments WHERE customer_receivable_id=? AND status='APPROVED'),0) amount`,[receivableId,receivableId]);if(toMinor(settled.amount)+value.minor>toMinor(receivable.expected_amount))throw new FinancialOperationsError('RECEIVABLE_OVERALLOCATION','Allocation превышает receivable balance',409);allocated+=value.minor;if(allocated>amount.minor)throw new FinancialOperationsError('PAYMENT_OVERALLOCATION','Allocations превышают customer payment',409);await conn.execute(`INSERT INTO financial_customer_payment_allocations (customer_payment_id,customer_receivable_id,allocated_amount,idempotency_key,allocation_snapshot_json,allocated_by_user_id) VALUES (?,?,?,?,?,?)`,[insert.insertId,receivableId,value.value,requestKey(item.idempotency_key),JSON.stringify(item.evidence||{}),user]);await refreshReceivable(conn,receivableId)}const status=allocated===amount.minor?'ALLOCATED':allocated>0n?'PARTIALLY_ALLOCATED':'REGISTERED';await conn.execute('UPDATE financial_customer_payments SET status=? WHERE id=?',[status,insert.insertId]);await event(conn,'CustomerPaymentRegistered','financial_customer_payment',insert.insertId,user,{status,allocated_amount:fromMinor(allocated)});await conn.commit();return {customer_payment_id:insert.insertId,status,allocated_amount:fromMinor(allocated)}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function registerCustomerCreditAdjustment(payload,userId){const user=actor(userId),receivableId=idOrThrow(payload.receivable_id,'receivable_id'),amount=positiveMoney(payload.amount),conn=await db.getConnection();try{await conn.beginTransaction();const [[receivable]]=await conn.execute('SELECT currency,expected_amount FROM financial_customer_receivables WHERE id=? FOR UPDATE',[receivableId]);if(!receivable)throw new FinancialOperationsError('RECEIVABLE_NOT_FOUND','Customer Receivable не найден',404);if(currency(payload.currency)!==receivable.currency)throw new FinancialOperationsError('ADJUSTMENT_CURRENCY_MISMATCH','Adjustment currency не соответствует receivable',409);const [[settled]]=await conn.execute(`SELECT COALESCE((SELECT SUM(allocated_amount) FROM financial_customer_payment_allocations WHERE customer_receivable_id=? AND status='CONFIRMED'),0)+COALESCE((SELECT SUM(amount) FROM financial_customer_credit_adjustments WHERE customer_receivable_id=? AND status='APPROVED'),0) amount`,[receivableId,receivableId]);if(toMinor(settled.amount)+amount.minor>toMinor(receivable.expected_amount))throw new FinancialOperationsError('RECEIVABLE_OVERALLOCATION','Adjustment превышает receivable balance',409);const [insert]=await conn.execute(`INSERT INTO financial_customer_credit_adjustments (customer_receivable_id,amount,currency,reason_code,approval_reference,evidence_snapshot_json,status,created_by_user_id) VALUES (?,?,?,?,?,?,'APPROVED',?)`,[receivableId,amount.value,receivable.currency,requiredText(payload.reason_code,'reason_code',80),requiredText(payload.approval_reference,'approval_reference',255),JSON.stringify(payload.evidence||{}),user]);const status=await refreshReceivable(conn,receivableId);await event(conn,'CustomerReceivableAdjusted','financial_customer_credit_adjustment',insert.insertId,user,{receivable_id:receivableId,amount:amount.value,status});await conn.commit();return {adjustment_id:insert.insertId,receivable_status:status}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

module.exports={applyTrigger,createPaymentPlan,materializeApFromAcceptedConfirmation,materializeReceivable,openDispute,registerCreditNote,registerCustomerCreditAdjustment,registerCustomerPayment,registerSupplierInvoice,registerSupplierPayment}
