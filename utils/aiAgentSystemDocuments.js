const db = require('./db')
const { bucket, bucketName } = require('./gcsClient')
const { prepareFileBufferForOpenAi } = require('./aiAgentFiles')

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

const toId = (value) => {
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : null
}

const normalizeScope = (value) => {
  const scope = String(value || '').trim().toLowerCase()
  if (['catalog_position', 'catalog_positions', 'bom_item', 'equipment_model_bom_item'].includes(scope)) {
    return 'catalog_position'
  }
  if (['rfq', 'rfqs'].includes(scope)) return 'rfq'
  return scope
}

const safeLimit = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 10
  return Math.min(Math.trunc(n), 30)
}

const extractObjectPath = (fileUrl) => {
  const raw = String(fileUrl || '').trim()
  if (!raw) return ''

  try {
    const url = new URL(raw)
    if (url.hostname === 'storage.googleapis.com') {
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] === bucketName) return parts.slice(1).map(decodeURIComponent).join('/')
    }
    if (url.hostname.endsWith('.storage.googleapis.com')) {
      return url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/')
    }
  } catch {}

  return raw
    .replace(/^gs:\/\/[^/]+\//, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
    .join('/')
}

const mapRfqDocument = (row) => ({
  scope: 'rfq',
  document_id: row.id,
  entity_id: row.rfq_id,
  entity_label: row.rfq_number || `RFQ #${row.rfq_id}`,
  document_type: row.document_type,
  supplier_name: row.supplier_name,
  file_name: row.file_name,
  file_type: row.file_type,
  file_size: row.file_size,
  created_at: row.created_at,
})

const listSystemDocuments = async ({ scope, entity_id, query, limit } = {}) => {
  const normalizedScope = normalizeScope(scope)
  const id = toId(entity_id)
  const q = String(query || '').trim()
  const maxRows = safeLimit(limit)

  if (normalizedScope === 'catalog_position') {
    return {
      scope: normalizedScope,
      documents: [],
      note: 'Документы позиций каталога будут подключены отдельным блоком карточки позиции. Старый OEM-документооборот удален.',
    }
  }

  if (normalizedScope === 'rfq') {
    const params = []
    const where = []
    if (id) {
      where.push('d.rfq_id = ?')
      params.push(id)
    }
    if (q) {
      where.push('(d.file_name LIKE ? OR d.document_type LIKE ? OR r.rfq_number LIKE ? OR ps.name LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }
    if (!where.length) where.push('1 = 1')

    const [rows] = await db.execute(
      `
      SELECT d.id,
             d.rfq_id,
             d.document_type,
             d.file_name,
             d.file_type,
             d.file_size,
             d.created_at,
             r.rfq_number,
             ps.name AS supplier_name
        FROM rfq_documents d
        JOIN rfqs r ON r.id = d.rfq_id
        LEFT JOIN rfq_suppliers rs ON rs.id = d.rfq_supplier_id
        LEFT JOIN part_suppliers ps ON ps.id = rs.supplier_id
       WHERE ${where.join(' AND ')}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ${maxRows}
      `,
      params
    )
    return {
      scope: normalizedScope,
      documents: rows.map(mapRfqDocument),
      note: 'Чтобы проанализировать файл, вызови read_system_document с scope и document_id.',
    }
  }

  return {
    scope: normalizedScope || null,
    documents: [],
    note: 'Пока поддержаны документы RFQ. Документы позиций каталога будут подключены в карточке позиции.',
  }
}

const getDocumentRecord = async (scope, documentId) => {
  if (scope === 'rfq') {
    const [[row]] = await db.execute(
      `
      SELECT d.*,
             r.rfq_number,
             ps.name AS supplier_name
        FROM rfq_documents d
        JOIN rfqs r ON r.id = d.rfq_id
        LEFT JOIN rfq_suppliers rs ON rs.id = d.rfq_supplier_id
        LEFT JOIN part_suppliers ps ON ps.id = rs.supplier_id
       WHERE d.id = ?
       LIMIT 1
      `,
      [documentId]
    )
    if (!row) return null
    return {
      scope,
      metadata: mapRfqDocument(row),
      file_url: row.file_url,
    }
  }

  return null
}

const readSystemDocument = async ({ scope, document_id } = {}) => {
  const normalizedScope = normalizeScope(scope)
  const documentId = toId(document_id)
  if (!documentId) throw new Error('Укажите document_id документа')
  if (!bucket || !bucketName) throw new Error('GCS бакет не настроен на сервере')

  const record = await getDocumentRecord(normalizedScope, documentId)
  if (!record) throw new Error('Документ не найден')
  if (!record.file_url) throw new Error('У документа нет ссылки на файл в бакете')

  const objectPath = extractObjectPath(record.file_url)
  if (!objectPath) throw new Error('Не удалось определить путь файла в бакете')

  const fileSize = Number(record.metadata.file_size || 0)
  if (fileSize > MAX_DOCUMENT_BYTES) {
    throw new Error('Документ больше 20 МБ, агент пока не анализирует такие файлы')
  }

  const [buffer] = await bucket.file(objectPath).download()
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error('Документ больше 20 МБ, агент пока не анализирует такие файлы')
  }

  const openAiContent = await prepareFileBufferForOpenAi({
    originalname: record.metadata.file_name || `document-${documentId}`,
    mimetype: record.metadata.file_type || 'application/octet-stream',
    size: buffer.length,
    buffer,
  })

  return {
    ...record.metadata,
    bucket: bucketName,
    object_path: objectPath,
    downloaded_size: buffer.length,
    analysis_hint: 'Документ приложен к следующему шагу модели. Проанализируй его содержимое и ответь пользователю.',
    __openaiContent: openAiContent,
  }
}

module.exports = {
  listSystemDocuments,
  readSystemDocument,
}
