const {AfterSalesError}=require('./domainError')
const {id,sha256,toId}=require('./helpers')

async function deliveredTrace(conn,{contractCaseId,clientId,deliveryConfirmationLineId,packageContentId,clientEquipmentUnitId}){
  const deliveryLineId=id(deliveryConfirmationLineId,'dispatch_delivery_confirmation_line_id')
  const [[row]]=await conn.execute(`SELECT dcl.id delivery_confirmation_line_id,dcl.delivered_quantity,dcl.uom,dc.id delivery_confirmation_id,dc.confirmation_number,dc.delivered_at,dc.evidence_reference delivery_evidence_reference,dc.evidence_hash delivery_evidence_hash,dc.status delivery_status,
    ds.id dispatch_shipment_id,ds.shipment_number,doa.id dispatch_order_allocation_id,doo.id dispatch_order_id,doo.order_number,doo.client_id,doo.source_contract_case_id,
    cc.contract_number,cc.aggregate_status contract_status,co.id contract_commitment_id,co.contract_line_id,co.subject_snapshot_json,co.commitment_hash,doa.catalog_position_id
    FROM dispatch_delivery_confirmation_lines dcl
    JOIN dispatch_delivery_confirmations dc ON dc.id=dcl.dispatch_delivery_confirmation_id AND dc.status='CONFIRMED'
    JOIN dispatch_shipments ds ON ds.id=dc.dispatch_shipment_id
    JOIN dispatch_order_allocations doa ON doa.id=dcl.dispatch_order_allocation_id
    JOIN dispatch_orders doo ON doo.id=doa.dispatch_order_id
    JOIN contract_commitments co ON co.id=doa.contract_commitment_id
    JOIN contract_cases cc ON cc.id=co.contract_case_id
    WHERE dcl.id=? AND doo.source_contract_case_id=? AND doo.client_id=?`,[deliveryLineId,contractCaseId,clientId])
  if(!row)throw new AfterSalesError('CONFIRMED_DELIVERED_LINE_REQUIRED','Claim line должна ссылаться на CONFIRMED delivery line этого Client и Contract',409)

  let packageTrace=null
  const contentId=toId(packageContentId)
  if(contentId){
    const [[content]]=await conn.execute(`SELECT dpc.id dispatch_package_content_id,dpc.dispatch_package_id,dp.package_number,dpc.stock_unit_id,dpc.quantity package_quantity,dpc.uom package_uom,dpc.lineage_snapshot_json,dpc.lineage_hash,
      wsu.stock_unit_code,wsu.root_receipt_line_id warehouse_receipt_line_id,wsu.supplier_part_id,wsu.catalog_position_id stock_catalog_position_id,wsu.supplier_lot_number,wsu.internal_lot_number,wsu.lineage_hash stock_lineage_hash,
      wiel.source_po_line_id procurement_purchase_order_line_id,wie.supplier_id,ps.company_name supplier_name,wr.receipt_number,wr.received_at,ppo.po_number
      FROM dispatch_package_contents dpc JOIN dispatch_packages dp ON dp.id=dpc.dispatch_package_id
      JOIN dispatch_shipment_packages dsp ON dsp.dispatch_package_id=dp.id AND dsp.dispatch_shipment_id=?
      JOIN warehouse_stock_units wsu ON wsu.id=dpc.stock_unit_id
      JOIN warehouse_receipt_lines wrl ON wrl.id=wsu.root_receipt_line_id JOIN warehouse_receipts wr ON wr.id=wrl.warehouse_receipt_id
      JOIN warehouse_inbound_expectation_lines wiel ON wiel.id=wrl.warehouse_inbound_expectation_line_id
      JOIN warehouse_inbound_expectations wie ON wie.id=wiel.warehouse_inbound_expectation_id
      JOIN part_suppliers ps ON ps.id=wie.supplier_id
      JOIN procurement_purchase_order_lines ppol ON ppol.id=wiel.source_po_line_id
      JOIN procurement_purchase_order_revisions ppor ON ppor.id=ppol.procurement_purchase_order_revision_id
      JOIN procurement_purchase_orders ppo ON ppo.id=ppor.procurement_purchase_order_id
      WHERE dpc.id=? AND dpc.dispatch_order_allocation_id=?`,[row.dispatch_shipment_id,contentId,row.dispatch_order_allocation_id])
    if(!content)throw new AfterSalesError('PACKAGE_TRACE_MISMATCH','Package/Stock Unit не принадлежит указанной доставленной строке',409)
    packageTrace=content
  }

  let installation=null
  const installationId=toId(clientEquipmentUnitId)
  if(installationId){
    const [[unit]]=await conn.execute('SELECT id,client_id,equipment_model_id,serial_number,internal_name,site_name FROM client_equipment_units WHERE id=? AND client_id=?',[installationId,clientId])
    if(!unit)throw new AfterSalesError('CLIENT_INSTALLATION_MISMATCH','Client Installation не принадлежит выбранному Client',409)
    installation=unit
  }
  const snapshot={delivery:row,package_stock_supplier:packageTrace,client_installation:installation}
  const gaps=[]
  if(!packageTrace)gaps.push('PACKAGE_STOCK_RECEIPT_PO_SUPPLIER_NOT_SELECTED')
  if(!installation)gaps.push('CLIENT_INSTALLATION_NOT_SELECTED')
  return{row,packageTrace,installation,snapshot,gaps,traceHash:sha256(snapshot)}
}

module.exports={deliveredTrace}
