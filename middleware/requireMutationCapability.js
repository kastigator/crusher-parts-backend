const requireCapability = require('./requireCapability')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function requireMutationCapability(capabilityKeys, options = {}) {
  const guard = requireCapability(capabilityKeys, options)

  return function mutationCapabilityGuard(req, res, next) {
    if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) {
      return next()
    }
    return guard(req, res, next)
  }
}

module.exports = requireMutationCapability
