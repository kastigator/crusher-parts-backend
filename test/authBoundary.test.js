const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

const authMiddleware = require('../middleware/authMiddleware')

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    },
  }
}

test('auth boundary preserves missing-token behavior', () => {
  const req = { headers: {} }
  const res = responseRecorder()
  let nextCalled = false

  authMiddleware(req, res, () => { nextCalled = true })

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.payload, { message: 'Токен не передан' })
  assert.equal(nextCalled, false)
})

test('auth boundary preserves invalid-token behavior', () => {
  const req = { headers: { authorization: 'Bearer invalid' } }
  const res = responseRecorder()

  authMiddleware(req, res, () => assert.fail('next must not be called'))

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.payload, { message: 'Неверный или просроченный токен' })
})

test('auth boundary forwards the existing decoded JWT payload', () => {
  const token = jwt.sign(
    { id: 7, role: 'admin' },
    process.env.JWT_SECRET || 'super-secret-key'
  )
  const req = { headers: { authorization: `Bearer ${token}` } }
  const res = responseRecorder()
  let nextCalled = false

  authMiddleware(req, res, () => { nextCalled = true })

  assert.equal(nextCalled, true)
  assert.equal(req.user.id, 7)
  assert.equal(req.user.role, 'admin')
})
