const CAPABILITY_DEFINITIONS = [
  {
    key: 'catalogs.lookup',
    name: 'Справочный доступ к каталогам',
    description: 'Поиск и чтение мастер-данных без полного редактирования',
    section: 'catalogs',
    sort_order: 10,
  },
  {
    key: 'catalogs.edit',
    name: 'Полное редактирование каталогов',
    description: 'Редактирование каталогов напрямую',
    section: 'catalogs',
    sort_order: 20,
  },
  {
    key: 'workflow.rfq.master_data.write',
    name: 'Изменение мастер-данных из RFQ',
    description: 'Создание и правка supplier parts, цен и связанных данных внутри RFQ-процесса',
    section: 'workflow',
    sort_order: 30,
  },
  {
    key: 'workflow.client.master_data.write',
    name: 'Изменение клиентских данных из раздела Заявки клиентов',
    description: 'Правка клиентов, контактов и реквизитов из клиентского процесса',
    section: 'workflow',
    sort_order: 40,
  },
  {
    key: 'workflow.sales_quotes.manage',
    name: 'Управление КП',
    description: 'Создание и изменение коммерческих предложений и ревизий',
    section: 'workflow',
    sort_order: 50,
  },
  {
    key: 'workflow.contracts.manage',
    name: 'Управление контрактами',
    description: 'Создание и изменение контрактов',
    section: 'workflow',
    sort_order: 60,
  },
  {
    key: 'workflow.purchase_orders.manage',
    name: 'Управление заказами поставщикам',
    description: 'Создание и изменение заказов поставщикам',
    section: 'workflow',
    sort_order: 70,
  },
  {
    key: 'admin.users_roles.manage',
    name: 'Управление пользователями и ролями',
    description: 'Администрирование пользователей, ролей и прав',
    section: 'administration',
    sort_order: 80,
  },
]

const ROLE_CAPABILITY_PRESETS = {
  admin: CAPABILITY_DEFINITIONS.map((item) => item.key),
  prodavec: [
    'catalogs.lookup',
    'workflow.client.master_data.write',
    'workflow.sales_quotes.manage',
    'workflow.contracts.manage',
  ],
  zakupshchik: [
    'catalogs.lookup',
    'workflow.rfq.master_data.write',
    'workflow.purchase_orders.manage',
  ],
  'nachalnik-otdela-zakupok': [
    'catalogs.lookup',
    'catalogs.edit',
    'workflow.rfq.master_data.write',
    'workflow.client.master_data.write',
    'workflow.sales_quotes.manage',
    'workflow.contracts.manage',
    'workflow.purchase_orders.manage',
    'admin.users_roles.manage',
  ],
  'specialist-po-katalogam': [
    'catalogs.lookup',
    'catalogs.edit',
  ],
  nablyudatel: [
    'catalogs.lookup',
  ],
}

module.exports = {
  CAPABILITY_DEFINITIONS,
  ROLE_CAPABILITY_PRESETS,
}
