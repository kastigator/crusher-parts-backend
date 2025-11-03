const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// история
const logActivity   = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const up = (v, n) =>
  v == null
    ? null
    : typeof v === 'string'
    ? v.trim().toUpperCase().slice(0, n || v.length)
    : v

// --- резолвер оригинальной детали (id | cat_number + model_id) ---
async function resolveOriginalPartId({ original_part_id, original_part_cat_number, equipment_model_id }) {
  if (original_part_id !== undefined && original_part_id !== null) {
    const id = toId(original_part_id)
    if (!id) throw new Error('ORIGINAL_ID_INVALID')
    const [[row]] = await db.execute('SELECT id FROM original_parts WHERE id=?', [id])
    if (!row) throw new Error('ORIGINAL_NOT_FOUND')
    return id
  }
  const cat = nz(original_part_cat_number)
  if (!cat) throw new Error('ORIGINAL_CAT_REQUIRED')

  const [rows] = await db.execute(
    'SELECT id, equipment_model_id FROM original_parts WHERE cat_number=?',
    [cat]
  )
  if (!rows.length) throw new Error('ORIGINAL_NOT_FOUND')
  if (rows.length === 1) return rows[0].id

  const emid = toId(equipment_model_id)
  if (!emid) throw new Error('ORIGINAL_AMBIGUOUS')
  const hit = rows.find(r => r.equipment_model_id === emid)
  if (!hit) throw new Error('ORIGINAL_NOT_FOUND_IN_MODEL')
  return hit.id
}

/* =========================================================================
   LIST (обязателен supplier_id; возвращаем также supplier_name и last price)
   GET /supplier-parts?supplier_id=&q=&page=&page_size=
   Ответ: { items, page, page_size, total }
   ========================================================================= */
