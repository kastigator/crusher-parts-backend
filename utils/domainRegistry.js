const DOMAIN_ENTITIES = [
  {
    key: 'client_request',
    label_ru: 'Заявка клиента',
    purpose: 'Входящая потребность клиента до формирования RFQ.',
    canonical: {
      table: 'client_requests',
      api_route: '/client-requests',
      frontend_sections: ['Client Request Workspace', 'Заявки клиентов'],
    },
    legacy_or_compatibility: {
      tables: ['client_orders'],
      api_routes: [],
      words: ['заказ клиента', 'client order'],
    },
    user_words: ['заявка', 'заявка клиента', 'запрос клиента', 'потребность клиента', 'PDF от клиента'],
    status: 'canonical_with_legacy_names',
    guidance:
      'В новых ответах и интерфейсе называй это "заявка клиента". client_orders встречается только как старое название.',
  },
  {
    key: 'oem_part',
    label_ru: 'OEM деталь',
    purpose: 'Оригинальная деталь производителя оборудования с каталожным номером, применяемостью и логистикой.',
    canonical: {
      table: 'oem_parts',
      api_route: '/oem-parts',
      frontend_sections: ['Каталоги -> OEM детали'],
    },
    legacy_or_compatibility: {
      tables: ['original_parts'],
      api_routes: ['/original-parts'],
      words: ['оригинальная деталь', 'оригиналка', 'original part'],
    },
    user_words: ['OEM', 'ОЕМ', 'оэм', 'каталожный номер', 'номер детали', 'part number', 'оригиналка'],
    status: 'mixed_route_compatibility',
    guidance:
      'Смысловая сущность одна: OEM деталь. База сейчас oem_parts; /original-parts оставлен как совместимый маршрут фронтенда.',
  },
  {
    key: 'supplier_part',
    label_ru: 'Деталь поставщика',
    purpose: 'Номенклатурная позиция конкретного поставщика: артикул, описание, цена, вес/габариты и связи.',
    canonical: {
      table: 'supplier_parts',
      api_route: '/supplier-parts',
      frontend_sections: ['Каталоги -> Детали поставщиков'],
    },
    legacy_or_compatibility: {
      tables: [],
      api_routes: [],
      words: ['поставщицкая деталь'],
    },
    user_words: ['деталь поставщика', 'позиция поставщика', 'артикул поставщика', 'номер поставщика', 'аналог'],
    status: 'canonical',
    guidance:
      'Не смешивай с BOM-строкой: поставщик продает свою позицию, а связь с позицией каталога хранится отдельно.',
  },
  {
    key: 'supplier_part_catalog_position_link',
    label_ru: 'Связь детали поставщика с позицией каталога',
    purpose: 'Связь поставщицкой позиции с карточкой классификатора или BOM модели.',
    canonical: {
      table: 'supplier_part_catalog_positions',
      api_route: '/supplier-part-catalog-positions',
      frontend_sections: ['Детали поставщиков', 'Классификатор'],
    },
    legacy_or_compatibility: {
      tables: [],
      api_routes: [],
      words: ['связь с оригинальной деталью', 'supplier part original', 'supplier part OEM link'],
    },
    user_words: ['связь поставщика с позицией каталога', 'аналог позиции', 'замена позиции', 'привязка поставщика'],
    status: 'canonical',
    guidance:
      'В разговоре называй "связь детали поставщика с позицией каталога". Старые OEM/original связи не являются рабочим контуром.',
  },
  {
    key: 'equipment_classifier_node',
    label_ru: 'Узел классификатора оборудования',
    purpose: 'Инженерное дерево техники, узлов и моделей оборудования.',
    canonical: {
      table: 'equipment_classifier_nodes',
      api_route: '/equipment-classifier',
      frontend_sections: ['Каталоги -> Классификатор оборудования'],
    },
    legacy_or_compatibility: {
      tables: [],
      api_routes: [],
      words: ['классификатор'],
    },
    user_words: ['дерево оборудования', 'узел', 'тип оборудования', 'модель техники', 'классификатор оборудования'],
    status: 'canonical',
    guidance:
      'Не превращай классификатор оборудования в общий каталог деталей. Он описывает оборудование и узлы.',
  },
  {
    key: 'rfq_supplier_response',
    label_ru: 'Ответ поставщика на RFQ',
    purpose: 'Ответ поставщика с ценами, сроками и строками предложения по RFQ.',
    canonical: {
      table: 'rfq_supplier_responses',
      api_route: '/supplier-responses',
      frontend_sections: ['RFQ Workspace'],
    },
    legacy_or_compatibility: {
      tables: ['supplier_responses'],
      api_routes: [],
      words: ['supplier response'],
    },
    user_words: ['ответ поставщика', 'ответ RFQ', 'коммерческое поставщика', 'предложение поставщика'],
    status: 'canonical_with_legacy_names',
    guidance:
      'Если встречается supplier_responses, это старое/ошибочное имя. Реальная таблица сейчас rfq_supplier_responses.',
  },
  {
    key: 'sales_quote',
    label_ru: 'Коммерческое предложение клиенту',
    purpose: 'КП клиенту, сформированное после выбора закупки и экономики RFQ.',
    canonical: {
      table: 'sales_quotes',
      api_route: '/sales-quotes',
      frontend_sections: ['RFQ Workspace', 'КП клиенту'],
    },
    legacy_or_compatibility: {
      tables: [],
      api_routes: [],
      words: ['sales quote'],
    },
    user_words: ['КП', 'коммерческое', 'предложение клиенту', 'коммерческое предложение'],
    status: 'canonical',
    guidance:
      'Отличай КП клиенту от ответа поставщика: ответ поставщика приходит в закупку, КП уходит клиенту.',
  },
  {
    key: 'client_contract',
    label_ru: 'Контракт с клиентом',
    purpose: 'Договор/контракт с клиентом, созданный из коммерческого предложения.',
    canonical: {
      table: 'client_contracts',
      api_route: '/contracts',
      frontend_sections: ['Контракты', 'RFQ Workspace'],
    },
    legacy_or_compatibility: {
      tables: ['client_order_contracts'],
      api_routes: [],
      words: ['договор клиента'],
    },
    user_words: ['контракт', 'договор', 'незакрытый контракт', 'открытый контракт'],
    status: 'canonical_with_legacy_names',
    guidance:
      'Для пользователя называй "контракт" или "договор". В базе актуально client_contracts.',
  },
  {
    key: 'supplier_purchase_order',
    label_ru: 'Заказ поставщику',
    purpose: 'Покупной заказ поставщику по выбранным строкам закупки.',
    canonical: {
      table: 'supplier_purchase_orders',
      api_route: '/purchase-orders',
      frontend_sections: ['RFQ Workspace', 'Заказы поставщикам'],
    },
    legacy_or_compatibility: {
      tables: ['purchase_orders'],
      api_routes: [],
      words: ['supplier purchase order'],
    },
    user_words: ['PO', 'заказ поставщику', 'покупной заказ', 'заказ на поставщика'],
    status: 'canonical_with_short_route',
    guidance:
      'PO и заказ поставщику означают supplier_purchase_orders. Не путай с заявкой клиента.',
  },
  {
    key: 'tnved_code',
    label_ru: 'Код ТН ВЭД',
    purpose: 'Таможенный код, пошлина и классификация для деталей.',
    canonical: {
      table: 'tnved_codes',
      api_route: '/tnved-codes',
      frontend_sections: ['Каталоги -> Коды ТН ВЭД'],
    },
    legacy_or_compatibility: {
      tables: [],
      api_routes: [],
      words: ['HS code'],
    },
    user_words: ['ТН ВЭД', 'ТНВЭД', 'таможенный код', 'код пошлины', 'hs code'],
    status: 'canonical',
    guidance:
      'При привязке к деталям сначала ищи код и найденные OEM детали, затем показывай черновик пользователю.',
  },
  {
    key: 'measurement_unit',
    label_ru: 'Единица измерения',
    purpose: 'Справочник допустимых единиц измерения и их использования в системе.',
    canonical: {
      table: 'measurement_units',
      api_route: '/measurement-units',
      frontend_sections: ['Единицы измерения'],
    },
    legacy_or_compatibility: {
      tables: [],
      api_routes: [],
      words: ['UOM'],
    },
    user_words: ['единица', 'единица измерения', 'ед. изм.', 'шт', 'кг', 'см', 'uom'],
    status: 'transitional_string_codes',
    guidance:
      'Справочник задает допустимые коды, но часть полей системы пока хранит строковый код единицы.',
  },
]

