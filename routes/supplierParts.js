const express = require('express')
const router = express.Router()

const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return ''
  return String(v).trim()
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const boolToInt = (v) => (v ? 1 : 0)

const pickSupplierPartFields = (body = {}) => ({
  supplier_id: toId(body.supplier_id),
  supplier_part_number: nz(body.supplier_part_number) || null,
  description_ru: nz(body.description_ru) || null,
  description_en: nz(body.description_en) || null,
  comment: nz(body.comment) || null,
  lead_time_days: numOrNull(body.lead_time_days),
  min_order_qty: numOrNull(body.min_order_qty),
  packaging: nz(body.packaging) || null,
  active: body.active === undefined ? null : boolToInt(!!body.active),
  original_part_cat_number: nz(body.original_part_cat_number) || null,
  default_material_id: toId(body.default_material_id),
  weight_kg: numOrNull(body.weight_kg),
  length_cm: numOrNull(body.length_cm),
  width_cm: numOrNull(body.width_cm),
  height_cm: numOrNull(body.height_cm),
  is_overweight: body.is_overweight === undefined ? null : boolToInt(!!body.is_overweight),
  is_oversize: body.is_oversize === undefined ? null : boolToInt(!!body.is_oversize),
  part_type: nz(body.part_type) || null,
})

