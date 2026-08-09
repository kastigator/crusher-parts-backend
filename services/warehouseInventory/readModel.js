const db = require('../../utils/db')
const { WarehouseInventoryError } = require('./domainError')
const { toId } = require('./helpers')

const BALANCE_SQL = `SELECT u.id stock_unit_id,u.stock_unit_code,u.catalog_position_id,u.supplier_part_id,u.warehouse_id,u.current_storage_place_id,
 u.internal_lot_number,u.supplier_lot_number,u.uom,u.quality_status,u.status,u.lineage_hash,
 cp.manufacturer_part_number,cp.display_name,sp.canonical_part_number supplier_part_number,ps.name supplier_name,
 wl.code warehouse_code,wl.name warehouse_name,p.code storage_place_code,
 COALESCE(SUM(m.quantity_delta),0) physical_quantity,COALESCE(SUM(m.reserved_delta),0) reserved_quantity,
 CASE WHEN u.quality_status='RELEASED' THEN GREATEST(COALESCE(SUM(m.quantity_delta),0)-COALESCE(SUM(m.reserved_delta),0),0) ELSE 0 END available_quantity,
 CASE WHEN u.quality_status IN ('HOLD','REJECTED') THEN GREATEST(COALESCE(SUM(m.quantity_delta),0),0) ELSE 0 END held_quantity
 FROM warehouse_stock_units u
 JOIN catalog_positions cp ON cp.id=u.catalog_position_id JOIN supplier_parts sp ON sp.id=u.supplier_part_id
 LEFT JOIN part_suppliers ps ON ps.id=sp.supplier_id JOIN warehouse_locations wl ON wl.id=u.warehouse_id
 LEFT JOIN warehouse_storage_places p ON p.id=u.current_storage_place_id LEFT JOIN warehouse_inventory_movements m ON m.stock_unit_id=u.id`
const GROUP_SQL = ` GROUP BY u.id,cp.id,sp.id,ps.id,wl.id,p.id`

