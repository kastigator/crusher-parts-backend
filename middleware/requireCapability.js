const { hasCapability } = require('../services/authorizationService')

function requireCapability(capabilityKeys, options = {}) {
  return function capabilityGuard(req, res, next) {
    const user = req.user
    if (!user) {
      return res.status(401).json({ message: 'Необходима авторизация' })
    }

    if (!hasCapability(user, capabilityKeys, options)) {
      return res.status(403).json({ message: 'Недостаточно прав для этого действия' })
    }

    next()
  }
}

module.exports = requireCapability
