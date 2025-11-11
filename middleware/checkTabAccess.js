/**
 * Проверяет, что у пользователя есть доступ к указанной вкладке.
 * tabPath — строка из таблицы `tabs.path`, например '/original-parts'.
 *
 * Поведение:
 *   👑 admin → всегда разрешено
 *   👥 остальные → если ID вкладки есть в user.permissions (из токена JWT)
 */
const db = require('../utils/db')

function checkTabAccess(tabPath) {
  return async function (req, res, next) {
    try {
      const user = req.user
      if (!user) {
        return res.status(401).json({ message: 'Необходима авторизация' })
      }

      // 👑 Администратор имеет полный доступ
      if (user.role && user.role.toLowerCase() === 'admin') {
        return next()
      }

      // Проверим permissions (они приходят из токена при логине)
      const perms = Array.isArray(user.permissions) ? user.permissions : []
      if (!perms.length) {
        console.warn(`🚫 У пользователя ${user.username} нет разрешений в токене`)
        return res.status(403).json({ message: 'Нет прав доступа к разделам' })
      }

      // Попробуем найти ID вкладки по path (один раз из БД)
      const [rows] = await db.execute(
        'SELECT id FROM tabs WHERE path = ? AND is_active = 1',
        [tabPath]
      )

      if (!rows.length) {
        console.warn(`⚠️ Вкладка ${tabPath} не найдена или неактивна`)
        return res.status(403).json({ message: 'Раздел не найден или неактивен' })
      }

      const tabId = rows[0].id

      // Проверим, есть ли этот ID в списке разрешённых вкладок
      if (!perms.includes(tabId)) {
        console.warn(`🚫 Доступ запрещён: ${user.username} → ${tabPath}`)
        return res.status(403).json({ message: 'Недостаточно прав для этого раздела' })
      }

      // ✅ Всё ок — пропускаем дальше
      next()
    } catch (err) {
      console.error('❌ Ошибка в checkTabAccess:', err)
      res.status(500).json({ message: 'Ошибка проверки прав доступа' })
    }
  }
}

module.exports = checkTabAccess
