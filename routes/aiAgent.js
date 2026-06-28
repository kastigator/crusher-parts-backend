const express = require('express')
const multer = require('multer')
const {
  getBusinessSnapshot,
  getCatalogHealthSummary,
  getOpenContracts,
  getAnalyticsVisualization,
  findTnvedAssignmentCandidates,
  listTnvedCodesByDutyRate,
  searchBusinessObjects,
  getBusinessObjectTimeline,
  getRfqTimeline,
  getCatalogQualityQueue,
  explainMeasurementUnitUsage,
} = require('../utils/aiAgentContext')
const {
  getSystemMap,
  getBusinessProcessGuide,
  getAgentActionPolicy,
  getAgentConfigurationGuide,
  getDomainRegistry,
  resolveDomainTerm,
} = require('../utils/aiAgentDomainContext')
const { prepareFilesForOpenAi } = require('../utils/aiAgentFiles')
const { listSystemDocuments, readSystemDocument } = require('../utils/aiAgentSystemDocuments')

const router = express.Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 8,
    fileSize: 20 * 1024 * 1024,
  },
})

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.AI_AGENT_MODEL || 'gpt-5.4-mini'
const USER_LANGUAGE_GUIDE = `
Словарь интерфейса для пользователя:
- "Клиенты" = карточки организаций покупателей, контакты, адреса, банки, техника клиента.
- "Заявки клиентов", "заявка", "client request" = входящая потребность клиента до закупки.
- "RFQ", "запрос поставщикам", "закупка" = рабочий процесс запроса цен у поставщиков.
- "Поставщики" = организации поставщиков.
- "Детали поставщиков" = номенклатура поставщика, supplier part.
- "OEM детали", "оригинальные детали" = оригинальные детали производителя оборудования.
- "Классификатор оборудования" = дерево типов техники и узлов, к которым привязываются модели оборудования.
- "Материалы" = справочник материалов.
- "Единицы измерения" = справочник допустимых единиц: шт, кг, см и т.д.
- "Качество каталогов" = обзор проблем нормализации: нет классификатора, нет веса/габаритов.

Синонимы и живая речь пользователей:
- "каталожный номер", "каталожник", "номер детали", "номер позиции", "парт номер", "part number", "артикул" обычно означают номер OEM детали или детали поставщика.
- "оригиналка", "оригинальная", "OEM", "ОЕМ", "оэм" обычно означают OEM деталь.
- "поставщицкая", "позиция поставщика", "номер поставщика", "аналог поставщика" обычно означают деталь поставщика.
- "стандартная", "типовая", "крепеж", "болт", "гайка", "электродвигатель" должны идти через классификатор, а не через отдельный справочник.
- "таможенный код", "код таможни", "ТНВЭД", "ТН ВЭД", "tnved", "hs code", "код пошлины" означают код ТН ВЭД.
- "пошлина 10%", "ставка пошлины", "коды с пошлиной", "код с 0%" означает фильтр справочника ТН ВЭД по ставке пошлины.
- "весогабариты", "массо-габаритные", "логистика", "вес и размеры", "габариты" означают вес и длину/ширину/высоту.
- "заявка", "заявка клиента", "запрос клиента", "потребность клиента", "PDF от клиента" обычно означает клиентскую заявку.
- "закупка", "опрос поставщиков", "разослать поставщикам", "запрос цен" обычно означает RFQ.
- "КП", "коммерческое", "предложение клиенту" означает коммерческое предложение.
- "контракт", "договор", "незакрытые контракты", "открытые контракты" означает клиентские контракты в работе.
- "заказ поставщику", "PO", "покупной заказ" означает заказ поставщику.
- "заказывал", "что-нибудь заказывали", "работали с ними", "что было по клиенту", "имеет контракты", "есть контракты по клиенту" означает историю конкретного клиента: заявки, RFQ, КП, контракты и заказы поставщикам.

Правила языка:
- Не показывай пользователю имена таблиц и колонок, если он сам не просит технические детали.
- Не показывай пользователю названия инструментов, SQL-таблиц, колонок, JSON-ключей или ошибки базы. Если инструмент упал, скажи простыми словами: "не удалось проверить из-за ошибки сервера", без текста SQL-ошибки.
- Когда инструмент вернул type вроде oem_part или supplier_part, переведи это в понятный тип: "OEM деталь", "деталь поставщика", "стандартная деталь", "клиент", "поставщик", "материал".
- Если нужно сослаться на место в интерфейсе, называй раздел меню: "Каталоги -> OEM детали", "Каталоги -> Детали поставщиков", "RFQ Workspace". Не показывай пользователю URL, route, query-параметры и строки вида /clients/69 или ?focus=142.
- Если пользователь говорит неточно, сначала сделай разумную интерпретацию и явно напиши "Я понял это так: ...".
- Если есть 2-3 возможных смысла, не угадывай молча: перечисли варианты и предложи самый вероятный следующий шаг.
- Для действий с изменением данных всегда показывай найденные совпадения и черновик изменений перед выполнением.
- Для живого поиска по системе используй search_business_objects. Для вопросов про историю клиента/заказы клиента используй get_business_object_timeline.
- Для вопросов "какие коды ТН ВЭД имеют пошлину X%" или "покажи коды со ставкой от X до Y%" используй list_tnved_codes_by_duty_rate. Не ищи такие вопросы текстовым поиском.
- Если пользователь указывает название клиента и спрашивает про контракты, заказы, заявки, RFQ или КП, сначала используй get_business_object_timeline по этому клиенту. get_open_contracts используй только для общего вопроса "покажи открытые/незакрытые контракты" без конкретного клиента.
- Если пользователь просит привязать/назначить ТН ВЭД к каталожным номерам, вызови find_tnved_assignment_candidates и верни понятный черновик: найденный код, найденные OEM детали, текущий код у каждой детали, что будет изменено.
`

