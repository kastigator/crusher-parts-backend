// routes/originalPartDocuments.js
const express = require("express")
const router = express.Router()
const multer = require("multer")
const path = require("path")
const fs = require("fs/promises")

const db = require("../utils/db")
const { bucket, bucketName } = require("../utils/gcsClient")
const logActivity = require("../utils/logActivity")

/**
 * ВНИМАНИЕ:
 *  - Доступ (auth + requireTabAccess('/original-parts')) навешивается
 *    снаружи в routerIndex.js.
 *  - Здесь только бизнес-логика и работа с GCS.
 */

// --------- in-memory загрузка
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
})

// (необязательно) белый список типов — расширяй при необходимости
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel", // xls
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword", // doc
  "text/plain",
])

// helpers
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Попытка починить «кракозябры» ("ÐŸÐ»Ð¸Ñ‚Ð°...") без записи в БД.
 */
const fixFileName = (name) => {
  if (!name) return ""
  const s = String(name)
  try {
    const buf = Buffer.from(s, "latin1")
    const utf8 = buf.toString("utf8")
    if (utf8.includes("\uFFFD")) return s
    return utf8
  } catch {
    return s
  }
}

/* ============================================================
   GET /original-parts/:id/documents — список документов
============================================================ */
router.get("/original-parts/:id/documents", async (req, res) => {
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
      [id]
    )

    res.json(rows.map((r) => ({ ...r, file_name: fixFileName(r.file_name) })))
  } catch (e) {
    console.error("GET /original-parts/:id/documents error:", e)
    res.status(500).json({ message: "Ошибка сервера при получении документов" })
  }
})

/* ============================================================
   POST /original-parts/:id/documents — загрузка файла
   form-data: file, description
============================================================ */
router.post(
  "/original-parts/:id/documents",
  upload.single("file"),
  async (req, res) => {
    let tmpPath
    try {
      const id = toId(req.params.id)
      if (!id) return res.status(400).json({ message: "Некорректный id детали" })

      if (!bucket || !bucketName) {
        return res.status(500).json({ message: "GCS бакет не настроен на сервере" })
      }

      const file = req.file
      if (!file) return res.status(400).json({ message: "Файл не передан" })
      if (ALLOWED_TYPES.size && !ALLOWED_TYPES.has(file.mimetype)) {
        return res.status(415).json({ message: `Недопустимый тип файла: ${file.mimetype}` })
      }

      // проверяем, что деталь существует
      const [[part]] = await db.execute(
        "SELECT id, cat_number FROM original_parts WHERE id = ?",
        [id]
      )
      if (!part) return res.status(404).json({ message: "Деталь не найдена" })

      // 1) временно кладём в /tmp (нужна для bucket.upload)
      tmpPath = `/tmp/upload_${Date.now()}_${Math.random().toString(16).slice(2)}`
      await fs.writeFile(tmpPath, file.buffer)

      // 2) имя объекта в бакете
      const ext = path.extname(file.originalname) || ""
      const rawBase = path.basename(file.originalname, ext)
      const safeBase = rawBase.replace(/[^\w\-]+/g, "_")
      const objectPath = [
        "original-parts",
        String(id),
        `${Date.now()}_${safeBase}${ext}`,
      ]
        .map((seg) => encodeURIComponent(seg))
        .join("/")

      // 3) загружаем в GCS
      try {
        await bucket.upload(tmpPath, {
          destination: objectPath,
          resumable: false,
          metadata: { contentType: file.mimetype },
        })
      } catch (err) {
        console.error("GCS upload error:", {
          message: err.message,
          code: err.code,
          errors: err.errors,
        })
        return res.status(500).json({ message: "Ошибка загрузки файла в хранилище" })
      } finally {
        try {
          await fs.unlink(tmpPath)
        } catch {}
      }

      // 4) сохраняем запись в БД
      try {
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
        const description =
          typeof req.body.description === "string"
            ? req.body.description.trim() || null
            : null
        const uploadedBy = req.user?.id || null

        const [ins] = await db.execute(
          `
          INSERT INTO original_part_documents
            (original_part_id, file_name, file_type, file_size, file_url, description, uploaded_by)
          VALUES (?,?,?,?,?,?,?)
          `,
          [
            id,
            file.originalname, // исходное имя
            file.mimetype,
            file.size,
            publicUrl,
            description,
            uploadedBy,
          ]
        )

        // флаг наличия чертежа/документа
        await db.execute("UPDATE original_parts SET has_drawing = 1 WHERE id = ?", [id])

        const [[row]] = await db.execute(
          "SELECT * FROM original_part_documents WHERE id = ?",
          [ins.insertId]
        )

        await logActivity({
          req,
          action: "upload_document",
          entity_type: "original_parts",
          entity_id: id,
          comment: `Загружен документ "${fixFileName(file.originalname)}"`,
        })

        row.file_name = fixFileName(row.file_name)
        res.status(201).json(row)
      } catch (e) {
        console.error("DB save doc error:", e)
        res.status(500).json({ message: "Ошибка сохранения данных о документе" })
      }
    } catch (e) {
      console.error("POST /original-parts/:id/documents error:", e)
      res.status(500).json({ message: "Ошибка сервера при загрузке документа" })
    } finally {
      try {
        if (tmpPath) await fs.unlink(tmpPath)
      } catch {}
    }
  }
)

