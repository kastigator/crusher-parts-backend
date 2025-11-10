// routes/originalPartDocuments.js
const express = require("express")
const router = express.Router()
const multer = require("multer")
const path = require("path")

const db = require("../utils/db")
const auth = require("../middleware/authMiddleware")
const adminOnly = require("../middleware/adminOnly")
const { bucket, bucketName } = require("../utils/gcsClient")
const logActivity = require("../utils/logActivity")

// in-memory загрузка (без сохранения на диск)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
})

// маленький helper
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/* ============================================================
   GET /original-parts/:id/documents
   Список документов по детали
============================================================ */
router.get("/original-parts/:id/documents", auth, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: "Некорректный id детали" })

    const [rows] = await db.execute(
      `
      SELECT
        d.id,
        d.original_part_id,
        d.file_name,
        d.file_type,
        d.file_size,
        d.file_url,
        d.description,
        d.uploaded_by,
        d.uploaded_at
      FROM original_part_documents d
      WHERE d.original_part_id = ?
      ORDER BY d.uploaded_at DESC, d.id DESC
      `,
      [id],
    )

    res.json(rows)
  } catch (e) {
    console.error("GET /original-parts/:id/documents error:", e)
    res.status(500).json({ message: "Ошибка сервера" })
  }
})

/* ============================================================
   POST /original-parts/:id/documents
   Загрузка файла
   form-data: file, description
============================================================ */
router.post(
  "/original-parts/:id/documents",
  auth,
  adminOnly,
  upload.single("file"),
  async (req, res) => {
    try {
      const id = toId(req.params.id)
      if (!id) return res.status(400).json({ message: "Некорректный id детали" })

      if (!bucket) {
        return res
          .status(500)
          .json({ message: "GCS бакет не настроен на сервере" })
      }

      const file = req.file
      if (!file) return res.status(400).json({ message: "Файл не передан" })

      // проверяем, что деталь существует
      const [[part]] = await db.execute(
        "SELECT id, cat_number FROM original_parts WHERE id = ?",
        [id],
      )
      if (!part) return res.status(404).json({ message: "Деталь не найдена" })

      const ext = path.extname(file.originalname) || ""
      const safeName = path
        .basename(file.originalname, ext)
        .replace(/[^\w\-]+/g, "_")
      const gcsFileName = `original-parts/${id}/${Date.now()}_${safeName}${ext}`

      const gcsFile = bucket.file(gcsFileName)

      const stream = gcsFile.createWriteStream({
        resumable: false,
        contentType: file.mimetype,
      })

      stream.on("error", (err) => {
        console.error("GCS upload error:", err)
        return res.status(500).json({ message: "Ошибка загрузки файла" })
      })

      stream.on("finish", async () => {
        try {
          // публичный URL (если бакет открыт для чтения)
          const publicUrl = `https://storage.googleapis.com/${bucketName}/${encodeURI(
            gcsFileName,
          )}`

          const description = req.body.description || null
          const uploadedBy = req.user?.id || null

          const [ins] = await db.execute(
            `
            INSERT INTO original_part_documents
              (original_part_id, file_name, file_type, file_size, file_url, description, uploaded_by)
            VALUES (?,?,?,?,?,?,?)
            `,
            [
              id,
              file.originalname,
              file.mimetype,
              file.size,
              publicUrl,
              description,
              uploadedBy,
            ],
          )

          const [[row]] = await db.execute(
            "SELECT * FROM original_part_documents WHERE id = ?",
            [ins.insertId],
          )

          await logActivity({
            req,
            action: "upload_document",
            entity_type: "original_parts",
            entity_id: id,
            comment: `Загружен документ "${file.originalname}"`,
          })

          res.status(201).json(row)
        } catch (e) {
          console.error("DB save doc error:", e)
          res.status(500).json({ message: "Ошибка сохранения документа" })
        }
      })

      stream.end(file.buffer)
    } catch (e) {
      console.error("POST /original-parts/:id/documents error:", e)
      res.status(500).json({ message: "Ошибка сервера" })
    }
  },
)

/* ============================================================
   DELETE /original-parts/documents/:docId
============================================================ */
router.delete(
  "/original-parts/documents/:docId",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const docId = toId(req.params.docId)
      if (!docId) return res.status(400).json({ message: "Некорректный id документа" })

      const [[doc]] = await db.execute(
        "SELECT * FROM original_part_documents WHERE id = ?",
        [docId],
      )
      if (!doc) return res.status(404).json({ message: "Документ не найден" })

      // удаляем файл из GCS, если можем
      try {
        if (bucket && doc.file_url && doc.file_url.includes(bucket.name)) {
          // получаем путь внутри бакета
          const idx = doc.file_url.indexOf(bucket.name) + bucket.name.length + 1
          const objectPath = decodeURI(doc.file_url.substring(idx))
          await bucket.file(objectPath).delete({ ignoreNotFound: true })
        }
      } catch (gcsErr) {
        console.warn("Не удалось удалить файл из GCS:", gcsErr.message)
      }

      await db.execute("DELETE FROM original_part_documents WHERE id = ?", [
        docId,
      ])

      await logActivity({
        req,
        action: "delete_document",
        entity_type: "original_parts",
        entity_id: doc.original_part_id,
        comment: `Удалён документ "${doc.file_name}"`,
      })

      res.json({ message: "Документ удалён" })
    } catch (e) {
      console.error("DELETE /original-parts/documents/:docId error:", e)
      res.status(500).json({ message: "Ошибка сервера" })
    }
  },
)

module.exports = router