const NAMING_AUDIT = [
  {
    area: 'OEM детали',
    risk: 'high',
    current_state:
      'Активная таблица называется oem_parts, но совместимый frontend/backend маршрут и часть схем импорта используют original-parts/original_parts.',
    decision: 'Каноническое бизнес-название: OEM деталь. Технически целиться в oem_parts и постепенно убирать original из новых мест.',
  },
  {
    area: 'Ответы поставщиков',
    risk: 'medium',
    current_state:
      'Правильная таблица rfq_supplier_responses. Имя supplier_responses встречалось как ошибочная укороченная форма и уже приводило к сбою агента.',
    decision: 'Всегда использовать rfq_supplier_responses в SQL и "ответ поставщика на RFQ" в интерфейсе.',
  },
  {
    area: 'Заявки клиентов',
    risk: 'medium',
    current_state:
      'Актуальная таблица client_requests, старые следы client_orders есть в миграциях/логах/словарях.',
    decision: 'В пользовательском языке закрепить "заявка клиента"; client_orders считать legacy alias.',
  },
  {
    area: 'Контракты',
    risk: 'low',
    current_state:
      'Актуальная таблица client_contracts, маршрут короткий /contracts, старое имя client_order_contracts встречается в презентационном слое.',
    decision: 'Для пользователя "контракт/договор", в технической карте client_contracts.',
  },
  {
    area: 'Деталь поставщика -> позиция каталога',
    risk: 'medium',
    current_state:
      'Актуальная таблица supplier_part_catalog_positions, маршрут /supplier-part-catalog-positions.',
    decision:
      'Называть связью детали поставщика с позицией каталога/BOM. Не использовать старую OEM-связь поставщика.',
  },
  {
    area: 'Заказы поставщикам',
    risk: 'low',
    current_state:
      'Актуальная таблица supplier_purchase_orders, пользовательский маршрут /purchase-orders короче технического имени.',
    decision: 'Это допустимое сокращение маршрута; агент должен маппить PO/заказ поставщику на supplier_purchase_orders.',
  },
]

