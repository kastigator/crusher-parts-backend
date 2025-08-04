const express = require('express');
const router = express.Router();

router.use('/import', require('./import'))


// Auth and User Management
router.use('/auth', require('./auth'));
router.use('/users', require('./users'));
router.use('/roles', require('./roles'));

// Clients and Addresses
router.use('/clients', require('./clients'));
router.use('/client-bank-details', require('./clientBankDetails'));
router.use('/client-billing-addresses', require('./clientBillingAddresses'));
router.use('/client-shipping-addresses', require('./clientShippingAddresses'));

// Equipment: Manufacturers and Models
router.use('/equipment-manufacturers', require('./equipmentManufacturers'));
router.use('/equipment-models', require('./equipmentModels'));

// Original Parts
router.use('/original-parts', require('./originalParts'));

// Tnved Codes
router.use('/tnved-codes', require('./tnvedCodes'));

// Suppliers and Supplier Parts
router.use('/part-suppliers', require('./partSuppliers'));
router.use('/supplier-parts', require('./supplierParts'));
router.use('/supplier-part-prices', require('./supplierPartPrices'));

// 🔹 Новое: Связи между поставщиками и оригиналами (многие-ко-многим)
router.use('/supplier-part-originals', require('./supplierPartOriginals'));

// 💡 Логи (подключим позже, когда появится необходимость в чтении)
router.use('/activity-logs', require('./activityLogs'));
// Публичные маршруты (не требуют авторизации)
router.use('/public', require('./public'))




module.exports = router;
