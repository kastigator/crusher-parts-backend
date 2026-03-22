const CATALOG_CHILD_PATHS = [
  '/clients',
  '/suppliers',
  '/supplier-parts',
  '/original-parts',
  '/standard-parts',
  '/equipment-classifier',
  '/materials',
  '/tnved-codes',
  '/logistics-route-templates',
]

const ACCESS_SECTIONS = [
  {
    key: 'workspaces',
    label: 'Рабочие зоны',
    paths: ['/client-request-workspace', '/rfq-workspace'],
  },
  {
    key: 'analytics',
    label: 'Показатели',
    paths: ['/kpi'],
  },
  {
    key: 'catalogs',
    label: 'Каталоги',
    paths: [
      '/catalogs',
      ...CATALOG_CHILD_PATHS,
    ],
  },
  {
    key: 'logistics',
    label: 'Шаблоны доставки',
    paths: ['/logistics-route-templates'],
  },
  {
    key: 'administration',
    label: 'Администрирование',
    paths: ['/admin', '/users'],
  },
]

const ROLE_PRESETS = {
  admin: {
    label: 'Администратор',
    description:
      'Полный доступ к системе: пользователи, роли, оба рабочих контура и каталоги.',
    tabPaths: ['/client-request-workspace', '/rfq-workspace', '/kpi', '/catalogs', '/users'],
  },
  prodavec: {
    label: 'Продавец',
    description:
      'Ведет клиентскую заявку, коммерческое предложение и контракт. Видит свой KPI, но не управляет закупкой и PO.',
    tabPaths: ['/client-request-workspace', '/kpi'],
  },
  zakupshchik: {
    label: 'Закупщик',
    description:
      'Работает в RFQ-процессе, логистике, экономике и исполнении закупки. Видит свой KPI и использует каталоги как справочник из workflow.',
    tabPaths: ['/rfq-workspace', '/kpi'],
  },
  'nachalnik-otdela-zakupok': {
    label: 'Начальник отдела закупок',
    description:
      'Видит оба workspace, каталоги и администрирование ролей/пользователей.',
    tabPaths: [
      '/client-request-workspace',
      '/rfq-workspace',
      '/kpi',
      '/catalogs',
      '/users',
    ],
  },
  'specialist-po-katalogam': {
    label: 'Специалист по каталогам',
    description:
      'Поддерживает справочники и мастер-данные. Не ведет RFQ, КП, контракты и PO как основной процесс.',
    tabPaths: ['/catalogs'],
  },
  nablyudatel: {
    label: 'Наблюдатель',
    description:
      'Смотрит оба рабочих контура и справочники, но не должен менять данные и запускать процессные действия.',
    tabPaths: ['/client-request-workspace', '/rfq-workspace', '/kpi', '/catalogs'],
  },
}

const ROUTE_BUNDLES = {
  CLIENT_REQUEST_WORKSPACE: ['/client-request-workspace'],
  RFQ_WORKSPACE: ['/rfq-workspace'],
  CATALOGS: ['/catalogs'],
  ADMIN: ['/admin', '/users'],
  CLIENTS_LOOKUP: ['/catalogs', '/client-request-workspace'],
  SUPPLIER_LOOKUP: ['/catalogs', '/rfq-workspace'],
  MASTER_DATA_LOOKUP: ['/catalogs', '/rfq-workspace', '/client-request-workspace'],
  COMMERCIAL_FLOW: ['/client-request-workspace', '/rfq-workspace'],
}

function normalizePathSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )
}

function buildRoleDiagnostics(role, allowedPaths) {
  const warnings = []
  const preset = ROLE_PRESETS[role.slug] || null
  const hasCatalogRoot = allowedPaths.has('/catalogs')
  const hasAdminRoot = allowedPaths.has('/admin')
  const hasUsersPage = allowedPaths.has('/users')
  const hasClientWorkspace = allowedPaths.has('/client-request-workspace')
  const hasRfqWorkspace = allowedPaths.has('/rfq-workspace')

  if (!allowedPaths.size) {
    warnings.push('У роли нет ни одной доступной зоны или справочника.')
  }

  if (hasAdminRoot && !hasUsersPage) {
    warnings.push('Есть доступ к админке, но нет доступа к странице "Пользователи и роли".')
  }

  if (!hasAdminRoot && hasUsersPage) {
    warnings.push('Есть доступ к странице "Пользователи и роли", но нет корневой админки.')
  }

  if (!hasCatalogRoot) {
    const catalogChildren = CATALOG_CHILD_PATHS
      .filter((path) => allowedPaths.has(path))
    if (catalogChildren.length) {
      warnings.push('Выданы отдельные каталоговые вкладки без корневой вкладки "Каталоги". Навигация будет выглядеть непоследовательно.')
    }
  }

  if (hasClientWorkspace && hasRfqWorkspace && role.slug === 'prodavec') {
    warnings.push('Для продавца выдан доступ к закупочному workspace. Проверь, нужно ли это по процессу.')
  }

  if (role.slug === 'zakupshchik' && hasClientWorkspace) {
    warnings.push('Для закупщика выдан доступ к клиентскому workspace. Проверь, нужен ли коммерческий контур.')
  }

  if (role.slug === 'specialist-po-katalogam' && (hasClientWorkspace || hasRfqWorkspace)) {
    warnings.push('Специалисту по каталогам выдан доступ к рабочим workspace. Обычно ему достаточно раздела "Каталоги".')
  }

  if (role.slug === 'nablyudatel' && (hasAdminRoot || hasUsersPage)) {
    warnings.push('Наблюдателю выданы административные права. Обычно эта роль должна быть только обзорной.')
  }

  const missingRecommended = []
  const extraPaths = []

  if (preset) {
    const recommended = normalizePathSet(preset.tabPaths)
    for (const path of recommended) {
      if (!allowedPaths.has(path)) missingRecommended.push(path)
    }
    for (const path of allowedPaths) {
      if (!recommended.has(path)) extraPaths.push(path)
    }
  }

  return {
    roleSlug: role.slug,
    roleName: role.name,
    preset,
    warnings,
    missingRecommended,
    extraPaths,
  }
}

module.exports = {
  ACCESS_SECTIONS,
  CATALOG_CHILD_PATHS,
  ROLE_PRESETS,
  ROUTE_BUNDLES,
  buildRoleDiagnostics,
}