const normalize = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_/.-]+/g, ' ')
    .replace(/\s+/g, ' ')

const collectSearchTerms = (entity) => [
  entity.key,
  entity.label_ru,
  entity.purpose,
  entity.canonical?.table,
  entity.canonical?.api_route,
  ...(entity.canonical?.frontend_sections || []),
  ...(entity.legacy_or_compatibility?.tables || []),
  ...(entity.legacy_or_compatibility?.api_routes || []),
  ...(entity.legacy_or_compatibility?.words || []),
  ...(entity.user_words || []),
]

const scoreEntity = (term, entity) => {
  const normalizedTerm = normalize(term)
  if (!normalizedTerm) return 0

  let score = 0
  collectSearchTerms(entity).forEach((candidate) => {
    const normalizedCandidate = normalize(candidate)
    if (!normalizedCandidate) return
    if (normalizedCandidate === normalizedTerm) score += 100
    else if (normalizedTerm.length <= 2 || normalizedCandidate.length <= 2) return
    else if (normalizedCandidate.includes(normalizedTerm)) score += 35
    else if (normalizedTerm.includes(normalizedCandidate)) score += 20
  })
  return score
}

const getDomainRegistry = () => ({
  entities: DOMAIN_ENTITIES,
  naming_audit: NAMING_AUDIT,
})

const resolveDomainTerm = ({ term, limit = 5 } = {}) => {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 5, 10))
  const matches = DOMAIN_ENTITIES
    .map((entity) => ({ ...entity, match_score: scoreEntity(term, entity) }))
    .filter((entity) => entity.match_score > 0)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, normalizedLimit)

  return {
    term: term || '',
    matches,
    note:
      matches.length > 0
        ? 'Используй label_ru и guidance для ответа пользователю, а canonical для технического выбора инструмента.'
        : 'Совпадений в доменном словаре не найдено. Нужно уточнить смысл у пользователя или искать по системе.',
  }
}

module.exports = {
  DOMAIN_ENTITIES,
  NAMING_AUDIT,
  getDomainRegistry,
  resolveDomainTerm,
}
