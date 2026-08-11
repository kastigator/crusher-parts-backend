const test = require('node:test')
const assert = require('node:assert/strict')

const { parseRepositoryName, secretFindings } = require('../scripts/ai-context/common')
const { featureDeploymentStatus, ledgerSummary } = require('../scripts/ai-context/collectors')
const { buildSystemState, renderDatabaseState, renderSystemState } = require('../scripts/ai-context/render')

const SHA = 'a'.repeat(40)
const MAIN_SHA = 'b'.repeat(40)

test('repository URL parsing supports HTTPS and SSH without leaking local paths', () => {
  assert.equal(parseRepositoryName('https://github.com/kastigator/crusher-parts-backend.git'), 'kastigator/crusher-parts-backend')
  assert.equal(parseRepositoryName('git@github.com:kastigator/crusher-parts-frontend.git'), 'kastigator/crusher-parts-frontend')
})

test('ledger summary preserves acknowledged and unresolved failures separately', () => {
  assert.deepEqual(ledgerSummary([
    { status: 'BASELINE' },
    { status: 'APPLIED' },
    { status: 'FAILED', metadata: { recovery: { kind: 'FORWARD_FIX' } } },
    { status: 'FAILED', metadata: {} },
    { status: 'RUNNING' },
  ]), {
    rows: 5,
    baseline: 1,
    applied: 1,
    historical_failed_with_acknowledged_forward_fix: 1,
    unresolved_failed: 1,
    running: 1,
  })
})

test('feature deployment status never guesses when release identity is unavailable', () => {
  const repository = { current_branch: 'feature', head_sha: SHA }
  assert.equal(featureDeploymentStatus(repository, { availability: 'UNKNOWN' }), 'UNKNOWN')
  assert.equal(featureDeploymentStatus(repository, {
    availability: 'AVAILABLE', backend: { release_commit: MAIN_SHA.slice(0, 7) },
  }), 'NOT_DEPLOYED')
  assert.equal(featureDeploymentStatus(repository, {
    availability: 'AVAILABLE', backend: { release_commit: SHA.slice(0, 7) },
  }), 'DEPLOYED_FEATURE')
})

test('generated machine files are stable, metadata-only and secret-scannable', () => {
  const database = {
    availability: 'AVAILABLE',
    platform: 'MySQL',
    instance: 'project:region:instance',
    database: 'test_db',
    engine_version: '8.0-test',
    schema_fingerprint: 'f'.repeat(64),
    expected_schema_fingerprint: 'f'.repeat(64),
    schema_drift: false,
    pending_migrations: [],
    latest_applied_migration: '202608110001_test',
    migration_ledger: {
      rows: 2, baseline: 1, applied: 1,
      historical_failed_with_acknowledged_forward_fix: 0,
      unresolved_failed: 0, running: 0,
    },
    inventory: { base_tables: 1, views: 1, columns: 3, table_names: ['items'], view_names: ['vw_items'] },
    contains_business_rows: false,
  }
  const repository = {
    repository: 'kastigator/example', current_branch: 'feature', head_sha: SHA,
    main_sha: MAIN_SHA, merged_into_main: false, working_tree_clean: true,
    working_tree_change_count: 0,
  }
  const state = buildSystemState({
    generatedAt: '2026-08-11T00:00:00.000Z',
    backend: repository,
    frontend: repository,
    database,
    deployment: { availability: 'UNKNOWN', reason: 'fixture' },
    featureDeployment: 'UNKNOWN',
  })
  const json = renderSystemState(state)
  const markdown = renderDatabaseState(database, state.generated_at)
  assert.deepEqual(JSON.parse(json), state)
  assert.match(markdown, /items/)
  assert.match(markdown, /contains no application rows/i)
  assert.deepEqual(secretFindings(json), [])
  assert.deepEqual(secretFindings(markdown), [])
  assert.equal(json.includes('/Users/'), false)
})

test('secret scanner rejects private keys and concrete credential values', () => {
  assert.deepEqual(secretFindings('-----BEGIN PRIVATE KEY-----'), ['private-key'])
  assert.deepEqual(secretFindings('DB_PASSWORD=real-value'), ['credential-value'])
  assert.deepEqual(secretFindings('DB_PASSWORD=[REDACTED]'), [])
})
