// routes/activityLogs.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const checkTabAccess = require('../middleware/checkTabAccess')

// ---------- helpers ----------
const normalizeLimit = (v, def = 200, max = 500) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const mustNum = (val, name = 'value') => {
  const n = Number(val)
  if (!Number.isFinite(n)) {
    const e = new Error(`${name} must be numeric`)
    e.status = 400
    throw e
  }
  return Math.trunc(n)
}

// алиасы старых/кривых имён сущностей → каноническое имя
const ENTITY_ALIAS = {
  tnved_code: 'tnved_codes',
  part_suppliers: 'suppliers', // если где-то так прилетает
}

// маппинг entity_type → вкладка (tabs.path)
// добавляй сюда новые сущности по мере подключения логирования
const ENTITY_TO_TAB = {
  // клиенты и их подтаблицы
  clients: '/clients',
  client_billing_addresses: '/clients',
  client_shipping_addresses: '/clients',
  client_bank_details: '/clients',

  // детали поставщиков
  supplier_parts: '/supplier-parts',

  // оригинальные детали
  original_parts: '/original-parts',

  // ТН ВЭД
  tnved_codes: '/tnved-codes',

  // примеры на будущее:
  // roles: '/admin', // если будет отдельно
  // tabs: '/admin',
}

// нормализуем entity_type + возвращаем { entityType, tabPath }
const resolveEntityAndTab = (raw) => {
  if (!raw) return { entityType: null, tabPath: null }
  const clean = String(raw).trim()
  const entityType = ENTITY_ALIAS[clean] || clean
  const tabPath = ENTITY_TO_TAB[entityType] || null
  return { entityType, tabPath }
}

// динамический гард: если можем определить вкладку — проверяем доступ к ней,
// иначе — требуем права администратора (safe fallback)
const dynamicTabGuard = (resolver) => async (req, res, next) => {
  try {
    const tabPath = await resolver(req)
    if (tabPath) {
      return checkTabAccess(tabPath)(req, res, next)
    }
    // нет привязки к вкладке → это кросс-системный запрос, пускаем только админа
    return adminOnly(req, res, next)
  } catch (e) {
    next(e)
  }
}

// глобальная авторизация
router.use(auth)

// ---------- /deleted ----------
// GET /activity-logs/deleted?entity_type=...&entity_id=...&limit=...
// Правило доступа:
//  - если указан entity_type (и мы знаем его вкладку) → доступ по вкладке
//  - если вкладку определить нельзя (или entity_type не задан) → только админ
router.get(
  '/deleted',
  dynamicTabGuard((req) => {
    const { entity_type } = req.query
    const { tabPath } = resolveEntityAndTab(entity_type)
    return tabPath // может быть null → тогда сработает fallback на adminOnly
  }),
  async (req, res) => {
    try {
      const { entity_type, entity_id } = req.query
      const limit = normalizeLimit(req.query.limit, 100, 500)

      let sql = `
        SELECT a.*, u.full_name AS user_name
        FROM activity_logs a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.action = 'delete'
      `
      const params = []

      if (entity_type && String(entity_type).trim()) {
        const { entityType } = resolveEntityAndTab(entity_type)
        sql += ' AND a.entity_type = ?'
        params.push(entityType)
      }

      if (entity_id !== undefined) {
        sql += ' AND a.entity_id = ?'
        params.push(mustNum(entity_id, 'entity_id'))
      }

      sql += ` ORDER BY a.created_at DESC LIMIT ${limit}`

      const [rows] = await db.execute(sql, params)
      res.json(rows)
    } catch (err) {
      const code = err.status || 500
      if (code === 400) return res.status(400).json({ message: err.message })
      console.error('Ошибка при получении удалённых записей:', err)
      res
        .status(500)
        .json({ message: 'Ошибка сервера при получении удалённых логов' })
    }
  }
)

