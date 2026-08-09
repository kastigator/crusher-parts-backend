const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { evaluateItemReadiness } = require('../services/clientRequests/readinessPolicy')

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8')

test('release readiness is explicit and rejects incomplete or already released items', () => {
  const base = {
    requested_qty: 2,
    uom: 'шт',
    item_status: 'active',
    identification_status: 'confirmed',
    identification_catalog_position_id: 47,
    substitution_policy: 'exact_only',
    already_released_count: 0,
  }
  assert.equal(evaluateItemReadiness(base).ready, true)
  assert.deepEqual(
    evaluateItemReadiness({ ...base, identification_status: 'needs_review' }).blocker_codes,
    ['IDENTIFICATION_NOT_CONFIRMED']
  )
  assert.deepEqual(
    evaluateItemReadiness({ ...base, substitution_policy: 'unspecified', already_released_count: 1 }).blocker_codes,
    ['SUBSTITUTION_POLICY_UNSPECIFIED', 'ALREADY_RELEASED']
  )
})

test('Wave 2 migration is additive, preserves legacy data, and creates immutable release snapshots', () => {
  const sql = read('migrations', 'managed', '202608080003_client_request_procurement_release.sql')
  assert.match(sql, /CREATE TABLE procurement_releases/)
  assert.match(sql, /CREATE TABLE procurement_release_items/)
  assert.match(sql, /source_data_snapshot_json JSON NOT NULL/)
  assert.match(sql, /INSERT INTO client_request_revisions/)
  assert.match(sql, /legacy-request-/)
  assert.match(sql, /client_requests\.release_to_procurement/)
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/)
})

test('target routes use capabilities and legacy RFQ commands are retired in favor of Sourcing', () => {
  const routes = read('routes', 'clientRequestDomain.js')
  const releaseRoutes = read('routes', 'procurementReleases.js')
  const legacyRoutes = read('routes', 'clientRequests.js')
  assert.match(routes, /client_requests\.identify_items/)
  assert.match(routes, /client_requests\.manage_requirements/)
  assert.match(releaseRoutes, /client_requests\.release_to_procurement/)
  assert.match(legacyRoutes, /LEGACY_RFQ_COMMAND_RETIRED/)
  assert.match(legacyRoutes, /router\.all\('\/:id\/assign-rfq'/)
  assert.match(legacyRoutes, /target_route: '\/sourcing\/cases\/from-release'/)
})

test('Client Request read model marks downstream data non-authoritative and read-only', () => {
  const source = read('services', 'clientRequests', 'clientRequestReadModel.js')
  assert.match(source, /authoritative: false/)
  assert.match(source, /read_only: true/)
  assert.match(source, /owner: 'downstream_domains'/)
})
