const { resolveEffectiveAccess } = require('../services/authorizationService')

module.exports = async function loadAuthorizationContext(req, res, next) {
  try {
    const access = await resolveEffectiveAccess(req.user?.id)
    if (!access) {
      return res.status(401).json({ message: 'Пользователь не найден' })
    }
    if (!access.is_active) {
      return res.status(403).json({ message: 'Пользователь деактивирован' })
    }
    if (!access.roles.length) {
      return res.status(403).json({ message: 'Пользователю не назначена роль' })
    }

    req.user = access
    req.authorizationResolved = true
    next()
  } catch (error) {
    console.error('loadAuthorizationContext error:', error)
    res.status(500).json({ message: 'Ошибка проверки полномочий' })
  }
}
