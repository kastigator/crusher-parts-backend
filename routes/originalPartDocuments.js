// routes/originalPartDocuments.js
const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs/promises')
const os = require('os')

const db = require('../utils/db')
const { bucket, bucketName } = require('../utils/gcsClient')
const logActivity = require('../utils/logActivity')
const { createTrashEntry } = require('../utils/trashStore')
const DOCUMENTS_TABLE = 'oem_part_documents'

/**
 * Ограничения:
 *  - авторизация (auth + requireTabAccess('/original-parts')) подключена
 *    выше в routerIndex.js.
 *  - файлы хранятся в GCS.
 */

// --------- in-memory загрузка
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
})

// (опционально) жёсткий список MIME - можно расширять
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/tiff',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // doc
  'text/plain',
])

// helpers
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function resolveOemPartId(rawId) {
  const id = toId(rawId)
  if (!id) return null

  const [[oem]] = await db.execute('SELECT id, part_number AS cat_number FROM oem_parts WHERE id = ?', [id])
  return oem || null
}

/**
 * Попытка раскодировать <кракозябры> ("?Y?>??N'?...") если пришли в ISO-8859-1.
 */
const fixFileName = (name) => {
  if (!name) return ''
  const s = String(name)
  try {
    const buf = Buffer.from(s, 'latin1')
    const utf8 = buf.toString('utf8')
    if (utf8.includes('\uFFFD')) return s
    return utf8
  } catch {
    return s
  }
}

/* ============================================================
   GET /api/original-parts/:id/documents - список документов
   (роут подключается из /original-parts)
============================================================ */
router.get('/:id/documents', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Неверный идентификатор детали' })

    const oemPart = await resolveOemPartId(id)
    if (!oemPart) return res.status(404).json({ message: 'Деталь не найдена' })

    const [rows] = await db.execute(
      `
      SELECT
        d.id,
        d.oem_part_id AS original_part_id,
        d.file_name,
        d.file_type,
        d.file_size,
        d.file_url,
        d.description,
        d.uploaded_by,
        d.uploaded_at
      FROM oem_part_documents d
      WHERE d.oem_part_id = ?
      ORDER BY d.uploaded_at DESC, d.id DESC
      `,
      [oemPart.id]
    )

    res.json(rows.map((r) => ({ ...r, file_name: fixFileName(r.file_name) })))
  } catch (e) {
    console.error('GET /original-parts/:id/documents error:', e)
    res.status(500).json({ message: 'Ошибка запроса на получение документов' })
  }
})

/* ============================================================
   POST /api/original-parts/:id/documents - загрузка файла
   form-data: file, description
============================================================ */
router.post('/:id/documents', upload.single('file'), async (req, res) => {
  let tmpPath
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Неверный идентификатор детали' })

    if (!bucket || !bucketName) {
      return res.status(500).json({ message: 'GCS бакет не настроен на сервере' })
    }

    const file = req.file
    if (!file) return res.status(400).json({ message: 'Файл не загружен' })
    if (ALLOWED_TYPES.size && !ALLOWED_TYPES.has(file.mimetype)) {
      return res
        .status(415)
        .json({ message: `Недопустимый MIME файла: ${file.mimetype}` })
    }

    // Проверяем, что деталь существует
    const part = await resolveOemPartId(id)
    if (!part) return res.status(404).json({ message: 'Деталь не найдена' })

    // 1) Сохраняем файл во временную папку (нужен путь для bucket.upload)
    const tmpDir = path.join(os.tmpdir(), 'original-part-docs')
    await fs.mkdir(tmpDir, { recursive: true })
    tmpPath = path.join(
      tmpDir,
      `upload_${Date.now()}_${Math.random().toString(16).slice(2)}`
    )
    await fs.writeFile(tmpPath, file.buffer)

    // 2) Формируем путь в бакете
    const ext = path.extname(file.originalname) || ''
    const rawBase = path.basename(file.originalname, ext)
    const safeBase = rawBase.replace(/[^\w\-]+/g, '_')
    const objectPath = ['original-parts', String(id), `${Date.now()}_${safeBase}${ext}`]
      .map((seg) => encodeURIComponent(seg))
      .join('/')

    // 3) Загружаем в GCS
    try {
      await bucket.upload(tmpPath, {
        destination: objectPath,
        resumable: false,
        metadata: { contentType: file.mimetype },
      })
    } catch (err) {
      const credsMissing =
        typeof err?.message === 'string' &&
        err.message.toLowerCase().includes('could not load the default credentials')

      console.error('GCS upload error:', {
        message: err.message,
        code: err.code,
        errors: err.errors,
      })
      return res.status(500).json({
        message: credsMissing
          ? 'GCS credentials missing'
          : 'Ошибка загрузки файла в хранилище',
      })
    } finally {
      try {
        await fs.unlink(tmpPath)
      } catch {}
    }

    // 4) Сохраняем запись в БД
    try {
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
      const description =
        typeof req.body.description === 'string'
          ? req.body.description.trim() || null
          : null
      const uploadedBy = req.user?.id || null

      const [ins] = await db.execute(
        `
        INSERT INTO oem_part_documents
          (oem_part_id, file_name, file_type, file_size, file_url, description, uploaded_by)
        VALUES (?,?,?,?,?,?,?)
        `,
        [
          part.id,
          file.originalname, // сохраняем исходное имя
          file.mimetype,
          file.size,
          publicUrl,
          description,
          uploadedBy,
        ]
      )

      // Флаг наличия чертежа/документа
      await db.execute('UPDATE oem_parts SET has_drawing = 1 WHERE id = ?', [
        part.id,
      ])

      const [[row]] = await db.execute(
        `SELECT * FROM ${DOCUMENTS_TABLE} WHERE id = ?`,
        [ins.insertId]
      )

      await logActivity({
        req,
        action: 'upload_document',
        entity_type: 'oem_parts',
        entity_id: part.id,
        comment: `Загрузили документ "${fixFileName(file.originalname)}"`,
      })

      row.file_name = fixFileName(row.file_name)
      res.status(201).json(row)
    } catch (e) {
      console.error('DB save doc error:', e)
      res.status(500).json({ message: 'Ошибка сохранения записи о документе' })
    }
  } catch (e) {
    console.error('POST /original-parts/:id/documents error:', e)
    res.status(500).json({ message: 'Ошибка запроса на загрузку документа' })
  } finally {
    try {
      if (tmpPath) await fs.unlink(tmpPath)
    } catch {}
  }
})