// ---------- /by-client/:clientId ----------
// GET /activity-logs/by-client/:clientId?limit=...
// Эта выборка логически принадлежит разделу клиентов → требуем доступ к /clients
router.get(
  '/by-client/:clientId',
  checkTabAccess('/clients'),
  async (req, res) => {
    try {
      const clientId = mustNum(req.params.clientId, 'clientId')
      const limit = normalizeLimit(req.query.limit, 200, 500)

      const sql = `
        SELECT a.*, u.full_name AS user_name
        FROM activity_logs a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.client_id = ?
        ORDER BY a.created_at DESC
        LIMIT ${limit}
      `
      const [rows] = await db.execute(sql, [clientId])
      res.json(rows)
    } catch (err) {
      const code = err.status || 500
      if (code === 400) return res.status(400).json({ message: err.message })
      console.error('Ошибка при получении истории по клиенту:', err)
      res
        .status(500)
        .json({ message: 'Ошибка сервера при получении логов по клиенту' })
    }
  }
)

// ---------- /:entity/:id ----------
// GET /activity-logs/:entity/:id?action=&field=&limit=...
// Правило доступа: по entity → вычисляем вкладку и проверяем её
router.get(
  '/:entity/:id',
  dynamicTabGuard((req) => {
    const { entity, id } = req.params
    void id // просто чтобы линтер не ругался на неиспользуемую переменную
    const { tabPath } = resolveEntityAndTab(entity)
    return tabPath // если null → fallback adminOnly
  }),
  async (req, res) => {
    try {
      const rawEntity = String(req.params.entity || '').trim()
      const { entityType } = resolveEntityAndTab(rawEntity)
      const entityId = mustNum(req.params.id, 'id')

      const limit = normalizeLimit(req.query.limit, 500, 1000)

      let action = null
      if (req.query.action) {
        action = String(req.query.action).trim().toLowerCase()
        if (!['create', 'update', 'delete'].includes(action)) {
          return res.status(400).json({ message: 'invalid action filter' })
        }
      }

      const field = req.query.field ? String(req.query.field).trim() : null

      let sql = `
        SELECT a.*, u.full_name AS user_name
        FROM activity_logs a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.entity_type = ? AND a.entity_id = ?
      `
      const params = [entityType, entityId]

      if (action) {
        sql += ' AND a.action = ?'
        params.push(action)
      }
      if (field) {
        sql += ' AND a.field_changed = ?'
        params.push(field)
      }

      sql += ` ORDER BY a.created_at DESC LIMIT ${limit}`

      const [rows] = await db.execute(sql, params)
      res.json(rows)
    } catch (err) {
      const code = err.status || 500
      if (code === 400) return res.status(400).json({ message: err.message })
      console.error('Ошибка при получении истории:', err)
      res.status(500).json({ message: 'Ошибка сервера при получении логов' })
    }
  }
)

// ---------- POST ----------
// Создание лога: доступ определяется по вкладке сущности (если она есть),
// иначе — только админ.
router.post(
  '/',
  dynamicTabGuard((req) => {
    const { entity_type } = req.body || {}
    const { tabPath } = resolveEntityAndTab(entity_type)
    return tabPath // null → adminOnly
  }),
  async (req, res) => {
    try {
      const {
        action,
        entity_type,
        entity_id,
        field_changed,
        old_value,
        new_value,
        comment,
        client_id,
      } = req.body

      const act = String(action || '').trim().toLowerCase()
      if (!['create', 'update', 'delete'].includes(act)) {
        return res.status(400).json({ message: `invalid action: ${action}` })
      }

      const idNum =
        entity_id === undefined || entity_id === null || entity_id === ''
          ? null
          : mustNum(entity_id, 'entity_id')

      const clientIdNorm =
        client_id === undefined || client_id === null || client_id === ''
          ? null
          : mustNum(client_id, 'client_id')

      const user_id = req?.user?.id || null
      const { entityType } = resolveEntityAndTab(entity_type)

      await db.execute(
        `INSERT INTO activity_logs
          (user_id, action, entity_type, entity_id, client_id, field_changed, old_value, new_value, comment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user_id,
          act,
          entityType,
          idNum,
          clientIdNorm,
          field_changed ?? null,
          old_value ?? null,
          new_value ?? null,
          comment ?? null,
        ]
      )

      res.status(201).json({ success: true })
    } catch (err) {
      const code = err.status || 500
      if (code === 400) return res.status(400).json({ message: err.message })
      console.error('Ошибка при сохранении лога:', err)
      res.status(500).json({ message: 'Ошибка при логировании действия' })
    }
  }
)

module.exports = router
