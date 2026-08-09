const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function legacyReadOnly({ surface, targetRoute }) {
  return function legacyReadOnlyGuard(req, res, next) {
    if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return next()
    return res.status(410).json({
      code: 'LEGACY_WRITE_SURFACE_RETIRED',
      message: `${surface} доступен только для исторического чтения`,
      target_route: targetRoute,
    })
  }
}

module.exports = legacyReadOnly
