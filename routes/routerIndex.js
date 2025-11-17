// routes/routerIndex.js
const express = require('express')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const requireTabAccess = require('../middleware/requireTabAccess')

// ======================================================
// === Авторизация и публичные разделы ==================
// ======================================================

// Логин / refresh / смена пароля и т.п.
router.use('/auth', require('./auth'))

// Публичные хелперы (например, список админов для "забыли пароль")
router.use('/public', require('./public'))

// ======================================================
// === Админка (пользователи, роли, вкладки) ============
// ======================================================
//
// Эти роуты живут СВЕРХУ всего RBAC по вкладкам.
// Доступ только для role = 'admin' через adminOnly.
// ======================================================

router.use('/users', auth, adminOnly, require('./users'))
router.use('/roles', auth, adminOnly, require('./roles'))
router.use('/tabs', auth, adminOnly, require('./tabs'))
router.use('/role-permissions', auth, adminOnly, require('./rolePermissions'))

// Внутренние dev-инструменты — тоже только для админа
router.use('/dev-tools', auth, adminOnly, require('./devTools'))

// ======================================================
// === Коды ТН ВЭД (TAB: tnved_codes) ===================
// ======================================================
//
// Вкладка "Коды ТН ВЭД" → tab_name = 'tnved_codes'
// Всё, что относится к ТН ВЭД, закрыто requireTabAccess('tnved_codes')
// ======================================================

router.use(
  '/tnved-codes',
  auth,
  requireTabAccess('tnved_codes'),
  require('./tnvedCodes')
)

// (импорт и логи для ТН ВЭД привяжем отдельно, когда будем рефакторить /import и /activity-logs)

// ======================================================
// === Клиенты (TAB: clients) ===========================
// ======================================================
//
// Клиенты + их реквизиты (юр. адреса, доставки, банки)
// Все эти роуты доступны, если есть доступ к вкладке "Клиенты"
// ======================================================

router.use(
  '/clients',
  auth,
  requireTabAccess('clients'),
  require('./clients')
)

router.use(
  '/client-billing-addresses',
  auth,
  requireTabAccess('clients'),
  require('./clientBillingAddresses')
)

router.use(
  '/client-shipping-addresses',
  auth,
  requireTabAccess('clients'),
  require('./clientShippingAddresses')
)

router.use(
  '/client-bank-details',
  auth,
  requireTabAccess('clients'),
  require('./clientBankDetails')
)

// ======================================================
// === Поставщики (TAB: suppliers) ======================
// ======================================================
//
// Карточка поставщика + его адреса, контакты, банковские реквизиты.
// Это аналог блока "Клиенты", только для поставщиков.
// ======================================================

// ⚠️ Здесь предполагается, что у тебя есть файл routes/suppliers.js
// Если базовый роутер поставщиков называется иначе — поправь require.
router.use(
  '/partSuppliers',
  auth,
  requireTabAccess('suppliers'),
  require('./suppliers')
)

router.use(
  '/supplier-addresses',
  auth,
  requireTabAccess('suppliers'),
  require('./supplierAddresses')
)

router.use(
  '/supplier-contacts',
  auth,
  requireTabAccess('suppliers'),
  require('./supplierContacts')
)

router.use(
  '/supplier-bank-details',
  auth,
  requireTabAccess('suppliers'),
  require('./supplierBankDetails')
)

// ======================================================
// === Детали поставщиков (TAB: supplier-parts) =========
// ======================================================
//
// Каталог деталей поставщиков + история цен + связи с оригинальными
// ======================================================

router.use(
  '/supplier-parts',
  auth,
  requireTabAccess('supplier-parts'),
  require('./supplierParts')
)

router.use(
  '/supplier-part-prices',
  auth,
  requireTabAccess('supplier-parts'),
  require('./supplierPartPrices')
)

router.use(
  '/supplier-part-originals',
  auth,
  requireTabAccess('supplier-parts'),
  require('./supplierPartOriginals')
)

// ======================================================
// === Оригинальные детали (TAB: original-parts) ========
// ======================================================
//
// Всё, что относится к каталогу оригинальных деталей:
// сами детали, группы, BOM, замены, документы, привязка к оборудованию,
// привязка поставщиков и бандлы (комплекты из supplier_parts)
// ======================================================

router.use(
  '/original-parts',
  auth,
  requireTabAccess('original-parts'),
  require('./originalParts')
)

router.use(
  '/original-part-groups',
  auth,
  requireTabAccess('original-parts'),
  require('./originalPartGroups')
)

router.use(
  '/original-part-bom',
  auth,
  requireTabAccess('original-parts'),
  require('./originalPartBom')
)

router.use(
  '/original-part-substitutions',
  auth,
  requireTabAccess('original-parts'),
  require('./originalPartSubstitutions')
)

router.use(
  '/original-part-documents',
  auth,
  requireTabAccess('original-parts'),
  require('./originalPartDocuments')
)

router.use(
  '/original-part-alt',
  auth,
  requireTabAccess('original-parts'),
  require('./originalPartAlt')
)

router.use(
  '/equipment-manufacturers',
  auth,
  requireTabAccess('original-parts'),
  require('./equipmentManufacturers')
)

router.use(
  '/equipment-models',
  auth,
  requireTabAccess('original-parts'),
  require('./equipmentModels')
)

// Комплекты (bundle), как собрать оригинальную деталь из деталей поставщиков
router.use(
  '/supplier-bundles',
  auth,
  requireTabAccess('original-parts'),
  require('./supplierBundles')
)

// Связь оригинальная деталь ↔ поставщики / детали поставщиков
router.use(
  '/part-suppliers',
  auth,
  requireTabAccess('original-parts'),
  require('./partSuppliers')
)

// ======================================================
// === Системные сервисы (импорт, логи) =================
// ======================================================
//
// Тут пока оставляем как есть (auth + общий роутер).
// Позже, когда будем наводить порядок с импортом/логами, разделим
// по вкладкам (import/tnved, import/original-parts и т.п.)
// ======================================================

router.use('/import', auth, require('./import'))

router.use('/activity-logs', auth, require('./activityLogs'))

// ======================================================
// === Экспорт роутера ==================================
// ======================================================

module.exports = router
