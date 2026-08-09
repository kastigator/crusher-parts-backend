const test = require('node:test')
const assert = require('node:assert/strict')

const { buildCorsPolicy, corsOptionsFromPolicy } = require('../utils/corsPolicy')

const evaluateOrigin = (options, origin) => new Promise((resolve) => {
  options.origin(origin, (error, allowed) => resolve({ error, allowed }))
})

test('production CORS uses only explicitly configured exact origins', async () => {
  const policy = buildCorsPolicy({
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://erp.example.test,https://storage.googleapis.com',
    CORS_ALLOW_NO_ORIGIN: 'false',
  })
  assert.deepEqual([...policy.allowedOrigins], [
    'https://erp.example.test',
    'https://storage.googleapis.com',
  ])
  assert.equal((await evaluateOrigin(corsOptionsFromPolicy(policy), 'https://erp.example.test')).allowed, true)
  assert.match((await evaluateOrigin(corsOptionsFromPolicy(policy), 'https://evil.example.test')).error.message, /Not allowed/)
  assert.match((await evaluateOrigin(corsOptionsFromPolicy(policy), undefined)).error.message, /no-origin/)
})

test('storage.googleapis.com is not an unconditional production origin', () => {
  const policy = buildCorsPolicy({ NODE_ENV: 'production' })
  assert.equal(policy.allowedOrigins.has('https://storage.googleapis.com'), false)
})

test('local origins and intentional no-Origin compatibility remain available', async () => {
  const policy = buildCorsPolicy({ NODE_ENV: 'local' })
  assert.equal(policy.allowedOrigins.has('http://localhost:5173'), true)
  assert.equal((await evaluateOrigin(corsOptionsFromPolicy(policy), undefined)).allowed, true)
})

test('CORS rejects paths and invalid boolean configuration', () => {
  assert.throws(() => buildCorsPolicy({ NODE_ENV: 'production', CORS_ORIGINS: 'https://example.test/path' }), /exact/)
  assert.throws(() => buildCorsPolicy({ NODE_ENV: 'production', CORS_ALLOW_NO_ORIGIN: 'sometimes' }), /must be true or false/)
})
