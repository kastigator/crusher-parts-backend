// routes/routerIndex.js
const express = require('express')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const requireTabAccess = require('../middleware/requireTabAccess')

// ===== Публичные/авторизация
router.use('/auth', require('./auth'))
router.use('/public', require('./public'))

// ===== Админка (вне вкладок)
router.use('/users',            auth, adminOnly, require('./users'))
router.use('/roles',            auth, adminOnly, require('./roles'))
router.use('/role-permissions', auth, adminOnly, require('./rolePermissions'))
router.use('/tabs',             auth, adminOnly, require('./tabs'))

// ===== Клиенты (вкладка /clients)
router.use('/clients',                   auth, requireTabAccess('/clients'),  require('./clients'))
router.use('/client-billing-addresses',  auth, requireTabAccess('/clients'),  require('./clientBillingAddresses'))
router.use('/client-shipping-addresses', auth, requireTabAccess('/clients'),  require('./clientShippingAddresses'))
router.use('/client-bank-details',       auth, requireTabAccess('/clients'),  require('./clientBankDetails'))

// ===== Поставщики (вкладка /suppliers)
router.use('/suppliers',                 auth, requireTabAccess('/suppliers'), require('./partSuppliers'))        // список поставщиков (таблица компаний)
router.use('/supplier-addresses',        auth, requireTabAccess('/suppliers'), require('./supplierAddresses'))
router.use('/supplier-contacts',         auth, requireTabAccess('/suppliers'), require('./supplierContacts'))
router.use('/supplier-bank-details',     auth, requireTabAccess('/suppliers'), require('./supplierBankDetails'))

// ===== Детали поставщиков (отдельная вкладка /supplier-parts, если есть)
router.use('/supplier-parts',            auth, requireTabAccess('/supplier-parts'), require('./supplierParts'))
router.use('/supplier-parts/prices',     auth, requireTabAccess('/supplier-parts'), require('./supplierPartPrices'))
router.use('/supplier-parts/originals',  auth, requireTabAccess('/supplier-parts'), require('./supplierPartOriginals'))
router.use('/supplier-bundles',          auth, requireTabAccess('/supplier-parts'), require('./supplierBundles'))

module.exports = router
