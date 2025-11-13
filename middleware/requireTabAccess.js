const db = require('../utils/db')

/**
 * Проверяет доступ к вкладке по tab_name или path
 * Пример: requireTabAccess('clients') или requireTabAccess('/clients')
 *
 * Логика:
 *   👑 Админ → полные права
 *   👥 Остальные → проверка role_permissions.can_view = 1
 */
function requireTabAccess(tabNameOrPath) {
  return async function (req, res, next) {
    try {
      const user = req.user

      if (!user) {
        return res.status(401).json({ message: 'Необходима авторизация' })
      }

      // 👑 Администратор = доступ ко всему
      if (user.role === 'admin' || user.role_id === 1 || user.is_admin) {
        return next()
      }

      const roleId = user.role_id
      if (!roleId) {
        return res.status(403).json({ message: 'Роль пользователя не определена' })
      }

      // Определяем, что нам передали: tab_name или path
      const key = tabNameOrPath.startsWith('/')
        ? tabNameOrPath
        : tabNameOrPath

      // Проверяем права доступа к вкладке
      const [rows] = await db.execute(
        `
        SELECT 1
          FROM role_permissions rp
          JOIN tabs t ON t.id = rp.tab_id
         WHERE rp.role_id = ?
           AND rp.can_view = 1
           AND (t.tab_name = ? OR t.path = ?)
         LIMIT 1
        `,
        [roleId, key, key]
      )

      if (!rows.length) {
        console.warn(`🚫 Доступ запрещён: роль ${roleId} → вкладка ${key}`)
        return res.status(403).json({ message: 'Нет доступа к этой вкладке' })
      }

      // 🎉 Всё хорошо — пропускаем
      next()
    } catch (err) {
      console.error('❌ Ошибка в requireTabAccess:', err)
      res.status(500).json({ message: 'Ошибка проверки прав доступа' })
    }
  }
}

module.exports = requireTabAccess
