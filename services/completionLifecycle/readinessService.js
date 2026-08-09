const {CompletionLifecycleError}=require('./domainError')
const {parseJson,sha256}=require('./helpers')
const EPS=0.0005
const rows=async(executor,sql,params=[])=>executor.execute(sql,params).then(([result])=>result)
const blocker=(gate,code,sourceRefs=[],details={})=>({gate,code,source_refs:sourceRefs,details})

async function loadPolicy(executor,revisionId){
  const [policy]=await rows(executor,`SELECT r.*,p.policy_code,p.case_type FROM completion_policy_revisions r JOIN completion_policies p ON p.id=r.completion_policy_id WHERE r.id=?`,[revisionId])
  if(!policy||policy.status!=='ACTIVE')throw new CompletionLifecycleError('ACTIVE_POLICY_REQUIRED','Completion policy revision недоступна',409)
  const snapshot=parseJson(policy.policy_snapshot_json,null)
  if(!snapshot||sha256(snapshot)!==policy.policy_hash)throw new CompletionLifecycleError('POLICY_HASH_MISMATCH','Completion policy snapshot hash mismatch',409)
  const rules=await rows(executor,'SELECT gate_code,gate_requirement,configuration_json,sort_order FROM completion_policy_rules WHERE completion_policy_revision_id=? ORDER BY sort_order,id',[revisionId])
  return {id:Number(policy.id),code:policy.policy_code,case_type:policy.case_type,revision_number:Number(policy.revision_number),snapshot,hash:policy.policy_hash,rules:rules.map(rule=>({...rule,configuration_json:parseJson(rule.configuration_json,{})}))}
}

