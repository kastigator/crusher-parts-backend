// routes/routerIndex.js
const express = require('express');
const router = express.Router();

// ======================
// Import
// ======================
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
router.use('/original-part-substitutions', require('./originalPartSubstitutions')); // замены/комплекты

// ======================
// Tnved Codes
// ======================
router.use('/tnved-codes', require('./tnvedCodes'));

// ======================
// Suppliers and Supplier Parts
// ======================
router.use('/part-suppliers', require('./partSuppliers'));                 // справочник поставщиков
router.use('/supplier-parts', require('./supplierParts'));                 // детали поставщиков + связь с оригиналами
router.use('/supplier-part-prices', require('./supplierPartPrices'));      // история цен по деталям

// ======================
// Supplier child entities
// ======================
router.use('/supplier-addresses', require('./supplierAddresses'));
router.use('/supplier-contacts', require('./supplierContacts'));
router.use('/supplier-bank-details', require('./supplierBankDetails'));

// ======================
// Logs
// ======================
router.use('/activity-logs', require('./activityLogs'));

// ======================
// Public routes (no auth)
// ======================
router.use('/public', require('./public'));

module.exports = router;
