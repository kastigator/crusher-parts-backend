const express = require('express')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const requireTabAccess = require('../middleware/requireTabAccess')

// ======================================================
// === Авторизация и публичные разделы ==================
// ======================================================

router.use('/auth', require('./auth'))
router.use('/public', require('./public'))

// ======================================================
// === Админка (пользователи, роли, вкладки) ============
// ======================================================

router.use('/users', auth, adminOnly, require('./users'))
router.use('/roles', auth, adminOnly, require('./roles'))

router.use('/tabs', auth, require('./tabs'))
router.use('/role-permissions', auth, adminOnly, require('./rolePermissions'))
router.use('/dev-tools', auth, adminOnly, require('./devTools'))

// ======================================================
// === Коды ТН ВЭД (TAB: /tnved-codes) ==================
// ======================================================

router.use(
  '/tnved-codes',
  auth,
  requireTabAccess('/tnved-codes'),
  require('./tnvedCodes')
)

// ======================================================
// === Материалы (TAB: /materials) ======================
// ======================================================

router.use(
  '/materials',
  auth,
  requireTabAccess('/materials'),
  require('./materials')
)

// ======================================================
// === Клиенты (TAB: /clients) ==========================
// ======================================================

router.use(
  '/clients',
  auth,
  requireTabAccess('/clients'),
  require('./clients')
)

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
// === Поставщики (TAB: /suppliers) =====================
// ======================================================

router.use(
  '/suppliers',
  auth,
  requireTabAccess('/suppliers'),
  require('./partSuppliers')
)

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
// === Детали поставщиков (TAB: /supplier-parts) ========
// ======================================================

router.use(
  '/supplier-parts',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierParts')
)

router.use(
  '/supplier-part-prices',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierPartPrices')
)

router.use(
  '/supplier-part-originals',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierPartOriginals')
)

// ======================================================
// === Логистика (TAB: /logistics-routes) ===============
// ======================================================

router.use(
  '/logistics-routes',
  auth,
  requireTabAccess('/logistics-routes'),
  require('./logisticsRoutes')
)

// ======================================================
// === Оригинальные детали (TAB: /original-parts) =======
// ======================================================

router.use(
  '/original-parts',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalParts')
)

router.use(
  '/original-part-groups',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartGroups')
)

router.use(
  '/original-part-bom',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartBom')
)

router.use(
  '/original-part-substitutions',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartSubstitutions')
)

router.use(
  '/original-parts',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartDocuments')
)

router.use(
  '/original-part-alt',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartAlt')
)

// ======================================================
// === Заказы клиентов (TAB: /client-orders) ============
// ======================================================

router.use(
  '/client-orders',
  auth,
  requireTabAccess('/client-orders'),
  require('./clientOrders')
)

// ======================================================
// === Вспомогательные справочники оборудования =========
// ======================================================

router.use('/equipment-manufacturers', auth, require('./equipmentManufacturers'))
router.use('/equipment-models', auth, require('./equipmentModels'))

// ======================================================
// === Комплекты (TAB: /original-parts) =================
// ======================================================

router.use(
  '/supplier-bundles',
  auth,
  requireTabAccess('/original-parts'),
  require('./supplierBundles')
)

router.use(
  '/part-suppliers',
  auth,
  requireTabAccess('/original-parts'),
  require('./partSuppliers')
)

// ======================================================
// === Системные сервисы (импорт, логи) =================
// ======================================================

router.use('/import', require('./import'))
router.use('/activity-logs', require('./activityLogs'))

// ======================================================
// === Экспорт роутера ==================================
// ======================================================

module.exports = router
