const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname,'..')
const read = (...parts) => fs.readFileSync(path.join(root,...parts),'utf8')
const { assessFeedbackChange, findRestrictedClientPayload, priceAuthority } = require('../services/commercialOffers/policy')

test('Wave 5 migration is additive and creates the canonical Commercial Offer evidence model', () => {
  const sql = read('migrations','managed','202608080007_commercial_offer_foundation.sql')
  const feedbackForwardFix = read('migrations','managed','202608080008_commercial_offer_feedback_events_forward_fix.sql')
  for (const table of [
    'commercial_offers','commercial_offer_revisions','commercial_offer_lines','commercial_approval_requests',
    'commercial_offer_document_generations','commercial_sent_offer_snapshots','commercial_client_feedback',
    'commercial_client_feedback_lines','commercial_change_impact_assessments','commercial_accepted_revisions',
    'commercial_accepted_lines','commercial_offer_events',
  ]) assert.match(sql,new RegExp(`CREATE TABLE ${table}\\b`))
  assert.doesNotMatch(sql,/(^|;)\s*(DROP|TRUNCATE|DELETE\s+FROM)\b/i)
  assert.match(sql,/commercial_offers\.approvals\.decide/)
  assert.match(sql,/source_pricing_decision_id/)
  assert.match(feedbackForwardFix,/DROP INDEX uq_commercial_feedback_snapshot/)
  assert.match(feedbackForwardFix,/ADD KEY idx_commercial_feedback_snapshot/)
  assert.doesNotMatch(feedbackForwardFix,/(^|;)\s*(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i)
})

test('Commercial Offer intake selects only fixed Pricing seller/client projections', () => {
  const service = read('services','commercialOffers','commandService.js')
  assert.match(service,/decision\.status !== 'FIXED'/)
  assert.match(service,/seller_projection_snapshot_json/)
  assert.match(service,/client_projection_snapshot_json/)
  assert.doesNotMatch(service,/procurement_projection_snapshot_json/)
  assert.doesNotMatch(service,/JOIN\s+part_suppliers|JOIN\s+supplier_parts|JOIN\s+supplier_offer_lines/i)
})

test('client projection rejects procurement and supplier-confidential fields', () => {
  assert.deepEqual(findRestrictedClientPayload({ description: 'Bearing',quantity: 2 }),[])
  const findings = findRestrictedClientPayload({ supplier_name: 'Hidden',nested: { purchase_price: 10 },description: 'Source A' })
  assert.ok(findings.some((item) => item.code === 'RESTRICTED_KEY'))
  assert.ok(findings.some((item) => item.code === 'RESTRICTED_TEXT'))
})

test('missing delegated floor is handled conservatively and requires approval below recommendation', () => {
  const line = { recommended_unit_price_snapshot: '100.0000',delegated_floor_snapshot: null,absolute_floor_snapshot: null }
  assert.equal(priceAuthority(line,100),'PERMITTED')
  assert.equal(priceAuthority(line,99),'APPROVAL_REQUIRED')
})

test('Change Impact Resolver keeps commercial edits local and escalates quantity/execution changes', () => {
  const offerLine = { offered_quantity: 2,offered_unit_price: 100,recommended_unit_price_snapshot: 100,delegated_floor_snapshot: 95,absolute_floor_snapshot: 90,client_delivery_commitment_days: 10 }
  assert.deepEqual(assessFeedbackChange({ result: 'NOT_REQUIRED' },offerLine).affected_domains,['COMMERCIAL_OFFER'])
  const quantity = assessFeedbackChange({ result: 'CHANGE_REQUESTED',requested_quantity: 3 },offerLine)
  assert.equal(quantity.required_action,'UPSTREAM_REVISION_REQUIRED')
  assert.ok(quantity.affected_domains.includes('SOURCING'))
  assert.ok(quantity.affected_domains.includes('PRICING'))
  const discount = assessFeedbackChange({ result: 'CHANGE_REQUESTED',requested_unit_price: 92 },offerLine)
  assert.equal(discount.required_action,'APPROVAL_REQUIRED')
})

test('API uses capability guards and exposes lifecycle/readiness/contract input', () => {
  const route = read('routes','commercialOffers.js')
  const router = read('routes','routerIndex.js')
  for (const capability of ['commercial_offers.access','commercial_offers.manage','commercial_offers.approvals.decide','commercial_offers.issue','commercial_offers.feedback.manage','commercial_offers.accept']) {
    assert.match(route,new RegExp(capability.replaceAll('.','\\.')))
  }
  assert.match(router,/require\('\.\/commercialOffers'\)/)
  for (const endpoint of ['client-preview','submit-review','ready','render','send','assess-impact','create-next-revision','revisions/from-pricing-decision','acceptance','accepted-result','compare']) assert.match(route,new RegExp(endpoint))
  assert.match(read('services','commercialOffers','commandService.js'),/PRICING_DECISION_SCOPE_MISMATCH/)
})

test('issued and accepted facts are guarded as immutable revisions/snapshots', () => {
  const service = read('services','commercialOffers','commandService.js')
  assert.match(service,/revision\.status !== 'DRAFT'/)
  assert.match(service,/REVISION_IMMUTABLE/)
  assert.match(service,/commercial_sent_offer_snapshots/)
  assert.match(service,/commercial_accepted_revisions/)
  assert.match(service,/acceptance_hash/)
})
