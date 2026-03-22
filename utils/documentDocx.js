const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { Document, Packer } = require('docx')
const { bucket, bucketName } = require('./gcsClient')

const formatMoney = (value, currency = null) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(2)}${currency ? ` ${String(currency).toUpperCase()}` : ''}`
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

const createDocxBuffer = async (sections) => {
  const doc = new Document({ sections })
  return Packer.toBuffer(doc)
}

const uploadDocxBuffer = async ({ folder, fileName, buffer }) => {
  if (!bucket || !bucketName) {
    throw new Error('GCS бакет не настроен')
  }
  const tmpPath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(tmpPath, buffer)
  try {
    const destination = `${folder}/${fileName}`
    await bucket.upload(tmpPath, {
      destination,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      metadata: { cacheControl: 'private, max-age=0' },
    })
    return `https://storage.googleapis.com/${bucketName}/${destination}`
  } finally {
    try {
      await fs.unlink(tmpPath)
    } catch {}
  }
}

module.exports = {
  Document,
  createDocxBuffer,
  uploadDocxBuffer,
  formatMoney,
  formatDateRu,
  formatDateRuLong,
}
