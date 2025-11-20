// routes/supplierParts.js
const express = require('express')
const router = express.Router()

const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// ---------------- helpers ----------------

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return ''
  const s = String(v).trim()
  return s
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// ----------------------------------------------------------
// По cat_number или id найти original_parts.id
// ----------------------------------------------------------

async function resolveOriginalPartId({
  original_part_id,
  original_part_cat_number,
  equipment_model_id,
}) {
  const id = toId(original_part_id)
  if (id) return id

  const cat = nz(original_part_cat_number)
  if (!cat) {
    throw new Error('ORIGINAL_CAT_REQUIRED')
  }

  const [rows] = await db.execute(
    `
    SELECT id, equipment_model_id
      FROM original_parts
     WHERE cat_number = ?
    `,
    [cat]
  )

  if (!rows.length) {
    throw new Error('ORIGINAL_NOT_FOUND')
  }

  if (rows.length === 1 && !equipment_model_id) {
    return rows[0].id
  }

  // если есть несколько – надо указать модель
  const emid = toId(equipment_model_id)
  if (!emid) throw new Error('ORIGINAL_AMBIGUOUS')

  const hit = rows.find((r) => r.equipment_model_id === emid)
  if (!hit) throw new Error('ORIGINAL_NOT_FOUND_IN_MODEL')

  return hit.id
}

/* =========================================================================
   Лёгкий поиск для Drawer в комплектах
   GET /supplier-parts/search-lite
   ========================================================================= */

/**
 * Используется в SupplierPartPickerDrawer.
 * Возвращает плоский массив деталей поставщиков без пагинации.
 * Параметры:
 *   q           – строка поиска (номер / описание / поставщик), min 2 символа
 *   limit       – макс. количество записей (по умолчанию 50, не более 200)
 *   exclude_ids – список id через запятую, которые нужно исключить
 */
