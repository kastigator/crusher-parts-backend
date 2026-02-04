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
const canonicalPartNumber = (v) => {
  const s = nz(v)
  if (!s) return null
  return s
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_./\\]/g, '')
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)

// NOTE: For PUT updates we treat:
// - `undefined` as "field not provided" (do not update)
// - `null` as "explicitly clear the field" (set to NULL)
const pickSupplierPartFields = (body = {}) => ({
  supplier_id: has(body, 'supplier_id') ? toId(body.supplier_id) : undefined,
  supplier_part_number: has(body, 'supplier_part_number') ? nz(body.supplier_part_number) || null : undefined,
  description_ru: has(body, 'description_ru') ? nz(body.description_ru) || null : undefined,
  description_en: has(body, 'description_en') ? nz(body.description_en) || null : undefined,
  comment: has(body, 'comment') ? nz(body.comment) || null : undefined,
  lead_time_days: has(body, 'lead_time_days') ? numOrNull(body.lead_time_days) : undefined,
  min_order_qty: has(body, 'min_order_qty') ? numOrNull(body.min_order_qty) : undefined,
  packaging: has(body, 'packaging') ? nz(body.packaging) || null : undefined,
  active: has(body, 'active') ? (body.active === null ? null : boolToInt(!!body.active)) : undefined,
  original_part_cat_number: has(body, 'original_part_cat_number') ? nz(body.original_part_cat_number) || null : undefined,
  default_material_id: has(body, 'default_material_id') ? toId(body.default_material_id) : undefined,
  weight_kg: has(body, 'weight_kg') ? numOrNull(body.weight_kg) : undefined,
  length_cm: has(body, 'length_cm') ? numOrNull(body.length_cm) : undefined,
  width_cm: has(body, 'width_cm') ? numOrNull(body.width_cm) : undefined,
  height_cm: has(body, 'height_cm') ? numOrNull(body.height_cm) : undefined,
  is_overweight: has(body, 'is_overweight')
    ? (body.is_overweight === null ? null : boolToInt(!!body.is_overweight))
    : undefined,
  is_oversize: has(body, 'is_oversize')
    ? (body.is_oversize === null ? null : boolToInt(!!body.is_oversize))
    : undefined,
  part_type: has(body, 'part_type') ? nz(body.part_type) || null : undefined,
})

