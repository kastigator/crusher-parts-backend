// utils/gcsClient.js
const { Storage } = require("@google-cloud/storage")

// Имя бакета берём из переменной окружения
const bucketName = process.env.GCS_DOCS_BUCKET || ""

if (!bucketName) {
  console.warn("[GCS] ВНИМАНИЕ: переменная GCS_DOCS_BUCKET не задана – загрузка документов не будет работать")
}

const isProd = process.env.NODE_ENV === "production"

// ⚠️ Костыль: на всякий случай вырубаем GOOGLE_APPLICATION_CREDENTIALS,
// чтобы @google-cloud/storage НЕ пытался искать ./google-credentials.json
if (isProd && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log(
    "[GCS] Cloud Run: игнорируем GOOGLE_APPLICATION_CREDENTIALS =", 
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  )
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS
}

let storage

if (isProd) {
  // В Cloud Run используем встроенные сервисные креды
  console.log("[GCS] Cloud Run – используем встроенные сервисные креды (Application Default Credentials)")
  storage = new Storage()
} else {
  // Локально тоже ADC (gcloud auth application-default login), как раньше
  console.log("[GCS] Локальный режим – используем Application Default Credentials")
  storage = new Storage()
}

// Если бакета нет – экспортируем null, роут это уже проверяет
const bucket = bucketName ? storage.bucket(bucketName) : null

module.exports = {
  storage,
  bucket,
  bucketName,
}