async function loadSources(executor,completionCase){
  const contractCaseId=Number(completionCase.contract_case_id)
  const [contract]=await rows(executor,`SELECT c.id,c.contract_number,c.aggregate_status,c.current_revision_id,c.client_id,cl.company_name,
      r.status revision_status,r.content_hash,r.effective_at,r.shipping_address_snapshot_json,r.client_snapshot_json,r.company_legal_snapshot_json
    FROM contract_cases c JOIN clients cl ON cl.id=c.client_id LEFT JOIN contract_revisions r ON r.id=c.current_revision_id WHERE c.id=?`,[contractCaseId])
  if(!contract)throw new CompletionLifecycleError('CONTRACT_CASE_NOT_FOUND','Source Contract Case не найден',404)
  const commitments=await rows(executor,`SELECT cc.id,cc.contract_line_id,cc.commitment_type,cc.quantity,cc.uom,cc.unit_price,cc.currency,cc.line_total,
      cc.commitment_hash,cc.procurement_readiness,cc.readiness_reasons_json,cc.fulfillment_status,cc.delivery_snapshot_json,cc.payment_snapshot_json,
      COALESCE((SELECT SUM(dl.delivered_quantity) FROM dispatch_delivery_confirmation_lines dl
        JOIN dispatch_delivery_confirmations dc ON dc.id=dl.dispatch_delivery_confirmation_id AND dc.status='CONFIRMED'
        JOIN dispatch_order_allocations da ON da.id=dl.dispatch_order_allocation_id WHERE da.contract_commitment_id=cc.id),0) delivered_quantity,
      COALESCE((SELECT SUM(da.allocated_quantity) FROM dispatch_order_allocations da JOIN dispatch_orders o ON o.id=da.dispatch_order_id
        WHERE da.contract_commitment_id=cc.id AND o.status<>'CANCELLED'),0) allocated_quantity
    FROM contract_commitments cc WHERE cc.contract_case_id=? ORDER BY cc.id`,[contractCaseId])
  const procurement=await rows(executor,`SELECT i.id procurement_item_id,i.contract_commitment_id,i.readiness_status,i.allocated_quantity,i.purchase_quantity,i.excess_quantity,i.purchase_unit_price,i.purchase_currency,
      pc.id procurement_case_id,pc.case_number procurement_case_number,pc.status procurement_case_status,
      po.id po_id,po.po_number,po.status po_status,pr.id po_revision_id,pr.status po_revision_status,
      sc.id supplier_confirmation_id,sc.confirmation_reference,sc.status supplier_confirmation_status,sc.evidence_hash supplier_confirmation_hash,
      i.supplier_id
    FROM procurement_execution_items i JOIN procurement_execution_cases pc ON pc.id=i.procurement_execution_case_id
    LEFT JOIN procurement_purchase_order_lines pol ON pol.procurement_execution_item_id=i.id
    LEFT JOIN procurement_purchase_order_revisions pr ON pr.id=pol.procurement_purchase_order_revision_id
    LEFT JOIN procurement_purchase_orders po ON po.id=pr.procurement_purchase_order_id AND po.current_revision_id=pr.id
    LEFT JOIN procurement_supplier_confirmations sc ON sc.procurement_purchase_order_revision_id=pr.id AND sc.status='ACCEPTED'
    WHERE i.contract_commitment_id IN (SELECT id FROM contract_commitments WHERE contract_case_id=?) ORDER BY i.id,po.id,sc.id`,[contractCaseId])
  const procurementChanges=await rows(executor,`SELECT cr.id,cr.procurement_execution_case_id,cr.target_domain,cr.reason_code,cr.status
    FROM procurement_change_requests cr JOIN procurement_execution_cases pc ON pc.id=cr.procurement_execution_case_id
    JOIN procurement_execution_items i ON i.procurement_execution_case_id=pc.id
    JOIN contract_commitments cc ON cc.id=i.contract_commitment_id WHERE cc.contract_case_id=? AND cr.status IN ('OPEN','ACKNOWLEDGED') GROUP BY cr.id`,[contractCaseId])
  const orders=await rows(executor,`SELECT o.id,o.order_number,o.status,o.row_version,
      COALESCE(SUM(a.allocated_quantity),0) allocated_quantity,
      COALESCE((SELECT SUM(dl.delivered_quantity) FROM dispatch_delivery_confirmation_lines dl JOIN dispatch_delivery_confirmations dc ON dc.id=dl.dispatch_delivery_confirmation_id AND dc.status='CONFIRMED' JOIN dispatch_order_allocations da ON da.id=dl.dispatch_order_allocation_id WHERE da.dispatch_order_id=o.id),0) delivered_quantity
    FROM dispatch_orders o LEFT JOIN dispatch_order_allocations a ON a.dispatch_order_id=o.id WHERE o.source_contract_case_id=? GROUP BY o.id ORDER BY o.id`,[contractCaseId])
  const warehouseReservations=await rows(executor,`SELECT wr.id,wr.reservation_number,wr.source_entity_id dispatch_order_id,wr.status,COUNT(a.id) allocation_count,COALESCE(SUM(a.quantity),0) quantity
    FROM warehouse_inventory_reservations wr JOIN dispatch_orders o ON o.id=wr.source_entity_id AND wr.source_domain='dispatch_delivery'
    LEFT JOIN warehouse_inventory_reservation_allocations a ON a.warehouse_inventory_reservation_id=wr.id AND a.status='ACTIVE'
    WHERE o.source_contract_case_id=? AND wr.status='ACTIVE' GROUP BY wr.id ORDER BY wr.id`,[contractCaseId])
  const picking=await rows(executor,`SELECT pr.id,pr.request_number,pr.dispatch_order_id,pr.status FROM dispatch_picking_requests pr JOIN dispatch_orders o ON o.id=pr.dispatch_order_id
    WHERE o.source_contract_case_id=? AND (
      pr.status IN ('REQUESTED','ALLOCATED','PICKING','EXCEPTION') OR
      (pr.status IN ('PICKED','STAGED') AND EXISTS (
        SELECT 1 FROM dispatch_picking_request_lines pl
        WHERE pl.dispatch_picking_request_id=pr.id AND NOT EXISTS (
          SELECT 1 FROM dispatch_package_contents pc JOIN dispatch_packages p ON p.id=pc.dispatch_package_id
          WHERE pc.dispatch_picking_request_line_id=pl.id AND p.status IN ('DISPATCHED','DELIVERED')
        )
      ))
    ) ORDER BY pr.id`,[contractCaseId])
  const heldStock=await rows(executor,`SELECT DISTINCT su.id stock_unit_id,su.stock_unit_code,su.quality_status,su.status
    FROM dispatch_package_contents pc JOIN dispatch_order_allocations da ON da.id=pc.dispatch_order_allocation_id
    JOIN dispatch_orders o ON o.id=da.dispatch_order_id JOIN warehouse_stock_units su ON su.id=pc.stock_unit_id
    WHERE o.source_contract_case_id=? AND (su.quality_status IN ('HOLD','REJECTED') OR su.status='ACTIVE') ORDER BY su.id`,[contractCaseId])
  const deliveries=await rows(executor,`SELECT dc.id,dc.confirmation_number,dc.dispatch_shipment_id,dc.delivered_at,dc.received_by,dc.evidence_reference,dc.evidence_hash,
      SUM(dl.delivered_quantity) delivered_quantity
    FROM dispatch_delivery_confirmations dc JOIN dispatch_delivery_confirmation_lines dl ON dl.dispatch_delivery_confirmation_id=dc.id
    JOIN dispatch_order_allocations da ON da.id=dl.dispatch_order_allocation_id JOIN dispatch_orders o ON o.id=da.dispatch_order_id
    WHERE o.source_contract_case_id=? AND dc.status='CONFIRMED' GROUP BY dc.id ORDER BY dc.delivered_at,dc.id`,[contractCaseId])
  const dispatchExceptions=await rows(executor,`SELECT de.id,de.entity_type,de.entity_id,de.exception_type,de.severity,de.status,de.evidence_reference
    FROM dispatch_exceptions de WHERE de.status IN ('OPEN','ACKNOWLEDGED') AND (
      (de.entity_type='dispatch_order' AND de.entity_id IN (SELECT id FROM dispatch_orders WHERE source_contract_case_id=?)) OR
      (de.entity_type='dispatch_picking_request' AND de.entity_id IN (SELECT pr.id FROM dispatch_picking_requests pr JOIN dispatch_orders o ON o.id=pr.dispatch_order_id WHERE o.source_contract_case_id=?)) OR
      (de.entity_type='dispatch_package' AND de.entity_id IN (SELECT p.id FROM dispatch_packages p JOIN dispatch_orders o ON o.id=p.dispatch_order_id WHERE o.source_contract_case_id=?)) OR
      (de.entity_type='dispatch_shipment' AND de.entity_id IN (SELECT sp.dispatch_shipment_id FROM dispatch_shipment_packages sp JOIN dispatch_packages p ON p.id=sp.dispatch_package_id JOIN dispatch_orders o ON o.id=p.dispatch_order_id WHERE o.source_contract_case_id=?)) OR
      (de.entity_type='dispatch_delivery_confirmation' AND de.entity_id IN (SELECT dc.id FROM dispatch_delivery_confirmations dc JOIN dispatch_shipment_packages sp ON sp.dispatch_shipment_id=dc.dispatch_shipment_id JOIN dispatch_packages p ON p.id=sp.dispatch_package_id JOIN dispatch_orders o ON o.id=p.dispatch_order_id WHERE o.source_contract_case_id=?))
    ) ORDER BY de.id`,[contractCaseId,contractCaseId,contractCaseId,contractCaseId,contractCaseId])
  const ap=await rows(executor,`SELECT DISTINCT a.id,a.case_number,a.source_supplier_confirmation_id,a.source_po_id,a.status,a.currency,a.total_amount,
      COUNT(fc.id) commitment_count,SUM(fc.status IN ('PAID','CANCELLED','CORRECTED')) resolved_count,
      SUM(fc.status='DISPUTED') disputed_count
    FROM financial_ap_cases a LEFT JOIN financial_commitments fc ON fc.financial_ap_case_id=a.id
    WHERE a.source_supplier_confirmation_id IN (
      SELECT sc.id FROM procurement_supplier_confirmations sc JOIN procurement_purchase_order_revisions pr ON pr.id=sc.procurement_purchase_order_revision_id
      JOIN procurement_purchase_order_lines pol ON pol.procurement_purchase_order_revision_id=pr.id JOIN procurement_execution_items i ON i.id=pol.procurement_execution_item_id
      JOIN contract_commitments cc ON cc.id=i.contract_commitment_id WHERE cc.contract_case_id=? AND sc.status='ACCEPTED'
    ) GROUP BY a.id ORDER BY a.id`,[contractCaseId])
  const ar=await rows(executor,`SELECT r.id,r.receivable_number,r.contract_commitment_id,r.status,r.currency,r.expected_amount,r.due_date,r.readiness_reasons_json,
      COALESCE((SELECT SUM(a.allocated_amount) FROM financial_customer_payment_allocations a WHERE a.customer_receivable_id=r.id AND a.status='CONFIRMED'),0) paid_amount,
      COALESCE((SELECT SUM(c.amount) FROM financial_customer_credit_adjustments c WHERE c.customer_receivable_id=r.id AND c.status='APPROVED'),0) credited_amount
    FROM financial_customer_receivables r WHERE r.contract_case_id=? ORDER BY r.id`,[contractCaseId])
  const disputes=await rows(executor,`SELECT DISTINCT d.id,COALESCE(d.financial_commitment_id,ia.financial_commitment_id) financial_commitment_id,d.reason_code,d.status,d.disputed_amount,d.currency
    FROM financial_disputes d LEFT JOIN financial_commitments fc ON fc.id=d.financial_commitment_id
    LEFT JOIN financial_invoice_allocations ia ON ia.supplier_invoice_id=d.supplier_invoice_id AND ia.status='CONFIRMED'
    LEFT JOIN financial_commitments ifc ON ifc.id=ia.financial_commitment_id
    JOIN financial_ap_cases a ON a.id=COALESCE(fc.financial_ap_case_id,ifc.financial_ap_case_id)
    WHERE d.status IN ('OPEN','UNDER_REVIEW') AND a.source_supplier_confirmation_id IN (
      SELECT sc.id FROM procurement_supplier_confirmations sc JOIN procurement_purchase_order_revisions pr ON pr.id=sc.procurement_purchase_order_revision_id
      JOIN procurement_purchase_order_lines pol ON pol.procurement_purchase_order_revision_id=pr.id JOIN procurement_execution_items i ON i.id=pol.procurement_execution_item_id
      JOIN contract_commitments cc ON cc.id=i.contract_commitment_id WHERE cc.contract_case_id=?
    ) ORDER BY d.id`,[contractCaseId])
  const [documents]=await rows(executor,`SELECT COUNT(*) document_count FROM contract_documents d WHERE d.contract_revision_id=?`,[contract.current_revision_id])
  const traceability=await rows(executor,`SELECT cc.id contract_commitment_id,da.id dispatch_allocation_id,p.id package_id,p.package_number,s.id shipment_id,s.shipment_number,
      dc.id pod_id,dc.confirmation_number pod_number,pc.stock_unit_id,su.stock_unit_code,su.internal_lot_number,wr.id warehouse_receipt_id,wr.receipt_number,
      we.id inbound_expectation_id,we.expectation_number,po.id supplier_po_id,po.po_number,sc.id supplier_confirmation_id,i.supplier_id,ps.name supplier_name
    FROM contract_commitments cc JOIN dispatch_order_allocations da ON da.contract_commitment_id=cc.id
    JOIN dispatch_package_contents pc ON pc.dispatch_order_allocation_id=da.id JOIN dispatch_packages p ON p.id=pc.dispatch_package_id
    JOIN dispatch_shipment_packages sp ON sp.dispatch_package_id=p.id JOIN dispatch_shipments s ON s.id=sp.dispatch_shipment_id
    JOIN dispatch_delivery_confirmation_lines dl ON dl.dispatch_order_allocation_id=da.id JOIN dispatch_delivery_confirmations dc ON dc.id=dl.dispatch_delivery_confirmation_id AND dc.dispatch_shipment_id=s.id AND dc.status='CONFIRMED'
    JOIN warehouse_stock_units su ON su.id=pc.stock_unit_id JOIN warehouse_receipt_lines wrl ON wrl.id=su.root_receipt_line_id JOIN warehouse_receipts wr ON wr.id=wrl.warehouse_receipt_id
    JOIN warehouse_inbound_expectation_lines wel ON wel.id=wrl.warehouse_inbound_expectation_line_id JOIN warehouse_inbound_expectations we ON we.id=wel.warehouse_inbound_expectation_id
    JOIN procurement_purchase_order_lines pol ON pol.id=wel.source_po_line_id JOIN procurement_purchase_order_revisions por ON por.id=pol.procurement_purchase_order_revision_id
    JOIN procurement_purchase_orders po ON po.id=por.procurement_purchase_order_id JOIN procurement_execution_items i ON i.id=pol.procurement_execution_item_id
    JOIN part_suppliers ps ON ps.id=i.supplier_id LEFT JOIN procurement_supplier_confirmations sc ON sc.id=we.source_supplier_confirmation_id
    WHERE cc.contract_case_id=? ORDER BY cc.id,da.id,pc.id,dc.id`,[contractCaseId])
  return {contract:{...contract,shipping_address_snapshot_json:parseJson(contract.shipping_address_snapshot_json,{}),client_snapshot_json:parseJson(contract.client_snapshot_json,{}),company_legal_snapshot_json:parseJson(contract.company_legal_snapshot_json,{})},commitments:commitments.map(x=>({...x,readiness_reasons_json:parseJson(x.readiness_reasons_json,[]),delivery_snapshot_json:parseJson(x.delivery_snapshot_json,{}),payment_snapshot_json:parseJson(x.payment_snapshot_json,{})})),procurement,procurement_changes:procurementChanges,warehouse:{active_reservations:warehouseReservations,active_picking:picking,held_or_active_package_stock:heldStock},dispatch:{orders,delivery_confirmations:deliveries,open_exceptions:dispatchExceptions},finance:{ap,ar:ar.map(x=>({...x,readiness_reasons_json:parseJson(x.readiness_reasons_json,[])})),open_disputes:disputes},documents:{contract_document_count:Number(documents?.document_count||0)},traceability}
}

