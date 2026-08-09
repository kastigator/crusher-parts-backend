const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertMutationConfirmation,
  assertNonProductionTarget,
} = require('../utils/stagingSafety/targetGuard')

const staging = {
  environment: 'staging',
  projectId: 'erp-sandbox',
  instance: 'erp-stage-db',
  database: 'crusher_parts_stage',
  host: '10.20.30.40',
}

test('explicit non-production target passes and receives a non-secret fingerprint', () => {
  const target = assertNonProductionTarget(staging, [{ database: 'crusher_parts_db', host: '10.0.0.1' }])
  assert.equal(target.environment, 'staging')
  assert.match(target.fingerprint, /^[a-f0-9]{16}$/)
})

test('production markers and exact protected identities are rejected', () => {
  assert.throws(() => assertNonProductionTarget({ ...staging, environment: 'production' }), /non-production/)
  assert.throws(() => assertNonProductionTarget({ ...staging, instance: 'erp-prod-db' }), /production marker/)
  assert.throws(
    () => assertNonProductionTarget(staging, [{ projectId: 'erp-sandbox' }]),
    /matches a protected production target/
  )
})

test('mutation confirmation is exact', () => {
  assert.doesNotThrow(() => assertMutationConfirmation('MASK_NON_PRODUCTION_DATA'))
  assert.throws(() => assertMutationConfirmation('yes'), /must equal/)
})
