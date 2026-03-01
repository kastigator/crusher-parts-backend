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
router.use('/sessions', auth, require('./sessions'))
router.use('/user-ui-settings', auth, require('./userUiSettings'))

router.use('/tabs', auth, require('./tabs'))
router.use('/role-permissions', auth, adminOnly, require('./rolePermissions'))
router.use('/dev-tools', auth, adminOnly, require('./devTools'))

// ======================================================
// === Дашборд (главная) ================================
// ======================================================

router.use('/dashboard', auth, require('./dashboard'))

// ======================================================
// === Catalogs (TAB: /catalogs) ========================
// ======================================================

router.use('/tnved-codes', auth, requireTabAccess('/catalogs'), require('./tnvedCodes'))
router.use('/materials', auth, requireTabAccess('/catalogs'), require('./materials'))

router.use('/clients', auth, requireTabAccess('/catalogs'), require('./clients'))
router.use('/client-contacts', auth, requireTabAccess('/catalogs'), require('./clientContacts'))
router.use('/client-billing-addresses', auth, requireTabAccess('/catalogs'), require('./clientBillingAddresses'))
router.use('/client-shipping-addresses', auth, requireTabAccess('/catalogs'), require('./clientShippingAddresses'))
router.use('/client-bank-details', auth, requireTabAccess('/catalogs'), require('./clientBankDetails'))

router.use('/suppliers', auth, requireTabAccess('/catalogs'), require('./partSuppliers'))
router.use('/supplier-addresses', auth, requireTabAccess('/catalogs'), require('./supplierAddresses'))
router.use('/supplier-contacts', auth, requireTabAccess('/catalogs'), require('./supplierContacts'))
router.use('/supplier-bank-details', auth, requireTabAccess('/catalogs'), require('./supplierBankDetails'))

router.use('/supplier-parts', auth, requireTabAccess('/catalogs'), require('./supplierParts'))
router.use('/supplier-part-originals', auth, requireTabAccess('/catalogs'), require('./supplierPartOriginals'))
router.use('/supplier-part-materials', auth, requireTabAccess('/catalogs'), require('./supplierPartMaterials'))
router.use('/supplier-part-prices', auth, requireTabAccess('/catalogs'), require('./supplierPartPrices'))
router.use('/supplier-price-lists', auth, requireTabAccess('/catalogs'), require('./supplierPriceLists'))
router.use('/logistics-corridors', auth, requireTabAccess('/catalogs'), require('./logisticsCorridors'))

router.use('/original-parts', auth, requireTabAccess('/catalogs'), require('./originalParts'))
router.use('/original-part-groups', auth, requireTabAccess('/catalogs'), require('./originalPartGroups'))
router.use('/original-part-bom', auth, requireTabAccess('/catalogs'), require('./originalPartBom'))
router.use('/original-part-substitutions', auth, requireTabAccess('/catalogs'), require('./originalPartSubstitutions'))
router.use('/original-part-materials', auth, requireTabAccess('/catalogs'), require('./originalPartMaterials'))
router.use('/original-part-material-specs', auth, requireTabAccess('/catalogs'), require('./originalPartMaterialSpecs'))
router.use('/original-parts', auth, requireTabAccess('/catalogs'), require('./originalPartDocuments'))
router.use('/original-part-alt', auth, requireTabAccess('/catalogs'), require('./originalPartAlt'))

// ======================================================
// === Вспомогательные справочники оборудования =========
// ======================================================

router.use('/equipment-manufacturers', auth, require('./equipmentManufacturers'))
router.use('/equipment-models', auth, require('./equipmentModels'))

// ======================================================
// === Комплекты (TAB: /original-parts) =================
// ======================================================

router.use('/supplier-bundles', auth, requireTabAccess('/catalogs'), require('./supplierBundles'))
router.use('/part-suppliers', auth, requireTabAccess('/catalogs'), require('./partSuppliers'))

// ======================================================
// === Системные сервисы (импорт, логи) =================
// ======================================================

router.use('/import', require('./import'))
router.use('/activity-logs', require('./activityLogs'))

// ======================================================
// === FX курсы (служебный сервис) ======================
// ======================================================
router.use('/fx', auth, require('./fxRates'))

// ======================================================
// === New process tabs =================================
// ======================================================

router.use(
  '/client-requests',
  auth,
  requireTabAccess('/client-request-workspace'),
  require('./clientRequests')
)
router.use('/rfqs', auth, requireTabAccess(['/rfq-workspace', '/rfq']), require('./rfqs'))
router.use(
  '/supplier-responses',
  auth,
  requireTabAccess(['/rfq-workspace', '/supplier-responses']),
  require('./supplierResponses')
)
router.use('/coverage', auth, requireTabAccess(['/rfq-workspace', '/coverage']), require('./coverage'))
router.use('/scorecard', auth, requireTabAccess('/scorecard'), require('./scorecard'))
router.use('/economics', auth, requireTabAccess(['/rfq-workspace', '/economics']), require('./economics'))
router.use('/selection', auth, requireTabAccess(['/rfq-workspace', '/selection']), require('./selection'))
router.use('/sales-quotes', auth, requireTabAccess(['/rfq-workspace', '/sales-quotes']), require('./salesQuotes'))
router.use('/contracts', auth, requireTabAccess(['/rfq-workspace', '/contracts']), require('./contracts'))
router.use(
  '/purchase-orders',
  auth,
  requireTabAccess(['/rfq-workspace', '/purchase-orders']),
  require('./purchaseOrders')
)

// ======================================================
// === Экспорт роутера ==================================
// ======================================================

module.exports = router
