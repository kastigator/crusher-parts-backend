const express = require('express')
const router = express.Router()

const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')

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
const normalizeUom = (v) => {
  const raw = nz(v).toLowerCase()
  if (!raw) return null
  if (['pcs', 'pc', 'piece', 'pieces', 'шт'].includes(raw)) return 'pcs'
  if (['kg', 'кг'].includes(raw)) return 'kg'
  if (['set', 'компл', 'компл.'].includes(raw)) return 'set'
  return raw.slice(0, 16)
}
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
  uom: has(body, 'uom') ? normalizeUom(body.uom) || 'pcs' : undefined,
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
        COALESCE(l.oem_links, 0) AS oem_links,
        COALESCE(l.oem_links, 0) AS original_links,
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
        SELECT supplier_part_id, COUNT(*) AS oem_links
        FROM supplier_part_oem_parts
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
        lp.source_type AS latest_price_source_type,
        lp.source_subtype AS latest_price_source_subtype,
        rfl.entry_source AS latest_price_entry_source,
        rfq.id AS latest_price_rfq_id,
        rfq.rfq_number AS latest_price_rfq_number,
        rr.rev_number AS latest_price_rfq_rev_number,
        spl.id AS latest_price_price_list_id,
        spl.list_code AS latest_price_price_list_code,
        spl.list_name AS latest_price_price_list_name,
        spl.valid_from AS latest_price_price_list_valid_from,
        spl.valid_to AS latest_price_price_list_valid_to,
        oc.oem_part_numbers,
        oc.oem_part_numbers AS original_cat_numbers,
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
      LEFT JOIN rfq_response_lines rfl
        ON rfl.id = lp.source_id
       AND lp.source_type IN ('RFQ', 'RFQ_RESPONSE')
      LEFT JOIN rfq_response_revisions rr ON rr.id = rfl.rfq_response_revision_id
      LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
      LEFT JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
      LEFT JOIN rfqs rfq ON rfq.id = rs.rfq_id
      LEFT JOIN supplier_price_list_lines spll
        ON spll.id = lp.source_id
       AND lp.source_type = 'PRICE_LIST'
      LEFT JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
      LEFT JOIN (
        SELECT
          spo.supplier_part_id,
          GROUP_CONCAT(op.part_number ORDER BY op.part_number SEPARATOR ', ') AS oem_part_numbers
        FROM supplier_part_oem_parts spo
        JOIN oem_parts op ON op.id = spo.oem_part_id
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
    const oemLinksMode = nz(req.query.oem_links_mode) || nz(req.query.originals_mode) || ''
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

    if (oemLinksMode === 'linked') {
      where.push('EXISTS (SELECT 1 FROM supplier_part_oem_parts spo2 WHERE spo2.supplier_part_id = sp.id)')
    } else if (oemLinksMode === 'unlinked') {
      where.push('NOT EXISTS (SELECT 1 FROM supplier_part_oem_parts spo2 WHERE spo2.supplier_part_id = sp.id)')
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
        lp.price AS latest_price,
        lp.currency AS latest_currency,
        lp.date AS latest_price_date,
        lp.source_type AS latest_price_source_type,
        lp.source_subtype AS latest_price_source_subtype,
        rfl.entry_source AS latest_price_entry_source,
        rfq.id AS latest_price_rfq_id,
        rfq.rfq_number AS latest_price_rfq_number,
        rr.rev_number AS latest_price_rfq_rev_number,
        spl.id AS latest_price_price_list_id,
        spl.list_code AS latest_price_price_list_code,
        spl.list_name AS latest_price_price_list_name,
        spl.valid_from AS latest_price_price_list_valid_from,
        spl.valid_to AS latest_price_price_list_valid_to,
        oc.oem_part_numbers,
        oc.oem_part_numbers AS original_cat_numbers,
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
      LEFT JOIN rfq_response_lines rfl
        ON rfl.id = lp.source_id
       AND lp.source_type IN ('RFQ', 'RFQ_RESPONSE')
      LEFT JOIN rfq_response_revisions rr ON rr.id = rfl.rfq_response_revision_id
      LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
      LEFT JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
      LEFT JOIN rfqs rfq ON rfq.id = rs.rfq_id
      LEFT JOIN supplier_price_list_lines spll
        ON spll.id = lp.source_id
       AND lp.source_type = 'PRICE_LIST'
      LEFT JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
      LEFT JOIN (
        SELECT
          spo.supplier_part_id,
          GROUP_CONCAT(op.part_number ORDER BY op.part_number SEPARATOR ', ') AS oem_part_numbers
        FROM supplier_part_oem_parts spo
        JOIN oem_parts op ON op.id = spo.oem_part_id
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

router.get('/validate-number', async (req, res) => {
  try {
    const supplierId = toId(req.query.supplier_id)
    const excludeId = toId(req.query.exclude_id)
    const supplierPartNumber = nz(req.query.supplier_part_number)
    const canonical = canonicalPartNumber(supplierPartNumber)

    if (!supplierId) {
      return res.status(400).json({ message: 'Не выбран поставщик' })
    }
    if (!supplierPartNumber) {
      return res.status(400).json({ message: 'Не указан номер у поставщика' })
    }

    const where = ['supplier_id = ?']
    const params = [supplierId]

    where.push('(supplier_part_number = ? OR canonical_part_number = ?)')
    params.push(supplierPartNumber, canonical)

    if (excludeId) {
      where.push('id <> ?')
      params.push(excludeId)
    }

    const [[row]] = await db.execute(
      `
      SELECT id, supplier_part_number
      FROM supplier_parts
      WHERE ${where.join(' AND ')}
      LIMIT 1
      `,
      params
    )

    if (!row) return res.json({ exists: false })
    return res.json({
      exists: true,
      id: row.id,
      supplier_part_number: row.supplier_part_number,
      message: 'Такой номер уже существует у выбранного поставщика',
    })
  } catch (e) {
    console.error('GET /supplier-parts/validate-number error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

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
        lp.source_type AS latest_price_source_type,
        lp.source_subtype AS latest_price_source_subtype,
        rfl.entry_source AS latest_price_entry_source,
        rfq.id AS latest_price_rfq_id,
        rfq.rfq_number AS latest_price_rfq_number,
        rr.rev_number AS latest_price_rfq_rev_number,
        spl.id AS latest_price_price_list_id,
        spl.list_code AS latest_price_price_list_code,
        spl.list_name AS latest_price_price_list_name,
        spl.valid_from AS latest_price_price_list_valid_from,
        spl.valid_to AS latest_price_price_list_valid_to,
        oc.oem_part_numbers,
        oc.oem_part_numbers AS original_cat_numbers,
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
      LEFT JOIN rfq_response_lines rfl
        ON rfl.id = lp.source_id
       AND lp.source_type IN ('RFQ', 'RFQ_RESPONSE')
      LEFT JOIN rfq_response_revisions rr ON rr.id = rfl.rfq_response_revision_id
      LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
      LEFT JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
      LEFT JOIN rfqs rfq ON rfq.id = rs.rfq_id
      LEFT JOIN supplier_price_list_lines spll
        ON spll.id = lp.source_id
       AND lp.source_type = 'PRICE_LIST'
      LEFT JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
      LEFT JOIN (
        SELECT
          spo.supplier_part_id,
          GROUP_CONCAT(op.part_number ORDER BY op.part_number SEPARATOR ', ') AS oem_part_numbers
        FROM supplier_part_oem_parts spo
        JOIN oem_parts op ON op.id = spo.oem_part_id
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
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `
      SELECT
        op.id AS oem_part_id,
        op.id AS original_part_id,
        op.id,
        op.part_number AS oem_part_number,
        op.part_number AS cat_number,
        op.description_ru,
        op.description_en,
        m.model_name,
        mf.name AS manufacturer_name
      FROM supplier_part_oem_parts spo
      JOIN oem_parts op ON op.id = spo.oem_part_id
      LEFT JOIN oem_part_model_fitments f ON f.oem_part_id = op.id
      LEFT JOIN equipment_models m ON m.id = f.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
      WHERE spo.supplier_part_id = ?
      ORDER BY mf.name, m.model_name, op.part_number
      `,
      [id]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-parts/:id/originals (OEM links) error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const fields = withCanonicalPartNumber(pickSupplierPartFields(req.body))
    if (!fields.supplier_id) {
      return res.status(400).json({ message: 'Не выбран поставщик' })
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
    if (e?.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json({ message: 'Такой номер уже существует у выбранного поставщика' })
    }
    console.error('POST /supplier-parts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

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
    if (e?.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json({ message: 'Такой номер уже существует у выбранного поставщика' })
    }
    console.error('PUT /supplier-parts/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    await conn.beginTransaction()

    const [[part]] = await conn.execute('SELECT * FROM supplier_parts WHERE id = ? FOR UPDATE', [id])
    if (!part) {
      await conn.rollback()
      return res.status(404).json({ message: 'Позиция поставщика не найдена' })
    }

    const [materials] = await conn.execute(
      'SELECT * FROM supplier_part_materials WHERE supplier_part_id = ? ORDER BY material_id ASC',
      [id]
    )
    const [oemLinks] = await conn.execute(
      'SELECT * FROM supplier_part_oem_parts WHERE supplier_part_id = ? ORDER BY oem_part_id ASC',
      [id]
    )
    const [standardLinks] = await conn.execute(
      'SELECT * FROM supplier_part_standard_parts WHERE supplier_part_id = ? ORDER BY standard_part_id ASC',
      [id]
    )
    const [prices] = await conn.execute(
      'SELECT * FROM supplier_part_prices WHERE supplier_part_id = ? ORDER BY id ASC',
      [id]
    )

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'supplier_parts',
      entityId: id,
      rootEntityType: 'part_suppliers',
      rootEntityId: Number(part.supplier_id),
      title: part.supplier_part_number || part.canonical_part_number || `Позиция поставщика #${id}`,
      subtitle: part.part_type || null,
      snapshot: part,
      context: {
        supplier_id: Number(part.supplier_id),
        child_counts: {
          supplier_part_materials: materials.length,
          supplier_part_oem_parts: oemLinks.length,
          supplier_part_standard_parts: standardLinks.length,
          supplier_part_prices: prices.length,
        },
      },
    })

    let sortOrder = 0
    for (const row of materials) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_materials',
        itemId: null,
        itemRole: 'material_link',
        title: `Материал ${row.supplier_part_id}:${row.material_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of oemLinks) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_oem_parts',
        itemId: null,
        itemRole: 'oem_link',
        title: `OEM link ${row.supplier_part_id}:${row.oem_part_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of standardLinks) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_standard_parts',
        itemId: null,
        itemRole: 'standard_part_link',
        title: `Standard link ${row.supplier_part_id}:${row.standard_part_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of prices) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'supplier_part_prices',
        itemId: row.id,
        itemRole: 'price_history',
        title: `Цена #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }

    await conn.execute('DELETE FROM supplier_parts WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: Number(part.supplier_id),
      old_value: String(trashEntryId),
      comment: 'Позиция поставщика перемещена в корзину',
    })

    await conn.commit()
    res.json({ success: true, trash_entry_id: trashEntryId })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /supplier-parts/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
