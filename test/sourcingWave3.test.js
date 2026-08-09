const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8')

test('Wave 3 migration is additive and establishes the explicit Sourcing ownership chain', () => {
  const sql = read('migrations', 'managed', '202608080004_sourcing_foundation.sql')
  for (const table of [
    'sourcing_cases', 'sourcing_demands', 'supplier_inquiries',
    'supplier_inquiry_revisions', 'supplier_inquiry_dispatches',
    'supplier_offers', 'supplier_offer_revisions', 'supplier_offer_lines',
    'sourcing_coverage_options', 'sourcing_decisions', 'sourcing_decision_lines',
  ]) assert.match(sql, new RegExp(`CREATE TABLE ${table}`))
  assert.match(sql, /procurement_release_item_id INT NOT NULL/)
  assert.match(sql, /legacy_rfq_id/)
  assert.match(sql, /supplier_master_data_promotion_requests/)
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/)
})

test('Sourcing commands are capability-gated with a default-deny decision boundary', () => {
  const routes = read('routes', 'sourcing.js')
  for (const capability of [
    'sourcing.access', 'sourcing.cases.manage', 'sourcing.inquiries.manage',
    'sourcing.offers.manage', 'sourcing.coverage.manage',
    'sourcing.decisions.finalize', 'sourcing.master_data_promotion.request',
  ]) assert.match(routes, new RegExp(capability.replaceAll('.', '\\.')))
  assert.match(routes, /decisions\/finalize/)
  assert.match(routes, /master-data-promotion-requests/)
})

test('Supplier Offer persistence cannot silently mutate Supplier master data', () => {
  const offerService = read('services', 'sourcing', 'offerService.js')
  const promotionService = read('services', 'sourcing', 'promotionService.js')
  assert.match(offerService, /INSERT INTO supplier_offers/)
  assert.match(offerService, /INSERT INTO supplier_offer_lines/)
  assert.doesNotMatch(offerService, /INSERT INTO supplier_parts|UPDATE supplier_parts|INSERT INTO supplier_part_prices|UPDATE supplier_part_prices/)
  assert.match(promotionService, /INSERT INTO supplier_master_data_promotion_requests/)
  assert.doesNotMatch(promotionService, /INSERT INTO supplier_parts|UPDATE supplier_parts|INSERT INTO supplier_part_prices|UPDATE supplier_part_prices/)
})

test('decision lines preserve release, supplier, offer, catalog and coverage trace', () => {
  const service = read('services', 'sourcing', 'coverageDecisionService.js')
  assert.match(service, /procurement_release_item_id/)
  assert.match(service, /supplier_offer_line_id/)
  assert.match(service, /offered_catalog_position_id/)
  assert.match(service, /coverage_option_id/)
  assert.match(service, /stable_item_key/)
  assert.match(service, /DECISION_BLOCKED/)
})

test('Client Request only receives a read-only downstream link to Sourcing Case', () => {
  const readModel = read('services', 'clientRequests', 'clientRequestReadModel.js')
  assert.match(readModel, /sourcing_cases: sourcingCases/)
  assert.match(readModel, /authoritative: false/)
  assert.match(readModel, /read_only: true/)
  assert.doesNotMatch(readModel, /UPDATE sourcing_cases|INSERT INTO sourcing_cases/)
})
