// utils/gcsClient.js
const { Storage } = require("@google-cloud/storage")

// Имя бакета берём из переменной окружения
const bucketName = process.env.GCS_DOCS_BUCKET

if (!bucketName) {
  console.warn(
    "⚠ GCS_DOCS_BUCKET не задан — загрузка документов работать не будет",
  )
}

// Cloud Run всегда выставляет K_SERVICE
const isCloudRun = !!process.env.K_SERVICE

let storage

if (isCloudRun) {
  // 🔹 В Cloud Run используем Application Default Credentials
  // (тот самый service account, который ты уже выдал на бакет)
  storage = new Storage()
} else {
  // 🔹 Локально — через файл ключа, как и раньше
  storage = new Storage({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
  })
}

const bucket = bucketName ? storage.bucket(bucketName) : null

module.exports = { storage, bucket, bucketName }
