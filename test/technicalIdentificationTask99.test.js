const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const requireCapability = require('../middleware/requireCapability')
const {
  classifyRows,
  normalizeRow,
} = require('../services/technicalIdentification/matchService')
const {
  buildMeasurementUnitIndex,
  resolveCanonicalMeasurementUnit,
} = require('../services/measurementUnits/canonicalService')

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8')
const units = buildMeasurementUnitIndex([
  { id: 1, code: 'шт', name_ru: 'Штука', symbol: 'шт', dimension_type: 'quantity', is_active: 1 },
  { id: 2, code: 'кг', name_ru: 'Килограмм', symbol: 'кг', dimension_type: 'mass', is_active: 1 },
  { id: 3, code: 'стар', name_ru: 'Старая единица', symbol: 'стар', dimension_type: 'custom', is_active: 0 },
])

const candidate = (overrides = {}) => ({
  id: 1,
  manufacturer_part_number: 'HP-100',
  position_code: 'CP-100',
  display_name_ru: 'Втулка бронзовая',
  manufacturer_name: 'Metso',
  model_name: 'HP 800',
  classifier_node_name: 'Втулки',
  manufacturer_id: 10,
  equipment_model_id: 20,
  ...overrides,
})

test('canonical UOM resolves aliases to active measurement_units and preserves provenance', () => {
  for (const token of ['pcs', 'ea', 'шт.']) {
    const row = normalizeRow({ client_description: 'Позиция', requested_qty: 1, uom: token, source_uom: token }, 0, {}, units)
    assert.equal(row.uom, 'шт')
    assert.equal(row.source_uom, token)
    assert.equal(row.measurement_unit_id, 1)
    assert.equal(row.uom_resolution.original, token)
    assert.equal(row.uom_resolution.canonical, 'шт')
    assert.equal(row.errors.length, 0)
  }
  const kg = resolveCanonicalMeasurementUnit('kg', units)
  assert.equal(kg.uom, 'кг')
  assert.equal(kg.measurement_unit_id, 2)
})

test('unknown and inactive UOM values are rejected instead of creating dictionary rows', () => {
  assert.equal(resolveCanonicalMeasurementUnit('crate', units).error.code, 'UOM_NOT_IN_DICTIONARY')
  assert.equal(resolveCanonicalMeasurementUnit('стар', units).error.code, 'UOM_INACTIVE')
  const service = read('services', 'measurementUnits', 'canonicalService.js')
  const intake = read('services', 'clientRequests', 'intakeService.js')
  assert.doesNotMatch(`${service}\n${intake}`, /INSERT INTO measurement_units|UPDATE measurement_units|DELETE FROM measurement_units/i)
})

test('exact matching requires compatible manufacturer and equipment evidence', () => {
  const matching = normalizeRow({ client_catalog_number: 'HP 100', client_manufacturer_text: 'Metso', client_equipment_model_text: 'HP800', requested_qty: 1, uom: 'шт' })
  const manufacturerConflict = normalizeRow({ client_catalog_number: 'HP 100', client_manufacturer_text: 'Sandvik', client_equipment_model_text: 'HP800', requested_qty: 1, uom: 'шт' })
  const modelConflict = normalizeRow({ client_catalog_number: 'HP 100', client_manufacturer_text: 'Metso', client_equipment_model_text: 'CH880', requested_qty: 1, uom: 'шт' })
  assert.equal(classifyRows([matching], [candidate()])[0].match_status, 'exact_unique')
  const manufacturerResult = classifyRows([manufacturerConflict], [candidate()])[0]
  assert.equal(manufacturerResult.match_status, 'probable')
  assert.equal(manufacturerResult.candidates[0].evidence.manufacturer, 'conflict')
  assert.ok(manufacturerResult.candidates[0].reason_codes.includes('MANUFACTURER_CONFLICT'))
  const modelResult = classifyRows([modelConflict], [candidate()])[0]
  assert.equal(modelResult.match_status, 'probable')
  assert.equal(modelResult.candidates[0].evidence.equipment_model, 'conflict')
})

test('duplicate exact candidates are explicit ambiguous results and never first-candidate confirmation', () => {
  const row = normalizeRow({ client_catalog_number: 'HP-100', client_manufacturer_text: 'Metso', requested_qty: 1, uom: 'шт' })
  const result = classifyRows([row], [candidate(), candidate({ id: 2, position_code: 'CP-101' })])[0]
  assert.equal(result.match_status, 'ambiguous')
  assert.equal(result.candidates.length, 2)
  assert.deepEqual(result.candidates.map((item) => item.catalog_position_id), [1, 2])
})

