// utils/gcsClient.js
const { Storage } = require('@google-cloud/storage')
const logger = require('./logger')

const bucketName = process.env.GCS_DOCS_BUCKET || ''

if (!bucketName) {
  logger.warn(
    '[GCS] Внимание: переменная GCS_DOCS_BUCKET не задана — загрузка файлов работать не будет'
  )
}

// Не трогаем GOOGLE_APPLICATION_CREDENTIALS:
// если указано в env, используем keyFilename; иначе — ADC.
const storageOptions = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS }
  : {}

if (storageOptions.keyFilename) {
  logger.debug('[GCS] Используем key file из GOOGLE_APPLICATION_CREDENTIALS')
} else {
  logger.debug('[GCS] Инициализация Storage() через Application Default Credentials')
}

const storage = new Storage(storageOptions)
const bucket = bucketName ? storage.bucket(bucketName) : null

module.exports = {
  storage,
  bucket,
  bucketName,
}
