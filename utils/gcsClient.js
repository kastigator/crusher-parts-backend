// utils/gcsClient.js
const { Storage } = require("@google-cloud/storage")

const bucketName = process.env.GCS_DOCS_BUCKET || ""

if (!bucketName) {
  console.warn(
    "[GCS] ВНИМАНИЕ: переменная GCS_DOCS_BUCKET не задана – загрузка документов работать не будет",
  )
}

// ⚠️ ЖЁСТКИЙ КОСТЫЛЬ:
// где бы ни была выставлена GOOGLE_APPLICATION_CREDENTIALS
// (dotenv, Docker, Cloud Run env vars) – мы её игнорируем.
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log(
    "[GCS] Удаляем GOOGLE_APPLICATION_CREDENTIALS, было =",
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  )
  try {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
  } catch {
    // на всякий случай, но по идее delete отработает
  }
}

// просто используем Application Default Credentials
console.log("[GCS] Инициализация Storage() через Application Default Credentials")
const storage = new Storage()

const bucket = bucketName ? storage.bucket(bucketName) : null

module.exports = {
  storage,
  bucket,
  bucketName,
}
