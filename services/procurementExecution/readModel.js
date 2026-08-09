const db=require('../../utils/db')
const { ProcurementExecutionError }=require('./domainError')
const { parseJson,toId }=require('./helpers')
const fields={
  item:['supplier_snapshot_json','supplier_part_snapshot_json','contract_trace_snapshot_json','sourcing_trace_snapshot_json','readiness_reasons_json'],
  candidate:['grouping_snapshot_json'],revision:['supplier_snapshot_json','buyer_snapshot_json','delivery_snapshot_json','payment_snapshot_json','legal_basis_snapshot_json','presentation_snapshot_json','source_trace_snapshot_json'],
  line:['supplier_part_snapshot_json','source_trace_snapshot_json'],confirmationLine:['confirmed_snapshot_json','comparison_snapshot_json'],event:['payload_json'],change:['before_snapshot_json','requested_change_json','evidence_snapshot_json'],reconfirmation:['confirmed_snapshot_json','comparison_snapshot_json'],document:['content_snapshot_json'],send:['recipient_snapshot_json'],
}
const decode=(row,names)=>(names||[]).reduce((result,name)=>(result[name]=parseJson(result[name],name.endsWith('reasons_json')?[]:{}),result),{...row})
async function listCases(filters={}){
  const params=[],where=[];if(filters.status){where.push('pec.status=?');params.push(filters.status)}
  const [rows]=await db.execute(`SELECT pec.*,CASE WHEN COUNT(DISTINCT ppo.id)>0 AND COUNT(DISTINCT CASE WHEN ppo.status<>'CONFIRMED' THEN ppo.id END)=0 THEN 'CONFIRMED' ELSE pec.status END status,u.full_name owner_name,COUNT(DISTINCT pei.id) item_count,COUNT(DISTINCT CASE WHEN pei.readiness_status='READY' THEN pei.id END) ready_count,COUNT(DISTINCT ppo.id) po_count,MAX(pee.created_at) last_activity_at FROM procurement_execution_cases pec LEFT JOIN users u ON u.id=pec.owner_user_id LEFT JOIN procurement_execution_items pei ON pei.procurement_execution_case_id=pec.id LEFT JOIN procurement_purchase_orders ppo ON ppo.procurement_execution_case_id=pec.id LEFT JOIN procurement_execution_events pee ON pee.procurement_execution_case_id=pec.id ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY pec.id,u.full_name ORDER BY pec.updated_at DESC`,params)
  return rows
}
async function listCommitmentIntake(){
  const [rows]=await db.execute(`SELECT cc.id,cc.quantity,cc.uom,cc.line_total,cc.currency,
      ccase.contract_number,cl.line_number,cl.client_representation_snapshot_json,
      cli.company_name client_name,pei.id procurement_item_id
    FROM contract_commitments cc
    JOIN contract_cases ccase ON ccase.id=cc.contract_case_id
    JOIN contract_lines cl ON cl.id=cc.contract_line_id
    JOIN clients cli ON cli.id=ccase.client_id
    LEFT JOIN procurement_execution_items pei ON pei.contract_commitment_id=cc.id
    WHERE ccase.aggregate_status='EFFECTIVE'
    ORDER BY ccase.contract_number,cl.line_number,cc.id`)
  return rows.map(row=>decode(row,['client_representation_snapshot_json']))
}
async function getWorkspace(idInput){
  const id=toId(idInput);const [[procurementCase]]=await db.execute('SELECT pec.*,u.full_name owner_name FROM procurement_execution_cases pec LEFT JOIN users u ON u.id=pec.owner_user_id WHERE pec.id=?',[id])
  if(!procurementCase)throw new ProcurementExecutionError('CASE_NOT_FOUND','Procurement Execution Case не найден',404)
  const [items,reconfirmations,changes,candidates,candidateItems,orders,revisions,lines,documents,sends,confirmations,confirmationLines,events]=await Promise.all([
    db.execute('SELECT * FROM procurement_execution_items WHERE procurement_execution_case_id=? ORDER BY id',[id]).then(([r])=>r.map(x=>decode(x,fields.item))),
    db.execute('SELECT r.* FROM procurement_supplier_reconfirmations r JOIN procurement_execution_items i ON i.id=r.procurement_execution_item_id WHERE i.procurement_execution_case_id=? ORDER BY r.id',[id]).then(([r])=>r.map(x=>decode(x,fields.reconfirmation))),
    db.execute('SELECT * FROM procurement_change_requests WHERE procurement_execution_case_id=? ORDER BY id',[id]).then(([r])=>r.map(x=>decode(x,fields.change))),
    db.execute('SELECT * FROM procurement_po_candidates WHERE procurement_execution_case_id=? ORDER BY id',[id]).then(([r])=>r.map(x=>decode(x,fields.candidate))),
    db.execute('SELECT ci.* FROM procurement_po_candidate_items ci JOIN procurement_po_candidates c ON c.id=ci.procurement_po_candidate_id WHERE c.procurement_execution_case_id=? ORDER BY ci.procurement_po_candidate_id,ci.procurement_execution_item_id',[id]).then(([r])=>r),
    db.execute('SELECT * FROM procurement_purchase_orders WHERE procurement_execution_case_id=? ORDER BY id',[id]).then(([r])=>r),
    db.execute('SELECT r.* FROM procurement_purchase_order_revisions r JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id WHERE o.procurement_execution_case_id=? ORDER BY r.procurement_purchase_order_id,r.revision_number',[id]).then(([r])=>r.map(x=>decode(x,fields.revision))),
    db.execute('SELECT l.* FROM procurement_purchase_order_lines l JOIN procurement_purchase_order_revisions r ON r.id=l.procurement_purchase_order_revision_id JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id WHERE o.procurement_execution_case_id=? ORDER BY l.id',[id]).then(([r])=>r.map(x=>decode(x,fields.line))),
    db.execute('SELECT d.* FROM procurement_purchase_order_documents d JOIN procurement_purchase_order_revisions r ON r.id=d.procurement_purchase_order_revision_id JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id WHERE o.procurement_execution_case_id=? ORDER BY d.id',[id]).then(([r])=>r.map(x=>decode(x,fields.document))),
    db.execute('SELECT s.* FROM procurement_purchase_order_sends s JOIN procurement_purchase_order_revisions r ON r.id=s.procurement_purchase_order_revision_id JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id WHERE o.procurement_execution_case_id=? ORDER BY s.id',[id]).then(([r])=>r.map(x=>decode(x,fields.send))),
    db.execute('SELECT c.* FROM procurement_supplier_confirmations c JOIN procurement_purchase_order_revisions r ON r.id=c.procurement_purchase_order_revision_id JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id WHERE o.procurement_execution_case_id=? ORDER BY c.id',[id]).then(([r])=>r),
    db.execute('SELECT cl.* FROM procurement_supplier_confirmation_lines cl JOIN procurement_supplier_confirmations c ON c.id=cl.procurement_supplier_confirmation_id JOIN procurement_purchase_order_revisions r ON r.id=c.procurement_purchase_order_revision_id JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id WHERE o.procurement_execution_case_id=? ORDER BY cl.id',[id]).then(([r])=>r.map(x=>decode(x,fields.confirmationLine))),
    db.execute('SELECT e.*,u.full_name actor_name FROM procurement_execution_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.procurement_execution_case_id=? ORDER BY e.created_at,e.id',[id]).then(([r])=>r.map(x=>decode(x,fields.event))),
  ])
  const sourcingDecisionIds=[...new Set(items.map(item=>Number(item.sourcing_trace_snapshot_json?.sourcing_decision_id)).filter(Boolean))]
  const decisionCases=sourcingDecisionIds.length
    ? await db.execute(`SELECT d.id decision_id,d.sourcing_case_id,c.case_number sourcing_case_number FROM sourcing_decisions d JOIN sourcing_cases c ON c.id=d.sourcing_case_id WHERE d.id IN (${sourcingDecisionIds.map(()=>'?').join(',')})`,sourcingDecisionIds).then(([rows])=>rows)
    : []
  const decisionCaseById=new Map(decisionCases.map(row=>[Number(row.decision_id),row]))
  const enrichedChanges=changes.map(change=>{const sourceItem=items.find(item=>Number(item.id)===Number(change.procurement_execution_item_id))||items[0];const trace=sourceItem?.sourcing_trace_snapshot_json||{};const sourceCase=decisionCaseById.get(Number(trace.sourcing_decision_id));return {...change,sourcing_case_id:trace.sourcing_case_id||trace.case_id||sourceCase?.sourcing_case_id||null,sourcing_case_number:trace.sourcing_case_number||sourceCase?.sourcing_case_number||null}})
  return { procurement_case:procurementCase,items:items.map(item=>({...item,reconfirmations:reconfirmations.filter(r=>Number(r.procurement_execution_item_id)===Number(item.id))})),change_requests:enrichedChanges,candidates:candidates.map(c=>({...c,item_ids:candidateItems.filter(i=>Number(i.procurement_po_candidate_id)===Number(c.id)).map(i=>i.procurement_execution_item_id)})),purchase_orders:orders.map(order=>({...order,revisions:revisions.filter(r=>Number(r.procurement_purchase_order_id)===Number(order.id)).map(revision=>({...revision,lines:lines.filter(l=>Number(l.procurement_purchase_order_revision_id)===Number(revision.id)),documents:documents.filter(d=>Number(d.procurement_purchase_order_revision_id)===Number(revision.id)),sends:sends.filter(s=>Number(s.procurement_purchase_order_revision_id)===Number(revision.id)),confirmations:confirmations.filter(c=>Number(c.procurement_purchase_order_revision_id)===Number(revision.id)).map(c=>({...c,lines:confirmationLines.filter(l=>Number(l.procurement_supplier_confirmation_id)===Number(c.id))}))}))})),history:events,boundaries:{contract:'read_only_effective_commitments',sourcing:'read_only_immutable_decision_trace',pricing:'read_only_fixed_projection',warehouse:false,finance:false}}
}
module.exports={ getWorkspace,listCases,listCommitmentIntake }
