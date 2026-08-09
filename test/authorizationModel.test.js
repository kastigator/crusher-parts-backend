const test = require('node:test')
const assert = require('node:assert/strict')

const requireCapability = require('../middleware/requireCapability')
const {
  hasCapability,
  resolveEffectiveAccess,
} = require('../services/authorizationService')

class AuthorizationExecutor {
  constructor({ roles = [], capabilities = [], permissions = [] } = {}) {
    this.roles = roles
    this.capabilities = capabilities
    this.permissions = permissions
  }

  async execute(sql) {
    const normalized = sql.replace(/\s+/g, ' ')
    if (normalized.includes('FROM users')) {
      return [[{
        id: 9,
        username: 'multi-role-user',
        full_name: 'Multi Role',
        email: null,
        phone: null,
        role_id: 4,
        is_active: 1,
        must_change_password: 0,
        disabled_at: null,
      }]]
    }
    if (normalized.includes('FROM user_roles')) return [this.roles]
    if (normalized.includes('FROM role_capabilities')) {
      return [this.capabilities.map((capability_key) => ({ capability_key }))]
    }
    if (normalized.includes('FROM role_permissions')) {
      return [this.permissions.map((tab_id) => ({ tab_id }))]
    }
    if (normalized.includes('FROM roles')) return [[]]
    throw new Error(`Unexpected SQL: ${normalized}`)
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.payload = payload; return this },
  }
}

test('multiple roles resolve to the union of role capabilities and legacy tab compatibility', async () => {
  const executor = new AuthorizationExecutor({
    roles: [
      { id: 4, name: 'Sales', slug: 'sales', is_primary: 1, is_system: 0, is_super_admin: 0 },
      { id: 14, name: 'Procurement', slug: 'procurement', is_primary: 0, is_system: 0, is_super_admin: 0 },
    ],
    capabilities: ['client_request.manage', 'sourcing.manage'],
    permissions: [25, 39],
  })

  const access = await resolveEffectiveAccess(9, executor)
  assert.deepEqual(access.role_ids, [4, 14])
  assert.equal(access.role, 'sales')
  assert.deepEqual(access.capabilities, ['client_request.manage', 'sourcing.manage'])
  assert.deepEqual(access.permissions, [25, 39])
  assert.equal(access.authorization_source, 'user_roles')
})

test('effective capability checks are default-deny and support all/any semantics', () => {
  const access = { capabilities: ['administration.access', 'administration.users.manage'] }
  assert.equal(hasCapability(access, 'administration.access'), true)
  assert.equal(hasCapability(access, 'administration.roles.manage'), false)
  assert.equal(hasCapability(access, ['administration.access', 'administration.roles.manage']), true)
  assert.equal(hasCapability(access, ['administration.access', 'administration.roles.manage'], { mode: 'all' }), false)
  assert.equal(hasCapability({ capabilities: [] }, 'new.capability'), false)
})

test('Super Administrator is explicit and bypasses capability assignment without a magic role id', () => {
  assert.equal(hasCapability({ is_super_admin: true, role_id: 77, capabilities: [] }, 'any.action'), true)
  assert.equal(hasCapability({ is_super_admin: false, role_id: 1, capabilities: [] }, 'any.action'), false)
})

test('backend capability middleware allows, denies, and preserves authentication semantics', () => {
  const guard = requireCapability('administration.users.manage')

  const allowedReq = { user: { capabilities: ['administration.users.manage'] } }
  const allowedRes = responseRecorder()
  let allowed = false
  guard(allowedReq, allowedRes, () => { allowed = true })
  assert.equal(allowed, true)

  const deniedRes = responseRecorder()
  guard({ user: { capabilities: [] } }, deniedRes, () => assert.fail('must deny'))
  assert.equal(deniedRes.statusCode, 403)

  const unauthenticatedRes = responseRecorder()
  guard({}, unauthenticatedRes, () => assert.fail('must require authentication'))
  assert.equal(unauthenticatedRes.statusCode, 401)
})

test('protected Super Administrator role and compatibility structures are declared by the managed migration', () => {
  const migration = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', 'migrations', 'managed', '202608080001_administration_access_control_foundation.sql'),
    'utf8'
  )
  assert.match(migration, /CREATE TABLE user_roles/)
  assert.match(migration, /is_super_admin/)
  assert.match(migration, /CREATE TABLE security_audit_events/)
  assert.match(migration, /INSERT INTO user_roles/)
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM users|DELETE FROM role_permissions/)
})
