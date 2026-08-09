const db = require('../utils/db')

function normalizeCapabilityKey(value) {
  return String(value || '').trim().toLowerCase()
}

async function fetchUserRecord(executor, userId) {
  const [[user]] = await executor.execute(
    `
    SELECT id, username, full_name, email, phone, role_id, is_active,
           must_change_password, disabled_at
    FROM users
    WHERE id = ?
    LIMIT 1
    `,
    [userId]
  )
  return user || null
}

async function fetchCanonicalRoles(executor, userId) {
  const [rows] = await executor.execute(
    `
    SELECT r.id, r.name, r.slug, r.description, r.is_system, r.is_super_admin,
           ur.is_primary, ur.assigned_at
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ?
    ORDER BY ur.is_primary DESC, r.name, r.id
    `,
    [userId]
  )
  return rows || []
}

async function fetchLegacyRole(executor, roleId) {
  if (!roleId) return []
  const [rows] = await executor.execute(
    `
    SELECT id, name, slug, description, is_system, is_super_admin,
           1 AS is_primary, NULL AS assigned_at
    FROM roles
    WHERE id = ?
    `,
    [roleId]
  )
  return rows || []
}

async function fetchCapabilities(executor, roleIds) {
  if (!roleIds.length) return []
  const placeholders = roleIds.map(() => '?').join(',')
  const [rows] = await executor.execute(
    `
    SELECT DISTINCT c.capability_key
    FROM role_capabilities rc
    JOIN capabilities c ON c.id = rc.capability_id
    WHERE rc.role_id IN (${placeholders})
      AND rc.is_allowed = 1
      AND c.is_active = 1
    ORDER BY c.capability_key
    `,
    roleIds
  )
  return rows.map((row) => normalizeCapabilityKey(row.capability_key)).filter(Boolean)
}

async function fetchLegacyTabPermissions(executor, roleIds) {
  if (!roleIds.length) return []
  const placeholders = roleIds.map(() => '?').join(',')
  const [rows] = await executor.execute(
    `
    SELECT DISTINCT tab_id
    FROM role_permissions
    WHERE role_id IN (${placeholders}) AND can_view = 1
    ORDER BY tab_id
    `,
    roleIds
  )
  return rows.map((row) => Number(row.tab_id)).filter(Number.isInteger)
}

async function resolveEffectiveAccess(userId, executor = db) {
  const id = Number(userId)
  if (!Number.isInteger(id) || id <= 0) return null

  const user = await fetchUserRecord(executor, id)
  if (!user) return null

  let roles = await fetchCanonicalRoles(executor, id)
  let roleSource = 'user_roles'
  if (!roles.length && user.role_id) {
    roles = await fetchLegacyRole(executor, user.role_id)
    roleSource = 'users.role_id_compatibility'
  }

  const roleIds = roles.map((role) => Number(role.id)).filter(Number.isInteger)
  const [capabilities, legacyPermissions] = await Promise.all([
    fetchCapabilities(executor, roleIds),
    fetchLegacyTabPermissions(executor, roleIds),
  ])
  const primaryRole = roles.find((role) => Number(role.is_primary) === 1) || roles[0] || null
  const isSuperAdmin = roles.some((role) => Number(role.is_super_admin) === 1)

  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    is_active: Number(user.is_active) === 1,
    must_change_password: Number(user.must_change_password) === 1,
    disabled_at: user.disabled_at,
    roles: roles.map((role) => ({
      id: Number(role.id),
      name: role.name,
      slug: role.slug,
      description: role.description,
      is_system: Number(role.is_system) === 1,
      is_super_admin: Number(role.is_super_admin) === 1,
      is_primary: Number(role.is_primary) === 1,
      assigned_at: role.assigned_at,
    })),
    role_ids: roleIds,
    role_id: primaryRole ? Number(primaryRole.id) : null,
    role: primaryRole?.slug || null,
    is_super_admin: isSuperAdmin,
    capabilities,
    permissions: isSuperAdmin ? [] : legacyPermissions,
    authorization_source: roleSource,
  }
}

function hasCapability(access, capabilityKeys, options = {}) {
  if (!access) return false
  if (access.is_super_admin === true) return true

  const keys = (Array.isArray(capabilityKeys) ? capabilityKeys : [capabilityKeys])
    .map(normalizeCapabilityKey)
    .filter(Boolean)
  if (!keys.length) return false

  const available = new Set(
    (Array.isArray(access.capabilities) ? access.capabilities : [])
      .map(normalizeCapabilityKey)
      .filter(Boolean)
  )
  return options.mode === 'all'
    ? keys.every((key) => available.has(key))
    : keys.some((key) => available.has(key))
}

module.exports = {
  hasCapability,
  normalizeCapabilityKey,
  resolveEffectiveAccess,
}
