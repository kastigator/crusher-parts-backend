const requireTabAccess = require('./requireTabAccess')
const { ROUTE_BUNDLES } = require('../utils/accessModel')

function requireAccessBundle(bundleKeyOrKeys) {
  const keys = Array.isArray(bundleKeyOrKeys) ? bundleKeyOrKeys : [bundleKeyOrKeys]
  const resolvedPaths = keys.flatMap((key) => {
    if (ROUTE_BUNDLES[key]) return ROUTE_BUNDLES[key]
    return [key]
  })

  return requireTabAccess(resolvedPaths)
}

module.exports = requireAccessBundle
