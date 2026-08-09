const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { calculatePricingRevision, calculateRouteCost } = require('../services/pricing/calculationEngine')

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8')

test('Wave 4 migration establishes additive Pricing ownership and immutable revisions', () => {
  const sql = read('migrations', 'managed', '202608080006_pricing_foundation.sql')
  for (const table of [
    'pricing_cases', 'pricing_input_snapshots', 'pricing_input_lines',
    'pricing_calculation_groups', 'pricing_route_variants',
    'pricing_variant_parameter_revisions', 'pricing_calculation_revisions',
    'pricing_calculation_block_results', 'pricing_calculation_line_results',
    'pricing_client_price_lines', 'pricing_price_overrides',
    'pricing_decisions', 'pricing_decision_lines', 'pricing_rework_signals',
  ]) assert.match(sql, new RegExp(`CREATE TABLE ${table}`))
  assert.match(sql, /sourcing_decision_id BIGINT NOT NULL/)
  assert.match(sql, /seller_projection_snapshot_json/)
  assert.match(sql, /procurement_projection_snapshot_json/)
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/)
})

test('Pricing API is capability-gated and supplier reveal is explicit', () => {
  const routes = read('routes', 'pricing.js')
  for (const capability of [
    'pricing.access', 'pricing.cases.manage', 'pricing.groups.manage',
    'pricing.calculate', 'pricing.client_prices.manage',
    'pricing.overrides.approve', 'pricing.decisions.finalize',
    'pricing.supplier_identity.reveal',
  ]) assert.match(routes, new RegExp(capability.replaceAll('.', '\\.')))
  assert.match(routes, /supplier-identity/)
  assert.match(routes, /rework-signals/)
})

test('Pricing writes neither Sourcing/Supplier master nor physical shipment truth', () => {
  const files = [
    read('services', 'pricing', 'caseService.js'),
    read('services', 'pricing', 'calculationService.js'),
    read('services', 'pricing', 'readModel.js'),
  ].join('\n')
  assert.doesNotMatch(files, /UPDATE sourcing_|INSERT INTO sourcing_|DELETE FROM sourcing_/)
  assert.doesNotMatch(files, /UPDATE supplier_parts|INSERT INTO supplier_parts|UPDATE part_suppliers|INSERT INTO part_suppliers/)
  assert.doesNotMatch(files, /rfq_shipment_groups|rfq_shipment_group_routes|shipment_groups|shipments|dispatches/)
})

test('validated legacy route formula remains deterministic', () => {
  assert.equal(calculateRouteCost({ pricing_model: 'fixed', fixed_cost: 100, min_cost: 80, markup_pct: 10, markup_fixed: 5 }, {}).toFixed(4), '115.0000')
  assert.equal(calculateRouteCost({ pricing_model: 'per_kg', rate_per_kg: 2.4, min_cost: 100 }, { TOTAL_WEIGHT_KG: 50 }).toFixed(4), '120.0000')
  assert.equal(calculateRouteCost({ pricing_model: 'per_kg_or_cbm_max', rate_per_kg: 2, rate_per_cbm: 50 }, { TOTAL_WEIGHT_KG: 20, TOTAL_VOLUME_CBM: 2 }).toFixed(4), '100.0000')
})

test('calculation revision preserves requested/supply quantities, FX, allocation, duty, markup and rounding', () => {
  const calculation = calculatePricingRevision({
    lines: [
      { id: 1, purchase_unit_price: '10', purchase_currency: 'EUR', purchase_quantity: '2', client_quantity: '2' },
      { id: 2, purchase_unit_price: '20', purchase_currency: 'USD', purchase_quantity: '1', client_quantity: '1' },
    ],
    parameters: {
      fx_rates: { EUR: '1.2' }, FREIGHT_TOTAL: '12', FREIGHT_CURRENCY: 'USD',
      OTHER_TOTAL: '4', DUTY_RATE_PCT: '5', TARGET_MARKUP_PCT: '25', ROUNDING_INCREMENT: '0.05',
    },
    template: { pricing_model: 'fixed', currency: 'USD' },
    allocationMethod: 'BY_VALUE', calculationCurrency: 'USD',
  })
  assert.deepEqual(calculation.totals, {
    goods: '44.00000000', freight: '12.00000000', duty: '2.20000000', other: '4.00000000', landed: '62.20000000',
  })
  assert.equal(calculation.results[0].rounded_client_unit_price, '21.2000')
  assert.equal(calculation.results[1].rounded_client_unit_price, '35.3500')
  assert.equal(calculation.results.reduce((sum, line) => sum + Number(line.freight_amount_raw), 0), 12)
})

test('workspace masks real Supplier identity and cost projection by default', () => {
  const readModel = read('services', 'pricing', 'readModel.js')
  assert.match(readModel, /delete base\.supply_identity_snapshot_json/)
  assert.match(readModel, /delete base\.supplier_id/)
  assert.match(readModel, /pricing\.costs\.view/)
  assert.match(readModel, /supplier_identity_revealed/)
  assert.match(readModel, /alias_only/)
})