const withCanonicalPartNumber = (fields) => {
  const next = { ...(fields || {}) }
  if (next.supplier_part_number !== undefined) {
    next.canonical_part_number = canonicalPartNumber(next.supplier_part_number)
  }
  return next
}

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
        lp.price AS latest_price,
        lp.currency AS latest_currency,
        lp.date AS latest_price_date,
        oc.original_cat_numbers,
        sm.materials_count,
        sm.default_material_name
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
      ) lp ON lp.supplier_part_id = sp.id
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
    const partTypeRaw = nz(req.query.part_type)
    const partType = partTypeRaw ? partTypeRaw.toUpperCase() : ''
    const originalsMode = nz(req.query.originals_mode) || ''
    const materialId = req.query.material_id !== undefined ? toId(req.query.material_id) : null
    const materialMode = nz(req.query.material_mode) || 'any'

    const weightMin = numOrNull(req.query.weight_min)
    const weightMax = numOrNull(req.query.weight_max)
    const leadTimeMin = numOrNull(req.query.lead_time_min)
    const leadTimeMax = numOrNull(req.query.lead_time_max)
    const moqMin = numOrNull(req.query.moq_min)
    const moqMax = numOrNull(req.query.moq_max)
    const lengthMin = numOrNull(req.query.length_min)
    const lengthMax = numOrNull(req.query.length_max)
    const widthMin = numOrNull(req.query.width_min)
    const widthMax = numOrNull(req.query.width_max)
    const heightMin = numOrNull(req.query.height_min)
    const heightMax = numOrNull(req.query.height_max)

    const isOverweight = (req.query.is_overweight || '').toString().trim() === '1'
    const isOversize = (req.query.is_oversize || '').toString().trim() === '1'

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

    if (partType) {
      where.push('UPPER(sp.part_type) = ?')
      params.push(partType)
    }
    if (isOverweight) where.push('sp.is_overweight = 1')
    if (isOversize) where.push('sp.is_oversize = 1')

    if (weightMin != null) {
      where.push('sp.weight_kg >= ?')
      params.push(weightMin)
    }
    if (weightMax != null) {
      where.push('sp.weight_kg <= ?')
      params.push(weightMax)
    }
    if (leadTimeMin != null) {
      where.push('sp.lead_time_days >= ?')
      params.push(leadTimeMin)
    }
    if (leadTimeMax != null) {
      where.push('sp.lead_time_days <= ?')
      params.push(leadTimeMax)
    }
    if (moqMin != null) {
      where.push('sp.min_order_qty >= ?')
      params.push(moqMin)
    }
    if (moqMax != null) {
      where.push('sp.min_order_qty <= ?')
      params.push(moqMax)
    }
    if (lengthMin != null) {
      where.push('sp.length_cm >= ?')
      params.push(lengthMin)
    }
    if (lengthMax != null) {
      where.push('sp.length_cm <= ?')
      params.push(lengthMax)
    }
    if (widthMin != null) {
      where.push('sp.width_cm >= ?')
      params.push(widthMin)
    }
    if (widthMax != null) {
      where.push('sp.width_cm <= ?')
      params.push(widthMax)
    }
    if (heightMin != null) {
      where.push('sp.height_cm >= ?')
      params.push(heightMin)
    }
    if (heightMax != null) {
      where.push('sp.height_cm <= ?')
      params.push(heightMax)
    }

    if (originalsMode === 'linked') {
      where.push('EXISTS (SELECT 1 FROM supplier_part_originals spo2 WHERE spo2.supplier_part_id = sp.id)')
    } else if (originalsMode === 'unlinked') {
      where.push('NOT EXISTS (SELECT 1 FROM supplier_part_originals spo2 WHERE spo2.supplier_part_id = sp.id)')
    }

    if (materialId) {
      if (materialMode === 'default') {
        where.push(
          'EXISTS (SELECT 1 FROM supplier_part_materials spm2 WHERE spm2.supplier_part_id = sp.id AND spm2.material_id = ? AND spm2.is_default = 1)'
        )
        params.push(materialId)
      } else {
        where.push(
          'EXISTS (SELECT 1 FROM supplier_part_materials spm2 WHERE spm2.supplier_part_id = sp.id AND spm2.material_id = ?)'
        )
        params.push(materialId)
      }
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
      `
      SELECT
        sp.*,
        ps.name  AS supplier_name,
        ps.country AS supplier_country,
        ps.website AS supplier_website,
        ps.payment_terms AS supplier_payment_terms,
        ps.preferred_currency AS supplier_preferred_currency,
        ps.public_code AS supplier_public_code,
        (
          SELECT sc.name
          FROM supplier_contacts sc
          WHERE sc.supplier_id = ps.id
          ORDER BY sc.is_primary DESC, sc.id ASC
          LIMIT 1
        ) AS supplier_contact_name,
        (
          SELECT sc.email
          FROM supplier_contacts sc
          WHERE sc.supplier_id = ps.id
          ORDER BY sc.is_primary DESC, sc.id ASC
          LIMIT 1
        ) AS supplier_contact_email,
        (
          SELECT sc.phone
          FROM supplier_contacts sc
          WHERE sc.supplier_id = ps.id
          ORDER BY sc.is_primary DESC, sc.id ASC
          LIMIT 1
        ) AS supplier_contact_phone,
        (
          SELECT sa.formatted_address
          FROM supplier_addresses sa
          WHERE sa.supplier_id = ps.id
          ORDER BY sa.is_primary DESC, sa.id ASC
          LIMIT 1
        ) AS supplier_primary_address,
        lp.price AS latest_price,
        lp.currency AS latest_currency,
        lp.date AS latest_price_date,
        lp.offer_type AS latest_offer_type,
        oc.original_cat_numbers,
        sm.materials_count,
        sm.default_material_name
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
      ) lp ON lp.supplier_part_id = sp.id
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
      WHERE sp.id = ?
      `,
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
    const fields = withCanonicalPartNumber(pickSupplierPartFields(req.body))
    if (!fields.supplier_id) {
      return res.status(400).json({ message: 'supplier_id обязателен' })
    }

    const columns = []
    const values = []
    const params = []

    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined) {
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

    const fields = withCanonicalPartNumber(pickSupplierPartFields(req.body))
    const updates = []
    const params = []

    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined) {
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
