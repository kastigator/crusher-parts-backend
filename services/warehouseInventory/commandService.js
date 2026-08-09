const db = require('../../utils/db')
const { WarehouseInventoryError } = require('./domainError')
const { actor, event, json, key, nonNegativeQty, positiveQty, sha256, text, toId } = require('./helpers')

const id = (value, field) => {
  const result = toId(value)
  if (!result) throw new WarehouseInventoryError('INVALID_ID', `Некорректный ${field}`)
  return result
}
async function stockState(conn, stockUnitId, lock = false) {
  const [[row]] = await conn.execute(`SELECT u.*,
    COALESCE(SUM(m.quantity_delta),0) physical_quantity,
    COALESCE(SUM(m.reserved_delta),0) reserved_quantity
    FROM warehouse_stock_units u LEFT JOIN warehouse_inventory_movements m ON m.stock_unit_id=u.id
    WHERE u.id=? GROUP BY u.id${lock ? ' FOR UPDATE' : ''}`, [stockUnitId])
  if (!row) throw new WarehouseInventoryError('STOCK_UNIT_NOT_FOUND', 'Stock Unit не найден', 404)
  row.available_quantity = row.quality_status === 'RELEASED' ? Number(row.physical_quantity) - Number(row.reserved_quantity) : 0
  return row
}
async function location(conn, warehouseId, placeId) {
  const [[warehouse]] = await conn.execute("SELECT id,location_type FROM warehouse_locations WHERE id=? AND is_active=1", [warehouseId])
  if (!warehouse || warehouse.location_type !== 'physical') throw new WarehouseInventoryError('PHYSICAL_WAREHOUSE_REQUIRED', 'Требуется активный физический склад', 409)
  if (placeId) {
    const [[place]] = await conn.execute('SELECT id FROM warehouse_storage_places WHERE id=? AND warehouse_id=? AND is_active=1', [placeId, warehouseId])
    if (!place) throw new WarehouseInventoryError('WAREHOUSE_PLACE_MISMATCH', 'Место хранения не принадлежит складу', 409)
  }
}
async function movement(conn, input) {
  const [result] = await conn.execute(`INSERT INTO warehouse_inventory_movements
    (stock_unit_id,movement_type,quantity_delta,reserved_delta,from_warehouse_id,from_storage_place_id,to_warehouse_id,to_storage_place_id,reason_code,evidence_snapshot_json,operation_key,reversal_of_movement_id,created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [input.stock_unit_id,input.movement_type,input.quantity_delta || 0,input.reserved_delta || 0,
    input.from_warehouse_id || null,input.from_storage_place_id || null,input.to_warehouse_id || null,input.to_storage_place_id || null,
    input.reason_code || null,json(input.evidence),input.operation_key,input.reversal_of_movement_id || null,actor(input.user_id)])
  return result.insertId
}

// Explicit Warehouse command boundary consumed by Dispatch. The caller owns the
// transaction so ShipmentDispatched and the stock issue commit atomically.
async function issueForShipment(conn,payload,userId){
  const shipmentId=id(payload.shipment_id,'shipment_id'),user=actor(userId),lines=Array.isArray(payload.lines)?payload.lines:[]
  if(!conn||typeof conn.execute!=='function')throw new WarehouseInventoryError('WAREHOUSE_TRANSACTION_REQUIRED','Требуется Warehouse transaction boundary')
  if(!lines.length)throw new WarehouseInventoryError('DISPATCH_LINES_REQUIRED','Shipment не содержит Stock Unit lines')
  const issued=[]
  for(const item of lines){
    const allocationId=id(item.warehouse_reservation_allocation_id,'warehouse_reservation_allocation_id'),unitId=id(item.stock_unit_id,'stock_unit_id'),qty=positiveQty(item.quantity,'quantity')
    const [[allocation]]=await conn.execute(`SELECT a.*,r.status reservation_status,r.source_domain,r.source_entity_type,r.source_entity_id
      FROM warehouse_inventory_reservation_allocations a JOIN warehouse_inventory_reservations r ON r.id=a.warehouse_inventory_reservation_id
      WHERE a.id=? FOR UPDATE`,[allocationId])
    if(!allocation||allocation.status!=='ACTIVE'||allocation.reservation_status!=='ACTIVE')throw new WarehouseInventoryError('ACTIVE_DISPATCH_RESERVATION_REQUIRED','Требуется активная Warehouse reservation allocation',409)
    if(allocation.source_domain!=='dispatch_delivery')throw new WarehouseInventoryError('DISPATCH_RESERVATION_REQUIRED','Reservation должна принадлежать Dispatch & Delivery',409)
    if(Number(allocation.stock_unit_id)!==unitId||Math.abs(Number(allocation.quantity)-qty)>0.0005)throw new WarehouseInventoryError('RESERVATION_LINE_MISMATCH','Shipment content должен точно совпадать с Warehouse reservation allocation',409)
    const unit=await stockState(conn,unitId,true)
    if(unit.quality_status!=='RELEASED')throw new WarehouseInventoryError('RELEASED_STOCK_REQUIRED','Dispatch разрешён только для RELEASED stock',409)
    if(Number(unit.physical_quantity)+0.0005<qty||Number(unit.reserved_quantity)+0.0005<qty)throw new WarehouseInventoryError('INSUFFICIENT_RESERVED_STOCK','Недостаточно physical/reserved stock для dispatch',409)
    const operationKey=`dispatch:${shipmentId}:reservation-allocation:${allocationId}`
    const [[duplicate]]=await conn.execute('SELECT id FROM warehouse_inventory_movements WHERE operation_key=?',[operationKey])
    if(duplicate){issued.push({movement_id:duplicate.id,stock_unit_id:unitId,already_exists:true});continue}
    const movementId=await movement(conn,{stock_unit_id:unitId,movement_type:'ISSUE_DISPATCH',quantity_delta:-qty,reserved_delta:-qty,
      from_warehouse_id:unit.warehouse_id,from_storage_place_id:unit.current_storage_place_id,
      reason_code:'SHIPMENT_DISPATCHED',evidence:{shipment_id:shipmentId,dispatch_package_content_id:item.package_content_id||null,reservation_allocation_id:allocationId,evidence:payload.evidence||{}},operation_key:operationKey,user_id:user})
    await conn.execute("UPDATE warehouse_inventory_reservation_allocations SET status='CONSUMED' WHERE id=? AND status='ACTIVE'",[allocationId])
    const [[remaining]]=await conn.execute("SELECT COUNT(*) count FROM warehouse_inventory_reservation_allocations WHERE warehouse_inventory_reservation_id=? AND status='ACTIVE'",[allocation.warehouse_inventory_reservation_id])
    if(!Number(remaining.count))await conn.execute("UPDATE warehouse_inventory_reservations SET status='CONSUMED' WHERE id=? AND status='ACTIVE'",[allocation.warehouse_inventory_reservation_id])
    if(Number(unit.physical_quantity)-qty<=0.0005)await conn.execute("UPDATE warehouse_stock_units SET status='DEPLETED',row_version=row_version+1 WHERE id=?",[unitId])
    issued.push({movement_id:movementId,stock_unit_id:unitId,quantity:qty})
  }
  await event(conn,'StockIssuedForShipment','warehouse_shipment_issue',shipmentId,user,{shipment_id:shipmentId,issued},{domain:'dispatch_delivery',entity_type:'dispatch_shipment',entity_id:shipmentId})
  return issued
}

async function materializeExpectedInbound(confirmationIdInput, userId) {
  const confirmationId = id(confirmationIdInput, 'confirmation_id'), user = actor(userId), conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[source]] = await conn.execute(`SELECT c.*,r.procurement_purchase_order_id,r.content_hash,r.supplier_snapshot_json,r.delivery_snapshot_json,
      r.source_trace_snapshot_json,o.po_number,o.supplier_id,o.status po_status
      FROM procurement_supplier_confirmations c
      JOIN procurement_purchase_order_revisions r ON r.id=c.procurement_purchase_order_revision_id
      JOIN procurement_purchase_orders o ON o.id=r.procurement_purchase_order_id WHERE c.id=? FOR UPDATE`, [confirmationId])
    if (!source) throw new WarehouseInventoryError('CONFIRMATION_NOT_FOUND', 'Supplier Confirmation не найден', 404)
    if (source.status !== 'ACCEPTED' || !source.accepted_at || source.po_status !== 'CONFIRMED') throw new WarehouseInventoryError('ACCEPTED_CONFIRMATION_REQUIRED', 'Expected inbound возникает только из SupplierConfirmationAccepted', 409)
    if (!source.evidence_hash || !source.content_hash) throw new WarehouseInventoryError('SOURCE_HASH_REQUIRED', 'Confirmation evidence hash и PO revision hash обязательны', 409)
    const [[existing]] = await conn.execute('SELECT id,status FROM warehouse_inbound_expectations WHERE source_supplier_confirmation_id=?', [confirmationId])
    if (existing) { await conn.commit(); return { expectation_id: existing.id, status: existing.status, already_exists: true } }
    const [lines] = await conn.execute(`SELECT pol.id source_po_line_id,pol.line_number,pol.procurement_execution_item_id,pol.quantity,pol.uom,pol.line_hash,
      pcl.id source_confirmation_line_id,pcl.discrepancy_class,
      COALESCE(pei.supplier_part_id,(SELECT sp.id FROM supplier_parts sp WHERE sp.supplier_id=sdl.supplier_id AND UPPER(TRIM(sp.supplier_part_number))=UPPER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(pol.supplier_part_snapshot_json,'$.part_number')))) ORDER BY sp.id DESC LIMIT 1)) supplier_part_id,
      COALESCE(sdl.offered_catalog_position_id,sd.catalog_position_id_snapshot) catalog_position_id,
      pol.supplier_part_snapshot_json,pol.source_trace_snapshot_json
      FROM procurement_purchase_order_lines pol
      JOIN procurement_execution_items pei ON pei.id=pol.procurement_execution_item_id
      JOIN sourcing_decision_lines sdl ON sdl.id=pei.sourcing_decision_line_id
      JOIN sourcing_demands sd ON sd.id=sdl.sourcing_demand_id
      LEFT JOIN procurement_supplier_confirmation_lines pcl ON pcl.procurement_supplier_confirmation_id=? AND pcl.procurement_purchase_order_line_id=pol.id
      WHERE pol.procurement_purchase_order_revision_id=? ORDER BY pol.line_number`, [confirmationId, source.procurement_purchase_order_revision_id])
    if (!lines.length) throw new WarehouseInventoryError('PO_LINES_REQUIRED', 'PO revision не содержит строк', 409)
    const headerBlockers = []
    const prepared = lines.map((line) => {
      const blockers = []
      if (!line.source_confirmation_line_id || line.discrepancy_class !== 'NONE') blockers.push('MATCHED_CONFIRMATION_LINE_REQUIRED')
      if (!toId(line.catalog_position_id)) blockers.push('CATALOG_POSITION_REQUIRED')
      if (!toId(line.supplier_part_id)) blockers.push('SUPPLIER_PART_REQUIRED')
      if (!String(line.uom || '').trim()) blockers.push('UOM_REQUIRED')
      if (!(Number(line.quantity) > 0)) blockers.push('EXPECTED_QUANTITY_REQUIRED')
      headerBlockers.push(...blockers)
      return { ...line, blockers }
    })
    const sourceSnapshot = { confirmation:{id:confirmationId,reference:source.confirmation_reference,evidence_reference:source.evidence_reference,evidence_hash:source.evidence_hash,accepted_at:source.accepted_at},po:{id:source.procurement_purchase_order_id,revision_id:source.procurement_purchase_order_revision_id,number:source.po_number,content_hash:source.content_hash},supplier:source.supplier_snapshot_json,delivery:source.delivery_snapshot_json,upstream:source.source_trace_snapshot_json }
    const status = headerBlockers.length ? 'BLOCKED' : 'OPEN'
    const [insert] = await conn.execute(`INSERT INTO warehouse_inbound_expectations
      (expectation_number,source_supplier_confirmation_id,source_po_id,source_po_revision_id,supplier_id,status,source_snapshot_json,blocker_reasons_json,source_hash,created_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [`INB-${String(confirmationId).padStart(8,'0')}`,confirmationId,source.procurement_purchase_order_id,
      source.procurement_purchase_order_revision_id,source.supplier_id,status,json(sourceSnapshot),json([...new Set(headerBlockers)]),sha256(sourceSnapshot),user])
    for (const line of prepared) {
      const lineage = { confirmation:{id:confirmationId,line_id:line.source_confirmation_line_id},po:{id:source.procurement_purchase_order_id,revision_id:source.procurement_purchase_order_revision_id,line_id:line.source_po_line_id,line_number:line.line_number,line_hash:line.line_hash},procurement_execution_item_id:line.procurement_execution_item_id,catalog_position_id:line.catalog_position_id,supplier_part_id:line.supplier_part_id,uom:line.uom,quantity:line.quantity,source_trace:line.source_trace_snapshot_json,supplier_part_snapshot:line.supplier_part_snapshot_json }
      await conn.execute(`INSERT INTO warehouse_inbound_expectation_lines
        (warehouse_inbound_expectation_id,source_confirmation_line_id,source_po_line_id,procurement_execution_item_id,catalog_position_id,supplier_part_id,line_number,expected_quantity,uom,status,blocker_reasons_json,lineage_snapshot_json,lineage_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [insert.insertId,line.source_confirmation_line_id,line.source_po_line_id,line.procurement_execution_item_id,line.catalog_position_id,line.supplier_part_id,line.line_number,line.quantity,line.uom,line.blockers.length?'BLOCKED':'OPEN',json(line.blockers),json(lineage),sha256(lineage)])
    }
    await event(conn,status==='OPEN'?'ExpectedInboundMaterialized':'ExpectedInboundBlocked','warehouse_inbound_expectation',insert.insertId,user,{confirmation_id:confirmationId,blockers:[...new Set(headerBlockers)]},{domain:'procurement_execution',entity_type:'procurement_supplier_confirmation',entity_id:confirmationId})
    await conn.commit(); return { expectation_id: insert.insertId, status, blockers:[...new Set(headerBlockers)] }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function reconcileExpectedInbound(expectationIdInput, userId) {
  const expectationId = id(expectationIdInput, 'expectation_id'), user = actor(userId), conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[expectation]] = await conn.execute('SELECT * FROM warehouse_inbound_expectations WHERE id=? FOR UPDATE', [expectationId])
    if (!expectation) throw new WarehouseInventoryError('EXPECTATION_NOT_FOUND', 'Expected inbound не найден', 404)
    if (expectation.status !== 'BLOCKED') {
      await conn.commit()
      return { expectation_id: expectationId, status: expectation.status, already_reconciled: true }
    }
    const [lines] = await conn.execute(`SELECT l.*,
      JSON_UNQUOTE(JSON_EXTRACT(pol.supplier_part_snapshot_json,'$.part_number')) supplier_part_number
      FROM warehouse_inbound_expectation_lines l
      JOIN procurement_purchase_order_lines pol ON pol.id=l.source_po_line_id
      WHERE l.warehouse_inbound_expectation_id=? FOR UPDATE`, [expectationId])
    const remaining = new Set()
    let reconciledLineCount = 0
    for (const line of lines) {
      let supplierPartId = toId(line.supplier_part_id)
      if (!supplierPartId && String(line.supplier_part_number || '').trim()) {
        const [[part]] = await conn.execute(`SELECT id FROM supplier_parts
          WHERE supplier_id=? AND UPPER(TRIM(supplier_part_number))=UPPER(TRIM(?))
          ORDER BY id DESC LIMIT 1`, [expectation.supplier_id, line.supplier_part_number])
        supplierPartId = toId(part?.id)
      }
      const blockers = []
      if (!line.source_confirmation_line_id) blockers.push('MATCHED_CONFIRMATION_LINE_REQUIRED')
      if (!toId(line.catalog_position_id)) blockers.push('CATALOG_POSITION_REQUIRED')
      if (!supplierPartId) blockers.push('SUPPLIER_PART_REQUIRED')
      if (!String(line.uom || '').trim()) blockers.push('UOM_REQUIRED')
      if (!(Number(line.expected_quantity) > 0)) blockers.push('EXPECTED_QUANTITY_REQUIRED')
      blockers.forEach((blocker) => remaining.add(blocker))
      const lineage = typeof line.lineage_snapshot_json === 'string'
        ? JSON.parse(line.lineage_snapshot_json || '{}')
        : (line.lineage_snapshot_json || {})
      lineage.supplier_part_id = supplierPartId
      lineage.reconciliation = { expectation_id: expectationId, supplier_part_master_reused: Boolean(supplierPartId) }
      await conn.execute(`UPDATE warehouse_inbound_expectation_lines
        SET supplier_part_id=?,status=?,blocker_reasons_json=?,lineage_snapshot_json=?,lineage_hash=? WHERE id=?`,
      [supplierPartId, blockers.length ? 'BLOCKED' : 'OPEN', json(blockers), json(lineage), sha256(lineage), line.id])
      if (!blockers.length) reconciledLineCount += 1
    }
    const status = remaining.size ? 'BLOCKED' : 'OPEN'
    await conn.execute('UPDATE warehouse_inbound_expectations SET status=?,blocker_reasons_json=? WHERE id=?', [status, json([...remaining]), expectationId])
    await event(conn, status === 'OPEN' ? 'ExpectedInboundReconciled' : 'ExpectedInboundReconciliationBlocked',
      'warehouse_inbound_expectation', expectationId, user,
      { expectation_id: expectationId, status, blockers: [...remaining], reconciled_line_count: reconciledLineCount },
      { domain: 'procurement_execution', entity_type: 'procurement_supplier_confirmation', entity_id: expectation.source_supplier_confirmation_id })
    await conn.commit()
    return { expectation_id: expectationId, status, blockers: [...remaining], reconciled_line_count: reconciledLineCount }
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

async function receiveInbound(expectationIdInput, payload, userId) {
  const expectationId=id(expectationIdInput,'expectation_id'),user=actor(userId),warehouseId=id(payload.warehouse_id,'warehouse_id'),placeId=toId(payload.receiving_place_id),requestKey=key(payload.idempotency_key),conn=await db.getConnection()
  try { await conn.beginTransaction(); await location(conn,warehouseId,placeId)
    const [[expectation]]=await conn.execute('SELECT * FROM warehouse_inbound_expectations WHERE id=? FOR UPDATE',[expectationId])
    if(!expectation)throw new WarehouseInventoryError('EXPECTATION_NOT_FOUND','Expected inbound не найден',404)
    if(expectation.status==='BLOCKED')throw new WarehouseInventoryError('EXPECTATION_BLOCKED','Приёмка заблокирована из-за неполной source identity',409)
    const [[duplicate]]=await conn.execute('SELECT id FROM warehouse_receipts WHERE idempotency_key=?',[requestKey]);if(duplicate){await conn.commit();return{receipt_id:duplicate.id,already_exists:true}}
    const receivedAt=new Date(payload.received_at);if(Number.isNaN(receivedAt.getTime()))throw new WarehouseInventoryError('INVALID_DATE','Некорректный received_at')
    const evidenceReference=text(payload.evidence_reference,'evidence_reference',1000),lines=Array.isArray(payload.lines)?payload.lines:[];if(!lines.length)throw new WarehouseInventoryError('RECEIPT_LINES_REQUIRED','Нужна хотя бы одна строка фактической приёмки')
    const [receipt]=await conn.execute(`INSERT INTO warehouse_receipts (receipt_number,warehouse_inbound_expectation_id,warehouse_id,receiving_place_id,received_at,evidence_reference,evidence_hash,idempotency_key,received_by_user_id) VALUES (?,?,?,?,?,?,?,?,?)`,[`RCV-${Date.now()}-${expectationId}`,expectationId,warehouseId,placeId,receivedAt,evidenceReference,sha256({reference:evidenceReference,evidence:payload.evidence||{}}),requestKey,user])
    const created=[]
    for(const item of lines){const lineId=id(item.expectation_line_id,'expectation_line_id'),received=positiveQty(item.received_quantity,'received_quantity'),damaged=nonNegativeQty(item.damaged_quantity,'damaged_quantity'),missing=nonNegativeQty(item.missing_quantity,'missing_quantity');if(damaged>received)throw new WarehouseInventoryError('DAMAGED_EXCEEDS_RECEIVED','damaged_quantity превышает received_quantity',409)
      const [[line]]=await conn.execute(`SELECT l.*,COALESCE((SELECT SUM(rl.received_quantity) FROM warehouse_receipt_lines rl JOIN warehouse_receipts r ON r.id=rl.warehouse_receipt_id WHERE rl.warehouse_inbound_expectation_line_id=l.id AND r.status='POSTED'),0) already_received FROM warehouse_inbound_expectation_lines l WHERE l.id=? AND l.warehouse_inbound_expectation_id=? FOR UPDATE`,[lineId,expectationId])
      if(!line||line.status==='BLOCKED'||!line.catalog_position_id||!line.supplier_part_id||!line.uom)throw new WarehouseInventoryError('RECEIPT_SOURCE_IDENTITY_REQUIRED','Строка не имеет полной PO/confirmation/Catalog Position/Supplier Part/UOM трассировки',409)
      if(Number(line.already_received)+received>Number(line.expected_quantity)+0.0005)throw new WarehouseInventoryError('OVER_RECEIPT','Приёмка превышает ожидаемое количество',409)
      const [receiptLine]=await conn.execute(`INSERT INTO warehouse_receipt_lines (warehouse_receipt_id,warehouse_inbound_expectation_line_id,received_quantity,damaged_quantity,missing_quantity,supplier_lot_number,evidence_snapshot_json) VALUES (?,?,?,?,?,?,?)`,[receipt.insertId,lineId,received,damaged,missing,item.supplier_lot_number?String(item.supplier_lot_number).slice(0,160):null,json(item.evidence)])
      const portions=[{qty:Number((received-damaged).toFixed(3)),quality:'RELEASED'},{qty:damaged,quality:'HOLD'}].filter(x=>x.qty>0)
      for(let index=0;index<portions.length;index+=1){const portion=portions[index],code=`SU-${receiptLine.insertId}-${index+1}`,lineage={expectation_id:expectationId,expectation_line_id:lineId,receipt_id:receipt.insertId,receipt_line_id:receiptLine.insertId,source:line.lineage_snapshot_json,catalog_position_id:line.catalog_position_id,supplier_part_id:line.supplier_part_id,uom:line.uom,quantity:portion.qty}
        const [unit]=await conn.execute(`INSERT INTO warehouse_stock_units (stock_unit_code,root_receipt_line_id,catalog_position_id,supplier_part_id,warehouse_id,current_storage_place_id,supplier_lot_number,internal_lot_number,uom,quality_status,lineage_snapshot_json,lineage_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[code,receiptLine.insertId,line.catalog_position_id,line.supplier_part_id,warehouseId,placeId,item.supplier_lot_number?String(item.supplier_lot_number).slice(0,160):null,`LOT-${receiptLine.insertId}`,line.uom,portion.quality,json(lineage),sha256(lineage)])
        await movement(conn,{stock_unit_id:unit.insertId,movement_type:'RECEIPT',quantity_delta:portion.qty,to_warehouse_id:warehouseId,to_storage_place_id:placeId,evidence:{receipt_id:receipt.insertId,receipt_line_id:receiptLine.insertId},operation_key:`receipt:${receiptLine.insertId}:${index+1}`,user_id:user});created.push(unit.insertId)}
      const total=Number(line.already_received)+received;await conn.execute('UPDATE warehouse_inbound_expectation_lines SET status=? WHERE id=?',[total+0.0005>=Number(line.expected_quantity)?'RECEIVED':'PARTIALLY_RECEIVED',lineId])}
    const [[remaining]]=await conn.execute("SELECT COUNT(*) count FROM warehouse_inbound_expectation_lines WHERE warehouse_inbound_expectation_id=? AND status NOT IN ('RECEIVED','CANCELLED')",[expectationId]);await conn.execute('UPDATE warehouse_inbound_expectations SET status=? WHERE id=?',[Number(remaining.count)?'PARTIALLY_RECEIVED':'RECEIVED',expectationId]);await event(conn,'InboundReceived','warehouse_receipt',receipt.insertId,user,{expectation_id:expectationId,stock_unit_ids:created},{domain:'procurement_execution',entity_type:'procurement_supplier_confirmation',entity_id:expectation.source_supplier_confirmation_id});await conn.commit();return{receipt_id:receipt.insertId,stock_unit_ids:created}
  }catch(error){await conn.rollback();throw error}finally{conn.release()}
}

