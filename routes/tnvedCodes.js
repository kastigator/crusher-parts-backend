// routes/tnvedCodes.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const ExcelJS = require('exceljs')
const { createTrashEntry } = require('../utils/trashStore')

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

const getMetaTnvedIdSql = (alias = 'cp') =>
  `CAST(JSON_UNQUOTE(JSON_EXTRACT(${alias}.meta_json, '$.tnved_code_id')) AS UNSIGNED)`

const getMetaTnvedCodeSql = (alias = 'cp') =>
  `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.meta_json, '$.tnved_code')), '')`

const searchTokens = (...values) => {
  const text = values.filter(Boolean).join(' ').toLowerCase()
  return Array.from(new Set(text.match(/[a-zа-яё0-9]{3,}/giu) || [])).slice(0, 8)
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
      SELECT
        tn.id,
        tn.code,
        tn.description,
        tn.duty_rate,
        tn.notes,
        tn.version,
        tn.created_at,
        COALESCE(usage_stats.usage_count, 0) AS usage_count,
        COALESCE(usage_stats.model_count, 0) AS model_count
      FROM tnved_codes tn
      LEFT JOIN (
        SELECT
          matched.tnved_id,
          COUNT(DISTINCT matched.catalog_position_id) AS usage_count,
          COUNT(DISTINCT matched.equipment_model_id) AS model_count
        FROM (
          SELECT
            cp.id AS catalog_position_id,
            COALESCE(${getMetaTnvedIdSql('cp')}, tn_by_code.id) AS tnved_id,
            item.equipment_model_id
          FROM catalog_positions cp
          LEFT JOIN tnved_codes tn_by_code
            ON ${getMetaTnvedIdSql('cp')} IS NULL
           AND ${getMetaTnvedCodeSql('cp')} = tn_by_code.code
          LEFT JOIN equipment_model_bom_items item
            ON item.catalog_position_id = cp.id
          WHERE cp.is_active = 1
            AND COALESCE(${getMetaTnvedIdSql('cp')}, tn_by_code.id) IS NOT NULL
        ) matched
        GROUP BY matched.tnved_id
      ) usage_stats ON usage_stats.tnved_id = tn.id
      ORDER BY LENGTH(tn.code), tn.code
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
  } catch (_) {
    // ignore invalid date, use raw `after` as provided
  }

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
      }
    })

    const { validateImportRows } = require("../utils/importValidator")
    const { inserted, updated, errors } = await validateImportRows(normalized, {
      table: "tnved_codes",
      uniqueField: "code",
      requiredFields: ["code"],
      req,
      logType: "tnved_codes",
      mode: "upsert",
    })

    res.status(200).json({
      message: inserted.length || updated.length
        ? `Импортировано: ${inserted.length}, обновлено: ${updated.length}`
        : "Не удалось импортировать ни одной записи",
      inserted,
      updated,
      errors,
    })
  } catch (err) {
    console.error("POST /tnved-codes/import error:", err)
    res.status(500).json({ message: "Ошибка сервера при импорте" })
  }
})


