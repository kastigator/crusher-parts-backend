// middleware/adminOnly.js
const db = require('../utils/db')

// маршруты, которые действительно ДОЛЖНЫ быть только для админа
const ADMIN_ONLY_PREFIXES = [
  '/roles',
  '/role-permissions',
  '/users',
  '/activity-logs',
  '/import',
  // если нужно — добавь сюда ещё, например:
  // '/tabs'
]

module.exports = async function adminOrTabAccess(req, res, next) {
  try {
    const user = req.user

    if (!user) {
      return res.status(401).json({ message: 'Необходима авторизация' })
    }

    // Админ может всё
    if (user.role && user.role.toLowerCase() === 'admin') {
      return next()
    }

    // Определяем базовый путь, под которым смонтирован роут
    // например: '/api/original-parts' → отрежем '/api'
    let base = req.baseUrl || ''
    base = base.replace(/^\/api/, '')

    // 1️⃣ Жёстко админские префиксы
    if (ADMIN_ONLY_PREFIXES.some((p) => base.startsWith(p))) {
      return res.status(403).json({ message: 'Доступ только для администратора' })
    }

    // 2️⃣ Остальные — по вкладкам
    // Берём первый сегмент после слэша: '/original-parts/...' → 'original-parts'
    const parts = base.split('/').filter(Boolean)
    if (!parts.length) {
      // на всякий случай — если не смогли распарсить путь, не даём доступ
      return res.status(403).json({ message: 'Доступ запрещён' })
    }

    const tabPath = `/${parts[0]}` // → '/original-parts', '/clients', '/supplier-parts', ...

    // Ищем вкладку по path в таблице tabs
    const [tabs] = await db.execute(
      'SELECT id FROM tabs WHERE path = ? AND is_active = 1',
      [tabPath]
    )

    if (!tabs.length) {
      // вкладка не заведена или выключена → считаем, что это "админская зона"
      return res.status(403).json({ message: 'Доступ только для администратора' })
    }

    const tabId = tabs[0].id
    const perms = Array.isArray(user.permissions) ? user.permissions : []

    // проверяем, что id вкладки есть в permissions, который мы кладём в JWT при логине
    if (!perms.includes(tabId)) {
      return res.status(403).json({ message: 'Недостаточно прав для этой вкладки' })
    }

    // Всё ок — роль имеет эту вкладку → можно делать CRUD
    return next()
  } catch (err) {
    console.error('Ошибка в adminOnly / tab-access middleware:', err)
    return res.status(500).json({ message: 'Ошибка проверки прав' })
  }
}