async function getOverview() {
  const [inbound] = await db.execute(`SELECT e.id,e.expectation_number,e.status,e.source_supplier_confirmation_id,e.source_po_id,e.supplier_id,e.blocker_reasons_json,e.created_at,
    COUNT(l.id) line_count,COALESCE(SUM(l.expected_quantity),0) expected_quantity,
    COALESCE((SELECT SUM(rl.received_quantity) FROM warehouse_receipt_lines rl JOIN warehouse_receipts r ON r.id=rl.warehouse_receipt_id WHERE r.warehouse_inbound_expectation_id=e.id AND r.status='POSTED'),0) received_quantity
    FROM warehouse_inbound_expectations e LEFT JOIN warehouse_inbound_expectation_lines l ON l.warehouse_inbound_expectation_id=e.id GROUP BY e.id ORDER BY e.updated_at DESC LIMIT 100`)
  const [stock] = await db.execute(`${BALANCE_SQL}${GROUP_SQL} HAVING physical_quantity<>0 OR reserved_quantity<>0 ORDER BY u.updated_at DESC LIMIT 300`)
  const [reservations] = await db.execute(`SELECT r.id,r.reservation_number,r.source_domain,r.source_entity_type,r.source_entity_id,r.status,r.created_at,
    COUNT(a.id) allocation_count,COALESCE(SUM(a.quantity),0) reserved_quantity FROM warehouse_inventory_reservations r
    LEFT JOIN warehouse_inventory_reservation_allocations a ON a.warehouse_inventory_reservation_id=r.id AND a.status='ACTIVE'
    GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`)
  const [counts] = await db.execute(`SELECT c.*,wl.name warehouse_name,p.code storage_place_code FROM warehouse_inventory_counts c JOIN warehouse_locations wl ON wl.id=c.warehouse_id LEFT JOIN warehouse_storage_places p ON p.id=c.storage_place_id ORDER BY c.created_at DESC LIMIT 100`)
  const [confirmationIntake]=await db.execute(`SELECT sc.id,sc.confirmation_reference,sc.accepted_at,po.po_number,ps.name supplier_name,we.expectation_number
    FROM procurement_supplier_confirmations sc JOIN procurement_purchase_order_revisions por ON por.id=sc.procurement_purchase_order_revision_id
    JOIN procurement_purchase_orders po ON po.id=por.procurement_purchase_order_id LEFT JOIN part_suppliers ps ON ps.id=po.supplier_id
    LEFT JOIN warehouse_inbound_expectations we ON we.source_supplier_confirmation_id=sc.id
    WHERE sc.status='ACCEPTED' ORDER BY sc.accepted_at DESC,sc.id DESC`)
  const stats = stock.reduce((out,row)=>{out.physical_quantity+=Number(row.physical_quantity);out.reserved_quantity+=Number(row.reserved_quantity);out.held_quantity+=Number(row.held_quantity);out.available_quantity+=Number(row.available_quantity);return out},{physical_quantity:0,reserved_quantity:0,held_quantity:0,available_quantity:0})
  return { stats, inbound, stock, reservations, counts, confirmation_intake:confirmationIntake, boundaries:{classifier:'read_only_catalog_position_identity',supplier:'read_only_supplier_part_identity',procurement:'read_only_accepted_confirmation',financial_operations:'no_writes',dispatch:'stock_readiness_only',completion:'no_writes',expected_inbound_is_stock:false} }
}
async function getAvailability(catalogPositionIdInput) {
  const catalogPositionId=toId(catalogPositionIdInput);if(!catalogPositionId)throw new WarehouseInventoryError('INVALID_ID','Некорректный catalog_position_id')
  const [[position]]=await db.execute('SELECT id,manufacturer_part_number,display_name FROM catalog_positions WHERE id=?',[catalogPositionId]);if(!position)throw new WarehouseInventoryError('CATALOG_POSITION_NOT_FOUND','Catalog Position не найдена',404)
  const [units]=await db.execute(`${BALANCE_SQL} WHERE u.catalog_position_id=?${GROUP_SQL} HAVING physical_quantity<>0 OR reserved_quantity<>0 ORDER BY u.updated_at DESC`,[catalogPositionId])
  const [inbound]=await db.execute(`SELECT l.id expectation_line_id,e.expectation_number,e.status,l.expected_quantity,l.uom,l.supplier_part_id,
    COALESCE(SUM(CASE WHEN r.status='POSTED' THEN rl.received_quantity ELSE 0 END),0) received_quantity
    FROM warehouse_inbound_expectation_lines l JOIN warehouse_inbound_expectations e ON e.id=l.warehouse_inbound_expectation_id
    LEFT JOIN warehouse_receipt_lines rl ON rl.warehouse_inbound_expectation_line_id=l.id LEFT JOIN warehouse_receipts r ON r.id=rl.warehouse_receipt_id
    WHERE l.catalog_position_id=? GROUP BY l.id,e.id ORDER BY e.created_at DESC`,[catalogPositionId])
  const totals=units.reduce((out,row)=>{for(const key of ['physical_quantity','reserved_quantity','held_quantity','available_quantity'])out[key]+=Number(row[key]);return out},{physical_quantity:0,reserved_quantity:0,held_quantity:0,available_quantity:0})
  totals.expected_inbound_quantity=inbound.reduce((sum,row)=>sum+Math.max(Number(row.expected_quantity)-Number(row.received_quantity),0),0)
  return {position,totals,stock_units:units,expected_inbound:inbound,relationship_buckets:{exact:[],approved_equivalent:[],candidate_equivalent:[],note:'Relationship taxonomy remains Classifier-owned; this endpoint returns the requested Catalog Position only.'}}
}
async function getInboundExpectation(expectationIdInput){const id=toId(expectationIdInput);if(!id)throw new WarehouseInventoryError('INVALID_ID','Некорректный expectation_id');const [[expectation]]=await db.execute('SELECT * FROM warehouse_inbound_expectations WHERE id=?',[id]);if(!expectation)throw new WarehouseInventoryError('EXPECTATION_NOT_FOUND','Expected inbound не найден',404);const [lines]=await db.execute(`SELECT l.*,cp.manufacturer_part_number,cp.display_name,sp.canonical_part_number supplier_part_number,
  COALESCE(SUM(CASE WHEN r.status='POSTED' THEN rl.received_quantity ELSE 0 END),0) received_quantity,
  GREATEST(l.expected_quantity-COALESCE(SUM(CASE WHEN r.status='POSTED' THEN rl.received_quantity ELSE 0 END),0),0) remaining_quantity
  FROM warehouse_inbound_expectation_lines l LEFT JOIN catalog_positions cp ON cp.id=l.catalog_position_id LEFT JOIN supplier_parts sp ON sp.id=l.supplier_part_id
  LEFT JOIN warehouse_receipt_lines rl ON rl.warehouse_inbound_expectation_line_id=l.id LEFT JOIN warehouse_receipts r ON r.id=rl.warehouse_receipt_id
  WHERE l.warehouse_inbound_expectation_id=? GROUP BY l.id,cp.id,sp.id ORDER BY l.line_number`,[id]);return{expectation,lines}}
async function getMovements(stockUnitIdInput) { const id=toId(stockUnitIdInput);if(!id)throw new WarehouseInventoryError('INVALID_ID','Некорректный stock_unit_id');const [rows]=await db.execute('SELECT * FROM warehouse_inventory_movements WHERE stock_unit_id=? ORDER BY occurred_at,id',[id]);return rows }
async function getLocations(){const [warehouses]=await db.execute("SELECT * FROM warehouse_locations WHERE is_active=1 AND location_type='physical' ORDER BY name");const [places]=await db.execute('SELECT * FROM warehouse_storage_places WHERE is_active=1 ORDER BY warehouse_id,code');return{warehouses,places}}

module.exports={getAvailability,getInboundExpectation,getLocations,getMovements,getOverview}
