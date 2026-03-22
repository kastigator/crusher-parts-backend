const express = require('express')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const requireTabAccess = require('../middleware/requireTabAccess')
const requireAccessBundle = require('../middleware/requireAccessBundle')
const requireMutationCapability = require('../middleware/requireMutationCapability')

// ======================================================
// === Авторизация и публичные разделы ==================
// ======================================================

router.use('/auth', require('./auth'))
router.use('/public', require('./public'))

// ======================================================
// === Админка (пользователи, роли, вкладки) ============
// ======================================================

router.use(
  '/users',
  auth,
  requireTabAccess('/users'),
  requireMutationCapability('admin.users_roles.manage'),
  require('./users')
)
router.use(
  '/roles',
  auth,
  requireTabAccess('/users'),
  requireMutationCapability('admin.users_roles.manage'),
  require('./roles')
)
router.use('/sessions', auth, requireTabAccess('/users'), require('./sessions'))
router.use('/user-ui-settings', auth, require('./userUiSettings'))

router.use('/tabs', auth, require('./tabs'))
router.use(
  '/role-permissions',
  auth,
  requireTabAccess('/users'),
  requireMutationCapability('admin.users_roles.manage'),
  require('./rolePermissions')
)
router.use(
  '/capabilities',
  auth,
  requireTabAccess('/users'),
  requireMutationCapability('admin.users_roles.manage'),
  require('./capabilities')
)
router.use('/dev-tools', auth, adminOnly, require('./devTools'))

// ======================================================
// === Дашборд (главная) ================================
// ======================================================

router.use('/dashboard', auth, require('./dashboard'))
router.use('/company-profile', auth, require('./companyProfile'))

// ======================================================
// === Catalogs (TAB: /catalogs) ========================
// ======================================================

router.use('/tnved-codes', auth, requireAccessBundle('SUPPLIER_LOOKUP'), require('./tnvedCodes'))
router.use('/materials', auth, requireAccessBundle('SUPPLIER_LOOKUP'), require('./materials'))
router.use(
  '/equipment-classifier-nodes',
  auth,
  requireAccessBundle('CLIENTS_LOOKUP'),
  require('./equipmentClassifierNodes')
)
router.use(
  '/client-equipment-units',
  auth,
  requireAccessBundle('CLIENTS_LOOKUP'),
  require('./clientEquipmentUnits')
)
router.use('/standard-parts', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), require('./standardParts'))
router.use('/oem-parts', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), require('./oemParts'))
router.use(
  '/oem-part-standard-parts',
  auth,
  requireAccessBundle('MASTER_DATA_LOOKUP'),
  require('./oemPartStandardParts')
)

router.use('/clients', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clients'))
router.use('/client-contacts', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientContacts'))
router.use('/client-billing-addresses', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientBillingAddresses'))
router.use('/client-shipping-addresses', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientShippingAddresses'))
router.use('/client-bank-details', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientBankDetails'))

router.use('/suppliers', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./partSuppliers'))
router.use('/supplier-addresses', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./supplierAddresses'))
router.use('/supplier-contacts', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./supplierContacts'))
router.use('/supplier-bank-details', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./supplierBankDetails'))

router.use('/supplier-parts', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierParts'))
router.use('/supplier-part-originals', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPartOriginals'))
router.use('/supplier-part-standard-parts', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPartStandardParts'))
router.use('/supplier-part-materials', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPartMaterials'))
router.use('/supplier-part-prices', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPartPrices'))
router.use('/supplier-price-lists', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPriceLists'))
router.use('/logistics-route-templates', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./logisticsRouteTemplates'))

router.use('/original-parts', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalParts'))
router.use('/original-part-groups', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartGroups'))
router.use('/original-part-bom', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartBom'))
router.use('/original-part-substitutions', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartSubstitutions'))
router.use('/original-part-materials', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartMaterials'))
router.use('/original-part-material-specs', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartMaterialSpecs'))
router.use('/original-parts', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartDocuments'))
router.use('/original-parts', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartUnitOverrides'))
router.use('/original-parts', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartPresentationProfiles'))
router.use('/original-part-alt', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./originalPartAlt'))

// ======================================================
// === Вспомогательные справочники оборудования =========
// ======================================================

router.use('/equipment-manufacturers', auth, require('./equipmentManufacturers'))
router.use('/equipment-models', auth, require('./equipmentModels'))

// ======================================================
// === Комплекты (TAB: /original-parts) =================
// ======================================================

router.use('/supplier-bundles', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierBundles'))
router.use('/part-suppliers', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./partSuppliers'))

// ======================================================
// === Системные сервисы (импорт, логи) =================
// ======================================================

router.use('/import', auth, require('./import'))
router.use('/activity-logs', auth, require('./activityLogs'))

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
  requireAccessBundle('CLIENT_REQUEST_WORKSPACE'),
  require('./clientRequests')
)
router.use('/rfqs', auth, requireAccessBundle('RFQ_WORKSPACE'), require('./rfqs'))
router.use(
  '/supplier-responses',
  auth,
  requireAccessBundle('RFQ_WORKSPACE'),
  require('./supplierResponses')
)
router.use('/coverage', auth, requireAccessBundle('RFQ_WORKSPACE'), require('./coverage'))
router.use('/scorecard', auth, requireTabAccess('/scorecard'), require('./scorecard'))
router.use('/sales-kpi', auth, requireTabAccess('/kpi'), require('./salesKpi'))
router.use('/procurement-kpi', auth, requireTabAccess('/kpi'), require('./procurementKpi'))
router.use('/economics', auth, requireAccessBundle('RFQ_WORKSPACE'), require('./economics'))
router.use('/selection', auth, requireAccessBundle('RFQ_WORKSPACE'), require('./selection'))
router.use('/sales-quotes', auth, requireAccessBundle('COMMERCIAL_FLOW'), requireMutationCapability('workflow.sales_quotes.manage'), require('./salesQuotes'))
router.use('/contracts', auth, requireAccessBundle('COMMERCIAL_FLOW'), requireMutationCapability('workflow.contracts.manage'), require('./contracts'))
router.use(
  '/purchase-orders',
  auth,
  requireAccessBundle('RFQ_WORKSPACE'),
  requireMutationCapability('workflow.purchase_orders.manage'),
  require('./purchaseOrders')
)

// ======================================================
// === Экспорт роутера ==================================
// ======================================================

module.exports = router
