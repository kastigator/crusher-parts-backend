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

// 🔹 Права доступа по ролям (матрица)
router.use('/role-permissions', require('./rolePermissions'));

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
router.use('/original-part-substitutions', require('./originalPartSubstitutions')); // замены/комплекты (по supplier parts)
router.use('/original-part-groups', require('./originalPartGroups'));      // группы оригинальных деталей
router.use('/original-part-documents', require('./originalPartDocuments')); // 🔹 документы и чертежи деталей
router.use('/original-part-alt', require('./originalPartAlt'));            // альтернативные оригинальные детали

// ======================
// Tnved Codes
// ======================
router.use('/tnved-codes', require('./tnvedCodes'));

// ======================
// Suppliers and Supplier Parts
// ======================
router.use('/part-suppliers', require('./partSuppliers'));                 // справочник поставщиков
router.use('/supplier-parts', require('./supplierParts'));                 // детали поставщиков
router.use('/supplier-part-prices', require('./supplierPartPrices'));      // история цен по деталям
router.use('/supplier-part-originals', require('./supplierPartOriginals')); // ПРИВЯЗКИ к оригиналам

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

// ======================
// Supplier bundles (комплекты для оригинальной детали)
// ======================
router.use('/supplier-bundles', require('./supplierBundles'));

module.exports = router;
