// utils/gcsClient.js
const { Storage } = require("@google-cloud/storage")

const bucketName = process.env.GCS_DOCS_BUCKET || null

let storage = null
let bucket = null

try {
  // ⚙️ Определяем, внутри ли мы Cloud Run
  const isCloudRun = !!process.env.K_SERVICE

  if (!bucketName) {
    console.warn("[GCS] env GCS_DOCS_BUCKET не задан – загрузка документов отключена")
  }

  if (isCloudRun) {
    // 🔹 В Cloud Run КРЕДЫ БЕРЁМ ИЗ service account (IAM), никаких файлов!
    console.log("[GCS] Cloud Run режим – используем Application Default Credentials")
    storage = new Storage() // без параметров
  } else {
    // 🔹 Локально тоже можно без keyFilename, если ты залогинен через `gcloud auth application-default login`.
    // Если хочешь — можешь здесь оставить keyFilename, но ОЧЕНЬ важно,
    // чтобы в Cloud Run эта ветка НИКОГДА не выполнялась.
    console.log("[GCS] Локальный режим – используем Application Default Credentials")
    storage = new Storage()
  }

  if (bucketName && storage) {
    bucket = storage.bucket(bucketName)
    console.log(`[GCS] Инициализирован бакет "${bucketName}"`)
  }
} catch (err) {
  console.error("[GCS] Ошибка инициализации:", err.message || err)
  storage = null
  bucket = null
}

module.exports = {
  storage,
  bucket,
  bucketName,
}
