function requireCapability(capabilityKeys, options = {}) {
  const keys = Array.isArray(capabilityKeys) ? capabilityKeys : [capabilityKeys]
  const { mode = 'any' } = options

  return function capabilityGuard(req, res, next) {
    const user = req.user
    if (!user) {
      return res.status(401).json({ message: 'Необходима авторизация' })
    }

    if (user.role === 'admin' || user.role_id === 1 || user.is_admin) {
      return next()
    }

    const allowed = Array.isArray(user.capabilities) ? user.capabilities : []
    const allowedSet = new Set(allowed.map((item) => String(item || '').trim().toLowerCase()))
    const normalizedKeys = keys.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)

    const ok =
      mode === 'all'
        ? normalizedKeys.every((key) => allowedSet.has(key))
        : normalizedKeys.some((key) => allowedSet.has(key))

    if (!ok) {
      return res.status(403).json({ message: 'Недостаточно прав для этого действия' })
    }

    next()
  }
}

module.exports = requireCapability
