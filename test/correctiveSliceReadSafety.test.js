const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const legacyReadOnly = require('../middleware/legacyReadOnly')

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')

test('dashboard GET handlers are read-only and contain no mutation statements', () => {
  const source = read('routes/dashboard.js')
  for (const marker of ["router.get('/summary'", "router.get('/notifications'", "router.get('/events'"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  const getOnly = source
    .split("router.post('/notifications/mark-read'")[0]
  assert.doesNotMatch(getOnly, /\b(?:DELETE|UPDATE|INSERT|REPLACE|TRUNCATE)\b/i)
  assert.doesNotMatch(source, /roleOf|nachalnik-otdela-zakupok/)
})

test('dashboard summary can be read twice without issuing a mutation', async () => {
  const db = require('../utils/db')
  const router = require('../routes/dashboard')
  const layer = router.stack.find((item) => item.route?.path === '/summary')
  const handler = layer.route.stack[0].handle
  const originalExecute = db.execute
  const calls = []
  db.execute = async (sql) => {
    calls.push(sql.replace(/\s+/g, ' ').trim())
    if (sql.includes('AS assigned_requests')) return [[{ assigned_requests: 0, assigned_sourcing_cases: 0, unread_notifications: 0 }]]
    return [[]]
  }
  const responses = []
  const run = async () => {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode=code;return this }, json(body) { this.body=body;responses.push(body);return this } }
    await handler({ user:{ id:7,capabilities:[] }, query:{} }, res)
    assert.equal(res.statusCode, 200)
  }
  try {
    await run()
    await run()
  } finally {
    db.execute = originalExecute
  }
  assert.equal(responses.length, 2)
  assert.deepEqual(responses[0], responses[1])
  assert.equal(calls.length, 6)
  assert.equal(calls.every((sql) => /^SELECT\b/i.test(sql)), true)
})

test('legacy process surfaces allow historical reads and reject writes with an explicit target', () => {
  const guard = legacyReadOnly({ surface: 'Legacy RFQ', targetRoute: '/sourcing' })
  let nextCalled = false
  guard({ method: 'GET' }, {}, () => { nextCalled = true })
  assert.equal(nextCalled, true)
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
  guard({ method: 'POST' }, res, () => assert.fail('write must not pass'))
  assert.equal(res.statusCode, 410)
  assert.equal(res.body.code, 'LEGACY_WRITE_SURFACE_RETIRED')
  assert.equal(res.body.target_route, '/sourcing')
})

test('Client Request legacy RFQ write commands are explicitly retired before old handlers', () => {
  const source = read('routes/clientRequests.js')
  const retirement = source.indexOf("router.all('/:id/assign-rfq'")
  const oldHandler = source.indexOf("router.post('/:id/assign-rfq'")
  assert.ok(retirement >= 0 && oldHandler > retirement)
  assert.match(source, /LEGACY_RFQ_COMMAND_RETIRED/)
})