// =========================================================
// CREATE
// POST /tnved-codes
// =========================================================
router.post('/', async (req, res) => {
  const code = String(req.body?.code || '').trim()
  const description = toNull(req.body?.description?.trim?.())
  const dutyRate = toNumberOrNull(req.body?.duty_rate)
  const notes = toNull(req.body?.notes?.trim?.())

  if (!code) {
    return res.status(400).json({ message: 'Поле "code" обязательно' })
  }

  try {
    const [existing] = await db.execute(
      'SELECT id, code FROM tnved_codes WHERE code = ? LIMIT 1',
      [code]
    )
    if (existing.length) {
      return res.status(409).json({
        type: 'duplicate_key',
        message: 'Код ТН ВЭД уже существует. Откройте существующую запись и обновите её.',
      })
    }

    const [ins] = await db.execute(
      `INSERT INTO tnved_codes (code, description, duty_rate, notes)
       VALUES (?,?,?,?)`,
      [code, description, dutyRate, notes]
    )
    const [fresh] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [ins.insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'tnved_codes',
      entity_id: ins.insertId,
      comment: `Создан код ТН ВЭД: ${code}`,
    })

    res.status(201).json(fresh[0])
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate_key',
        message: 'Код ТН ВЭД уже существует',
      })
    }
    console.error('POST /tnved-codes error:', err)
    res.status(500).json({ message: 'Ошибка сервера при создании' })
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
    return res.status(400).json({ message: 'Некорректный идентификатор записи' })
  }

  const { code, description, duty_rate, notes, version } = req.body || {}

  if (!Number.isFinite(Number(version))) {
    return res
      .status(400)
      .json({ message: 'Не указана корректная версия записи' })
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
    return res.status(400).json({ message: 'Некорректный идентификатор записи' })
  }

  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'Некорректная версия записи' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.execute('SELECT * FROM tnved_codes WHERE id = ? FOR UPDATE', [
      id,
    ])
    if (!rows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Запись не найдена' })
    }
    const record = rows[0]

    if (version !== undefined && version !== record.version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: record,
      })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'tnved_codes',
      entityId: id,
      rootEntityType: 'tnved_codes',
      rootEntityId: id,
      title: record.code,
      subtitle: record.description || null,
      snapshot: record,
    })

    await conn.execute('DELETE FROM tnved_codes WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'tnved_codes',
      entity_id: id,
      old_value: String(trashEntryId),
      comment: `Удалён код ТН ВЭД: ${record.code}`,
    })

    await conn.commit()
    res.json({ message: 'Код ТН ВЭД перемещён в корзину', trash_entry_id: trashEntryId })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('Ошибка при удалении кода ТН ВЭД:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении кода ТН ВЭД' })
  } finally {
    conn.release()
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
       WHERE ${isCode ? 'code LIKE ?' : '(code LIKE ? OR description LIKE ? OR notes LIKE ?)'}
       ORDER BY LENGTH(code), code
       LIMIT 50
      `,
      isCode ? [like] : [like, like, like]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /tnved-codes/search error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

// =========================================================
// USAGE
// GET /tnved-codes/:id/usage
// Shows where the code is already used in classifier/BOM position cards
// and nearby unclassified candidate positions.
// =========================================================
router.get('/:id/usage', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Некорректный идентификатор кода' })
  }

  try {
    const [[code]] = await db.execute('SELECT * FROM tnved_codes WHERE id = ? LIMIT 1', [id])
    if (!code) return res.status(404).json({ message: 'Код ТН ВЭД не найден' })

    const [usage] = await db.execute(
      `
      SELECT
        cp.id AS catalog_position_id,
        cp.position_code,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.manufacturer_part_number,
        cp.description AS catalog_position_description,
        cp.uom,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.weight_kg')) AS weight_kg,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.length_mm')) AS length_mm,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.width_mm')) AS width_mm,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.height_mm')) AS height_mm,
        mf.name AS manufacturer_name,
        em.id AS equipment_model_id,
        em.model_name,
        item.id AS bom_item_id,
        item.parent_item_id,
        item.manufacturer_part_number AS bom_manufacturer_part_number,
        item.manufacturer_part_name AS bom_manufacturer_part_name,
        item.title AS bom_title,
        item.quantity AS bom_quantity,
        parent.manufacturer_part_number AS parent_manufacturer_part_number,
        parent.title AS parent_title,
        materials.materials_summary
      FROM catalog_positions cp
      LEFT JOIN equipment_model_bom_items item ON item.catalog_position_id = cp.id
      LEFT JOIN equipment_model_bom_items parent ON parent.id = item.parent_item_id
      LEFT JOIN equipment_models em ON em.id = COALESCE(item.equipment_model_id, cp.equipment_model_id)
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      LEFT JOIN (
        SELECT
          cpm.catalog_position_id,
          GROUP_CONCAT(
            TRIM(CONCAT_WS(' ', NULLIF(cpm.variant_name, ''), NULLIF(m.name, ''), NULLIF(m.code, ''), NULLIF(m.standard, '')))
            ORDER BY cpm.is_default DESC, cpm.id
            SEPARATOR '; '
          ) AS materials_summary
        FROM catalog_position_materials cpm
        JOIN materials m ON m.id = cpm.material_id
        GROUP BY cpm.catalog_position_id
      ) materials ON materials.catalog_position_id = cp.id
      WHERE cp.is_active = 1
        AND (${getMetaTnvedIdSql('cp')} = ? OR (${getMetaTnvedIdSql('cp')} IS NULL AND ${getMetaTnvedCodeSql('cp')} = ?))
      ORDER BY mf.name, em.model_name, item.sort_order, item.id, cp.id
      LIMIT 500
      `,
      [id, code.code]
    )

    const tokens = searchTokens(code.description, code.notes)
    let candidates = []
    if (tokens.length) {
      const clauses = []
      const params = []
      for (const token of tokens.slice(0, 6)) {
        const like = `%${token}%`
        clauses.push(
          `(cp.display_name LIKE ? OR cp.display_name_en LIKE ? OR cp.display_name_ru LIKE ? OR cp.manufacturer_part_number LIKE ? OR cp.description LIKE ? OR materials.materials_summary LIKE ?)`
        )
        params.push(like, like, like, like, like, like)
      }

      const [candidateRows] = await db.execute(
        `
        SELECT
          cp.id AS catalog_position_id,
          cp.position_code,
          cp.display_name,
          cp.display_name_en,
          cp.display_name_ru,
          cp.manufacturer_part_number,
          cp.description AS catalog_position_description,
          mf.name AS manufacturer_name,
          em.id AS equipment_model_id,
          em.model_name,
          item.id AS bom_item_id,
          item.manufacturer_part_number AS bom_manufacturer_part_number,
          item.manufacturer_part_name AS bom_manufacturer_part_name,
          item.title AS bom_title,
          item.quantity AS bom_quantity,
          materials.materials_summary
        FROM catalog_positions cp
        LEFT JOIN equipment_model_bom_items item ON item.catalog_position_id = cp.id
        LEFT JOIN equipment_models em ON em.id = COALESCE(item.equipment_model_id, cp.equipment_model_id)
        LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
        LEFT JOIN (
          SELECT
            cpm.catalog_position_id,
            GROUP_CONCAT(
              TRIM(CONCAT_WS(' ', NULLIF(cpm.variant_name, ''), NULLIF(m.name, ''), NULLIF(m.code, ''), NULLIF(m.standard, '')))
              ORDER BY cpm.is_default DESC, cpm.id
              SEPARATOR '; '
            ) AS materials_summary
          FROM catalog_position_materials cpm
          JOIN materials m ON m.id = cpm.material_id
          GROUP BY cpm.catalog_position_id
        ) materials ON materials.catalog_position_id = cp.id
        WHERE cp.is_active = 1
          AND ${getMetaTnvedIdSql('cp')} IS NULL
          AND ${getMetaTnvedCodeSql('cp')} IS NULL
          AND (${clauses.join(' OR ')})
        ORDER BY mf.name, em.model_name, item.sort_order, item.id, cp.id
        LIMIT 100
        `,
        params
      )
      candidates = candidateRows
    }

    const stats = {
      usage_count: new Set(usage.map((row) => row.catalog_position_id).filter(Boolean)).size,
      bom_usage_count: usage.filter((row) => row.bom_item_id).length,
      model_count: new Set(usage.map((row) => row.equipment_model_id).filter(Boolean)).size,
      candidate_count: new Set(candidates.map((row) => row.catalog_position_id).filter(Boolean)).size,
    }

    res.json({ code, stats, usage, candidates, candidate_tokens: tokens })
  } catch (e) {
    console.error('GET /tnved-codes/:id/usage error:', e)
    res.status(500).json({ message: 'Ошибка загрузки применений кода ТН ВЭД' })
  }
})

module.exports = router
