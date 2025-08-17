// routerIndex.js
const express = require('express');
const router = express.Router();

router.use('/import', require('./import'));

// ======================
// Auth and User Management
// ======================
router.use('/auth', require('./auth'));
router.use('/users', require('./users'));
router.use('/roles', require('./roles'));

// ======================
// Clients and Addresses
// ======================
router.use('/clients', require('./clients'));
router.use('/client-bank-details', require('./clientBankDetails'));
router.use('/client-billing-addresses', require('./clientBillingAddresses'));
router.use('/client-shipping-addresses', require('./clientShippingAddresses'));

// ======================
// Equipment: Manufacturers and Models
// ======================
router.use('/equipment-manufacturers', require('./equipmentManufacturers'));
router.use('/equipment-models', require('./equipmentModels'));

// ======================
// Original Parts
// ======================
router.use('/original-parts', require('./originalParts'));                 // справочник оригинальных деталей
router.use('/original-part-bom', require('./originalPartBom'));            // составы (BOM)
router.use('/original-part-substitutions', require('./originalPartSubstitutions')); // замены

// ======================
// Tnved Codes
// ======================
router.use('/tnved-codes', require('./tnvedCodes'));

// ======================
// Suppliers and Supplier Parts (мастер + каталоги/цены/связи)
// ======================
router.use('/part-suppliers', require('./partSuppliers'));                 // справочник поставщиков
router.use('/supplier-parts', require('./supplierParts'));                 // детали поставщиков + связь с оригиналами
router.use('/supplier-part-prices', require('./supplierPartPrices'));      // история цен

// ======================
// Supplier child entities
// ======================
router.use('/supplier-addresses', require('./supplierAddresses'));
router.use('/supplier-contacts', require('./supplierContacts'));
router.use('/supplier-bank-details', require('./supplierBankDetails'));

// ======================
// Supplier ↔ Original many-to-many (если нужен отдельный CRUD)
// ======================
router.use('/supplier-part-originals', require('./supplierPartOriginals'));

// ======================
// Logs
// ======================
router.use('/activity-logs', require('./activityLogs'));

// ======================
// Public routes (no auth)
// ======================
router.use('/public', require('./public'));

module.exports = router;
