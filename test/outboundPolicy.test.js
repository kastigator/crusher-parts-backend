const test = require('node:test')
const assert = require('node:assert/strict')

const { defaultOutboundMode, getOutboundMode } = require('../utils/outboundPolicy')
const { openAiRequest } = require('../utils/openAiGateway')
const { getFixtureRate } = require('../utils/fxRatesService')

test('staging and recovery default to disabled while production compatibility stays live', () => {
  assert.equal(defaultOutboundMode({ NODE_ENV: 'staging' }), 'disabled')
  assert.equal(defaultOutboundMode({ APP_ENV: 'recovery' }), 'disabled')
  assert.equal(defaultOutboundMode({ NODE_ENV: 'production' }), 'live')
})

test('service mode override is validated', () => {
  assert.equal(getOutboundMode('OPENAI', { OUTBOUND_MODE: 'fixture' }), 'fixture')
  assert.equal(getOutboundMode('OPENAI', { OUTBOUND_MODE: 'disabled', OPENAI_OUTBOUND_MODE: 'live' }), 'live')
  assert.throws(() => getOutboundMode('FX', { FX_OUTBOUND_MODE: 'maybe' }), /live, disabled, or fixture/)
})

test('OpenAI disabled and fixture modes never call the network', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; throw new Error('network must not run') }
  await assert.rejects(
    openAiRequest({}, { env: { OPENAI_OUTBOUND_MODE: 'disabled' }, fetchImpl }),
    (error) => error.code === 'OUTBOUND_DISABLED' && error.status === 503
  )
  const fixture = await openAiRequest({}, { env: { OPENAI_OUTBOUND_MODE: 'fixture' }, fetchImpl })
  assert.equal(fixture.id, 'fixture-response')
  assert.equal(calls, 0)
})

test('FX fixture is deterministic and requires an explicit available pair', () => {
  const env = { FX_FIXTURE_RATES_JSON: '{"USD->RUB":91.25}' }
  assert.equal(getFixtureRate('USD', 'RUB', env).rate, 91.25)
  assert.equal(getFixtureRate('RUB', 'USD', env).rate, 1 / 91.25)
  assert.throws(() => getFixtureRate('EUR', 'CNY', env), /has no rate/)
})
