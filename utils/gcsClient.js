// utils/gcsClient.js
const { Storage } = require("@google-cloud/storage")

const bucketName = process.env.GCS_DOCS_BUCKET

if (!bucketName) {
  console.warn("⚠ GCS_DOCS_BUCKET не задан в .env — загрузка документов работать не будет")
}

const storage = new Storage({
  // локально используем GOOGLE_APPLICATION_CREDENTIALS (путь к json)
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
})

const bucket = bucketName ? storage.bucket(bucketName) : null

module.exports = { storage, bucket, bucketName }