/* ============================================================
   DELETE /original-parts/documents/:docId — удалить документ
============================================================ */
router.delete("/original-parts/documents/:docId", async (req, res) => {
  try {
    const docId = toId(req.params.docId)
    if (!docId) return res.status(400).json({ message: "Некорректный id документа" })

    const [[doc]] = await db.execute(
      "SELECT * FROM original_part_documents WHERE id = ?",
      [docId]
    )
    if (!doc) return res.status(404).json({ message: "Документ не найден" })

    // удалить файл из GCS (если URL указывает на наш бакет)
    try {
      if (bucket && doc.file_url && doc.file_url.includes(bucket.name)) {
        const idx = doc.file_url.indexOf(bucket.name) + bucket.name.length + 1
        const objectPath = decodeURI(doc.file_url.substring(idx))
        await bucket.file(objectPath).delete({ ignoreNotFound: true })
      }
    } catch (gcsErr) {
      console.warn("Не удалось удалить файл из GCS:", gcsErr.message)
    }

    await db.execute("DELETE FROM original_part_documents WHERE id = ?", [docId])

    // обновить флаг has_drawing
    try {
      const [[{ cnt }]] = await db.execute(
        "SELECT COUNT(*) AS cnt FROM original_part_documents WHERE original_part_id = ?",
        [doc.original_part_id]
      )
      if (!cnt) {
        await db.execute("UPDATE original_parts SET has_drawing = 0 WHERE id = ?", [
          doc.original_part_id,
        ])
      }
    } catch (cntErr) {
      console.warn("Не удалось обновить has_drawing:", cntErr.message)
    }

    await logActivity({
      req,
      action: "delete_document",
      entity_type: "original_parts",
      entity_id: doc.original_part_id,
      comment: `Удалён документ "${fixFileName(doc.file_name)}"`,
    })

    res.json({ message: "Документ удалён" })
  } catch (e) {
    console.error("DELETE /original-parts/documents/:docId error:", e)
    res.status(500).json({ message: "Ошибка сервера при удалении документа" })
  }
})

/* ============================================================
   PUT /original-parts/documents/:docId — обновление описания
============================================================ */
router.put("/original-parts/documents/:docId", async (req, res) => {
  try {
    const docId = toId(req.params.docId)
    if (!docId) return res.status(400).json({ message: "Некорректный id документа" })

    const description =
      typeof req.body.description === "string" && req.body.description.trim()
        ? req.body.description.trim()
        : null

    const [[doc]] = await db.execute(
      "SELECT * FROM original_part_documents WHERE id = ?",
      [docId]
    )
    if (!doc) return res.status(404).json({ message: "Документ не найден" })

    await db.execute("UPDATE original_part_documents SET description = ? WHERE id = ?", [
      description,
      docId,
    ])

    await logActivity({
      req,
      action: "update_document",
      entity_type: "original_parts",
      entity_id: doc.original_part_id,
      comment: `Изменено описание документа "${fixFileName(doc.file_name)}"`,
    })

    const [[updated]] = await db.execute(
      "SELECT * FROM original_part_documents WHERE id = ?",
      [docId]
    )

    updated.file_name = fixFileName(updated.file_name)
    res.json(updated)
  } catch (e) {
    console.error("PUT /original-parts/documents/:docId error:", e)
    res.status(500).json({ message: "Ошибка сервера при обновлении документа" })
  }
})

module.exports = router
