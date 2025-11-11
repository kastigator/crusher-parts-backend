// utils/gcsClient.js
const { Storage } = require("@google-cloud/storage");

const bucketName = process.env.GCS_DOCS_BUCKET;

let storage = null;
let bucket = null;

try {
  if (!bucketName) {
    console.warn("[GCS] Переменная GCS_DOCS_BUCKET не задана — бакет недоступен");
  } else {
    // Никаких keyFilename и google-credentials.json!
    // Везде (и локально, и в Cloud Run) используем Application Default Credentials.
    storage = new Storage();
    bucket = storage.bucket(bucketName);

    console.log(`[GCS] Инициализирован бакет "${bucketName}"`);
  }
} catch (err) {
  console.error("[GCS] Ошибка инициализации GCS:", err);
}

module.exports = {
  storage,
  bucket,
  bucketName,
};
