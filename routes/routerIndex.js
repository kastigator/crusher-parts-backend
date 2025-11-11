// routes/routerIndex.js
const express = require('express')
const router = express.Router()
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// --- Авторизация и системные ---
router.use('/auth', require('./auth'))
router.use('/users', auth, adminOnly, require('./users'))
router.use('/roles', auth, adminOnly, require('./roles'))
router.use('/role-permissions', auth, adminOnly, require('./rolePermissions'))
router.use('/tabs', auth, adminOnly, require('./tabs'))
router.use('/activity-logs', auth, adminOnly, require('./activityLogs'))
router.use('/import', auth, adminOnly, require('./import'))

// --- Клиенты ---
router.use('/clients', auth, require('./clients'))
router.use('/clients/billing-addresses', auth, require('./clientBillingAddresses'))
router.use('/clients/shipping-addresses', auth, require('./clientShippingAddresses'))
router.use('/clients/bank-details', auth, require('./clientBankDetails'))

// --- Поставщики ---
router.use('/part-suppliers', auth, require('./partSuppliers'))
router.use('/part-suppliers/addresses', auth, require('./supplierAddresses'))
router.use('/part-suppliers/contacts', auth, require('./supplierContacts'))
router.use('/part-suppliers/bank-details', auth, require('./supplierBankDetails'))

// --- Детали поставщиков ---
router.use('/supplier-parts', auth, require('./supplierParts'))
router.use('/supplier-parts/prices', auth, require('./supplierPartPrices'))
router.use('/supplier-parts/originals', auth, require('./supplierPartOriginals'))
router.use('/supplier-bundles', auth, require('./supplierBundles'))

// --- Оригинальные детали ---
router.use('/original-parts', auth, require('./originalParts'))
router.use('/original-parts/bom', auth, require('./originalPartBom'))
router.use('/original-parts/groups', auth, require('./originalPartGroups'))
router.use('/original-parts/substitutions', auth, require('./originalPartSubstitutions'))
router.use('/original-parts/documents', auth, require('./originalPartDocuments'))
router.use('/original-parts/alt', auth, require('./originalPartAlt'))

// --- Оборудование ---
router.use('/equipment/models', auth, require('./equipmentModels'))
router.use('/equipment/manufacturers', auth, require('./equipmentManufacturers'))

// --- ТН ВЭД ---
router.use('/tnved-codes', auth, require('./tnvedCodes'))

// --- Публичные маршруты ---
router.use('/public', require('./public'))

module.exports = router
