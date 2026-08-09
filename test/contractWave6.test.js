const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname,'..')
const read = (...parts) => fs.readFileSync(path.join(root,...parts),'utf8')
const { assertDraftEditable, requiredSignatureRoles, resolveChangeImpact } = require('../services/contracts/policy')

test('Wave 6 migration is additive and creates the canonical Contract evidence model',() => {
  const sql = read('migrations','managed','202608080009_contract_foundation.sql')
  for (const table of [
    'contract_cases','contract_revisions','contract_lines','contract_terms','contract_clauses','contract_deviations',
    'contract_approvals','contract_documents','contract_external_sends','contract_signatures','contract_commitments','contract_events',
  ]) assert.match(sql,new RegExp(`CREATE TABLE ${table}\\b`))
  assert.doesNotMatch(sql,/(^|;)\s*(DROP|TRUNCATE|DELETE\s+FROM)\b/i)
  assert.match(sql,/source_commercial_acceptance_id/)
  assert.match(sql,/RECONFIRMATION_REQUIRED/)
  assert.match(sql,/contracts\.make_effective/)
})

test('Contract intake uses only immutable accepted commercial tables as business input',() => {
  const service = read('services','contracts','commandService.js')
  assert.match(service,/commercial_accepted_revisions/)
  assert.match(service,/commercial_accepted_lines/)
  assert.match(service,/accepted\.status !== 'FIXED'/)
  assert.doesNotMatch(service,/FROM\s+commercial_offer_revisions|FROM\s+commercial_offer_lines|FROM\s+sales_quotes|FROM\s+client_contracts/i)
})

test('Contract service does not own procurement, warehouse or finance execution',() => {
  const service = read('services','contracts','commandService.js')
  assert.doesNotMatch(service,/(INSERT|UPDATE|DELETE)\s+(INTO\s+)?(purchase_orders|supplier_orders|warehouse|shipments|payments|invoices|accounting)/i)
  assert.doesNotMatch(service,/JOIN\s+(part_suppliers|supplier_parts|supplier_offers|purchase_orders)/i)
  assert.match(service,/NO_SUPPLIER_ORDER_CREATED/)
})

test('Change Impact resolver keeps legal changes local and routes execution changes upstream',() => {
  const legal = resolveChangeImpact({ change_type:'LEGAL_TEXT' })
  assert.deepEqual(legal.affected_domains,['CONTRACT'])
  assert.equal(legal.required_action,'LOCAL_LEGAL_REVIEW')
  const quantity = resolveChangeImpact({ change_type:'QUANTITY' })
  assert.equal(quantity.required_action,'UPSTREAM_REVISION_REQUIRED')
  assert.ok(quantity.affected_domains.includes('SOURCING'))
  assert.ok(quantity.affected_domains.includes('PRICING'))
  assert.equal(resolveChangeImpact({ change_type:'PAYMENT' }).required_action,'UPSTREAM_REVISION_REQUIRED')
})

test('released revisions are immutable and signature policy is legal-form aware',() => {
  assert.doesNotThrow(() => assertDraftEditable({ status:'DRAFT' }))
  assert.throws(() => assertDraftEditable({ status:'EXTERNAL_REVIEW' }),(error) => error.code === 'REVISION_IMMUTABLE' && error.status === 409)
  assert.deepEqual(requiredSignatureRoles('ONE_OFF_CONTRACT'),['COMPANY','CLIENT'])
  assert.deepEqual(requiredSignatureRoles('SIGNED_QUOTATION'),['CLIENT'])
})

test('Contract API is capability guarded and exposes the bounded lifecycle',() => {
  const route = read('routes','contractDomain.js')
  const router = read('routes','routerIndex.js')
  for (const capability of ['contracts.access','contracts.manage','contracts.legal_review','contracts.approvals.request','contracts.approvals.decide','contracts.documents.manage','contracts.send_external','contracts.sign','contracts.make_effective']) assert.match(route,new RegExp(capability.replaceAll('.','\\.')))
  for (const endpoint of ['from-accepted-commercial','analyze-impact','submit-review','documents/generate','documents/register','send','ready-for-signature','signatures','make-effective','commitments','compare']) assert.match(route,new RegExp(endpoint))
  assert.match(router,/require\('\.\/contractDomain'\)/)
})

test('effective transition creates immutable commitments with accepted-line trace',() => {
  const migration = read('migrations','managed','202608080009_contract_foundation.sql')
  const service = read('services','contracts','commandService.js')
  assert.match(migration,/UNIQUE KEY uq_contract_commitment_line/)
  assert.match(service,/effective_contract_revision_id/)
  assert.match(service,/source_accepted_line_id/)
  assert.match(service,/commitment_hash/)
  assert.doesNotMatch(service,/UPDATE contract_commitments SET/i)
})
