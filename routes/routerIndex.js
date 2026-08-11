const express = require('express')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const requireTabAccess = require('../middleware/requireTabAccess')
const requireAccessBundle = require('../middleware/requireAccessBundle')
const requireMutationCapability = require('../middleware/requireMutationCapability')
const requireCapability = require('../middleware/requireCapability')
const loadAuthorizationContext = require('../middleware/loadAuthorizationContext')
const legacyReadOnly = require('../middleware/legacyReadOnly')

// Public, read-only release identity. The payload is deliberately limited to
// non-secret build identifiers so an artifact can be traced without auth.
router.use('/version', require('./version'))

// ======================================================
// === Авторизация и публичные разделы ==================
// ======================================================

router.use('/auth', require('./auth'))
router.use('/public', require('./public'))

// Authentication validates the token; authorization is then resolved from the
// current database assignments for every protected request.
router.use(auth, loadAuthorizationContext)

// ======================================================
// === Админка (пользователи, роли, вкладки) ============
// ======================================================

router.use(
  '/users',
  auth,
  requireCapability('administration.access'),
  requireMutationCapability('administration.users.manage'),
  require('./users')
)
router.use(
  '/roles',
  auth,
  requireCapability('administration.access'),
  requireMutationCapability('administration.roles.manage'),
  require('./roles')
)
router.use('/sessions', auth, require('./sessions'))
router.use(
  '/security-audit',
  auth,
  requireCapability('administration.audit.view'),
  require('./securityAudit')
)
router.use('/user-activity', auth, require('./userActivity'))
router.use('/user-ui-settings', auth, require('./userUiSettings'))

router.use('/tabs', auth, require('./tabs'))
router.use(
  '/role-permissions',
  auth,
  requireCapability('administration.access'),
  requireMutationCapability('administration.roles.manage'),
  require('./rolePermissions')
)
router.use(
  '/capabilities',
  auth,
  requireCapability('administration.access'),
  requireMutationCapability('administration.roles.manage'),
  require('./capabilities')
)
router.use('/dev-tools', auth, adminOnly, require('./devTools'))
router.use('/ai-agent', auth, require('./aiAgent'))

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
router.use('/measurement-units', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), require('./measurementUnits'))
router.use('/catalog-health', auth, requireAccessBundle('MASTER_DATA_LOOKUP'), require('./catalogHealth'))
router.use(
  '/equipment-classifier-nodes',
  auth,
  requireAccessBundle('CLIENTS_LOOKUP'),
  requireMutationCapability('catalogs.edit'),
  require('./equipmentClassifierNodes')
)
router.use(
  '/client-equipment-units',
  auth,
  requireAccessBundle('CLIENTS_LOOKUP'),
  require('./clientEquipmentUnits')
)
router.use(
  '/catalog-positions',
  auth,
  requireAccessBundle('MASTER_DATA_LOOKUP'),
  requireMutationCapability('catalogs.edit'),
  require('./catalogPositions')
)
router.use(
  '/classifier-imports',
  auth,
  requireAccessBundle('CLIENTS_LOOKUP'),
  requireMutationCapability('catalogs.edit'),
  require('./classifierImports')
)
router.use('/glossary-terms', auth, requireAccessBundle('CLIENTS_LOOKUP'), require('./glossaryTerms'))

