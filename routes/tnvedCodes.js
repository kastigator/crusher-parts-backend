// routes/tnvedCodes.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const ExcelJS = require('exceljs')

// ---------------- helpers ----------------
const toNull = (v) => (v === '' || v === undefined ? null : v)

const toNumberOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const toMysqlDateTime = (d) => {
  const pad = (n) => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  return `${y}-${m}-${day} ${h}:${mi}:${s}`
}

const normalizeLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

// =========================================================
// LIST
// GET /tnved-codes
// Доступ уже защищён в routerIndex (auth + requireTabAccess('/tnved-codes'))
// =========================================================
router.get('/', async (_req, res) => {
  try {
    const [codes] = await db.execute(
      `
      SELECT id, code, description, duty_rate, notes, version, created_at
        FROM tnved_codes
       ORDER BY LENGTH(code), code
      `
    )
    res.json(codes)
  } catch (err) {
    console.error('GET /tnved-codes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// =========================================================
// LIGHT POLL (новые записи после даты)
// GET /tnved-codes/new?after=ISO|MySQL
// =========================================================
router.get('/new', async (req, res) => {
  const { after } = req.query
  if (!after) {
    return res.status(400).json({ message: 'Missing "after" (ISO/MySQL date)' })
  }

  let mysqlAfter = after
  try {
    const d = new Date(after)
    if (!Number.isNaN(d.getTime())) mysqlAfter = toMysqlDateTime(d)
  } catch (_) {}

  try {
    const [rows] = await db.execute(
      `
      SELECT id, code, created_at
        FROM tnved_codes
       WHERE created_at > ?
       ORDER BY created_at DESC
       LIMIT 5
      `,
      [mysqlAfter]
    )
    res.json({ count: rows.length, latest: rows, usedAfter: mysqlAfter })
  } catch (e) {
    console.error('GET /tnved-codes/new error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

// =========================================================
/* ETAG (COUNT:SUM(version))
   GET /tnved-codes/etag
   ======================================================= */
router.get('/etag', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
        FROM tnved_codes
      `
    )
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    const etag = `${cnt}:${sum_ver}`
    res.json({ etag, cnt, sum_ver })
  } catch (e) {
    console.error('GET /tnved-codes/etag error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

// =========================================================
// IMPORT (массовый, из JSON после Excel)
// POST /tnved-codes/import
// =========================================================
router.post("/import", async (req, res) => {
  try {
    const input = Array.isArray(req.body) ? req.body : []
    if (!input.length) {
      return res.status(400).json({
        message: "Нет данных для импорта",
        inserted: [],
        errors: ["Файл пустой или не содержит допустимых строк"],
      })
    }

    const normalized = input.map((r = {}) => {
      const code = (r.code || "").trim()
      const description = toNull(r.description?.trim?.())

      return {
        code,
        description,
        duty_rate: toNumberOrNull(r.duty_rate),
        notes: toNull(r.notes?.trim?.()),
        // ключ для проверки ПОЛНОГО совпадения в файле
        _file_key: `${code}||${description || ""}`,
      }
    })

    const { validateImportRows } = require("../utils/importValidator")
    const { inserted, errors } = await validateImportRows(normalized, {
      table: "tnved_codes",
      uniqueField: "_file_key",    // уникальность внутри файла: код + описание
      requiredFields: ["code"],
      req,
      logType: "tnved_codes",
      mode: "insert",              // только INSERT
      disableExistingCheck: true,  // не ищем в БД по _file_key
    })

    res.status(200).json({
      message: inserted.length
        ? `Импортировано записей: ${inserted.length}`
        : "Не удалось импортировать ни одной записи",
      inserted,
      errors,
    })
  } catch (err) {
    console.error("POST /tnved-codes/import error:", err)
    res.status(500).json({ message: "Ошибка сервера при импорте" })
  }
})


// =========================================================
// IMPORT (массовый, из JSON после Excel)
// POST /tnved-codes/import
// =========================================================
router.post('/import', async (req, res) => {
  try {
    const input = Array.isArray(req.body) ? req.body : []
    if (!input.length) {
      return res.status(400).json({
        message: 'Нет данных для импорта',
        inserted: [],
        errors: ['Файл пустой или не содержит допустимых строк'],
      })
    }

    const normalized = input.map((r = {}) => ({
      code: r.code,
      description: toNull(r.description?.trim?.()),
      duty_rate: toNumberOrNull(r.duty_rate),
      notes: toNull(r.notes?.trim?.()),
    }))

    const { validateImportRows } = require('../utils/importValidator')

    // ВАЖНО: убрали uniqueField: 'code',
    // чтобы разрешить одинаковые коды с разными описаниями.
    const { inserted, errors } = await validateImportRows(normalized, {
      table: 'tnved_codes',
      // uniqueField: 'code', // больше не проверяем уникальность только по коду
      requiredFields: ['code'],
      req,
      logType: 'tnved_codes',
    })

    res.status(200).json({
      message: inserted.length
        ? `Импортировано записей: ${inserted.length}`
        : 'Не удалось импортировать ни одной записи',
      inserted,
      errors,
    })
  } catch (err) {
    console.error('POST /tnved-codes/import error:', err)
    res.status(500).json({ message: 'Ошибка сервера при импорте' })
  }
})

// =========================================================
// UPDATE
// PUT /tnved-codes/:id
// Оптимистическая блокировка по version
// =========================================================
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }

  const { code, description, duty_rate, notes, version } = req.body || {}

  if (!Number.isFinite(Number(version))) {
    return res
      .status(400)
      .json({ message: 'Missing or invalid "version" in body' })
  }

  const newCode = (code || '').trim()
  if (!newCode) {
    return res.status(400).json({ message: 'Поле "code" обязательно' })
  }

  try {
    const [rows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [
      id,
    ])
    if (!rows.length) {
      return res.status(404).json({ message: 'Запись не найдена' })
    }
    const old = rows[0]

    const [upd] = await db.execute(
      `
      UPDATE tnved_codes
         SET code = ?,
             description = ?,
             duty_rate = ?,
             notes = ?,
             version = version + 1
       WHERE id = ? AND version = ?
      `,
      [
        newCode,
        toNull(description?.trim?.()),
        toNumberOrNull(duty_rate),
        toNull(notes?.trim?.()),
        id,
        Number(version),
      ]
    )

    if (upd.affectedRows === 0) {
      const [freshRows] = await db.execute(
        'SELECT * FROM tnved_codes WHERE id = ?',
        [id]
      )
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись изменена другим пользователем',
        current: freshRows[0] || null,
      })
    }

    const [fresh] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [
      id,
    ])

    await logFieldDiffs({
      req,
      entity_type: 'tnved_codes',
      entity_id: id,
      oldData: old,
      newData: fresh[0],
    })

    res.json(fresh[0])
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate_key',
        message: 'Запись с таким кодом и описанием уже существует',
      })
    }
    console.error('PUT /tnved-codes error:', err)
    res.status(500).json({ message: 'Ошибка сервера при обновлении' })
  }
})

// =========================================================
// DELETE
// DELETE /tnved-codes/:id?version=
// =========================================================
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }

  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'version must be numeric' })
  }

  try {
    const [rows] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [
      id,
    ])
    if (!rows.length) {
      return res.status(404).json({ message: 'Запись не найдена' })
    }
    const record = rows[0]

    if (version !== undefined && version !== record.version) {
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: record,
      })
    }

    await db.execute('DELETE FROM tnved_codes WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'tnved_codes',
      entity_id: id,
      comment: `Удалён код ТН ВЭД: ${record.code}`,
    })

    res.json({ message: 'Код ТН ВЭД удалён' })
  } catch (err) {
    console.error('Ошибка при удалении кода ТН ВЭД:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении кода ТН ВЭД' })
  }
})

// =========================================================
// EXPORT (Excel)
// GET /tnved-codes/export
// =========================================================
router.get('/export', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT code, description, duty_rate, notes FROM tnved_codes ORDER BY code'
    )

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('TNVED Codes')

    ws.columns = [
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Description', key: 'description', width: 50 },
      { header: 'Duty Rate', key: 'duty_rate', width: 10 },
      { header: 'Notes', key: 'notes', width: 30 },
    ]

    rows.forEach((r) => {
      ws.addRow({
        code: r.code,
        description: r.description || '',
        duty_rate: r.duty_rate != null ? Number(r.duty_rate) : '',
        notes: r.notes || '',
      })
    })

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="tnved_codes.xlsx"'
    )

    await wb.xlsx.write(res)
    res.end()
  } catch (e) {
    console.error('GET /tnved-codes/export error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

// =========================================================
// SEARCH
// GET /tnved-codes/search?q=
// =========================================================
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json([])

  const like = `%${q}%`
  const isCode = /^\d+$/.test(q)

  try {
    const [rows] = await db.execute(
      `
      SELECT *
        FROM tnved_codes
       WHERE ${isCode ? 'code LIKE ?' : '(code LIKE ? OR description LIKE ?)'}
       ORDER BY LENGTH(code), code
       LIMIT 50
      `,
      isCode ? [like] : [like, like]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /tnved-codes/search error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router