function evaluateGates(sources,policy){
  const byGate=new Map(),warnings=[]
  const add=(gate,code,refs=[],details={})=>{if(!byGate.has(gate))byGate.set(gate,[]);byGate.get(gate).push(blocker(gate,code,refs,details))}
  const {contract,commitments,procurement,procurement_changes:changes,warehouse,dispatch,finance,documents}=sources
  if(contract.aggregate_status!=='EFFECTIVE'||contract.revision_status!=='EFFECTIVE'||!contract.content_hash)add('CONTRACT_LEGAL','EFFECTIVE_CONTRACT_EVIDENCE_REQUIRED',[{domain:'contract',entity_type:'contract_case',entity_id:contract.id}],{aggregate_status:contract.aggregate_status,revision_status:contract.revision_status})
  if(!commitments.length)add('FULFILLMENT','CONTRACT_COMMITMENTS_MISSING',[{domain:'contract',entity_type:'contract_case',entity_id:contract.id}])
  for(const item of commitments){if(Number(item.delivered_quantity)+EPS<Number(item.quantity))add('FULFILLMENT','CONFIRMED_DELIVERY_INCOMPLETE',[{domain:'contract',entity_type:'contract_commitment',entity_id:item.id},{domain:'dispatch_delivery',entity_type:'proof_of_delivery',entity_id:null}],{required_quantity:Number(item.quantity),confirmed_delivered_quantity:Number(item.delivered_quantity),uom:item.uom})}
  const supply=commitments.filter(x=>x.commitment_type==='SUPPLY'),procurementByCommitment=new Map(procurement.map(x=>[Number(x.contract_commitment_id),x]))
  for(const item of supply){const source=procurementByCommitment.get(Number(item.id));if(!source)add('PROCUREMENT','PROCUREMENT_EXECUTION_MISSING',[{domain:'contract',entity_type:'contract_commitment',entity_id:item.id}]);else if(source.readiness_status!=='READY'||source.supplier_confirmation_status!=='ACCEPTED'||source.po_status!=='CONFIRMED')add('PROCUREMENT','PROCUREMENT_NOT_OPERATIONALLY_COMPLETE',[{domain:'procurement_execution',entity_type:'procurement_execution_item',entity_id:source.procurement_item_id},{domain:'procurement_execution',entity_type:'supplier_confirmation',entity_id:source.supplier_confirmation_id||null}],{readiness_status:source.readiness_status,po_status:source.po_status,confirmation_status:source.supplier_confirmation_status})}
  for(const change of changes)add('PROCUREMENT','UPSTREAM_CHANGE_REQUEST_OPEN',[{domain:'procurement_execution',entity_type:'change_request',entity_id:change.id}],{target_domain:change.target_domain,reason_code:change.reason_code})
  for(const reservation of warehouse.active_reservations)add('WAREHOUSE','ACTIVE_RESERVATION_REMAINS',[{domain:'warehouse_inventory',entity_type:'inventory_reservation',entity_id:reservation.id}],{quantity:Number(reservation.quantity),dispatch_order_id:reservation.dispatch_order_id})
  for(const pick of warehouse.active_picking)add('WAREHOUSE','PICKED_OR_STAGED_WORK_REMAINS',[{domain:'dispatch_delivery',entity_type:'picking_request',entity_id:pick.id}],{status:pick.status})
  for(const unit of warehouse.held_or_active_package_stock)add('WAREHOUSE','CASE_STOCK_NOT_FULLY_ISSUED',[{domain:'warehouse_inventory',entity_type:'stock_unit',entity_id:unit.stock_unit_id}],{quality_status:unit.quality_status,status:unit.status})
  for(const item of supply){if(Number(item.allocated_quantity)<=EPS)add('DISPATCH','DISPATCH_ORDER_MISSING',[{domain:'contract',entity_type:'contract_commitment',entity_id:item.id}]);if(Number(item.delivered_quantity)+EPS<Number(item.quantity))add('DISPATCH','POD_CONFIRMED_DELIVERY_REQUIRED',[{domain:'contract',entity_type:'contract_commitment',entity_id:item.id}],{required_quantity:Number(item.quantity),confirmed_delivered_quantity:Number(item.delivered_quantity)})}
  for(const order of dispatch.orders.filter(x=>!['COMPLETED','CANCELLED'].includes(x.status)))add('DISPATCH','DISPATCH_ORDER_ACTIVE',[{domain:'dispatch_delivery',entity_type:'dispatch_order',entity_id:order.id}],{status:order.status})
  const acceptedConfirmationIds=new Set(procurement.filter(x=>x.supplier_confirmation_status==='ACCEPTED').map(x=>Number(x.supplier_confirmation_id))),apConfirmationIds=new Set(finance.ap.map(x=>Number(x.source_supplier_confirmation_id)))
  for(const item of supply){const source=procurementByCommitment.get(Number(item.id));if(!source?.supplier_confirmation_id)add('AP','AP_EVIDENCE_MISSING',[{domain:'contract',entity_type:'contract_commitment',entity_id:item.id}],{reason:'accepted_supplier_confirmation_missing'})}
  for(const confirmationId of acceptedConfirmationIds){if(!apConfirmationIds.has(confirmationId))add('AP','AP_EVIDENCE_MISSING',[{domain:'procurement_execution',entity_type:'supplier_confirmation',entity_id:confirmationId}])}
  for(const ap of finance.ap){
    if(Number(ap.commitment_count)!==Number(ap.resolved_count)||Number(ap.disputed_count)>0)add('AP','SUPPLIER_AP_NOT_COMPLETE',[{domain:'financial_operations',entity_type:'ap_case',entity_id:ap.id}],{status:ap.status,commitment_count:Number(ap.commitment_count),resolved_count:Number(ap.resolved_count),disputed_count:Number(ap.disputed_count)})
    else if(!['COMPLETED','CANCELLED'].includes(ap.status))warnings.push(blocker('AP','AP_CASE_STATUS_PROJECTION_LAG',[{domain:'financial_operations',entity_type:'ap_case',entity_id:ap.id}],{status:ap.status,resolved_count:Number(ap.resolved_count)}))
  }
  const arByCommitment=new Map(finance.ar.map(x=>[Number(x.contract_commitment_id),x]))
  for(const item of commitments){const ar=arByCommitment.get(Number(item.id));if(!ar)add('AR','CUSTOMER_RECEIVABLE_MISSING',[{domain:'contract',entity_type:'contract_commitment',entity_id:item.id}]);else{const balance=Number(ar.expected_amount)-Number(ar.paid_amount)-Number(ar.credited_amount);if(ar.readiness_reasons_json.length)add('AR','CUSTOMER_RECEIVABLE_READINESS_BLOCKED',[{domain:'financial_operations',entity_type:'customer_receivable',entity_id:ar.id}],{reasons:ar.readiness_reasons_json});if(balance>0.00005||!['PAID','CANCELLED','WAIVED'].includes(ar.status))add('AR','CUSTOMER_AR_NOT_COMPLETE',[{domain:'financial_operations',entity_type:'customer_receivable',entity_id:ar.id}],{status:ar.status,balance:Number(balance.toFixed(4)),currency:ar.currency})}}
  for(const dispute of finance.open_disputes)add('CLAIMS_COMPLIANCE','FINANCIAL_DISPUTE_OPEN',[{domain:'financial_operations',entity_type:'dispute',entity_id:dispute.id}],{reason_code:dispute.reason_code})
  for(const exception of dispatch.open_exceptions)add('CLAIMS_COMPLIANCE','DISPATCH_EXCEPTION_OPEN',[{domain:'dispatch_delivery',entity_type:exception.entity_type,entity_id:exception.entity_id},{domain:'dispatch_delivery',entity_type:'dispatch_exception',entity_id:exception.id}],{exception_type:exception.exception_type,severity:exception.severity})
  if(!documents.contract_document_count)add('REQUIRED_DOCUMENTS','CONTRACT_DOCUMENT_EVIDENCE_MISSING',[{domain:'contract',entity_type:'contract_revision',entity_id:contract.current_revision_id}])
  const blockers=[]
  for(const rule of policy.rules){const gateFindings=byGate.get(rule.gate_code)||[];if(rule.gate_requirement==='REQUIRED')blockers.push(...gateFindings);else if(rule.gate_requirement==='OPTIONAL')warnings.push(...gateFindings)}
  return {state:blockers.length?'NOT_READY':'READY_TO_CLOSE',blockers,warnings,gates:policy.rules.map(rule=>({gate_code:rule.gate_code,requirement:rule.gate_requirement,status:(byGate.get(rule.gate_code)||[]).length?'BLOCKED':'SATISFIED',findings:byGate.get(rule.gate_code)||[]}))}
}

async function evaluate(executor,completionCase){const policy=await loadPolicy(executor,completionCase.completion_policy_revision_id),sources=await loadSources(executor,completionCase),result=evaluateGates(sources,policy);const sourceSnapshot={contract:sources.contract,commitments:sources.commitments,procurement:sources.procurement,procurement_changes:sources.procurement_changes,warehouse:sources.warehouse,dispatch:sources.dispatch,finance:sources.finance,documents:sources.documents};return {...result,policy,source_snapshot:sourceSnapshot,traceability:sources.traceability,evaluation_hash:sha256({policy_hash:policy.hash,source_snapshot:sourceSnapshot,blockers:result.blockers,warnings:result.warnings,state:result.state})}}
module.exports={evaluate,evaluateGates,loadPolicy,loadSources}
