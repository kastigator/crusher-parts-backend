const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const readFrontend = (context, ...parts) => {
  const file = path.resolve(root, '..', 'crusher-parts-frontend', ...parts)
  if (!fs.existsSync(file)) { context.skip('frontend repository is not present in the isolated backend build'); return null }
  return fs.readFileSync(file, 'utf8')
}

test('Task 89 migration is additive and records a structured customer payment policy', () => {
  const sql = read('migrations','managed','202608090016_financial_completion_acceptance.sql')
  assert.match(sql, /ADD COLUMN payment_policy_snapshot_json JSON NULL/)
  assert.doesNotMatch(sql, /DROP|TRUNCATE|DELETE FROM/i)
})

test('accepted commercial payment policy reaches an effective contract commitment', () => {
  const commercial = read('services','commercialOffers','commandService.js')
  const contracts = read('services','contracts','commandService.js')
  const contractReadModel = read('services','contracts','readModel.js')
  assert.match(commercial, /payment_policy:\s*parseJson\(revision\.payment_policy_snapshot_json\)/)
  assert.match(contracts, /terms\.payment_policy/)
  assert.match(contracts, /value: terms\.payment_terms/)
  assert.match(contracts, /payment:terms\.PAYMENT \|\| null/)
  assert.match(contractReadModel, /value\.due_date \|\| value\.mode \|\| value\.display_terms/)
})

test('new purchase orders carry an explicit supplier payment schedule', () => {
  const procurement = read('services','procurementExecution','commandService.js')
  assert.match(procurement, /PAYMENT_DUE_DATE_REQUIRED/)
  assert.match(procurement, /schedule_stages/)
  assert.match(procurement, /trigger_type:'CONFIRMED'/)
  assert.match(procurement, /invoice_required:true/)
})

test('procurement execution can enter its canonical confirmed state', () => {
  const sql = read('migrations','managed','202608090017_procurement_case_confirmed_status.sql')
  assert.match(sql, /'CONFIRMED'/)
  assert.match(sql, /ADD CONSTRAINT chk_procurement_case_status/)
  assert.doesNotMatch(sql, /classifier|engineering|DELETE FROM|TRUNCATE/i)
})

test('financial UI uses business selectors instead of allocation JSON textareas', (context) => {
  const ui = readFrontend(context,'src','pages','FinancialOperationsWorkspacePage.jsx'); if (!ui) return
  assert.match(ui, /Form\.List name="allocations"/)
  assert.match(ui, /Задолженность клиента/)
  assert.doesNotMatch(ui, /parseAllocations|JSON\.parse\(value\)/)
})

test('commercial-offer workspace remains safe before an offer is selected', (context) => {
  const ui = readFrontend(context,'src','pages','CommercialOfferWorkspacePage.jsx'); if (!ui) return
  assert.match(ui, /item\.offer_number === offer\?\.offer_number/)
  assert.doesNotMatch(ui, /item\.offer_number === offer\.offer_number/)
})

test('contract workspace remains safe before a contract revision is selected', (context) => {
  const ui = readFrontend(context,'src','pages','ContractWorkspacePage.jsx'); if (!ui) return
  assert.match(ui, /\(currentRevision\?\.documents \|\| \[\]\)\.filter/)
  assert.doesNotMatch(ui, /\(currentRevision\.documents \|\| \[\]\)\.filter/)
})

test('blocked expected inbound has an audited UI recovery command that only reuses supplier master data', (context) => {
  const service = read('services','warehouseInventory','commandService.js')
  const route = read('routes','warehouseInventory.js')
  const ui = readFrontend(context,'src','pages','WarehouseInventoryWorkspacePage.jsx'); if (!ui) return
  assert.match(service, /async function reconcileExpectedInbound/)
  assert.match(service, /ExpectedInboundReconciled/)
  assert.match(service, /supplier_part_master_reused/)
  const recovery = service.slice(service.indexOf('async function reconcileExpectedInbound'), service.indexOf('async function receiveInbound'))
  assert.doesNotMatch(recovery, /INSERT INTO supplier_parts|UPDATE supplier_parts/)
  assert.match(route, /inbound\/:id\/reconcile/)
  assert.match(ui, /Повторить сопоставление/)
})

test('financial and warehouse completion projections recognize terminal RC1 evidence', () => {
  const finance = read('services','financialOperations','commandService.js')
  const completion = read('services','completionLifecycle','readinessService.js')
  assert.match(finance, /UPDATE financial_ap_cases SET status=/)
  assert.match(finance, /'COMPLETED'/)
  assert.match(completion, /dispatch_picking_request_line_id=pl\.id/)
  assert.match(completion, /p\.status IN \('DISPATCHED','DELIVERED'\)/)
  assert.match(completion, /AP_CASE_STATUS_PROJECTION_LAG/)
})
