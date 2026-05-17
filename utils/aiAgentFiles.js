const path = require('path')
const XLSX = require('xlsx')
const mammoth = require('mammoth')

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'application/csv',
  'application/json',
  'text/markdown',
])

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
])

const PDF_MIME_TYPES = new Set(['application/pdf'])

const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv'])
const WORD_EXTENSIONS = new Set(['.docx'])

const trimText = (value, max = 12000) => {
  const text = String(value || '').replace(/\u0000/g, '').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[Текст файла обрезан до ${max} символов]`
}

const workbookToText = (buffer, filename) => {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const chunks = [`Файл Excel/CSV: ${filename}`]
  workbook.SheetNames.slice(0, 8).forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' })
    chunks.push(`\nЛист: ${sheetName}`)
    rows.slice(0, 80).forEach((row, index) => {
      const line = row.map((cell) => String(cell || '').trim()).join(' | ').trim()
      if (line) chunks.push(`${index + 1}: ${line}`)
    })
    if (rows.length > 80) chunks.push(`[Показаны первые 80 строк из ${rows.length}]`)
  })
  return trimText(chunks.join('\n'), 20000)
}

const wordToText = async (buffer, filename) => {
  const result = await mammoth.extractRawText({ buffer })
  return trimText(`Файл Word: ${filename}\n\n${result.value || ''}`, 20000)
}

const prepareFilesForOpenAi = async (files = []) => {
  const content = []
  const summaries = []

  for (const file of files) {
    const filename = file.originalname || 'attachment'
    const mimeType = file.mimetype || 'application/octet-stream'
    const ext = path.extname(filename).toLowerCase()
    const base64 = file.buffer.toString('base64')

    summaries.push({
      filename,
      mime_type: mimeType,
      size: file.size,
    })

    if (PDF_MIME_TYPES.has(mimeType) || ext === '.pdf') {
      content.push({
        type: 'input_file',
        filename,
        file_data: `data:${mimeType};base64,${base64}`,
      })
      continue
    }

    if (IMAGE_MIME_TYPES.has(mimeType)) {
      content.push({
        type: 'input_image',
        image_url: `data:${mimeType};base64,${base64}`,
      })
      continue
    }

    if (EXCEL_EXTENSIONS.has(ext)) {
      content.push({
        type: 'input_text',
        text: workbookToText(file.buffer, filename),
      })
      continue
    }

    if (WORD_EXTENSIONS.has(ext)) {
      content.push({
        type: 'input_text',
        text: await wordToText(file.buffer, filename),
      })
      continue
    }

    if (TEXT_MIME_TYPES.has(mimeType)) {
      content.push({
        type: 'input_text',
        text: trimText(`Файл: ${filename}\n\n${file.buffer.toString('utf8')}`, 20000),
      })
      continue
    }

    content.push({
      type: 'input_text',
      text: `Файл ${filename} (${mimeType}) загружен, но этот формат пока не удалось прочитать. Попроси пользователя уточнить содержимое или загрузить PDF, изображение, Excel, CSV, DOCX или TXT.`,
    })
  }

  return { content, summaries }
}

module.exports = {
  prepareFilesForOpenAi,
}
