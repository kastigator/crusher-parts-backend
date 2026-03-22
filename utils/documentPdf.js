const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const PDFDocument = require('pdfkit')
const { bucket, bucketName } = require('./gcsClient')

const FONT_REGULAR_CANDIDATES = [
  path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf'),
  path.resolve(__dirname, '..', '..', 'реквизиты ГОК', 'IBM_Plex_Sans,Inter', 'IBM_Plex_Sans', 'static', 'IBMPlexSans-Regular.ttf'),
]
const FONT_BOLD_CANDIDATES = [
  path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSans-Bold.ttf'),
  path.resolve(__dirname, '..', '..', 'реквизиты ГОК', 'IBM_Plex_Sans,Inter', 'IBM_Plex_Sans', 'static', 'IBMPlexSans-Bold.ttf'),
]
const LOGO_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'реквизиты ГОК', 'GOK_Logo', 'PNG', 'GOK_Logo_Cobalt_Blue.png'),
]

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

const pickExisting = async (candidates) => {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  return null
}

const formatMoney = (value, currency = null) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(2)}${currency ? ` ${String(currency).toUpperCase()}` : ''}`
}

const formatDate = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().slice(0, 10)
}

const formatDateRu = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('ru-RU').format(date)
}

const formatDateRuLong = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(date)
}

const createPdfBuffer = async (renderFn) => {
  const doc = new PDFDocument({ margin: 48, size: 'A4' })
  const regularFont = await pickExisting(FONT_REGULAR_CANDIDATES)
  const boldFont = await pickExisting(FONT_BOLD_CANDIDATES)
  if (regularFont) doc.registerFont('regular', regularFont)
  if (boldFont) doc.registerFont('bold', boldFont)

  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  await renderFn(doc, {
    regularFont,
    boldFont,
    logoPath: await pickExisting(LOGO_CANDIDATES),
    formatMoney,
    formatDate,
  })
  doc.end()
  return done
}

const uploadPdfBuffer = async ({ folder, fileName, buffer }) => {
  if (!bucket || !bucketName) {
    throw new Error('GCS бакет не настроен')
  }
  const tmpPath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(tmpPath, buffer)
  try {
    const destination = `${folder}/${fileName}`
    await bucket.upload(tmpPath, {
      destination,
      contentType: 'application/pdf',
      metadata: { cacheControl: 'private, max-age=0' },
    })
    return `https://storage.googleapis.com/${bucketName}/${destination}`
  } finally {
    try {
      await fs.unlink(tmpPath)
    } catch {}
  }
}

const beginDocument = (doc, { title, subtitle, logoPath, boldFont, regularFont }) => {
  if (logoPath) {
    try {
      doc.image(logoPath, 48, 34, { fit: [120, 42] })
    } catch {}
  }
  doc.font(boldFont ? 'bold' : 'Helvetica-Bold').fontSize(18).fillColor('#163A70').text(title, 48, 92)
  if (subtitle) {
    doc.moveDown(0.4)
    doc.font(regularFont ? 'regular' : 'Helvetica').fontSize(10).fillColor('#444').text(subtitle)
  }
  doc.moveDown(1.2)
  doc.strokeColor('#d9d9d9').moveTo(48, doc.y).lineTo(547, doc.y).stroke()
  doc.moveDown(0.8)
}

const drawFieldGrid = (doc, fields, { regularFont, boldFont } = {}) => {
  fields.forEach(({ label, value }) => {
    doc.font(boldFont ? 'bold' : 'Helvetica-Bold').fontSize(10).fillColor('#222').text(`${label}: `, { continued: true })
    doc.font(regularFont ? 'regular' : 'Helvetica').fontSize(10).fillColor('#222').text(value ?? '—')
  })
  doc.moveDown(0.6)
}

const drawSimpleTable = (doc, columns, rows, { regularFont, boldFont } = {}) => {
  const startX = 48
  let y = doc.y
  const widths = columns.map((col) => col.width)

  const drawRow = (values, isHeader = false) => {
    let x = startX
    const height = 18
    values.forEach((value, index) => {
      doc
        .font(isHeader && boldFont ? 'bold' : regularFont ? 'regular' : 'Helvetica')
        .fontSize(isHeader ? 9.5 : 9)
        .fillColor(isHeader ? '#163A70' : '#222')
        .text(String(value ?? '—'), x, y, { width: widths[index], ellipsis: true })
      x += widths[index]
    })
    y += height
    if (y > 760) {
      doc.addPage()
      y = 48
    }
  }

  drawRow(columns.map((col) => col.title), true)
  rows.forEach((row) => drawRow(columns.map((col) => row[col.key])))
  doc.y = y + 4
}

module.exports = {
  createPdfBuffer,
  uploadPdfBuffer,
  beginDocument,
  drawFieldGrid,
  drawSimpleTable,
  formatMoney,
  formatDate,
  formatDateRu,
  formatDateRuLong,
}
