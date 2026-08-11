const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8')

test('Task 101 intake persistence is set-based and keeps one transaction boundary', () => {
  const service = read('services', 'clientRequests', 'intakeService.js')
  const persistence = service.slice(service.indexOf('async function persistRowsSetBased'), service.indexOf('async function commitIntake'))

  for (const table of [
    'client_request_revision_items',
    'client_request_item_requirements',
    'technical_identification_tasks',
    'technical_identification_task_events',
    'client_request_item_identifications',
    'client_request_events',
  ]) {
    assert.match(persistence, new RegExp(`insertRows\\(conn, '${table}'`))
  }
  assert.doesNotMatch(persistence, /for \(let index.*await conn\.execute/s)
  assert.match(service, /await conn\.beginTransaction\(\)/)
  assert.match(service, /await conn\.commit\(\)/)
  assert.match(service, /await conn\.rollback\(\)/)
})

test('Task 101 preserves technical identification, UOM provenance and safe matching semantics', () => {
  const service = read('services', 'clientRequests', 'intakeService.js')
  assert.match(service, /technical_task_open/)
  assert.match(service, /active_source_key/)
  assert.match(service, /intake_match_status/)
  assert.match(service, /intake_payload_hash/)
  assert.match(service, /source_uom/)
  assert.match(service, /measurement_unit_id/)
  assert.match(service, /explicit_bulk_action/)
  assert.match(service, /IDEMPOTENCY_PAYLOAD_CONFLICT/)
  assert.doesNotMatch(service, /INSERT INTO\s+(?:catalog_positions|measurement_units|equipment_models|equipment_manufacturers|equipment_classifier_nodes)/i)
})

test('Task 101 profiler reports phase timings and DB round trips for comparable runs', () => {
  const profiler = read('scripts', 'performance', 'benchmark-client-request-intake.js')
  for (const token of [
    'matching_candidates',
    'line_persistence',
    'task_creation',
    'task_events',
    'identification_persistence',
    'client_request_events',
    'commit',
    'db_round_trips',
    'median_commit_ms',
  ]) assert.match(profiler, new RegExp(token))
})
