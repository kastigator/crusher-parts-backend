// routes/routerIndex.js
const express = require('express')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const requireTabAccess = require('../middleware/requireTabAccess')

// ======================================================
// === Авторизация и публичные разделы ==================
// ======================================================

// Логин / регистрация / refresh и т.п.
router.use('/auth', require('./auth'))

// Публичные хелперы (список админов для "забыли пароль" и т.п.)
router.use('/public', require('./public'))

// ======================================================
// === Админка (управление пользователями и доступами) ==
// ======================================================

// Пользователи — всегда только admin
router.use('/users', auth, adminOnly, require('./users'))

// Роли и права по ролям — только admin
router.use('/roles', auth, adminOnly, require('./roles'))
router.use('/role-permissions', auth, adminOnly, require('./rolePermissions'))

// Вкладки:
//   - GET /tabs → любой авторизованный пользователь
//   - POST/PUT/DELETE внутри самого routes/tabs.js уже защищены adminOnly
router.use('/tabs', auth, require('./tabs'))

// Логи активности и импорт — доступны всем авторизованным
router.use('/activity-logs', auth, require('./activityLogs'))
router.use('/import', auth, require('./import'))

// ======================================================
// === Клиенты (вкладка /clients) =======================
// ======================================================

// Всё, что относится к клиентам (адреса, банки) — под правами вкладки /clients

router.use(
  '/clients',
  auth,
  requireTabAccess('/clients'),
  require('./clients')
)

// Топ-левел пути, которые использует фронт:
router.use(
  '/client-billing-addresses',
  auth,
  requireTabAccess('/clients'),
  require('./clientBillingAddresses')
)

router.use(
  '/client-shipping-addresses',
  auth,
  requireTabAccess('/clients'),
  require('./clientShippingAddresses')
)

router.use(
  '/client-bank-details',
  auth,
  requireTabAccess('/clients'),
  require('./clientBankDetails')
)

// ======================================================
// === Поставщики (вкладка /suppliers) ==================
// ======================================================

// Основная таблица поставщиков
router.use(
  '/part-suppliers',
  auth,
  requireTabAccess('/suppliers'),
  require('./partSuppliers')
)

// Адреса / контакты / банки поставщиков — ТОП-ЛЕВЕЛ, как у клиентов
router.use(
  '/supplier-addresses',
  auth,
  requireTabAccess('/suppliers'),
  require('./supplierAddresses')
)

router.use(
  '/supplier-contacts',
  auth,
  requireTabAccess('/suppliers'),
  require('./supplierContacts')
)

router.use(
  '/supplier-bank-details',
  auth,
  requireTabAccess('/suppliers'),
  require('./supplierBankDetails')
)

// ======================================================
// === Детали поставщиков (вкладка /supplier-parts) =====
// ======================================================

router.use(
  '/supplier-parts',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierParts')
)

router.use(
  '/supplier-parts/prices',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierPartPrices')
)

router.use(
  '/supplier-parts/originals',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierPartOriginals')
)

router.use(
  '/supplier-bundles',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierBundles')
)

// ======================================================
// === Оригинальные детали (вкладка /original-parts) ====
// ======================================================

router.use(
  '/original-parts',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalParts')
)

router.use(
  '/original-parts/bom',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartBom')
)

router.use(
  '/original-parts/groups',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartGroups')
)

router.use(
  '/original-parts/substitutions',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartSubstitutions')
)

router.use(
  '/original-parts/documents',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartDocuments')
)

router.use(
  '/original-parts/alt',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartAlt')
)

// ======================================================
// === Оборудование (служебные справочники) =============
// === используются внутри вкладки "Оригинальные детали"
// ======================================================

router.use(
  '/equipment/models',
  auth,
  requireTabAccess('/original-parts'),
  require('./equipmentModels')
)

router.use(
  '/equipment/manufacturers',
  auth,
  requireTabAccess('/original-parts'),
  require('./equipmentManufacturers')
)

// ======================================================
// === ТН ВЭД (вкладка /tnved-codes) ====================
// ======================================================

router.use(
  '/tnved-codes',
  auth,
  requireTabAccess('/tnved-codes'),
  require('./tnvedCodes')
)

// ======================================================
module.exports = router
