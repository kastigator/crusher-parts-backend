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
// Доступ только для role = 'admin' через adminOnly,
// КРОМЕ /tabs — он нужен всем авторизованным, чтобы
// подгрузить список доступных вкладок в Sidebar.
// ======================================================

router.use('/users', auth, adminOnly, require('./users'))
router.use('/roles', auth, adminOnly, require('./roles'))

// tabs: только auth, без adminOnly — чтобы любой
// авторизованный пользователь мог получить свои вкладки
router.use('/tabs', auth, require('./tabs'))

router.use('/role-permissions', auth, adminOnly, require('./rolePermissions'))

// Внутренние dev-инструменты — тоже только для админа
router.use('/dev-tools', auth, adminOnly, require('./devTools'))

// ======================================================
// === Коды ТН ВЭД (TAB: /tnved-codes) ==================
// ======================================================

router.use(
  '/tnved-codes',
  auth,
  requireTabAccess('/tnved-codes'),
  require('./tnvedCodes')
)

// ======================================================
// === Клиенты (TAB: /clients) ==========================
// ======================================================

router.use(
  '/clients',
  auth,
  requireTabAccess('/clients'),
  require('./clients')
)

router.use(
  '/client-billing-addresses',
  auth,
  requireTabAccess('/clients'),
  require('./clientBillingAddresses')
)

router.use(
  '/client-shipping-addresses',
  auth,
  requireTabAccess('/clients'),
  require('./clientShippingAddresses')
)

router.use(
  '/client-bank-details',
  auth,
  requireTabAccess('/clients'),
  require('./clientBankDetails')
)

// ======================================================
// === Поставщики (TAB: /suppliers) =====================
// ======================================================
//
// Карточка поставщика (partSuppliers.js) + адреса/контакты/банки.
// Все они относятся к вкладке /suppliers.
// ВАЖНО: базовый путь именно /suppliers — совпадает с tabs.path
// и с тем, куда стучится фронт.
// ======================================================

router.use(
  '/suppliers',
  auth,
  requireTabAccess('/suppliers'),
  require('./partSuppliers') // сам файл называется partSuppliers.js
)

router.use(
  '/supplier-addresses',
  auth,
  requireTabAccess('/suppliers'),
  require('./supplierAddresses')
)

router.use(
  '/supplier-contacts',
  auth,
  requireTabAccess('/suppliers'),
  require('./supplierContacts')
)

router.use(
  '/supplier-bank-details',
  auth,
  requireTabAccess('/suppliers'),
  require('./supplierBankDetails')
)

// ======================================================
// === Детали поставщиков (TAB: /supplier-parts) ========
// ======================================================

router.use(
  '/supplier-parts',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierParts')
)

router.use(
  '/supplier-part-prices',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierPartPrices')
)

router.use(
  '/supplier-part-originals',
  auth,
  requireTabAccess('/supplier-parts'),
  require('./supplierPartOriginals')
)

// ======================================================
// === Оригинальные детали (TAB: /original-parts) =======
// ======================================================

router.use(
  '/original-parts',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalParts')
)

router.use(
  '/original-part-groups',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartGroups')
)

router.use(
  '/original-part-bom',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartBom')
)

router.use(
  '/original-part-substitutions',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartSubstitutions')
)

// Документы оригинальных деталей — подресурс original-parts
router.use(
  '/original-parts',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartDocuments')
)


router.use(
  '/original-part-alt',
  auth,
  requireTabAccess('/original-parts'),
  require('./originalPartAlt')
)

// Вспомогательные справочники оборудования
// Используются и в оригинальных деталях, и при линковке деталей
// поставщиков, поэтому здесь БЕЗ requireTabAccess — достаточно auth.
// (Внутри файлов мы убрали tabGuard.)

router.use('/equipment-manufacturers', auth, require('./equipmentManufacturers'))
router.use('/equipment-models', auth, require('./equipmentModels'))

// Комплекты (bundle), как собрать оригинальную деталь из деталей поставщиков
router.use(
  '/supplier-bundles',
  auth,
  requireTabAccess('/original-parts'),
  require('./supplierBundles')
)

// Связь оригинальная деталь ↔ поставщики / детали поставщиков
router.use(
  '/part-suppliers',
  auth,
  requireTabAccess('/original-parts'),
  require('./partSuppliers')
)

// ======================================================
// === Системные сервисы (импорт, логи) =================
// ======================================================
//
// Здесь не вешаем requireTabAccess: внутри самих роутов
// уже стоит auth и своя логика доступа (dynamicTabGuard).
// ======================================================

router.use('/import', require('./import'))
router.use('/activity-logs', require('./activityLogs'))

// ======================================================
// === Экспорт роутера ==================================
// ======================================================

module.exports = router