router.use('/clients', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clients'))
router.use('/client-contacts', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientContacts'))
router.use('/client-billing-addresses', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientBillingAddresses'))
router.use('/client-shipping-addresses', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientShippingAddresses'))
router.use('/client-bank-details', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientBankDetails'))
router.use('/client-parts', auth, requireAccessBundle('CLIENTS_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.client.master_data.write']), require('./clientParts'))

router.use('/suppliers', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./partSuppliers'))
router.use('/supplier-addresses', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./supplierAddresses'))
router.use('/supplier-contacts', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./supplierContacts'))
router.use('/supplier-bank-details', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./supplierBankDetails'))

router.use('/supplier-parts', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierParts'))
router.use('/supplier-part-catalog-positions', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPartCatalogPositions'))
router.use('/supplier-part-materials', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPartMaterials'))
router.use('/supplier-part-prices', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPartPrices'))
router.use('/supplier-price-lists', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability(['catalogs.edit', 'workflow.rfq.master_data.write']), require('./supplierPriceLists'))
router.use('/logistics-route-templates', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./logisticsRouteTemplates'))

// ======================================================
// === Вспомогательные справочники оборудования =========
// ======================================================

router.use('/equipment-manufacturers', auth, require('./equipmentManufacturers'))
router.use('/equipment-models', auth, requireMutationCapability('catalogs.edit'), require('./equipmentModels'))

router.use('/part-suppliers', auth, requireAccessBundle('SUPPLIER_LOOKUP'), requireMutationCapability('catalogs.edit'), require('./partSuppliers'))

// ======================================================
// === Системные сервисы (импорт, логи) =================
// ======================================================

router.use('/import', auth, require('./import'))
router.use('/activity-logs', auth, require('./activityLogs'))
router.use('/trash', auth, require('./trash'))

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
  requireCapability('client_requests.access'),
  require('./clientRequestIntake')
)
router.use(
  '/client-requests',
  auth,
  requireCapability('client_requests.access'),
  require('./clientRequestDomain')
)
router.use(
  '/client-requests',
  auth,
  requireCapability('client_requests.access'),
  require('./clientRequests')
)
router.use(
  '/procurement-releases',
  auth,
  requireCapability('client_requests.access'),
  require('./procurementReleases')
)
router.use(
  '/technical-identification',
  auth,
  requireCapability('technical_identification.access'),
  require('./technicalIdentification')
)
router.use(
  '/sourcing',
  auth,
  requireCapability('sourcing.access'),
  require('./sourcing')
)
router.use(
  '/pricing',
  auth,
  requireCapability('pricing.access'),
  require('./pricing')
)
router.use(
  '/commercial-offers',
  auth,
  requireCapability('commercial_offers.access'),
  require('./commercialOffers')
)
router.use(
  '/contract-domain',
  auth,
  requireCapability('contracts.access'),
  require('./contractDomain')
)
router.use(
  '/procurement-execution',
  auth,
  requireCapability('procurement_execution.access'),
  require('./procurementExecution')
)
router.use(
  '/financial-operations',
  auth,
  requireCapability('financial_operations.access'),
  require('./financialOperations')
)
router.use(
  '/warehouse-inventory',
  auth,
  requireCapability('warehouse_inventory.access'),
  require('./warehouseInventory')
)
router.use(
  '/dispatch-delivery',
  auth,
  requireCapability('dispatch_delivery.access'),
  require('./dispatchDelivery')
)
router.use(
  '/completion-lifecycle',
  auth,
  requireCapability('completion.access'),
  require('./completionLifecycle')
)
router.use(
  '/after-sales',
  auth,
  requireCapability('after_sales.access'),
  require('./afterSales')
)
router.use('/rfqs', auth, requireAccessBundle('RFQ_WORKSPACE'), legacyReadOnly({ surface: 'Legacy RFQ', targetRoute: '/sourcing' }), require('./rfqs'))
router.use(
  '/supplier-responses',
  auth,
  requireAccessBundle('RFQ_WORKSPACE'),
  legacyReadOnly({ surface: 'Legacy Supplier Response', targetRoute: '/sourcing' }),
  require('./supplierResponses')
)
router.use('/coverage', auth, requireAccessBundle('RFQ_WORKSPACE'), legacyReadOnly({ surface: 'Legacy Coverage', targetRoute: '/sourcing' }), require('./coverage'))
router.use('/scorecard', auth, requireTabAccess('/scorecard'), legacyReadOnly({ surface: 'Legacy Scorecard', targetRoute: '/sourcing' }), require('./scorecard'))
router.use('/sales-kpi', auth, requireTabAccess('/kpi'), require('./salesKpi'))
router.use('/procurement-kpi', auth, requireTabAccess('/kpi'), require('./procurementKpi'))
router.use('/economics', auth, requireAccessBundle('RFQ_WORKSPACE'), legacyReadOnly({ surface: 'Legacy Economics', targetRoute: '/pricing' }), require('./economics'))
router.use('/selection', auth, requireAccessBundle('RFQ_WORKSPACE'), legacyReadOnly({ surface: 'Legacy Selection', targetRoute: '/sourcing' }), require('./selection'))
router.use('/sales-quotes', auth, requireAccessBundle('COMMERCIAL_FLOW'), legacyReadOnly({ surface: 'Legacy Sales Quote', targetRoute: '/commercial-offers' }), requireMutationCapability('workflow.sales_quotes.manage'), require('./salesQuotes'))
router.use('/contracts', auth, requireAccessBundle('COMMERCIAL_FLOW'), legacyReadOnly({ surface: 'Legacy Client Contract', targetRoute: '/contract-domain' }), requireMutationCapability('workflow.contracts.manage'), require('./contracts'))
router.use(
  '/purchase-orders',
  auth,
  requireAccessBundle('RFQ_WORKSPACE'),
  legacyReadOnly({ surface: 'Legacy Supplier Purchase Order', targetRoute: '/procurement-execution' }),
  requireMutationCapability('workflow.purchase_orders.manage'),
  require('./purchaseOrders')
)
router.use('/warehouse', auth, requireAccessBundle('WAREHOUSE'), legacyReadOnly({ surface: 'Legacy Warehouse', targetRoute: '/warehouse-inventory' }), require('./warehouse'))

// ======================================================
// === Экспорт роутера ==================================
// ======================================================

module.exports = router
