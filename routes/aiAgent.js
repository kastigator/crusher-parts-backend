const express = require('express')
const multer = require('multer')
const {
  getBusinessSnapshot,
  getCatalogHealthSummary,
  getOpenContracts,
  findTnvedAssignmentCandidates,
  searchSystemRecords,
} = require('../utils/aiAgentContext')
const {
  getSystemMap,
  getBusinessProcessGuide,
  getAgentActionPolicy,
} = require('../utils/aiAgentDomainContext')
const { prepareFilesForOpenAi } = require('../utils/aiAgentFiles')

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
- "Стандартные детали" = центральная каноническая сущность для болтов, крепежа, электродвигателей и прочих типовых изделий; через нее связываются OEM и поставщицкие представления.
- "Классификатор оборудования" = дерево типов техники и узлов, к которым привязываются модели оборудования.
- "Материалы" = справочник материалов.
- "Единицы измерения" = справочник допустимых единиц: шт, кг, см и т.д.
- "Качество каталогов" = обзор проблем нормализации: нет классификатора, нет связи со standard part, нет веса/габаритов, нет полей класса.

Синонимы и живая речь пользователей:
- "каталожный номер", "каталожник", "номер детали", "номер позиции", "парт номер", "part number", "артикул" обычно означают номер OEM детали или детали поставщика.
- "оригиналка", "оригинальная", "OEM", "ОЕМ", "оэм" обычно означают OEM деталь.
- "поставщицкая", "позиция поставщика", "номер поставщика", "аналог поставщика" обычно означают деталь поставщика.
- "стандартная", "типовая", "крепеж", "болт", "гайка", "электродвигатель" часто относятся к стандартным деталям.
- "таможенный код", "код таможни", "ТНВЭД", "ТН ВЭД", "tnved", "hs code", "код пошлины" означают код ТН ВЭД.
- "весогабариты", "массо-габаритные", "логистика", "вес и размеры", "габариты" означают вес и длину/ширину/высоту.
- "заявка", "заявка клиента", "запрос клиента", "потребность клиента", "PDF от клиента" обычно означает клиентскую заявку.
- "закупка", "опрос поставщиков", "разослать поставщикам", "запрос цен" обычно означает RFQ.
- "КП", "коммерческое", "предложение клиенту" означает коммерческое предложение.
- "контракт", "договор", "незакрытые контракты", "открытые контракты" означает клиентские контракты в работе.
- "заказ поставщику", "PO", "покупной заказ" означает заказ поставщику.

Правила языка:
- Не показывай пользователю имена таблиц и колонок, если он сам не просит технические детали.
- Когда инструмент вернул type вроде oem_part или supplier_part, переведи это в понятный тип: "OEM деталь", "деталь поставщика", "стандартная деталь", "клиент", "поставщик", "материал".
- Если нужно сослаться на место в интерфейсе, называй раздел меню: "Каталоги -> OEM детали", "Каталоги -> Детали поставщиков", "RFQ Workspace".
- Если пользователь говорит неточно, сначала сделай разумную интерпретацию и явно напиши "Я понял это так: ...".
- Если есть 2-3 возможных смысла, не угадывай молча: перечисли варианты и предложи самый вероятный следующий шаг.
- Для действий с изменением данных всегда показывай найденные совпадения и черновик изменений перед выполнением.
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
    name: 'get_business_snapshot',
    description:
      'Получить краткую сводку по системе: количество клиентов, поставщиков, деталей, заявок, RFQ и последние записи.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_catalog_health_summary',
    description:
      'Получить сводку качества каталогов: отсутствующие классификаторы, связи standard part, вес/габариты и примеры очередей нормализации.',
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
    name: 'search_system_records',
    description:
      'Искать записи в справочниках системы по строке: клиенты, поставщики, OEM детали, детали поставщиков, standard parts, материалы, коды ТН ВЭД. Поддерживает обычные номера и номера без пробелов/дефисов.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Строка поиска' },
        limit: { type: 'number', description: 'Лимит результатов на сущность' },
      },
      required: ['query'],
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
]

const callTool = async (name, args) => {
  if (name === 'get_system_map') return getSystemMap()
  if (name === 'get_business_process_guide') return getBusinessProcessGuide()
  if (name === 'get_agent_action_policy') return getAgentActionPolicy()
  if (name === 'get_business_snapshot') return getBusinessSnapshot()
  if (name === 'get_catalog_health_summary') return getCatalogHealthSummary()
  if (name === 'get_open_contracts') return getOpenContracts(args || {})
  if (name === 'search_system_records') return searchSystemRecords(args || {})
  if (name === 'find_tnved_assignment_candidates') {
    return findTnvedAssignmentCandidates(args || {})
  }
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

    let response = await openAiRequest({
      model: DEFAULT_MODEL,
      instructions: [
        'Ты встроенный ИИ-агент системы Crusher Parts.',
        'Отвечай по-русски, кратко и практически.',
        'Система управляет клиентскими заявками, RFQ, поставщиками, OEM деталями, деталями поставщиков, standard parts, материалами, единицами измерения, KPI, КП, контрактами и заказами поставщикам.',
        USER_LANGUAGE_GUIDE,
        'Используй инструменты, если пользователь спрашивает про реальные данные системы, существующих клиентов, поставщиков, детали, качество каталогов или состояние процесса.',
        'Если пользователь просит объяснить, как устроена система, где что находится, как работают каталоги или бизнес-процесс, используй get_system_map и get_business_process_guide.',
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
            message: toolError.message || 'Инструмент агента вернул ошибку',
          }
          executedTools.push({
            name: call.name,
            arguments: args,
            ok: false,
            error: output.message,
          })
        }
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(output),
        })
      }

      response = await openAiRequest({
        model: DEFAULT_MODEL,
        previous_response_id: response.id,
        input: toolOutputs,
      })
    }

    res.json({
      answer: extractOutputText(response) || 'Агент не вернул текстовый ответ.',
      model: DEFAULT_MODEL,
      attachments,
      tools: executedTools,
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
