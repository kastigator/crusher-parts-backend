const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  classifyRows,
  normalizeRow,
} = require('../services/technicalIdentification/matchService')

const read = (...parts) => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8')

const catalog = [
  { id: 1, manufacturer_part_number: 'HP-100', position_code: 'CP-100', display_name_ru: 'Втулка бронзовая', manufacturer_name: 'Metso', model_name: 'HP 800', classifier_node_name: 'Втулки' },
  { id: 2, manufacturer_part_number: 'DUP-10', position_code: 'CP-200', display_name_ru: 'Плита левая', manufacturer_name: 'ACME', model_name: 'M1', classifier_node_name: 'Плиты' },
  { id: 3, manufacturer_part_number: 'DUP-10', position_code: 'CP-201', display_name_ru: 'Плита правая', manufacturer_name: 'ACME', model_name: 'M1', classifier_node_name: 'Плиты' },
]

test('batch matching distinguishes exact, ambiguous probable, no-match, duplicate and malformed rows', () => {
  const source = [
    normalizeRow({ client_description: 'Втулка бронзовая', client_catalog_number: 'HP 100', requested_qty: 2, uom: 'шт' }, 0),
    normalizeRow({ client_description: 'Плита', client_catalog_number: 'DUP-10', requested_qty: 1, uom: 'шт' }, 1),
    normalizeRow({ client_description: 'Совершенно неизвестная деталь', requested_qty: 1, uom: 'шт' }, 2),
    normalizeRow({ client_description: 'Повтор', client_catalog_number: 'R-1', requested_qty: 1, uom: 'шт' }, 3),
    normalizeRow({ client_description: 'Повтор', client_catalog_number: 'R-1', requested_qty: 1, uom: 'шт' }, 4),
    normalizeRow({ client_description: '', requested_qty: 0, uom: '' }, 5),
  ]
  const result = classifyRows(source, catalog)
  assert.equal(result[0].match_status, 'exact_unique')
  assert.equal(result[0].candidates[0].catalog_position_id, 1)
  assert.equal(result[1].match_status, 'probable')
  assert.equal(result[1].candidates.length, 2)
  assert.equal(result[2].match_status, 'no_match')
  assert.equal(result[3].match_status, 'duplicate')
  assert.equal(result[4].match_status, 'duplicate')
  assert.equal(result[5].match_status, 'malformed')
})

for (const size of [10, 50, 100]) {
  test(`${size}-line intake normalization preserves source order and row identity`, () => {
    const rows = Array.from({ length: size }, (_, index) => normalizeRow({
      row_key: `source-${index + 1}`,
      client_description: `Позиция ${index + 1}`,
      client_catalog_number: `TEST-${index + 1}`,
      requested_qty: index + 1,
      uom: 'шт',
    }, index))
    assert.equal(rows.length, size)
    assert.equal(rows[0].source_row, 1)
    assert.equal(rows.at(-1).source_row, size)
    assert.equal(rows.at(-1).row_key, `source-${size}`)
    assert.ok(rows.every((row) => row.errors.length === 0))
  })
}

test('managed migration adds workflow state only and cannot rewrite protected Classifier data', () => {
  const sql = read('migrations', 'managed', '202608110018_technical_identification_mass_intake.sql')
  const forwardFix = read('migrations', 'managed', '202608110019_technical_identification_mass_intake_forward_fix.sql')
  assert.match(sql, /CREATE TABLE technical_identification_tasks/)
  assert.match(sql, /CREATE TABLE technical_identification_task_events/)
  assert.match(sql, /CREATE TABLE client_request_intake_commands/)
  assert.match(sql, /UNIQUE KEY uq_ti_active_source/)
  assert.match(sql, /UNIQUE KEY uq_ti_event_idempotency/)
  assert.match(sql, /result_catalog_position_id/)
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE FROM|TRUNCATE|DROP TABLE|ALTER TABLE)\s+(?:catalog_positions|equipment_models|equipment_model_bom_items|equipment_classifier_nodes)/i)
  assert.match(forwardFix, /CREATE TABLE IF NOT EXISTS technical_identification_tasks/)
  assert.match(forwardFix, /CREATE TABLE IF NOT EXISTS technical_identification_task_events/)
  assert.doesNotMatch(forwardFix, /(?:UPDATE|DELETE FROM|TRUNCATE|DROP TABLE|ALTER TABLE)\s+(?:catalog_positions|equipment_models|equipment_model_bom_items|equipment_classifier_nodes)/i)
})

test('task commands are versioned, idempotent and resolve through the Client Request transaction boundary', () => {
  const service = read('services', 'technicalIdentification', 'taskService.js')
  assert.match(service, /TASK_VERSION_CONFLICT/)
  assert.match(service, /idempotency_key/)
  assert.match(service, /FOR UPDATE/)
  assert.match(service, /setIdentificationInTransaction/)
  assert.match(service, /getRevisionReadiness/)
  assert.match(service, /await conn\.commit\(\)/)
  assert.match(service, /await conn\.rollback\(\)/)
  assert.match(service, /active_source_key = NULL/)
  assert.match(service, /reopened_from_task_id/)
  assert.doesNotMatch(service, /UPDATE\s+catalog_positions|INSERT INTO\s+catalog_positions/i)
})

test('mass intake commits request, revision, all rows, identifications, tasks and command ledger atomically', () => {
  const service = read('services', 'clientRequests', 'intakeService.js')
  assert.match(service, /await conn\.beginTransaction\(\)/)
  assert.match(service, /INSERT INTO client_requests/)
  assert.match(service, /INSERT INTO client_request_revisions/)
  assert.match(service, /INSERT INTO client_request_revision_items/)
  assert.match(service, /createTaskInTransaction/)
  assert.match(service, /INSERT INTO client_request_intake_commands/)
  assert.match(service, /PREVIEW_STALE/)
  assert.match(service, /IDEMPOTENCY_PAYLOAD_CONFLICT/)
  assert.match(service, /await conn\.rollback\(\)/)
  assert.doesNotMatch(service, /INSERT INTO\s+(?:catalog_positions|equipment_models|equipment_manufacturers|equipment_classifier_nodes)/i)
})

test('queue and registry expose aggregate read models without browser-side per-row orchestration', () => {
  const queue = read('services', 'technicalIdentification', 'readModel.js')
  const registry = read('services', 'clientRequests', 'registryReadModel.js')
  const routes = read('routes', 'technicalIdentification.js')
  assert.match(queue, /LIMIT \$\{pageSize\} OFFSET \$\{\(page - 1\) \* pageSize\}/)
  assert.match(queue, /client_request_number/)
  assert.match(registry, /ready_for_release_lines/)
  assert.match(registry, /technical_identification_tasks/)
  assert.match(routes, /technical_identification\.access/)
  assert.match(routes, /technical_identification\.resolve/)
})
