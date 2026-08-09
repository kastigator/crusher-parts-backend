const db = require('../../utils/db')
const { parseJson, toId } = require('./helpers')

const JSON_FIELDS = new Set([
  'source_snapshot_json','blocker_reasons_json','source_policy_snapshot_json','source_trace_snapshot_json',
  'scope_snapshot_json','allocation_snapshot_json','evidence_snapshot_json','readiness_reasons_json',
  'legal_entity_snapshot_json','client_snapshot_json','payer_snapshot_json','payload_json',
])
const decode = (row) => Object.entries(row).reduce((out,[key,value]) => ({ ...out, [key]: JSON_FIELDS.has(key) ? parseJson(value,key.includes('reasons')?[]:{}) : value }), {})
const rows = (sql,params=[]) => db.execute(sql,params).then(([result])=>result.map(decode))

async function getOverview(){
  const [ap,ar,exceptions,calendar]=await Promise.all([
    rows(`SELECT COUNT(*) case_count,COALESCE(SUM(total_amount),0) total_amount,currency,status FROM financial_ap_cases GROUP BY currency,status ORDER BY currency,status`),
    rows(`SELECT COUNT(*) receivable_count,COALESCE(SUM(expected_amount),0) expected_amount,currency,status FROM financial_customer_receivables GROUP BY currency,status ORDER BY currency,status`),
    rows(`SELECT 'AP_BLOCKER' type,id reference_id,case_number reference,status,blocker_reasons_json reasons,updated_at occurred_at FROM financial_ap_cases WHERE status='BLOCKED'
          UNION ALL SELECT 'DISPUTE',id,CONCAT('DISPUTE-',id),status,evidence_snapshot_json,opened_at FROM financial_disputes WHERE status IN ('OPEN','UNDER_REVIEW') ORDER BY occurred_at DESC`),
    rows(`SELECT 'AP' direction,c.id reference_id,a.case_number reference,c.expected_amount amount,c.currency,COALESCE(c.planned_payment_date,c.contractual_due_date) event_date,c.status
          FROM financial_commitments c JOIN financial_ap_cases a ON a.id=c.financial_ap_case_id WHERE c.status NOT IN ('PAID','CANCELLED','CORRECTED')
          UNION ALL SELECT 'AR',r.id,r.receivable_number,r.expected_amount,r.currency,r.due_date,r.status FROM financial_customer_receivables r WHERE r.status NOT IN ('PAID','CANCELLED','WAIVED') ORDER BY event_date`),
  ])
  return {ap,ar,exceptions,calendar,boundaries:{statutory_accounting:false,tax_ledger:false,procurement:'read_only_accepted_confirmation',contract:'read_only_effective_commitment',warehouse:false,dispatch:false,completion:'read_only_projection'}}
}
async function getWorkspace(){
  const [overview,ap_cases,schedules,stages,commitments,invoices,invoice_allocations,supplier_payments,supplier_payment_allocations,disputes,receivables,customer_payments,customer_payment_allocations,history]=await Promise.all([
    getOverview(),
    rows(`SELECT a.*,s.name supplier_name FROM financial_ap_cases a LEFT JOIN part_suppliers s ON s.id=a.supplier_id ORDER BY a.updated_at DESC,a.id DESC`),
    rows(`SELECT s.*,r.revision_number,r.source_policy_snapshot_json FROM financial_payment_schedules s LEFT JOIN financial_payment_schedule_revisions r ON r.id=s.current_revision_id ORDER BY s.updated_at DESC`),
    rows(`SELECT s.*,c.id commitment_id,c.status commitment_status FROM financial_payment_schedule_stages s LEFT JOIN financial_commitments c ON c.payment_schedule_stage_id=s.id ORDER BY s.financial_payment_schedule_revision_id,s.stage_number`),
    rows(`SELECT c.*,a.case_number,s.name supplier_name,
          COALESCE((SELECT SUM(x.allocated_amount) FROM financial_invoice_allocations x WHERE x.financial_commitment_id=c.id AND x.status='CONFIRMED'),0)
            - COALESCE((SELECT SUM(x.allocated_amount) FROM financial_credit_note_allocations x WHERE x.financial_commitment_id=c.id AND x.status='CONFIRMED'),0) invoiced_amount,
          COALESCE((SELECT SUM(x.allocated_amount) FROM financial_supplier_payment_allocations x WHERE x.financial_commitment_id=c.id AND x.status='CONFIRMED'),0) paid_amount
          FROM financial_commitments c JOIN financial_ap_cases a ON a.id=c.financial_ap_case_id LEFT JOIN part_suppliers s ON s.id=c.supplier_id ORDER BY COALESCE(c.planned_payment_date,c.contractual_due_date),c.id`),
    rows(`SELECT i.*,s.name supplier_name,COALESCE(SUM(a.allocated_amount),0) allocated_amount FROM financial_supplier_invoices i LEFT JOIN part_suppliers s ON s.id=i.supplier_id LEFT JOIN financial_invoice_allocations a ON a.supplier_invoice_id=i.id AND a.status='CONFIRMED' GROUP BY i.id,s.name ORDER BY i.invoice_date DESC,i.id DESC`),
    rows(`SELECT a.* FROM financial_invoice_allocations a ORDER BY a.allocated_at DESC,a.id DESC`),
    rows(`SELECT p.*,s.name supplier_name,COALESCE(SUM(a.allocated_amount),0) allocated_amount FROM financial_supplier_payments p LEFT JOIN part_suppliers s ON s.id=p.supplier_id LEFT JOIN financial_supplier_payment_allocations a ON a.supplier_payment_id=p.id AND a.status='CONFIRMED' GROUP BY p.id,s.name ORDER BY p.payment_date DESC,p.id DESC`),
    rows(`SELECT * FROM financial_supplier_payment_allocations ORDER BY allocated_at DESC,id DESC`),
    rows(`SELECT d.*,s.external_invoice_number FROM financial_disputes d LEFT JOIN financial_supplier_invoices s ON s.id=d.supplier_invoice_id ORDER BY d.opened_at DESC,d.id DESC`),
    rows(`SELECT r.*,c.company_name client_name,
          COALESCE((SELECT SUM(a.allocated_amount) FROM financial_customer_payment_allocations a WHERE a.customer_receivable_id=r.id AND a.status='CONFIRMED'),0) received_amount,
          COALESCE((SELECT SUM(a.amount) FROM financial_customer_credit_adjustments a WHERE a.customer_receivable_id=r.id AND a.status='APPROVED'),0) credited_amount
          FROM financial_customer_receivables r LEFT JOIN clients c ON c.id=r.client_id ORDER BY COALESCE(r.due_date,'9999-12-31'),r.id`),
    rows(`SELECT p.*,c.company_name client_name,COALESCE(SUM(a.allocated_amount),0) allocated_amount FROM financial_customer_payments p LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN financial_customer_payment_allocations a ON a.customer_payment_id=p.id AND a.status='CONFIRMED' GROUP BY p.id,c.company_name ORDER BY p.payment_date DESC,p.id DESC`),
    rows(`SELECT * FROM financial_customer_payment_allocations ORDER BY allocated_at DESC,id DESC`),
    rows(`SELECT e.*,u.full_name actor_name FROM financial_events e LEFT JOIN users u ON u.id=e.actor_user_id ORDER BY e.occurred_at DESC,e.id DESC LIMIT 500`),
  ])
  const [confirmation_intake,commitment_intake]=await Promise.all([
    rows(`SELECT sc.id,sc.confirmation_reference,sc.accepted_at,po.po_number,ps.name supplier_name,ap.case_number
      FROM procurement_supplier_confirmations sc JOIN procurement_purchase_order_revisions por ON por.id=sc.procurement_purchase_order_revision_id
      JOIN procurement_purchase_orders po ON po.id=por.procurement_purchase_order_id LEFT JOIN part_suppliers ps ON ps.id=po.supplier_id
      LEFT JOIN financial_ap_cases ap ON ap.source_supplier_confirmation_id=sc.id WHERE sc.status='ACCEPTED' ORDER BY sc.accepted_at DESC,sc.id DESC`),
    rows(`SELECT cc.id,cc.quantity,cc.uom,cc.line_total,cc.currency,co.contract_number,c.company_name client_name,cl.line_number,r.receivable_number
      FROM contract_commitments cc JOIN contract_cases co ON co.id=cc.contract_case_id JOIN contract_lines cl ON cl.id=cc.contract_line_id
      JOIN clients c ON c.id=co.client_id LEFT JOIN financial_customer_receivables r ON r.contract_commitment_id=cc.id
      WHERE co.aggregate_status='EFFECTIVE' ORDER BY co.contract_number,cl.line_number`),
  ])
  return {overview,ap_cases,schedules,stages,commitments,invoices,invoice_allocations,supplier_payments,supplier_payment_allocations,disputes,receivables,customer_payments,customer_payment_allocations,history,confirmation_intake,commitment_intake}
}
async function getPoFinancialSummary(idInput){const id=toId(idInput);if(!id)return null;const [cases]=await rows(`SELECT a.*,s.id schedule_id,s.status schedule_status FROM financial_ap_cases a LEFT JOIN financial_payment_schedules s ON s.financial_ap_case_id=a.id WHERE a.source_po_id=?`,[id]);const commitments=cases.length?await rows(`SELECT c.* FROM financial_commitments c WHERE c.financial_ap_case_id IN (${cases.map(()=>'?').join(',')}) ORDER BY c.id`,cases.map(x=>x.id)):[];return {purchase_order_id:id,ap_cases:cases,commitments,boundary:'read_only_financial_projection'}}
async function getCompletionReadiness(){const [ap,ar]=await Promise.all([rows(`SELECT a.id,a.case_number,a.status,COUNT(c.id) commitment_count,SUM(c.status='PAID') paid_count,SUM(c.status='DISPUTED') disputed_count FROM financial_ap_cases a LEFT JOIN financial_commitments c ON c.financial_ap_case_id=a.id GROUP BY a.id ORDER BY a.id`),rows(`SELECT contract_case_id,COUNT(*) receivable_count,SUM(status='PAID') paid_count,SUM(status IN ('OVERDUE','DISPUTED')) blocked_count FROM financial_customer_receivables GROUP BY contract_case_id ORDER BY contract_case_id`)]);return {ap,ar,writes_completion_domain:false,projection_only:true}}

module.exports={getCompletionReadiness,getOverview,getPoFinancialSummary,getWorkspace}