/* ============================================================
   DELETE /api/original-parts/documents/:docId - удаление
============================================================ */
router.delete('/documents/:docId', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const docId = toId(req.params.docId)
    if (!docId) return res.status(400).json({ message: 'Неверный идентификатор документа' })

    await conn.beginTransaction()
    const [[doc]] = await conn.execute(
      `SELECT * FROM ${DOCUMENTS_TABLE} WHERE id = ?`,
      [docId]
    )
    if (!doc) {
      await conn.rollback()
      return res.status(404).json({ message: 'Документ не найден' })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'oem_part_documents',
      entityId: docId,
      rootEntityType: 'oem_parts',
      rootEntityId: doc.oem_part_id,
      title: fixFileName(doc.file_name) || `Документ #${docId}`,
      subtitle: 'OEM document',
      snapshot: doc,
      context: {
        file_kept_in_storage: true,
        storage_bucket: bucketName || bucket?.name || null,
      },
    })

    await conn.execute(`DELETE FROM ${DOCUMENTS_TABLE} WHERE id = ?`, [docId])

    // Обновляем флаг has_drawing
    try {
      const [[{ cnt }]] = await conn.execute(
        `SELECT COUNT(*) AS cnt FROM ${DOCUMENTS_TABLE} WHERE oem_part_id = ?`,
        [doc.oem_part_id]
      )
      if (!cnt) {
        await conn.execute('UPDATE oem_parts SET has_drawing = 0 WHERE id = ?', [
          doc.oem_part_id,
        ])
      }
    } catch (cntErr) {
      console.warn('Не смогли обновить has_drawing:', cntErr.message)
    }

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'oem_parts',
      entity_id: doc.oem_part_id,
      old_value: String(trashEntryId),
      comment: `Удалили документ "${fixFileName(doc.file_name)}"`,
    })

    await conn.commit()
    res.json({ message: 'Документ перемещён в корзину', trash_entry_id: trashEntryId })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /original-parts/documents/:docId error:', e)
    res.status(500).json({ message: 'Ошибка запроса на удаление документа' })
  } finally {
    conn.release()
  }
})

/* ============================================================
   PUT /api/original-parts/documents/:docId - обновление описания
============================================================ */
router.put('/documents/:docId', async (req, res) => {
  try {
    const docId = toId(req.params.docId)
    if (!docId) return res.status(400).json({ message: 'Неверный идентификатор документа' })

    const description =
      typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null

    const [[doc]] = await db.execute(
      `SELECT * FROM ${DOCUMENTS_TABLE} WHERE id = ?`,
      [docId]
    )
    if (!doc) return res.status(404).json({ message: 'Документ не найден' })

    await db.execute(
      `UPDATE ${DOCUMENTS_TABLE} SET description = ? WHERE id = ?`,
      [description, docId]
    )

    await logActivity({
      req,
      action: 'update_document',
      entity_type: 'oem_parts',
      entity_id: doc.oem_part_id,
      comment: `Изменили описание документа "${fixFileName(doc.file_name)}"`,
    })

    const [[updated]] = await db.execute(
      `SELECT * FROM ${DOCUMENTS_TABLE} WHERE id = ?`,
      [docId]
    )

    updated.file_name = fixFileName(updated.file_name)
    res.json(updated)
  } catch (e) {
    console.error('PUT /original-parts/documents/:docId error:', e)
    res.status(500).json({ message: 'Ошибка запроса на обновление документа' })
  }
})

module.exports = router