async function moveStock(stockUnitIdInput,payload,userId){const unitId=id(stockUnitIdInput,'stock_unit_id'),toWarehouse=id(payload.to_warehouse_id,'to_warehouse_id'),toPlace=toId(payload.to_storage_place_id),requestKey=key(payload.idempotency_key),user=actor(userId),conn=await db.getConnection();try{await conn.beginTransaction();await location(conn,toWarehouse,toPlace);const unit=await stockState(conn,unitId,true);if(Number(unit.physical_quantity)<=0)throw new WarehouseInventoryError('NO_PHYSICAL_STOCK','Stock Unit не имеет физического остатка',409);if(Number(unit.reserved_quantity)>0)throw new WarehouseInventoryError('RESERVED_UNIT_MOVE_BLOCKED','Зарезервированный Stock Unit нельзя перемещать',409);const type=unit.current_storage_place_id?'MOVE':'PUTAWAY';await movement(conn,{stock_unit_id:unitId,movement_type:type,from_warehouse_id:unit.warehouse_id,from_storage_place_id:unit.current_storage_place_id,to_warehouse_id:toWarehouse,to_storage_place_id:toPlace,evidence:payload.evidence,operation_key:requestKey,user_id:user});await conn.execute('UPDATE warehouse_stock_units SET warehouse_id=?,current_storage_place_id=?,row_version=row_version+1 WHERE id=?',[toWarehouse,toPlace,unitId]);await event(conn,type==='PUTAWAY'?'StockPutAway':'StockMoved','warehouse_stock_unit',unitId,user,{from:{warehouse_id:unit.warehouse_id,place_id:unit.current_storage_place_id},to:{warehouse_id:toWarehouse,place_id:toPlace}});await conn.commit();return{stock_unit_id:unitId,movement_type:type}}catch(error){await conn.rollback();if(error.code==='ER_DUP_ENTRY')return{stock_unit_id:unitId,already_exists:true};throw error}finally{conn.release()}}