router.get('/search-lite', async (req, res) => {
  try {
    const rawQ = (req.query.q || '').trim()
    if (!rawQ || rawQ.length < 2) {
      // Для UX в Drawer проще отдать [] чем 400
      return res.json([])
    }

    const limit =
      Math.min(200, Math.max(1, Number(req.query.limit) || 50)) | 0

    const exclude = String(req.query.exclude_ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)

    const where = []
    const params = []

    const like = `%${rawQ}%`
    where.push(
      '(sp.supplier_part_number LIKE ? OR sp.description LIKE ? OR ps.name LIKE ?)'
    )
    params.push(like, like, like)

    if (exclude.length) {
      where.push(`sp.id NOT IN (${exclude.map(() => '?').join(',')})`)
      params.push(...exclude)
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const [rows] = await db.execute(
      `
      WITH latest AS (
        SELECT p.*,
               ROW_NUMBER() OVER (
                 PARTITION BY p.supplier_part_id
                 ORDER BY p.date DESC, p.id DESC
               ) rn
        FROM supplier_part_prices p
      ),
      links AS (
        SELECT
          spo.supplier_part_id,
          COUNT(*) AS original_links
        FROM supplier_part_originals spo
        GROUP BY spo.supplier_part_id
      )
      SELECT
        sp.id,
        sp.supplier_id,
        ps.name AS supplier_name,
        sp.supplier_part_number,
        sp.description,
        COALESCE(lp.price,    sp.price)    AS latest_price,
        COALESCE(lp.currency, sp.currency) AS latest_currency,
        lp.date                             AS latest_price_date,
        COALESCE(l.original_links, 0)      AS original_links
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN latest lp ON lp.supplier_part_id = sp.id AND lp.rn = 1
      LEFT JOIN links  l  ON l.supplier_part_id = sp.id
      ${whereSql}
      ORDER BY ps.name ASC, sp.supplier_part_number ASC
      LIMIT ${limit}
      `,
      params
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-parts/search-lite error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* =========================================================================
   Свободный пикер, LIST, GET ONE, originals, CREATE/UPDATE/DELETE
   ========================================================================= */

/**
 * GET /supplier-parts/picker
 * Используется в пикерах для связки с оригинальными деталями.
 */
router.get('/picker', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const supplierId =
      req.query.supplier_id !== undefined
        ? toId(req.query.supplier_id)
        : undefined
    const hasPrice =
      ('' + (req.query.has_price ?? '')).toLowerCase() === '1'

    const pageSize =
      Math.min(100, Math.max(1, Number(req.query.page_size) || 20)) | 0
    const page = Math.max(1, Number(req.query.page) || 1) | 0
    const offset = Math.max(0, (page - 1) * pageSize) | 0
    const limitSql = `LIMIT ${pageSize | 0} OFFSET ${offset | 0}`

    const exclude = (req.query.exclude_ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)

    const where = []
    const params = []

    if (supplierId) {
      where.push('sp.supplier_id = ?')
      params.push(supplierId)
    }
    if (q) {
      where.push(
        '(sp.supplier_part_number LIKE ? OR sp.description LIKE ? OR ps.name LIKE ?)'
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }
    if (hasPrice) {
      where.push(
        'EXISTS (SELECT 1 FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id)'
      )
    }
    if (exclude.length) {
      where.push(`sp.id NOT IN (${exclude.map(() => '?').join(',')})`)
      params.push(...exclude)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const [[{ total }]] = await db.execute(
      `
      SELECT COUNT(*) total
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
      ${whereSql}
      `,
      params
    )

    const [rows] = await db.execute(
      `
      WITH latest AS (
        SELECT p.*,
               ROW_NUMBER() OVER (
                 PARTITION BY p.supplier_part_id
                 ORDER BY p.date DESC, p.id DESC
               ) rn
        FROM supplier_part_prices p
      )
      SELECT
        sp.*,
        ps.name AS supplier_name,
        COALESCE(lp.price,    sp.price)    AS latest_price,
        COALESCE(lp.currency, sp.currency) AS latest_currency,
        lp.date                             AS latest_price_date
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN latest lp ON lp.supplier_part_id = sp.id AND lp.rn = 1
      ${whereSql}
      ORDER BY ps.name ASC, sp.supplier_part_number ASC
      ${limitSql}
      `,
      params
    )

    res.json({ items: rows, page, page_size: pageSize, total })
  } catch (e) {
    console.error('GET /supplier-parts/picker error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/**
 * GET /supplier-parts
 *  - список деталей конкретного поставщика (supplier_id)
 *  - глобальный режим "все детали" (all=1)
 *  - либо глобальный поиск по q≥2
 */
router.get('/', async (req, res) => {
  try {
    const supplierId =
      req.query.supplier_id !== undefined
        ? toId(req.query.supplier_id)
        : undefined
    const q = (req.query.q || '').trim()
    const allFlag = (req.query.all || '').toString().trim() === '1'

    const pageSize =
      Math.min(100, Math.max(1, Number(req.query.page_size) || 20)) | 0
    const page = Math.max(1, Number(req.query.page) || 1) | 0
    const offset = Math.max(0, (page - 1) * pageSize) | 0
    const limitSql = `LIMIT ${pageSize | 0} OFFSET ${offset | 0}`

    // ---- список по конкретному поставщику ----
    if (supplierId) {
      const where = ['sp.supplier_id = ?']
      const params = [supplierId]

      if (q) {
        const like = `%${q}%`
        // поиск по номеру, описанию, комменту, привязкам и комплектам
        where.push(
          `(
            sp.supplier_part_number LIKE ?
            OR sp.description LIKE ?
            OR sp.comment LIKE ?
            OR EXISTS (
              SELECT 1
                FROM supplier_part_originals spo
                JOIN original_parts op ON op.id = spo.original_part_id
               WHERE spo.supplier_part_id = sp.id
                 AND op.cat_number LIKE ?
            )
            OR EXISTS (
              SELECT 1
                FROM supplier_bundle_item_links bl
                JOIN supplier_bundle_items bi   ON bi.id = bl.item_id
                JOIN supplier_bundles b         ON b.id  = bi.bundle_id
                JOIN original_parts op2         ON op2.id = b.original_part_id
                JOIN equipment_models m         ON m.id  = op2.equipment_model_id
                JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
               WHERE bl.supplier_part_id = sp.id
                 AND (
                      op2.cat_number LIKE ?
                   OR m.model_name  LIKE ?
                   OR mf.name       LIKE ?
                   OR b.title       LIKE ?
                 )
            )
          )`
        )
        params.push(
          like, // номер
          like, // описание
          like, // comment
          like, // привязанные оригиналы cat_number
          like, // комплекты: cat_number
          like, // комплекты: модель
          like, // комплекты: производитель
          like  // комплекты: title
        )
      }

      const whereSql = 'WHERE ' + where.join(' AND ')

      const [[{ total }]] = await db.execute(
        `
        SELECT COUNT(*) AS total
          FROM supplier_parts sp
        ${whereSql}
        `,
        params
      )

      const [rows] = await db.execute(
        `
        WITH latest AS (
          SELECT p.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY p.supplier_part_id
                   ORDER BY p.date DESC, p.id DESC
                 ) rn
          FROM supplier_part_prices p
        )
        SELECT
          sp.*,
          ps.name AS supplier_name,
          COALESCE(lp.price,    sp.price)    AS latest_price,
          COALESCE(lp.currency, sp.currency) AS latest_currency,
          lp.date                             AS latest_price_date,
          agg.original_cat_numbers
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
        LEFT JOIN latest lp ON lp.supplier_part_id = sp.id AND lp.rn = 1
        LEFT JOIN (
          SELECT
            spo.supplier_part_id,
            GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ',') AS original_cat_numbers
          FROM supplier_part_originals spo
          JOIN original_parts op ON op.id = spo.original_part_id
          GROUP BY spo.supplier_part_id
        ) agg ON agg.supplier_part_id = sp.id
        ${whereSql}
        ORDER BY sp.id DESC
        ${limitSql}
        `,
        params
      )

      return res.json({ items: rows, page, page_size: pageSize, total })
    }

    // ---- глобальный режим "Показать все детали" (all=1) ----
    if (allFlag) {
      const where = []
      const params = []

      if (q) {
        const like = `%${q}%`
        where.push(
          `(
            sp.supplier_part_number LIKE ?
            OR sp.description LIKE ?
            OR sp.comment LIKE ?
            OR ps.name LIKE ?
            OR EXISTS (
              SELECT 1
                FROM supplier_part_originals spo
                JOIN original_parts op ON op.id = spo.original_part_id
               WHERE spo.supplier_part_id = sp.id
                 AND op.cat_number LIKE ?
            )
            OR EXISTS (
              SELECT 1
                FROM supplier_bundle_item_links bl
                JOIN supplier_bundle_items bi   ON bi.id = bl.item_id
                JOIN supplier_bundles b         ON b.id  = bi.bundle_id
                JOIN original_parts op2         ON op2.id = b.original_part_id
                JOIN equipment_models m         ON m.id  = op2.equipment_model_id
                JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
               WHERE bl.supplier_part_id = sp.id
                 AND (
                      op2.cat_number LIKE ?
                   OR m.model_name  LIKE ?
                   OR mf.name       LIKE ?
                   OR b.title       LIKE ?
                 )
            )
          )`
        )
        params.push(
          like, // номер
          like, // описание
          like, // comment
          like, // supplier name
          like, // привязка cat_number
          like, // комплект cat_number
          like, // модель
          like, // производитель
          like  // title комплекта
        )
      }

      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

      const [[{ total }]] = await db.execute(
        `
        SELECT COUNT(*) AS total
          FROM supplier_parts sp
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
        ${whereSql}
        `,
        params
      )

      const [rows] = await db.execute(
        `
        WITH latest AS (
          SELECT p.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY p.supplier_part_id
                   ORDER BY p.date DESC, p.id DESC
                 ) rn
          FROM supplier_part_prices p
        )
        SELECT
          sp.*,
          ps.name AS supplier_name,
          COALESCE(lp.price,    sp.price)    AS latest_price,
          COALESCE(lp.currency, sp.currency) AS latest_currency,
          lp.date                             AS latest_price_date,
          agg.original_cat_numbers
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
        LEFT JOIN latest lp ON lp.supplier_part_id = sp.id AND lp.rn = 1
        LEFT JOIN (
          SELECT
            spo.supplier_part_id,
            GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ',') AS original_cat_numbers
          FROM supplier_part_originals spo
          JOIN original_parts op ON op.id = spo.original_part_id
          GROUP BY spo.supplier_part_id
        ) agg ON agg.supplier_part_id = sp.id
        ${whereSql}
        ORDER BY ps.name ASC, sp.supplier_part_number ASC
        ${limitSql}
        `,
        params
      )

      return res.json({ items: rows, page, page_size: pageSize, total })
    }

    // ---- глобальный поиск, если задан q ≥ 2 ----
    if (q && q.length >= 2) {
      const where = []
      const params = []
      const like = `%${q}%`

      where.push(
        `(
          sp.supplier_part_number LIKE ?
          OR sp.description LIKE ?
          OR sp.comment LIKE ?
          OR EXISTS (
            SELECT 1
              FROM supplier_part_originals spo
              JOIN original_parts op ON op.id = spo.original_part_id
             WHERE spo.supplier_part_id = sp.id
               AND op.cat_number LIKE ?
          )
          OR EXISTS (
            SELECT 1
              FROM supplier_bundle_item_links bl
              JOIN supplier_bundle_items bi   ON bi.id = bl.item_id
              JOIN supplier_bundles b         ON b.id  = bi.bundle_id
              JOIN original_parts op2         ON op2.id = b.original_part_id
              JOIN equipment_models m         ON m.id  = op2.equipment_model_id
              JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
             WHERE bl.supplier_part_id = sp.id
               AND (
                    op2.cat_number LIKE ?
                 OR m.model_name  LIKE ?
                 OR mf.name       LIKE ?
                 OR b.title       LIKE ?
               )
          )
        )`
      )
      params.push(
        like, // номер
        like, // описание
        like, // comment
        like, // привязка cat_number
        like, // комплект cat_number
        like, // модель
        like, // производитель
        like  // title комплекта
      )

      const whereSql = 'WHERE ' + where.join(' AND ')

      const [[{ total }]] = await db.execute(
        `
        SELECT COUNT(*) AS total
          FROM supplier_parts sp
        ${whereSql}
        `,
        params
      )

      const [rows] = await db.execute(
        `
        WITH latest AS (
          SELECT p.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY p.supplier_part_id
                   ORDER BY p.date DESC, p.id DESC
                 ) rn
          FROM supplier_part_prices p
        )
        SELECT
          sp.id,
          sp.supplier_id,
          ps.name AS supplier_name,
          sp.supplier_part_number,
          sp.description,
          sp.comment,
          COALESCE(lp.price,    sp.price)    AS latest_price,
          COALESCE(lp.currency, sp.currency) AS latest_currency,
          lp.date                             AS latest_price_date
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
        LEFT JOIN latest lp ON lp.supplier_part_id = sp.id AND lp.rn = 1
        ${whereSql}
        ORDER BY ps.name ASC, sp.supplier_part_number ASC
        ${limitSql}
        `,
        params
      )

      return res.json({ items: rows, page, page_size: pageSize, total })
    }

    return res.status(400).json({
      message:
        'Укажите supplier_id (список поставщика), all=1 (все детали) или q≥2 (глобальный поиск).',
    })
  } catch (err) {
    console.error('GET /supplier-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// GET /supplier-parts/:id
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      WITH latest AS (
        SELECT p.*,
               ROW_NUMBER() OVER (
                 PARTITION BY p.supplier_part_id
                 ORDER BY p.date DESC, p.id DESC
               ) rn
        FROM supplier_part_prices p
      )
      SELECT
        sp.*,
        ps.name AS supplier_name,
        agg.original_ids,
        agg.original_cat_numbers,
        COALESCE(lp.price,    sp.price)    AS latest_price,
        COALESCE(lp.currency, sp.currency) AS latest_currency,
        lp.date                             AS latest_price_date
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN latest lp ON lp.supplier_part_id = sp.id AND lp.rn = 1
      LEFT JOIN (
        SELECT
          spo.supplier_part_id,
          GROUP_CONCAT(op.id ORDER BY op.id)                               AS original_ids,
          GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ',') AS original_cat_numbers
        FROM supplier_part_originals spo
        JOIN original_parts op ON op.id = spo.original_part_id
       WHERE spo.supplier_part_id = ?
       GROUP BY spo.supplier_part_id
      ) agg ON agg.supplier_part_id = sp.id
     WHERE sp.id = ?
      `,
      [id, id]
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'Деталь не найдена' })
    }

    res.json(rows[0])
  } catch (err) {
    console.error('GET /supplier-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// GET /supplier-parts/:id/originals
router.get('/:id/originals', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      SELECT
        op.id,
        op.cat_number,
        op.description_ru,
        op.description_en,
        m.model_name,
        mf.name AS manufacturer_name
      FROM supplier_part_originals spo
      JOIN original_parts op          ON op.id = spo.original_part_id
      JOIN equipment_models m         ON m.id = op.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
     WHERE spo.supplier_part_id = ?
     ORDER BY mf.name, m.model_name, op.cat_number
      `,
      [id]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-parts/:id/originals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* =========================================================================
   CREATE / UPDATE / DELETE
   ========================================================================= */

// POST /supplier-parts
router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const supplier_id = toId(req.body.supplier_id)
    const supplier_part_number = nz(req.body.supplier_part_number)
    const description = nz(req.body.description)
    const comment = nz(req.body.comment)
    const lead_time_days = numOrNull(req.body.lead_time_days)
    const min_order_qty = numOrNull(req.body.min_order_qty)
    const packaging = nz(req.body.packaging)

    if (!supplier_id) {
      return res.status(400).json({
        message: 'supplier_id обязателен и должен быть числом',
      })
    }
    if (!supplier_part_number) {
      return res
        .status(400)
        .json({ message: 'supplier_part_number обязателен' })
    }

    let insRes
    try {
      const [ins] = await conn.execute(
        `
        INSERT INTO supplier_parts
          (supplier_id, supplier_part_number, description, comment, lead_time_days, min_order_qty, packaging)
        VALUES (?,?,?,?,?,?,?)
        `,
        [
          supplier_id,
          supplier_part_number,
          description,
          comment,
          lead_time_days,
          min_order_qty,
          packaging,
        ]
      )
      insRes = ins
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        await conn.rollback()
        return res.status(409).json({
          type: 'duplicate',
          fields: ['supplier_id', 'supplier_part_number'],
          message: 'У этого поставщика такой номер уже есть',
        })
      }
      throw e
    }

    const supplier_part_id = insRes.insertId

    const hasOriginalPayload =
      req.body.original_part_id !== undefined ||
      req.body.original_part_cat_number !== undefined

    if (hasOriginalPayload) {
      let original_part_id
      try {
        original_part_id = await resolveOriginalPartId({
          original_part_id: req.body.original_part_id,
          original_part_cat_number: req.body.original_part_cat_number,
          equipment_model_id: req.body.equipment_model_id,
        })
      } catch (e) {
        const map = {
          ORIGINAL_ID_INVALID: 'Некорректный original_part_id',
          ORIGINAL_CAT_REQUIRED:
            'Укажите original_part_id или original_part_cat_number',
          ORIGINAL_AMBIGUOUS:
            'Найдено несколько деталей с таким cat_number. Укажите equipment_model_id.',
          ORIGINAL_NOT_FOUND: 'Оригинальная деталь не найдена',
          ORIGINAL_NOT_FOUND_IN_MODEL:
            'Для указанной модели не найдено оригинальной детали с таким cat_number',
        }
        await conn.rollback()
        return res.status(400).json({ message: map[e.message] || e.message })
      }

      await conn.execute(
        `
        INSERT INTO supplier_part_originals
          (supplier_part_id, original_part_id)
        VALUES (?,?)
        `,
        [supplier_part_id, original_part_id]
      )
    }

    await logActivity(conn, {
      entity_type: 'supplier_parts',
      entity_id: supplier_part_id,
      action: 'create',
      user_id: req.user?.id,
      payload: { supplier_id, supplier_part_number, description, comment },
    })

    await conn.commit()

    const [[created]] = await conn.execute(
      `
      SELECT *
        FROM supplier_parts
       WHERE id = ?
      `,
      [supplier_part_id]
    )

    res.status(201).json(created)
  } catch (e) {
    console.error('POST /supplier-parts error:', e)
    try {
      await conn.rollback()
    } catch {}
    res.status(500).json({ message: 'Ошибка сервера при создании детали' })
  } finally {
    conn.release()
  }
})

// PUT /supplier-parts/:id
router.put('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) {
      conn.release()
      return res.status(400).json({ message: 'Некорректный id' })
    }

    const [beforeRows] = await conn.execute(
      `SELECT * FROM supplier_parts WHERE id = ?`,
      [id]
    )
    if (!beforeRows.length) {
      conn.release()
      return res.status(404).json({ message: 'Деталь не найдена' })
    }
    const before = beforeRows[0]

    const supplier_id = toId(req.body.supplier_id ?? before.supplier_id)
    const supplier_part_number = nz(
      req.body.supplier_part_number ?? before.supplier_part_number
    )
    const description = nz(req.body.description ?? before.description)
    const comment = nz(req.body.comment ?? before.comment)
    const lead_time_days =
      numOrNull(req.body.lead_time_days) ?? before.lead_time_days
    const min_order_qty =
      numOrNull(req.body.min_order_qty) ?? before.min_order_qty
    const packaging = nz(req.body.packaging ?? before.packaging)

    if (!supplier_id) {
      conn.release()
      return res.status(400).json({
        message: 'supplier_id обязателен и должен быть числом',
      })
    }
    if (!supplier_part_number) {
      conn.release()
      return res
        .status(400)
        .json({ message: 'supplier_part_number обязателен' })
    }

    await conn.beginTransaction()

    try {
      await conn.execute(
        `
        UPDATE supplier_parts
           SET supplier_id = ?,
               supplier_part_number = ?,
               description = ?,
               comment = ?,
               lead_time_days = ?,
               min_order_qty = ?,
               packaging = ?
         WHERE id = ?
        `,
        [
          supplier_id,
          supplier_part_number,
          description,
          comment,
          lead_time_days,
          min_order_qty,
          packaging,
          id,
        ]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        await conn.rollback()
        conn.release()
        return res.status(409).json({
          type: 'duplicate',
          fields: ['supplier_id', 'supplier_part_number'],
          message: 'У этого поставщика такой номер уже есть',
        })
      }
      throw e
    }

    const [afterRows] = await conn.execute(
      `SELECT * FROM supplier_parts WHERE id = ?`,
      [id]
    )
    const after = afterRows[0]

    await logFieldDiffs(conn, {
      entity_type: 'supplier_parts',
      entity_id: id,
      user_id: req.user?.id,
      before,
      after,
      fields: [
        'supplier_id',
        'supplier_part_number',
        'description',
        'comment',
        'lead_time_days',
        'min_order_qty',
        'packaging',
      ],
    })

    await conn.commit()
    conn.release()

    res.json(after)
  } catch (e) {
    console.error('PUT /supplier-parts/:id error:', e)
    try {
      await conn.rollback()
    } catch {}
    conn.release()
    res.status(500).json({ message: 'Ошибка сервера при обновлении детали' })
  }
})

// DELETE /supplier-parts/:id
router.delete('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) {
      conn.release()
      return res.status(400).json({ message: 'Некорректный id' })
    }

    const [rows] = await conn.execute(
      `SELECT * FROM supplier_parts WHERE id = ?`,
      [id]
    )
    if (!rows.length) {
      conn.release()
      return res.status(404).json({ message: 'Деталь не найдена' })
    }
    const before = rows[0]

    await conn.beginTransaction()

    await conn.execute(
      `DELETE FROM supplier_part_originals WHERE supplier_part_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE FROM supplier_part_prices WHERE supplier_part_id = ?`,
      [id]
    )
    await conn.execute(`DELETE FROM supplier_parts WHERE id = ?`, [id])

    await logActivity(conn, {
      entity_type: 'supplier_parts',
      entity_id: id,
      action: 'delete',
      user_id: req.user?.id,
      payload: before,
      comment: 'Удалено пользователем',
    })

    await conn.commit()
    conn.release()

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /supplier-parts/:id error:', e)
    try {
      await conn.rollback()
    } catch {}
    conn.release()
    res.status(500).json({ message: 'Ошибка сервера при удалении детали' })
  }
})

module.exports = router