router.get('/', auth, async (req, res) => {
  try {
    const supplierId = req.query.supplier_id !== undefined ? toId(req.query.supplier_id) : undefined
    if (!supplierId) return res.status(400).json({ message: 'supplier_id должен быть числом' })

    const q = nz(req.query.q)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20)) | 0
    const page     = Math.max(1, Number(req.query.page) || 1) | 0
    const offset   = Math.max(0, (page - 1) * pageSize) | 0

    const where = ['sp.supplier_id = ?']
    const params = [supplierId]

    if (q) {
      where.push('(sp.supplier_part_number LIKE ? OR sp.description LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }

    const whereSql = 'WHERE ' + where.join(' AND ')

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM supplier_parts sp ${whereSql}`,
      params
    )

    const sql = `
      SELECT
        sp.*,
        ps.name AS supplier_name,
        agg.original_cat_numbers,
        (SELECT spp.price    FROM supplier_part_prices spp WHERE spp.supplier_part_id = sp.id ORDER BY spp.date DESC, spp.id DESC LIMIT 1) AS latest_price,
        (SELECT spp.currency FROM supplier_part_prices spp WHERE spp.supplier_part_id = sp.id ORDER BY spp.date DESC, spp.id DESC LIMIT 1) AS latest_currency,
        (SELECT spp.date     FROM supplier_part_prices spp WHERE spp.supplier_part_id = sp.id ORDER BY spp.date DESC, spp.id DESC LIMIT 1) AS latest_price_date
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN (
        SELECT spo.supplier_part_id,
               GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ',') AS original_cat_numbers
          FROM supplier_part_originals spo
          JOIN original_parts op ON op.id = spo.original_part_id
         GROUP BY spo.supplier_part_id
      ) agg ON agg.supplier_part_id = sp.id
      ${whereSql}
      ORDER BY sp.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `
    const [rows] = await db.execute(sql, params)

    res.json({ items: rows, page, page_size: pageSize, total })
  } catch (err) {
    console.error('GET /supplier-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* =========================================================================
   FREE PICKER (для модалок подбора) — ищет по всем поставщикам
   GET /supplier-parts/picker?q=&supplier_id=&has_price=1&exclude_ids=1,2&page=1&page_size=20
   ========================================================================= */
router.get('/picker', auth, async (req, res) => {
  try {
    const q = nz(req.query.q)
    const supplierId = req.query.supplier_id !== undefined ? toId(req.query.supplier_id) : undefined
    const hasPrice = ('' + (req.query.has_price ?? '')).toLowerCase() === '1'

    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20)) | 0
    const page     = Math.max(1, Number(req.query.page) || 1) | 0
    const offset   = Math.max(0, (page - 1) * pageSize) | 0

    const exclude = (req.query.exclude_ids || '')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n > 0)

    const where = []
    const params = []

    if (supplierId) { where.push('sp.supplier_id = ?'); params.push(supplierId) }
    if (q) {
      where.push('(sp.supplier_part_number LIKE ? OR sp.description LIKE ? OR ps.name LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }
    if (hasPrice) {
      where.push('EXISTS (SELECT 1 FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id)')
    }
    if (exclude.length) {
      where.push(`sp.id NOT IN (${exclude.map(() => '?').join(',')})`)
      params.push(...exclude)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) total
         FROM supplier_parts sp
         JOIN part_suppliers ps ON ps.id = sp.supplier_id
        ${whereSql}`,
      params
    )

    const sql = `
      SELECT sp.*,
             ps.name AS supplier_name,
             (SELECT price    FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id ORDER BY p.date DESC, p.id DESC LIMIT 1) AS latest_price,
             (SELECT currency FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id ORDER BY p.date DESC, p.id DESC LIMIT 1) AS latest_currency,
             (SELECT date     FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id ORDER BY p.date DESC, p.id DESC LIMIT 1) AS latest_price_date
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
       ${whereSql}
       ORDER BY ps.name ASC, sp.supplier_part_number ASC
       LIMIT ${pageSize} OFFSET ${offset}
    `
    const [rows] = await db.execute(sql, params)

    res.json({ items: rows, page, page_size: pageSize, total })
  } catch (e) {
    console.error('GET /supplier-parts/picker error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* =========================================================================
   GET ONE (с агрегатом по привязкам и последней ценой)
   GET /supplier-parts/:id
   ========================================================================= */
router.get('/:id', auth, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      SELECT sp.*,
             ps.name AS supplier_name,
             agg.original_ids,
             agg.original_cat_numbers,
             (SELECT spp.price    FROM supplier_part_prices spp WHERE spp.supplier_part_id = sp.id ORDER BY spp.date DESC, spp.id DESC LIMIT 1) AS latest_price,
             (SELECT spp.currency FROM supplier_part_prices spp WHERE spp.supplier_part_id = sp.id ORDER BY spp.date DESC, spp.id DESC LIMIT 1) AS latest_currency,
             (SELECT spp.date     FROM supplier_part_prices spp WHERE spp.supplier_part_id = sp.id ORDER BY spp.date DESC, spp.id DESC LIMIT 1) AS latest_price_date
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
        LEFT JOIN (
          SELECT spo.supplier_part_id,
                 GROUP_CONCAT(op.id ORDER BY op.id) AS original_ids,
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
    if (!rows.length) return res.status(404).json({ message: 'Деталь не найдена' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /supplier-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* =========================================================================
   Детализированные привязки к оригиналам
   GET /supplier-parts/:id/originals
   ========================================================================= */
router.get('/:id/originals', auth, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(`
      SELECT op.id, op.cat_number, op.description_ru, op.description_en,
             m.model_name, mf.name AS manufacturer_name
        FROM supplier_part_originals spo
        JOIN original_parts op           ON op.id = spo.original_part_id
        JOIN equipment_models m          ON m.id = op.equipment_model_id
        JOIN equipment_manufacturers mf  ON mf.id = m.manufacturer_id
       WHERE spo.supplier_part_id = ?
       ORDER BY mf.name, m.model_name, op.cat_number
    `, [id])

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-parts/:id/originals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* =========================================================================
   CREATE (без записи цен! цены — через /supplier-part-prices)
   body: { supplier_id, supplier_part_number, description?, lead_time_days?, min_order_qty?, packaging?,
           [original_part_id | original_part_cat_number + equipment_model_id]? }
   ========================================================================= */
router.post('/', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const supplier_id = toId(req.body.supplier_id)
    const supplier_part_number = nz(req.body.supplier_part_number)
    const description = nz(req.body.description)
    const lead_time_days = numOrNull(req.body.lead_time_days)
    const min_order_qty  = numOrNull(req.body.min_order_qty)
    const packaging      = nz(req.body.packaging)

    if (!supplier_id) return res.status(400).json({ message: 'supplier_id обязателен и должен быть числом' })
    if (!supplier_part_number) return res.status(400).json({ message: 'supplier_part_number обязателен' })

    // сам сп — уникальность по (supplier_id, supplier_part_number)
    let insRes
    try {
      const [ins] = await conn.execute(
        `INSERT INTO supplier_parts
           (supplier_id, supplier_part_number, description, lead_time_days, min_order_qty, packaging)
         VALUES (?,?,?,?,?,?)`,
        [supplier_id, supplier_part_number, description, lead_time_days, min_order_qty, packaging]
      )
      insRes = ins
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        await conn.rollback()
        return res.status(409).json({
          type: 'duplicate',
          fields: ['supplier_id','supplier_part_number'],
          message: 'У этого поставщика такой номер уже есть'
        })
      }
      throw e
    }
    const supplier_part_id = insRes.insertId

    // опциональная привязка к оригиналу
    const hasOriginalPayload =
      req.body.original_part_id !== undefined ||
      req.body.original_part_cat_number !== undefined

    if (hasOriginalPayload) {
      let original_part_id
      try {
        original_part_id = await resolveOriginalPartId({
          original_part_id: req.body.original_part_id,
          original_part_cat_number: req.body.original_part_cat_number,
          equipment_model_id: req.body.equipment_model_id
        })
      } catch (e) {
        const map = {
          ORIGINAL_ID_INVALID: 'Некорректный original_part_id',
          ORIGINAL_CAT_REQUIRED: 'Укажите original_part_id или original_part_cat_number',
          ORIGINAL_AMBIGUOUS: 'Найдено несколько деталей с таким cat_number. Укажите equipment_model_id.',
          ORIGINAL_NOT_FOUND: 'Оригинальная деталь не найдена',
          ORIGINAL_NOT_FOUND_IN_MODEL: 'В указанной модели такая деталь не найдена'
        }
        await conn.rollback()
        return res.status(400).json({ message: map[e.message] || 'Ошибка в данных для привязки' })
      }

      try {
        await conn.execute(
          'INSERT INTO supplier_part_originals (supplier_part_id, original_part_id) VALUES (?,?)',
          [supplier_part_id, original_part_id]
        )
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') {
          await conn.rollback()
          return res.status(409).json({ type: 'duplicate', message: 'Связь поставщик ↔ оригинал уже существует' })
        }
        if (e && e.errno === 1452) {
          await conn.rollback()
          return res.status(409).json({ type: 'fk_constraint', message: 'Нарушение ссылочной целостности при создании связи' })
        }
        throw e
      }

      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: supplier_part_id,
        field_changed: 'original_link_added',
        old_value: '',
        new_value: String(original_part_id),
        comment: 'Добавлена привязка к оригинальной детали'
      })
    }

    await conn.commit()

    await logActivity({
      req,
      action: 'create',
      entity_type: 'supplier_parts',
      entity_id: supplier_part_id,
      comment: `Создана деталь поставщика`
    })

    res.status(201).json({ id: supplier_part_id, message: 'Деталь поставщика добавлена' })
  } catch (err) {
    await conn.rollback()
    console.error('POST /supplier-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

/* =========================================================================
   UPDATE (без цен! цены — через /supplier-part-prices)
   body: { supplier_part_number?, description?, lead_time_days?, min_order_qty?, packaging? }
   ========================================================================= */
router.put('/:id', auth, adminOnly, async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный id' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[exists]] = await conn.execute('SELECT * FROM supplier_parts WHERE id=?', [id])
    if (!exists) {
      await conn.rollback()
      return res.status(404).json({ message: 'Деталь не найдена' })
    }
    const oldRow = exists

    const supplier_part_number = nz(req.body.supplier_part_number)
    const description = nz(req.body.description)
    const lead_time_days = req.body.lead_time_days === undefined ? null : numOrNull(req.body.lead_time_days)
    const min_order_qty  = req.body.min_order_qty  === undefined ? null : numOrNull(req.body.min_order_qty)
    const packaging      = req.body.packaging      === undefined ? null : nz(req.body.packaging)

    // формируем UPDATE лишь по тем полям, что пришли
    const set = []
    const vals = []
    if (supplier_part_number !== null) { set.push('supplier_part_number = ?'); vals.push(supplier_part_number) }
    if (description !== null)          { set.push('description = ?');          vals.push(description) }
    if (req.body.lead_time_days !== undefined) { set.push('lead_time_days = ?'); vals.push(lead_time_days) }
    if (req.body.min_order_qty  !== undefined) { set.push('min_order_qty = ?');  vals.push(min_order_qty) }
    if (req.body.packaging      !== undefined) { set.push('packaging = ?');      vals.push(packaging) }

    if (set.length) {
      try {
        await conn.execute(
          `UPDATE supplier_parts SET ${set.join(', ')} WHERE id = ?`,
          [...vals, id]
        )
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') {
          await conn.rollback()
          return res.status(409).json({
            type: 'duplicate',
            fields: ['supplier_id','supplier_part_number'],
            message: 'Такой номер у этого поставщика уже есть'
          })
        }
        throw e
      }
    }

    const [[fresh]] = await conn.execute('SELECT * FROM supplier_parts WHERE id=?', [id])

    await conn.commit()

    await logFieldDiffs({
      req,
      oldData: oldRow,
      newData: fresh,
      entity_type: 'supplier_parts',
      entity_id: id,
      exclude: ['id', 'supplier_id', 'created_at', 'updated_at']
    })

    res.json({ message: 'Деталь обновлена' })
  } catch (err) {
    await conn.rollback()
    console.error('PUT /supplier-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

/* =========================================================================
   DELETE (чистим связи и цены каскадом вручную)
   ========================================================================= */
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный id' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[oldRow]] = await conn.execute('SELECT * FROM supplier_parts WHERE id=?', [id])
    if (!oldRow) {
      await conn.rollback()
      return res.status(404).json({ message: 'Деталь не найдена' })
    }

    await conn.execute('DELETE FROM supplier_part_originals WHERE supplier_part_id = ?', [id])
    await conn.execute('DELETE FROM supplier_part_prices    WHERE supplier_part_id = ?', [id])

    const [del] = await conn.execute('DELETE FROM supplier_parts WHERE id = ?', [id])
    if (del.affectedRows === 0) {
      await conn.rollback()
      return res.status(404).json({ message: 'Деталь не найдена' })
    }

    await conn.commit()

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'supplier_parts',
      entity_id: id,
      comment: `Удалена деталь поставщика ${oldRow.supplier_part_number || ''}`.trim()
    })

    res.json({ message: 'Деталь удалена' })
  } catch (err) {
    await conn.rollback()
    console.error('DELETE /supplier-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
