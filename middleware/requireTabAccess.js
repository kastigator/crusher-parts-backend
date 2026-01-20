const db = require('../utils/db')

/**
 * Check access by tab_name or path.
 * Usage: requireTabAccess('clients') or requireTabAccess('/clients')
 */
function requireTabAccess(tabNameOrPath) {
  return async function (req, res, next) {
    try {
      const user = req.user

      if (!user) {
        return res.status(401).json({ message: 'Необходима авторизация' })
      }

      if (user.role === 'admin' || user.role_id === 1 || user.is_admin) {
        return next()
      }

      const roleId = user.role_id
      if (!roleId) {
        return res.status(403).json({ message: 'Роль пользователя не определена' })
      }

      const keys = Array.isArray(tabNameOrPath)
        ? tabNameOrPath.filter(Boolean)
        : [tabNameOrPath].filter(Boolean)
      if (!keys.length) {
        return res.status(500).json({ message: 'Некорректная настройка доступа' })
      }

      const placeholders = keys.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT 1
          FROM role_permissions rp
          JOIN tabs t ON t.id = rp.tab_id
         WHERE rp.role_id = ?
           AND rp.can_view = 1
           AND (t.tab_name IN (${placeholders}) OR t.path IN (${placeholders}))
         LIMIT 1
        `,
        [roleId, ...keys, ...keys]
      )

      if (!rows.length) {
        console.warn(`Access denied: role ${roleId} tab ${keys.join(', ')}`)
        return res.status(403).json({ message: 'Нет доступа к этой вкладке' })
      }

      next()
    } catch (err) {
      console.error('requireTabAccess error:', err)
      res.status(500).json({ message: 'Ошибка проверки прав доступа' })
    }
  }
}

module.exports = requireTabAccess