async function splitStockUnit(stockUnitIdInput,payload,userId){const unitId=id(stockUnitIdInput,'stock_unit_id'),quantity=positiveQty(payload.quantity),requestKey=key(payload.idempotency_key),user=actor(userId),conn=await db.getConnection();try{await conn.beginTransaction();const unit=await stockState(conn,unitId,true);if(Number(unit.reserved_quantity)>0)throw new WarehouseInventoryError('RESERVED_UNIT_SPLIT_BLOCKED','Сначала снимите резерв со Stock Unit',409);if(quantity>=Number(unit.physical_quantity)-0.0005)throw new WarehouseInventoryError('INVALID_SPLIT_QUANTITY','Split quantity должна быть меньше физического остатка',409);const lineage={parent_stock_unit_id:unitId,parent_lineage_hash:unit.lineage_hash,split_quantity:quantity,operation_key:requestKey};const [child]=await conn.execute(`INSERT INTO warehouse_stock_units (stock_unit_code,root_receipt_line_id,parent_stock_unit_id,catalog_position_id,supplier_part_id,warehouse_id,current_storage_place_id,supplier_lot_number,internal_lot_number,uom,quality_status,lineage_snapshot_json,lineage_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[`SU-SPLIT-${Date.now()}-${unitId}`,unit.root_receipt_line_id,unitId,unit.catalog_position_id,unit.supplier_part_id,unit.warehouse_id,unit.current_storage_place_id,unit.supplier_lot_number,`${unit.internal_lot_number}-S`,unit.uom,unit.quality_status,json(lineage),sha256(lineage)]);await movement(conn,{stock_unit_id:unitId,movement_type:'SPLIT_OUT',quantity_delta:-quantity,from_warehouse_id:unit.warehouse_id,from_storage_place_id:unit.current_storage_place_id,evidence:{child_stock_unit_id:child.insertId},operation_key:`${requestKey}:out`,user_id:user});await movement(conn,{stock_unit_id:child.insertId,movement_type:'SPLIT_IN',quantity_delta:quantity,to_warehouse_id:unit.warehouse_id,to_storage_place_id:unit.current_storage_place_id,evidence:{parent_stock_unit_id:unitId},operation_key:`${requestKey}:in`,user_id:user});await event(conn,'StockUnitSplit','warehouse_stock_unit',unitId,user,{child_stock_unit_id:child.insertId,quantity});await conn.commit();return{parent_stock_unit_id:unitId,child_stock_unit_id:child.insertId,quantity}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function createReservation(payload,userId){const user=actor(userId),requestKey=key(payload.idempotency_key),allocations=Array.isArray(payload.allocations)?payload.allocations:[],conn=await db.getConnection();if(!allocations.length)throw new WarehouseInventoryError('RESERVATION_ALLOCATIONS_REQUIRED','Нужна хотя бы одна allocation');try{await conn.beginTransaction();const [[duplicate]]=await conn.execute('SELECT id FROM warehouse_inventory_reservations WHERE idempotency_key=?',[requestKey]);if(duplicate){await conn.commit();return{reservation_id:duplicate.id,already_exists:true}}const [header]=await conn.execute(`INSERT INTO warehouse_inventory_reservations (reservation_number,source_domain,source_entity_type,source_entity_id,source_revision_id,evidence_snapshot_json,idempotency_key,created_by_user_id) VALUES (?,?,?,?,?,?,?,?)`,[`RSV-${Date.now()}`,text(payload.source_domain,'source_domain',40),text(payload.source_entity_type,'source_entity_type',64),id(payload.source_entity_id,'source_entity_id'),toId(payload.source_revision_id),json(payload.evidence),requestKey,user]);for(let index=0;index<allocations.length;index+=1){const item=allocations[index],unitId=id(item.stock_unit_id,'stock_unit_id'),qty=positiveQty(item.quantity),unit=await stockState(conn,unitId,true);if(unit.quality_status!=='RELEASED')throw new WarehouseInventoryError('HELD_STOCK_NOT_AVAILABLE','Hold/rejected stock нельзя резервировать',409);if(unit.available_quantity+0.0005<qty)throw new WarehouseInventoryError('INSUFFICIENT_AVAILABLE_STOCK','Недостаточно доступного остатка',409);await conn.execute('INSERT INTO warehouse_inventory_reservation_allocations (warehouse_inventory_reservation_id,stock_unit_id,quantity) VALUES (?,?,?)',[header.insertId,unitId,qty]);await movement(conn,{stock_unit_id:unitId,movement_type:'RESERVE',reserved_delta:qty,evidence:{reservation_id:header.insertId},operation_key:`reservation:${header.insertId}:${unitId}`,user_id:user})}await event(conn,'InventoryReserved','warehouse_inventory_reservation',header.insertId,user,{allocations},{domain:payload.source_domain,entity_type:payload.source_entity_type,entity_id:id(payload.source_entity_id,'source_entity_id')});await conn.commit();return{reservation_id:header.insertId,status:'ACTIVE'}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function createReservationWithAllocations(payload,userId){
  const result=await createReservation(payload,userId)
  const [allocations]=await db.execute(`SELECT a.id,a.stock_unit_id,a.quantity,u.warehouse_id
    FROM warehouse_inventory_reservation_allocations a
    JOIN warehouse_stock_units u ON u.id=a.stock_unit_id
    WHERE a.warehouse_inventory_reservation_id=? AND a.status='ACTIVE' ORDER BY a.id`,[result.reservation_id])
  return {...result,allocations:allocations.map(row=>({...row,quantity:Number(row.quantity)}))}
}

async function releaseReservation(reservationIdInput,payload,userId){const reservationId=id(reservationIdInput,'reservation_id'),user=actor(userId),requestKey=key(payload.idempotency_key),conn=await db.getConnection();try{await conn.beginTransaction();const [[reservation]]=await conn.execute('SELECT * FROM warehouse_inventory_reservations WHERE id=? FOR UPDATE',[reservationId]);if(!reservation)throw new WarehouseInventoryError('RESERVATION_NOT_FOUND','Reservation не найден',404);if(reservation.status==='RELEASED'){await conn.commit();return{reservation_id:reservationId,already_released:true}}const [allocations]=await conn.execute("SELECT * FROM warehouse_inventory_reservation_allocations WHERE warehouse_inventory_reservation_id=? AND status='ACTIVE' FOR UPDATE",[reservationId]);for(const allocation of allocations){await stockState(conn,allocation.stock_unit_id,true);await movement(conn,{stock_unit_id:allocation.stock_unit_id,movement_type:'UNRESERVE',reserved_delta:-Number(allocation.quantity),reason_code:payload.reason_code||'RELEASED',evidence:payload.evidence,operation_key:`${requestKey}:${allocation.stock_unit_id}`,user_id:user})}await conn.execute("UPDATE warehouse_inventory_reservation_allocations SET status='RELEASED' WHERE warehouse_inventory_reservation_id=? AND status='ACTIVE'",[reservationId]);await conn.execute("UPDATE warehouse_inventory_reservations SET status='RELEASED',released_by_user_id=?,released_at=NOW(6) WHERE id=?",[user,reservationId]);await event(conn,'InventoryReservationReleased','warehouse_inventory_reservation',reservationId,user,{reason_code:payload.reason_code});await conn.commit();return{reservation_id:reservationId,status:'RELEASED'}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function changeQualityStatus(stockUnitIdInput,payload,userId){const unitId=id(stockUnitIdInput,'stock_unit_id'),status=String(payload.quality_status||'').toUpperCase();if(!['HOLD','RELEASED','REJECTED'].includes(status))throw new WarehouseInventoryError('INVALID_QUALITY_STATUS','Некорректный quality_status');const conn=await db.getConnection(),user=actor(userId);try{await conn.beginTransaction();const unit=await stockState(conn,unitId,true);if(status!=='RELEASED'&&Number(unit.reserved_quantity)>0)throw new WarehouseInventoryError('RESERVED_STOCK_HOLD_BLOCKED','Сначала снимите активные резервы',409);if(unit.quality_status===status){await conn.commit();return{stock_unit_id:unitId,already_exists:true}}const type=status==='RELEASED'?'QUALITY_RELEASE':'QUALITY_HOLD';await movement(conn,{stock_unit_id:unitId,movement_type:type,reason_code:text(payload.reason_code,'reason_code',80),evidence:payload.evidence,operation_key:key(payload.idempotency_key),user_id:user});await conn.execute('UPDATE warehouse_stock_units SET quality_status=?,row_version=row_version+1 WHERE id=?',[status,unitId]);await event(conn,status==='RELEASED'?'StockQualityReleased':'StockQualityHeld','warehouse_stock_unit',unitId,user,{from:unit.quality_status,to:status,reason_code:payload.reason_code});await conn.commit();return{stock_unit_id:unitId,quality_status:status}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function adjustStock(stockUnitIdInput,payload,userId){const unitId=id(stockUnitIdInput,'stock_unit_id'),qty=Number(payload.quantity_delta),type=String(payload.movement_type||'COUNT_ADJUSTMENT').toUpperCase();if(!Number.isFinite(qty)||qty===0)throw new WarehouseInventoryError('INVALID_QUANTITY','quantity_delta должен быть ненулевым');if(!['COUNT_ADJUSTMENT','WRITE_OFF'].includes(type))throw new WarehouseInventoryError('INVALID_ADJUSTMENT_TYPE','Разрешены COUNT_ADJUSTMENT или WRITE_OFF');const conn=await db.getConnection(),user=actor(userId);try{await conn.beginTransaction();const unit=await stockState(conn,unitId,true);if(Number(unit.physical_quantity)+qty<Number(unit.reserved_quantity)-0.0005)throw new WarehouseInventoryError('ADJUSTMENT_BELOW_RESERVED','Корректировка опускает physical ниже reserved',409);await movement(conn,{stock_unit_id:unitId,movement_type:type,quantity_delta:qty,from_warehouse_id:qty<0?unit.warehouse_id:null,from_storage_place_id:qty<0?unit.current_storage_place_id:null,to_warehouse_id:qty>0?unit.warehouse_id:null,to_storage_place_id:qty>0?unit.current_storage_place_id:null,reason_code:text(payload.reason_code,'reason_code',80),evidence:{approval_reference:text(payload.approval_reference,'approval_reference',255),...(payload.evidence||{})},operation_key:key(payload.idempotency_key),user_id:user});await event(conn,type==='WRITE_OFF'?'StockWrittenOff':'StockAdjusted','warehouse_stock_unit',unitId,user,{quantity_delta:qty,reason_code:payload.reason_code,approval_reference:payload.approval_reference});await conn.commit();return{stock_unit_id:unitId,quantity_delta:qty}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function createCount(payload,userId){const warehouseId=id(payload.warehouse_id,'warehouse_id'),placeId=toId(payload.storage_place_id),user=actor(userId),conn=await db.getConnection();try{await conn.beginTransaction();await location(conn,warehouseId,placeId);const [header]=await conn.execute('INSERT INTO warehouse_inventory_counts (count_number,warehouse_id,storage_place_id,reason_code,created_by_user_id) VALUES (?,?,?,?,?)',[`CNT-${Date.now()}`,warehouseId,placeId,text(payload.reason_code,'reason_code',80),user]);const params=[warehouseId];let placeSql='';if(placeId){placeSql=' AND u.current_storage_place_id=?';params.push(placeId)}const [units]=await conn.execute(`SELECT u.id,COALESCE(SUM(m.quantity_delta),0) physical_quantity FROM warehouse_stock_units u LEFT JOIN warehouse_inventory_movements m ON m.stock_unit_id=u.id WHERE u.warehouse_id=?${placeSql} GROUP BY u.id HAVING physical_quantity>0`,params);for(const unit of units)await conn.execute('INSERT INTO warehouse_inventory_count_lines (warehouse_inventory_count_id,stock_unit_id,expected_quantity_snapshot,evidence_snapshot_json) VALUES (?,?,?,?)',[header.insertId,unit.id,unit.physical_quantity,json({blind_count:true})]);await event(conn,'InventoryCountOpened','warehouse_inventory_count',header.insertId,user,{warehouse_id:warehouseId,storage_place_id:placeId,stock_unit_count:units.length});await conn.commit();return{count_id:header.insertId,status:'OPEN',stock_unit_ids:units.map(x=>x.id)}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function submitCount(countIdInput,payload,userId){const countId=id(countIdInput,'count_id'),lines=Array.isArray(payload.lines)?payload.lines:[],user=actor(userId),conn=await db.getConnection();if(!lines.length)throw new WarehouseInventoryError('COUNT_LINES_REQUIRED','Нужны результаты blind count');try{await conn.beginTransaction();const [[count]]=await conn.execute('SELECT status FROM warehouse_inventory_counts WHERE id=? FOR UPDATE',[countId]);if(!count)throw new WarehouseInventoryError('COUNT_NOT_FOUND','Inventory Count не найден',404);if(count.status!=='OPEN')throw new WarehouseInventoryError('COUNT_NOT_OPEN','Count уже закрыт для ввода',409);for(const item of lines){const stockUnitId=id(item.stock_unit_id,'stock_unit_id'),counted=nonNegativeQty(item.counted_quantity,'counted_quantity');const [[line]]=await conn.execute('SELECT expected_quantity_snapshot FROM warehouse_inventory_count_lines WHERE warehouse_inventory_count_id=? AND stock_unit_id=? FOR UPDATE',[countId,stockUnitId]);if(!line)throw new WarehouseInventoryError('COUNT_UNIT_OUT_OF_SCOPE','Stock Unit не входит в blind count',409);await conn.execute('UPDATE warehouse_inventory_count_lines SET counted_quantity=?,variance_quantity=?-expected_quantity_snapshot,evidence_snapshot_json=?,counted_by_user_id=?,counted_at=NOW(6) WHERE warehouse_inventory_count_id=? AND stock_unit_id=?',[counted,counted,json(item.evidence),user,countId,stockUnitId])}const [[remaining]]=await conn.execute('SELECT COUNT(*) count FROM warehouse_inventory_count_lines WHERE warehouse_inventory_count_id=? AND counted_quantity IS NULL',[countId]);if(Number(remaining.count))throw new WarehouseInventoryError('COUNT_INCOMPLETE','Нужно посчитать все Stock Units',409);await conn.execute("UPDATE warehouse_inventory_counts SET status='COUNTED' WHERE id=?",[countId]);await event(conn,'InventoryCountSubmitted','warehouse_inventory_count',countId,user,{blind_count:true});await conn.commit();return{count_id:countId,status:'COUNTED'}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

async function approveCount(countIdInput,payload,userId){const countId=id(countIdInput,'count_id'),user=actor(userId),approval=text(payload.approval_reference,'approval_reference',255),conn=await db.getConnection();try{await conn.beginTransaction();const [[count]]=await conn.execute('SELECT * FROM warehouse_inventory_counts WHERE id=? FOR UPDATE',[countId]);if(!count)throw new WarehouseInventoryError('COUNT_NOT_FOUND','Inventory Count не найден',404);if(count.status!=='COUNTED')throw new WarehouseInventoryError('COUNT_NOT_READY','Сначала завершите blind count',409);const [lines]=await conn.execute('SELECT * FROM warehouse_inventory_count_lines WHERE warehouse_inventory_count_id=? FOR UPDATE',[countId]);for(const line of lines){const variance=Number(line.variance_quantity);if(!variance)continue;const unit=await stockState(conn,line.stock_unit_id,true);if(Number(unit.physical_quantity)+variance<Number(unit.reserved_quantity)-0.0005)throw new WarehouseInventoryError('COUNT_BELOW_RESERVED','Count adjustment опускает physical ниже reserved',409);await movement(conn,{stock_unit_id:line.stock_unit_id,movement_type:'COUNT_ADJUSTMENT',quantity_delta:variance,from_warehouse_id:variance<0?unit.warehouse_id:null,from_storage_place_id:variance<0?unit.current_storage_place_id:null,to_warehouse_id:variance>0?unit.warehouse_id:null,to_storage_place_id:variance>0?unit.current_storage_place_id:null,reason_code:count.reason_code,evidence:{count_id:countId,approval_reference:approval,counted_quantity:line.counted_quantity,expected_quantity:line.expected_quantity_snapshot},operation_key:`count:${countId}:${line.stock_unit_id}`,user_id:user})}await conn.execute("UPDATE warehouse_inventory_counts SET status='APPROVED',approved_by_user_id=?,approved_at=NOW(6) WHERE id=?",[user,countId]);await event(conn,'InventoryCountApproved','warehouse_inventory_count',countId,user,{approval_reference:approval,adjusted_line_count:lines.filter(x=>Number(x.variance_quantity)!==0).length});await conn.commit();return{count_id:countId,status:'APPROVED'}}catch(error){await conn.rollback();throw error}finally{conn.release()}}

module.exports={adjustStock,approveCount,changeQualityStatus,createCount,createReservation,createReservationWithAllocations,issueForShipment,materializeExpectedInbound,moveStock,receiveInbound,reconcileExpectedInbound,releaseReservation,splitStockUnit,stockState,submitCount}