const tools = [
  {
    type: 'function',
    name: 'get_system_map',
    description:
      'Получить карту интерфейса и основных разделов системы: где что находится, как пользователи называют разделы, назначение каталогов и рабочих зон.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_business_process_guide',
    description:
      'Получить описание полного бизнес-процесса: заявка клиента -> RFQ -> ответы поставщиков -> покрытие/экономика -> КП -> контракт -> заказы поставщикам.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_agent_action_policy',
    description:
      'Получить правила безопасных действий агента: чтение, подтверждение изменений, удаление через корзину, работа с неоднозначными запросами.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_agent_configuration_guide',
    description:
      'Получить карту настройки агента: пользовательские намерения, какие инструменты выбирать, текущие пробелы и следующие backend tools. Используй для широких вопросов "что агент умеет", "как агент должен искать", "почему он не понимает запрос".',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_domain_registry',
    description:
      'Получить канонический словарь доменных сущностей системы: как пользовательские слова, старые SQL/API названия и текущие таблицы/разделы соответствуют друг другу.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'resolve_domain_term',
    description:
      'Разобрать неоднозначный термин пользователя или техническое имя и найти, какой доменной сущности системы он соответствует. Используй при путанице original/oem, client_orders/client_requests, supplier_responses/rfq_supplier_responses и похожих случаях.',
    parameters: {
      type: 'object',
      properties: {
        term: {
          type: 'string',
          description: 'Слово пользователя, техническое имя таблицы/API или фраза для сопоставления',
        },
        limit: { type: 'number', description: 'Сколько вариантов вернуть' },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_business_snapshot',
    description:
      'Получить краткую сводку по системе: количество клиентов, поставщиков, деталей, заявок, RFQ и последние записи.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_catalog_health_summary',
    description:
      'Получить сводку качества каталогов: отсутствующие классификаторы, вес/габариты и примеры очередей нормализации.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_open_contracts',
    description:
      'Получить список незакрытых клиентских контрактов/договоров и сводку по статусам. Используй, когда пользователь спрашивает про открытые или не закрытые контракты.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Сколько контрактов вернуть' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_analytics_visualization',
    description:
      'Построить структурированные данные для графика/диаграммы по аналитике системы. Используй, когда пользователь просит график, диаграмму, динамику, топ, распределение или анализ во времени.',
    parameters: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          description:
            'contracts_by_month, client_requests_by_month, client_requests_by_status, rfqs_by_status, purchase_orders_by_supplier, tnved_duty_distribution',
        },
        from_date: {
          type: 'string',
          description: 'Дата начала в формате YYYY-MM-DD, если пользователь указал период',
        },
        to_date: {
          type: 'string',
          description: 'Дата окончания в формате YYYY-MM-DD, если пользователь указал период',
        },
        limit: { type: 'number', description: 'Сколько точек/строк вернуть' },
      },
      required: ['metric'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_business_objects',
    description:
      'Универсальный бизнес-поиск по словам пользователя: клиенты, поставщики, OEM детали, детали поставщиков, стандартные детали, материалы и коды ТН ВЭД. Возвращает человеческие названия, разделы интерфейса и ссылки для открытия.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Что ищет пользователь живым языком' },
        object_type: {
          type: 'string',
          description: 'Необязательно: client, supplier, oem_part, supplier_part или all',
        },
        limit: { type: 'number', description: 'Сколько совпадений вернуть' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_business_object_timeline',
    description:
      'Получить бизнес-историю объекта. Сейчас поддержан клиент: заявки клиента, RFQ, КП, контракты и заказы поставщикам. Используй для вопросов вроде "этот клиент что-то заказывал?", "что было по клиенту?", "есть ли по нему контракты?".',
    parameters: {
      type: 'object',
      properties: {
        object_type: { type: 'string', description: 'Тип объекта, например client' },
        object_id: { type: 'number', description: 'ID объекта, если уже известен' },
        query: { type: 'string', description: 'Название клиента или свободная строка поиска' },
        limit: { type: 'number', description: 'Сколько связанных записей вернуть' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_rfq_timeline',
    description:
      'Получить таймлайн RFQ: клиентская заявка, позиции, поставщики, ответы, выбор закупки, КП клиенту, контракты и заказы поставщикам. Используй для вопросов "что по RFQ", "кто ответил", "что передано продавцу", "почему процесс остановился".',
    parameters: {
      type: 'object',
      properties: {
        rfq_id: { type: 'number', description: 'ID RFQ, если известен' },
        query: { type: 'string', description: 'Номер RFQ, номер заявки или название клиента' },
        limit: { type: 'number', description: 'Сколько строк/связанных записей вернуть' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'find_tnved_assignment_candidates',
    description:
      'Подготовить черновик привязки кода ТН ВЭД к OEM деталям по каталожным номерам или свободному тексту. Ничего не изменяет в базе, только ищет код и детали для подтверждения.',
    parameters: {
      type: 'object',
      properties: {
        tnved_code: { type: 'string', description: 'Код ТН ВЭД, если пользователь его указал' },
        part_numbers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Каталожные номера/OEM номера, к которым пользователь хочет привязать код',
        },
        query: {
          type: 'string',
          description: 'Свободный текст запроса, если код или номера не удалось выделить отдельно',
        },
        limit: { type: 'number', description: 'Лимит найденных OEM деталей' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_tnved_codes_by_duty_rate',
    description:
      'Найти коды ТН ВЭД по ставке пошлины. Используй для вопросов "какие коды имеют пошлину 10%", "покажи коды с 0%", "ставка от 5 до 10%" и похожих.',
    parameters: {
      type: 'object',
      properties: {
        duty_rate: {
          type: 'number',
          description: 'Точная ставка пошлины в процентах, например 10 для 10%',
        },
        min_rate: {
          type: 'number',
          description: 'Минимальная ставка пошлины в процентах для диапазона',
        },
        max_rate: {
          type: 'number',
          description: 'Максимальная ставка пошлины в процентах для диапазона',
        },
        limit: { type: 'number', description: 'Сколько кодов вернуть' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_catalog_quality_queue',
    description:
      'Получить очередь качества каталогов: где нет веса/габаритов, какие модели не привязаны к классификатору, что надо нормализовать. Используй для вопросов про качество данных и нормализацию.',
    parameters: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description:
            'summary, oem_missing_logistics, supplier_parts_missing_logistics, equipment_models_without_classifier',
        },
        limit: { type: 'number', description: 'Сколько примеров вернуть' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'explain_measurement_unit_usage',
    description:
      'Объяснить справочник единиц измерения и где конкретная единица используется в системе человеческим языком. Используй для вопросов "где используется кг", "как использовать единицу", "почему есть pcs".',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Код единицы, например шт, кг, см' },
        query: { type: 'string', description: 'Свободный поиск по названию или символу единицы' },
        limit: { type: 'number', description: 'Сколько единиц или совпадений вернуть' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_system_documents',
    description:
      'Найти документы, уже сохраненные в системе и GCS-бакете, по OEM детали или RFQ. Используй перед анализом документов из карточки/заявки/RFQ.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Тип сущности: oem_part/original_part/oem или rfq',
        },
        entity_id: {
          type: 'number',
          description: 'ID OEM детали или RFQ, если пользователь его указал',
        },
        query: {
          type: 'string',
          description: 'Поиск по имени файла, описанию, номеру OEM детали, RFQ или поставщику',
        },
        limit: { type: 'number', description: 'Сколько документов вернуть' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'read_system_document',
    description:
      'Скачать документ из GCS-бакета и приложить его к анализу модели. Поддерживает PDF, изображения, Excel/CSV, Word и текст. Ничего не меняет в базе.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Тип сущности: oem_part/original_part/oem или rfq',
        },
        document_id: {
          type: 'number',
          description: 'ID документа из list_system_documents',
        },
      },
      required: ['scope', 'document_id'],
      additionalProperties: false,
    },
  },
]

const callTool = async (name, args) => {
  if (name === 'get_system_map') return getSystemMap()
  if (name === 'get_business_process_guide') return getBusinessProcessGuide()
  if (name === 'get_agent_action_policy') return getAgentActionPolicy()
  if (name === 'get_agent_configuration_guide') return getAgentConfigurationGuide()
  if (name === 'get_domain_registry') return getDomainRegistry()
  if (name === 'resolve_domain_term') return resolveDomainTerm(args || {})
  if (name === 'get_business_snapshot') return getBusinessSnapshot()
  if (name === 'get_catalog_health_summary') return getCatalogHealthSummary()
  if (name === 'get_open_contracts') return getOpenContracts(args || {})
  if (name === 'get_analytics_visualization') return getAnalyticsVisualization(args || {})
  if (name === 'search_business_objects') return searchBusinessObjects(args || {})
  if (name === 'get_business_object_timeline') return getBusinessObjectTimeline(args || {})
  if (name === 'get_rfq_timeline') return getRfqTimeline(args || {})
  if (name === 'find_tnved_assignment_candidates') {
    return findTnvedAssignmentCandidates(args || {})
  }
  if (name === 'list_tnved_codes_by_duty_rate') return listTnvedCodesByDutyRate(args || {})
  if (name === 'get_catalog_quality_queue') return getCatalogQualityQueue(args || {})
  if (name === 'explain_measurement_unit_usage') return explainMeasurementUnitUsage(args || {})
  if (name === 'list_system_documents') return listSystemDocuments(args || {})
  if (name === 'read_system_document') return readSystemDocument(args || {})
  throw new Error(`Неизвестный инструмент агента: ${name}`)
}

const openAiRequest = async (payload) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY не настроен на сервере')
    error.status = 503
    throw error
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI API вернул ошибку ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.details = data
    throw error
  }
  return data
}

const extractOutputText = (response) => {
  if (response?.output_text) return response.output_text
  const parts = []
  ;(response?.output || []).forEach((item) => {
    if (item.type !== 'message') return
    ;(item.content || []).forEach((content) => {
      if (content.type === 'output_text' && content.text) parts.push(content.text)
      if (content.type === 'text' && content.text) parts.push(content.text)
    })
  })
  return parts.join('\n').trim()
}

const extractToolCalls = (response) =>
  (response?.output || []).filter((item) => item.type === 'function_call')

const formatHistory = (history) => {
  if (!Array.isArray(history) || !history.length) return ''
  return history
    .slice(-8)
    .map((item) => {
      const role = item.role === 'assistant' ? 'Агент' : 'Пользователь'
      const text = String(item.content || '').trim().slice(0, 2000)
      return text ? `${role}: ${text}` : null
    })
    .filter(Boolean)
    .join('\n\n')
}

router.post('/chat', upload.array('files', 8), async (req, res) => {
  try {
    const message = String(req.body.message || '').trim()
    const historyRaw = String(req.body.history || '[]')
    const history = JSON.parse(historyRaw)
    const files = req.files || []

    if (!message && !files.length) {
      return res.status(400).json({ message: 'Введите сообщение или приложите файл' })
    }

    const { content: fileContent, summaries: attachments } = await prepareFilesForOpenAi(files)
    const userName = req.user?.full_name || req.user?.username || 'пользователь'
    const historyText = formatHistory(history)

    const input = [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            historyText ? `Контекст текущего диалога:\n${historyText}` : '',
            `Новый запрос пользователя:\n${
              message ||
              'Пользователь приложил файл без отдельного вопроса. Проанализируй файл и предложи, что можно сделать в системе.'
            }`,
          ].filter(Boolean).join('\n\n'),
        },
        ...fileContent,
      ],
    }]
    const charts = []
    const tables = []

    let response = await openAiRequest({
      model: DEFAULT_MODEL,
      instructions: [
        'Ты встроенный ИИ-агент системы Crusher Parts.',
        'Отвечай по-русски, кратко и практически.',
        'Система управляет клиентскими заявками, RFQ, поставщиками, OEM деталями, деталями поставщиков, классификатором, материалами, единицами измерения, KPI, КП, контрактами и заказами поставщикам.',
        USER_LANGUAGE_GUIDE,
        'Используй инструменты, если пользователь спрашивает про реальные данные системы, существующих клиентов, поставщиков, детали, качество каталогов или состояние процесса.',
        'Для обычных пользовательских вопросов выбирай бизнес-инструменты: search_business_objects и get_business_object_timeline. Не пытайся рассуждать через SQL-таблицы или колонки.',
        'Если пользователь спрашивает состояние конкретного RFQ, ответы поставщиков, выбор, КП, контракт или PO по RFQ, используй get_rfq_timeline.',
        'Если пользователь спрашивает про качество каталогов, нормализацию или незаполненный вес/габариты, используй get_catalog_quality_queue.',
        'Если пользователь спрашивает про единицы измерения, где используется единица или как пользоваться справочником единиц, используй explain_measurement_unit_usage.',
        'Если пользователь просит график, диаграмму, динамику, топ, распределение, статистику во времени или визуальный анализ данных, используй get_analytics_visualization. После вызова кратко объясни график и выводы.',
        'Если пользователь просит объяснить, как устроена система, где что находится, как работают каталоги или бизнес-процесс, используй get_system_map и get_business_process_guide.',
        'Если пользователь спрашивает, почему агент не понял запрос, как агент должен искать, чего ему не хватает или как настроить агента системно, используй get_agent_configuration_guide.',
        'Если пользователь спрашивает про путаницу названий, старые/новые сущности, таблицы, endpoint или говорит нечеткими словами, используй get_domain_registry или resolve_domain_term. Не угадывай техническое имя таблицы молча.',
        'Если пользователь просит посмотреть документ, чертеж, PDF, файл из карточки OEM детали или RFQ, сначала найди его через list_system_documents, затем скачай и приложи через read_system_document.',
        'Если пользователь просит создать, изменить, привязать или удалить данные, сначала используй get_agent_action_policy и сформируй черновик действий. Само выполнение будет добавлено отдельными подтверждаемыми инструментами.',
        'Если пользователь загрузил PDF, изображение, Excel, Word или CSV, извлеки смысл, перечисли найденные сущности, возможные совпадения в системе, пробелы и предложи следующий план действий.',
        'Пока не выполняй запись в базу данных. Если нужно создать или изменить записи, сформулируй блок "Предлагаемые действия" с конкретными полями и попроси пользователя подтвердить.',
        `Текущий пользователь: ${userName}.`,
      ].join('\n'),
      input,
      tools,
      tool_choice: 'auto',
    })

    const executedTools = []
    for (let step = 0; step < 4; step += 1) {
      const calls = extractToolCalls(response)
      if (!calls.length) break

      const toolOutputs = []
      const attachedDocumentContent = []
      for (const call of calls) {
        let args = {}
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {}
        } catch {
          args = {}
        }
        let output
        try {
          output = await callTool(call.name, args)
          executedTools.push({ name: call.name, arguments: args, ok: true })
        } catch (toolError) {
          output = {
            error: true,
            message:
              'Не удалось получить данные из системы. Скажи пользователю простыми словами, что проверка временно не удалась, без технических деталей.',
          }
          executedTools.push({
            name: call.name,
            arguments: args,
            ok: false,
            error: toolError.message || 'Инструмент агента вернул ошибку',
          })
        }
        if (Array.isArray(output?.__charts)) charts.push(...output.__charts)
        if (Array.isArray(output?.__tables)) tables.push(...output.__tables)
        const openAiContent = Array.isArray(output?.__openaiContent)
          ? output.__openaiContent
          : []
        if (openAiContent.length) {
          attachedDocumentContent.push({
            callName: call.name,
            content: openAiContent,
          })
          output = { ...output }
          delete output.__openaiContent
        }
        if (Array.isArray(output?.__charts) || Array.isArray(output?.__tables)) {
          output = { ...output }
          delete output.__charts
          delete output.__tables
        }
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(output),
        })
      }

      attachedDocumentContent.forEach((attachment) => {
        toolOutputs.push({
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                `Документ из системы загружен через ${attachment.callName}. ` +
                'Проанализируй приложенный файл в контексте запроса пользователя и данных инструмента.',
            },
            ...attachment.content,
          ],
        })
      })

      response = await openAiRequest({
        model: DEFAULT_MODEL,
        previous_response_id: response.id,
        input: toolOutputs,
        tools,
        tool_choice: 'auto',
      })
    }

    res.json({
      answer: extractOutputText(response) || 'Агент не вернул текстовый ответ.',
      model: DEFAULT_MODEL,
      attachments,
      tools: executedTools,
      charts,
      tables,
    })
  } catch (err) {
    console.error('POST /ai-agent/chat error:', {
      message: err.message,
      status: err.status,
    })
    res.status(err.status || 500).json({
      message: err.status === 413 ? 'Файл слишком большой' : err.message || 'Ошибка ИИ-агента',
    })
  }
})

module.exports = router
