const test=require('node:test')
const assert=require('node:assert/strict')
const {DOMAIN_ENTITIES,LEGACY_SURFACES}=require('../utils/domainRegistry')
const context=require('../utils/aiAgentDomainContext')

test('domain registry advertises every target bounded context through Wave 12',()=>{
  const keys=new Set(DOMAIN_ENTITIES.map((item)=>item.key))
  for(const key of ['client_request','sourcing_case','pricing_case','commercial_offer','contract_case','procurement_execution','financial_operations','warehouse_inventory','dispatch_delivery','completion_lifecycle','after_sales'])assert.ok(keys.has(key),key)
  assert.equal(DOMAIN_ENTITIES.every((item)=>item.status==='canonical_target_domain'),true)
})

test('legacy process tables and routes are only advertised as historical read-only surfaces',()=>{
  const canonical=JSON.stringify(DOMAIN_ENTITIES.map((item)=>item.canonical))
  for(const value of ['sales_quotes','client_contracts','supplier_purchase_orders','/sales-quotes','/economics','/rfqs'])assert.doesNotMatch(canonical,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
  assert.equal(LEGACY_SURFACES.every((item)=>item.mode==='historical_read_only'),true)
})

test('AI domain context uses target lifecycle and explicitly forbids mutation in reads',()=>{
  const system=context.getSystemMap(),process=context.getBusinessProcessGuide(),policy=context.getAgentActionPolicy()
  for(const section of ['Sourcing','Pricing','Commercial Offer','Contract','Procurement Execution','Financial Operations','Warehouse & Inventory','Dispatch & Delivery','Completion & Lifecycle','After Sales & Traceability'])assert.ok(system.interface_sections.some((item)=>item.section===section),section)
  assert.match(policy.delete_mode,/GET/)
  assert.ok(process.data_principles.some((item)=>item.includes('catalog_position_id')))
})