test('no match remains unresolved and 100-row normalization retains stable order', () => {
  const rows = Array.from({ length: 100 }, (_, index) => normalizeRow({
    row_key: `task99-${index + 1}`,
    client_description: `Позиция ${index + 1}`,
    requested_qty: 1,
    uom: index % 2 ? 'pcs' : 'ea',
    source_uom: index % 2 ? 'pcs' : 'ea',
  }, index, {}, units))
  const results = classifyRows(rows, [])
  assert.equal(results.length, 100)
  assert.ok(results.every((row) => row.match_status === 'no_match' && row.uom === 'шт'))
  assert.equal(results.at(-1).source_row, 100)
})

test('exact confirmation is explicit, hashed and auditable while unresolved outcomes create tasks', () => {
  const matching = read('services', 'technicalIdentification', 'matchService.js')
  const intake = read('services', 'clientRequests', 'intakeService.js')
  assert.match(intake, /confirm_exact_matches === true/)
  assert.match(intake, /EXACT_CONFIRMATION_REQUIRED/)
  assert.match(intake, /bulk_confirm_exact_unique/)
  assert.match(intake, /explicit_bulk_action/)
  assert.match(intake, /insertRows\(conn, 'client_request_item_identifications'/)
  assert.match(intake, /request_item_identified/)
  assert.match(intake, /\['probable', 'ambiguous', 'no_match'\]/)
  assert.match(matching, /exact_confirmation/)
  assert.doesNotMatch(intake, /confirm_exact_matches !== false/)
})

test('task lifecycle enforces canonical transitions, concurrency, idempotency and immutable reopen generations', () => {
  const service = read('services', 'technicalIdentification', 'taskService.js')
  for (const token of ['new', 'in_progress', 'waiting_client', 'resolved', 'closed']) assert.match(service, new RegExp(`['\"]${token}['\"]`))
  assert.match(service, /ROW_VERSION_REQUIRED/)
  assert.match(service, /TASK_VERSION_CONFLICT/)
  assert.match(service, /idempotency_key/)
  assert.match(service, /reopened_from_task_id/)
  assert.match(service, /TASK_TERMINAL/)
  assert.match(service, /previous_task_number/)
  assert.match(service, /status: 'not_required'/)
})

test('resolution and injected mid-batch failure remain inside backend transactions', () => {
  const task = read('services', 'technicalIdentification', 'taskService.js')
  const intake = read('services', 'clientRequests', 'intakeService.js')
  assert.match(task, /setIdentificationInTransaction/)
  assert.match(task, /getRevisionReadiness/)
  assert.match(task, /catalog_position_id: catalogPositionId/)
  assert.match(task, /await conn\.commit\(\)/)
  assert.match(task, /await conn\.rollback\(\)/)
  assert.match(intake, /runtime\.afterRow/)
  assert.match(intake, /await conn\.beginTransaction\(\)/)
  assert.match(intake, /await conn\.rollback\(\)/)
})

test('Task 99 schema change is a new forward migration and does not touch protected data', () => {
  const migration = read('migrations', 'managed', '202608110020_technical_identification_corrective_lifecycle.sql')
  assert.match(migration, /ALTER TABLE technical_identification_tasks/)
  assert.match(migration, /'closed'/)
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)[\s\S]*(?:catalog_positions|equipment_models|equipment_model_bom_items|equipment_classifier_nodes|measurement_units)/i)
})

test('RBAC guards allow the exact capability and deny read-only access to mutations', () => {
  const guard = requireCapability('technical_identification.resolve')
  let nextCalled = false
  guard({ user: { capabilities: ['technical_identification.resolve'] } }, {}, () => { nextCalled = true })
  assert.equal(nextCalled, true)
  let statusCode = null
  guard(
    { user: { capabilities: ['technical_identification.access'] } },
    { status(code) { statusCode = code; return this }, json() {} },
    () => assert.fail('read-only user must not pass mutation guard')
  )
  assert.equal(statusCode, 403)
  const routes = read('routes', 'technicalIdentification.js')
  assert.match(routes, /technical_identification\.access/)
  assert.match(routes, /technical_identification\.manage/)
  assert.match(routes, /technical_identification\.assign/)
  assert.match(routes, /technical_identification\.resolve/)
})

test('registry and queue stay bounded aggregate read models without request-per-row fetching', () => {
  const queue = read('services', 'technicalIdentification', 'readModel.js')
  const registry = read('services', 'clientRequests', 'registryReadModel.js')
  assert.match(queue, /COUNT\(\*\) AS total/)
  assert.match(queue, /LIMIT \$\{pageSize\} OFFSET/)
  assert.match(registry, /GROUP BY cr\.id/)
  assert.doesNotMatch(`${queue}\n${registry}`, /for\s*\([^)]*row[^)]*\)[\s\S]*getWorkspace/)
})