router.get('/search-lite', async (req, res) => {
  try {
    const rawQ = nz(req.query.q)
    if (!rawQ || rawQ.length < 2) return res.json([])

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50)) | 0
    const supplierId =
      req.query.supplier_id !== undefined ? toId(req.query.supplier_id) : null
    const exclude = String(req.query.exclude_ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)

    const where = []
    const params = []

    const like = `%${rawQ}%`
    where.push(
      '(sp.supplier_part_number LIKE ? OR sp.description_ru LIKE ? OR sp.description_en LIKE ? OR ps.name LIKE ?)'
    )
    params.push(like, like, like, like)

    if (supplierId) {
      where.push('sp.supplier_id = ?')
      params.push(supplierId)
    }

    if (exclude.length) {
      where.push(`sp.id NOT IN (${exclude.map(() => '?').join(',')})`)
      params.push(...exclude)
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const [rows] = await db.execute(
      `
      SELECT
        sp.id,
        sp.supplier_id,
        ps.name AS supplier_name,
        sp.supplier_part_number,
        sp.description_ru,
        sp.description_en,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        COALESCE(l.original_links, 0) AS original_links,
        spp.price,
        spp.currency,
        COALESCE(spp.lead_time_days, sp.lead_time_days) AS lead_time_days,
        COALESCE(spp.min_order_qty, sp.min_order_qty) AS min_order_qty,
        COALESCE(spp.packaging, sp.packaging) AS packaging,
        COALESCE(spp.offer_type, sp.part_type) AS part_type
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN (
        SELECT spp1.*
        FROM supplier_part_prices spp1
        JOIN (
          SELECT supplier_part_id, MAX(id) AS max_id
          FROM supplier_part_prices
          GROUP BY supplier_part_id
        ) latest
          ON latest.supplier_part_id = spp1.supplier_part_id
         AND latest.max_id = spp1.id
      ) spp ON spp.supplier_part_id = sp.id
      LEFT JOIN (
        SELECT supplier_part_id, COUNT(*) AS original_links
        FROM supplier_part_originals
        GROUP BY supplier_part_id
      ) l ON l.supplier_part_id = sp.id
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

router.get('/picker', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const supplierId =
      req.query.supplier_id !== undefined ? toId(req.query.supplier_id) : undefined

    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20)) | 0
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
        '(sp.supplier_part_number LIKE ? OR sp.description_ru LIKE ? OR sp.description_en LIKE ? OR ps.name LIKE ?)'
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
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
      SELECT
        sp.*,
        ps.name AS supplier_name,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        oc.original_cat_numbers,
        sm.materials_count,
        sm.default_material_name
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN (
        SELECT
          spo.supplier_part_id,
          GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ', ') AS original_cat_numbers
        FROM supplier_part_originals spo
        JOIN original_parts op ON op.id = spo.original_part_id
        GROUP BY spo.supplier_part_id
      ) oc ON oc.supplier_part_id = sp.id
      LEFT JOIN (
        SELECT
          spm.supplier_part_id,
          COUNT(*) AS materials_count,
          MAX(CASE WHEN spm.is_default = 1 THEN m.name END) AS default_material_name
        FROM supplier_part_materials spm
        LEFT JOIN materials m ON m.id = spm.material_id
        GROUP BY spm.supplier_part_id
      ) sm ON sm.supplier_part_id = sp.id
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

router.get('/', async (req, res) => {
  try {
    const supplierId =
      req.query.supplier_id !== undefined ? toId(req.query.supplier_id) : undefined
    const q = nz(req.query.q)
    const allFlag = (req.query.all || '').toString().trim() === '1'

    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20)) | 0
    const page = Math.max(1, Number(req.query.page) || 1) | 0
    const offset = Math.max(0, (page - 1) * pageSize) | 0
    const limitSql = `LIMIT ${pageSize | 0} OFFSET ${offset | 0}`

    const where = []
    const params = []

    if (supplierId && !allFlag) {
      where.push('sp.supplier_id = ?')
      params.push(supplierId)
    }
    if (q) {
      where.push(
        '(sp.supplier_part_number LIKE ? OR sp.description_ru LIKE ? OR sp.description_en LIKE ? OR ps.name LIKE ?)'
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
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
      SELECT
        sp.*,
        ps.name AS supplier_name,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        oc.original_cat_numbers,
        sm.materials_count,
        sm.default_material_name
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN (
        SELECT
          spo.supplier_part_id,
          GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ', ') AS original_cat_numbers
        FROM supplier_part_originals spo
        JOIN original_parts op ON op.id = spo.original_part_id
        GROUP BY spo.supplier_part_id
      ) oc ON oc.supplier_part_id = sp.id
      LEFT JOIN (
        SELECT
          spm.supplier_part_id,
          COUNT(*) AS materials_count,
          MAX(CASE WHEN spm.is_default = 1 THEN m.name END) AS default_material_name
        FROM supplier_part_materials spm
        LEFT JOIN materials m ON m.id = spm.material_id
        GROUP BY spm.supplier_part_id
      ) sm ON sm.supplier_part_id = sp.id
      ${whereSql}
      ORDER BY ps.name ASC, sp.supplier_part_number ASC
      ${limitSql}
      `,
      params
    )

    res.json({ items: rows, page, page_size: pageSize, total })
  } catch (e) {
    console.error('GET /supplier-parts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const [[row]] = await db.execute(
      `SELECT sp.*, ps.name AS supplier_name
       FROM supplier_parts sp
       JOIN part_suppliers ps ON ps.id = sp.supplier_id
       WHERE sp.id = ?`,
      [id]
    )
    if (!row) return res.status(404).json({ message: 'Не найдено' })

    res.json(row)
  } catch (e) {
    console.error('GET /supplier-parts/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/originals', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

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
      JOIN original_parts op ON op.id = spo.original_part_id
      JOIN equipment_models m ON m.id = op.equipment_model_id
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

router.post('/', async (req, res) => {
  try {
    const fields = pickSupplierPartFields(req.body)
    if (!fields.supplier_id) {
      return res.status(400).json({ message: 'supplier_id обязателен' })
    }

    const columns = []
    const values = []
    const params = []

    Object.entries(fields).forEach(([key, value]) => {
      if (value !== null) {
        columns.push(key)
        values.push('?')
        params.push(value)
      }
    })

    const sql = `INSERT INTO supplier_parts (${columns.join(', ')}) VALUES (${values.join(', ')})`
    const [result] = await db.execute(sql, params)

    const [[created]] = await db.execute('SELECT * FROM supplier_parts WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /supplier-parts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const fields = pickSupplierPartFields(req.body)
    const updates = []
    const params = []

    Object.entries(fields).forEach(([key, value]) => {
      if (value !== null) {
        updates.push(`${key} = ?`)
        params.push(value)
      }
    })

    if (!updates.length) {
      return res.status(400).json({ message: 'Нет данных для обновления' })
    }

    params.push(id)

    await db.execute(`UPDATE supplier_parts SET ${updates.join(', ')} WHERE id = ?`, params)
    const [[updated]] = await db.execute('SELECT * FROM supplier_parts WHERE id = ?', [id])
    res.json(updated)
  } catch (e) {
    console.error('PUT /supplier-parts/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    await db.execute('DELETE FROM supplier_parts WHERE id = ?', [id])
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /supplier-parts/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
