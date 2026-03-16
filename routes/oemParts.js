const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { normalizeUom } = require('../utils/uom')

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const toBool = (v) => v === true || v === '1' || v === 1 || v === 'true'

const clampLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const sqlValue = (v) => (v === undefined ? null : v)

const parseCanonicalUom = (value) => {
  const { uom, error } = normalizeUom(value, { allowEmpty: false })
  if (error || uom === undefined) {
    return { uom: null, error: error || 'Единица измерения обязательна' }
  }
  return { uom, error: null }
}

const baseListSql = `
  SELECT
    p.id,
    p.manufacturer_id,
    m.name AS manufacturer_name,
    p.part_number,
    p.description_ru,
    p.description_en,
    p.tech_description,
    p.uom,
    p.tnved_code_id,
    tc.code AS tnved_code,
    p.group_id,
    g.name AS group_name,
    p.has_drawing,
    p.is_overweight,
    p.is_oversize,
    p.created_at,
    p.updated_at,
    COUNT(DISTINCT f.equipment_model_id) AS fitments_count,
    COUNT(DISTINCT opsp.standard_part_id) AS standard_links_count,
    COUNT(DISTINCT ceu.id) AS client_usage_count
  FROM oem_parts p
  JOIN equipment_manufacturers m ON m.id = p.manufacturer_id
  LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
  LEFT JOIN original_part_groups g ON g.id = p.group_id
  LEFT JOIN oem_part_model_fitments f ON f.oem_part_id = p.id
  LEFT JOIN client_equipment_units ceu ON ceu.equipment_model_id = f.equipment_model_id
  LEFT JOIN oem_part_standard_parts opsp ON opsp.oem_part_id = p.id
`

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const manufacturerId = req.query.manufacturer_id !== undefined ? toId(req.query.manufacturer_id) : null
    const equipmentModelId =
      req.query.equipment_model_id !== undefined ? toId(req.query.equipment_model_id) : null
    const limit = clampLimit(req.query.limit, 200)
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Math.trunc(Number(req.query.offset))) : 0

    if (req.query.manufacturer_id !== undefined && !manufacturerId) {
      return res.status(400).json({ message: 'Некорректный manufacturer_id' })
    }
    if (req.query.equipment_model_id !== undefined && !equipmentModelId) {
      return res.status(400).json({ message: 'Некорректный equipment_model_id' })
    }

    const where = []
    const params = []
    let sql = baseListSql

    if (manufacturerId) {
      where.push('p.manufacturer_id = ?')
      params.push(manufacturerId)
    }
    if (equipmentModelId) {
      where.push('EXISTS (SELECT 1 FROM oem_part_model_fitments x WHERE x.oem_part_id = p.id AND x.equipment_model_id = ?)')
      params.push(equipmentModelId)
    }
    if (q) {
      where.push(
        '(p.part_number LIKE ? OR p.description_ru LIKE ? OR p.description_en LIKE ? OR m.name LIKE ?)'
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += `
      GROUP BY
        p.id, p.manufacturer_id, m.name, p.part_number, p.description_ru, p.description_en,
        p.tech_description, p.uom, p.tnved_code_id, tc.code, p.group_id, g.name,
        p.has_drawing, p.is_overweight, p.is_oversize, p.created_at, p.updated_at
      ORDER BY m.name ASC, p.part_number ASC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /oem-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `
      SELECT
        p.*,
        m.name AS manufacturer_name,
        tc.code AS tnved_code,
        g.name AS group_name
      FROM oem_parts p
      JOIN equipment_manufacturers m ON m.id = p.manufacturer_id
      LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
      LEFT JOIN original_part_groups g ON g.id = p.group_id
      WHERE p.id = ?
      `,
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'OEM деталь не найдена' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /oem-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/full', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[part]] = await db.execute(
      `
      SELECT
        p.*,
        m.name AS manufacturer_name,
        tc.code AS tnved_code,
        tc.duty_rate AS tnved_duty_rate,
        g.name AS group_name
      FROM oem_parts p
      JOIN equipment_manufacturers m ON m.id = p.manufacturer_id
      LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
      LEFT JOIN original_part_groups g ON g.id = p.group_id
      WHERE p.id = ?
      `,
      [id]
    )
    if (!part) return res.status(404).json({ message: 'OEM деталь не найдена' })

    const [fitments] = await db.execute(
      `
      SELECT
        f.*,
        em.model_name,
        em.model_code,
        mf.name AS manufacturer_name,
        ecn.name AS classifier_node_name
      FROM oem_part_model_fitments f
      JOIN equipment_models em ON em.id = f.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
      LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id
      WHERE f.oem_part_id = ?
      ORDER BY mf.name, em.model_name
      `,
      [id]
    )

    const [standardParts] = await db.execute(
      `
      SELECT
        opsp.*,
        sp.part_type,
        sp.designation,
        sp.standard_system,
        sp.description_ru,
        sp.description_en
      FROM oem_part_standard_parts opsp
      JOIN standard_parts sp ON sp.id = opsp.standard_part_id
      WHERE opsp.oem_part_id = ?
      ORDER BY opsp.is_primary DESC, sp.part_type, sp.designation
      `,
      [id]
    )

    const [clientUsage] = await db.execute(
      `
      SELECT
        ceu.id,
        ceu.client_id,
        ceu.equipment_model_id,
        ceu.serial_number,
        ceu.manufacture_year,
        ceu.site_name,
        ceu.internal_name,
        ceu.status,
        c.company_name AS client_name,
        em.model_name,
        em.model_code,
        mf.name AS manufacturer_name
      FROM client_equipment_units ceu
      JOIN clients c ON c.id = ceu.client_id
      JOIN equipment_models em ON em.id = ceu.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
      WHERE EXISTS (
        SELECT 1
          FROM oem_part_model_fitments f
         WHERE f.oem_part_id = ?
           AND f.equipment_model_id = ceu.equipment_model_id
      )
      ORDER BY c.company_name, mf.name, em.model_name, ceu.serial_number
      `,
      [id]
    )

    const [[stats]] = await db.execute(
      `
      SELECT
        (SELECT COUNT(*) FROM oem_part_model_bom b WHERE b.parent_oem_part_id = ?) AS bom_children_count,
        (SELECT COUNT(*) FROM oem_part_model_bom b WHERE b.child_oem_part_id = ?) AS where_used_count,
        (SELECT COUNT(*) FROM oem_part_documents d WHERE d.oem_part_id = ?) AS documents_count,
        (SELECT COUNT(*) FROM oem_part_materials m WHERE m.oem_part_id = ?) AS materials_count,
        (SELECT COUNT(*) FROM supplier_bundles sb WHERE sb.oem_part_id = ?) AS bundles_count,
        (SELECT COUNT(*) FROM client_equipment_units ceu
          WHERE EXISTS (
            SELECT 1
              FROM oem_part_model_fitments f
             WHERE f.oem_part_id = ?
               AND f.equipment_model_id = ceu.equipment_model_id
          )
        ) AS client_usage_count
      `,
      [id, id, id, id, id, id]
    )

    res.json({
      ...part,
      fitments,
      standard_parts: standardParts,
      client_usage: clientUsage,
      stats: stats || {},
    })
  } catch (err) {
    console.error('GET /oem-parts/:id/full error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const manufacturer_id = toId(req.body.manufacturer_id)
    const part_number = nz(req.body.part_number)
    const description_ru = nz(req.body.description_ru)
    const description_en = nz(req.body.description_en)
    const tech_description = nz(req.body.tech_description)
    const { uom, error: uomError } = parseCanonicalUom(req.body.uom || 'pcs')
    const tnved_code_id = req.body.tnved_code_id === undefined ? null : toId(req.body.tnved_code_id)
    const group_id = req.body.group_id === undefined ? null : toId(req.body.group_id)
    const has_drawing = toBool(req.body.has_drawing) ? 1 : 0
    const is_overweight = toBool(req.body.is_overweight) ? 1 : 0
    const is_oversize = toBool(req.body.is_oversize) ? 1 : 0
    const equipment_model_ids = Array.isArray(req.body.equipment_model_ids)
      ? req.body.equipment_model_ids.map(toId).filter(Boolean)
      : []

    if (!manufacturer_id) return res.status(400).json({ message: 'manufacturer_id обязателен' })
    if (!part_number) return res.status(400).json({ message: 'part_number обязателен' })
    if (uomError) return res.status(400).json({ message: uomError })

    const [[mfr]] = await db.execute('SELECT id FROM equipment_manufacturers WHERE id = ?', [manufacturer_id])
    if (!mfr) return res.status(400).json({ message: 'Производитель не найден' })

    const [ins] = await db.execute(
      `
      INSERT INTO oem_parts
        (
          manufacturer_id, part_number, description_ru, description_en, tech_description,
          uom, tnved_code_id, group_id, has_drawing, is_overweight, is_oversize
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        manufacturer_id,
        part_number,
        description_ru,
        description_en,
        tech_description,
        uom,
        tnved_code_id,
        group_id,
        has_drawing,
        is_overweight,
        is_oversize,
      ]
    )

    if (equipment_model_ids.length) {
      const placeholders = equipment_model_ids.map(() => '(?, ?)').join(', ')
      const values = []
      equipment_model_ids.forEach((modelId) => values.push(ins.insertId, modelId))
      await db.execute(
        `INSERT IGNORE INTO oem_part_model_fitments (oem_part_id, equipment_model_id) VALUES ${placeholders}`,
        values
      )
    }

    const [[created]] = await db.execute('SELECT * FROM oem_parts WHERE id = ?', [ins.insertId])
    await logActivity({
      req,
      action: 'create',
      entity_type: 'oem_parts',
      entity_id: ins.insertId,
      comment: 'Создана OEM деталь',
    })
    res.status(201).json(created)
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Такая OEM деталь уже существует у производителя' })
    }
    console.error('POST /oem-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await conn.execute('SELECT * FROM oem_parts WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'OEM деталь не найдена' })

    const manufacturer_id = req.body.manufacturer_id !== undefined ? toId(req.body.manufacturer_id) : undefined
    const part_number = req.body.part_number !== undefined ? nz(req.body.part_number) : undefined
    const description_ru = req.body.description_ru !== undefined ? nz(req.body.description_ru) : undefined
    const description_en = req.body.description_en !== undefined ? nz(req.body.description_en) : undefined
    const tech_description =
      req.body.tech_description !== undefined ? nz(req.body.tech_description) : undefined
    let uom
    if (req.body.uom !== undefined) {
      const parsed = parseCanonicalUom(req.body.uom)
      if (parsed.error) return res.status(400).json({ message: parsed.error })
      uom = parsed.uom
    }
    const tnved_code_id =
      req.body.tnved_code_id !== undefined
        ? (req.body.tnved_code_id === null || req.body.tnved_code_id === '' ? null : toId(req.body.tnved_code_id))
        : undefined
    const group_id =
      req.body.group_id !== undefined
        ? (req.body.group_id === null || req.body.group_id === '' ? null : toId(req.body.group_id))
        : undefined
    const has_drawing = req.body.has_drawing !== undefined ? (toBool(req.body.has_drawing) ? 1 : 0) : undefined
    const is_overweight = req.body.is_overweight !== undefined ? (toBool(req.body.is_overweight) ? 1 : 0) : undefined
    const is_oversize = req.body.is_oversize !== undefined ? (toBool(req.body.is_oversize) ? 1 : 0) : undefined
    const equipment_model_ids = Array.isArray(req.body.equipment_model_ids)
      ? req.body.equipment_model_ids.map(toId).filter(Boolean)
      : null

    await conn.beginTransaction()
    await conn.execute(
      `
      UPDATE oem_parts
         SET manufacturer_id = COALESCE(?, manufacturer_id),
             part_number = COALESCE(?, part_number),
             description_ru = COALESCE(?, description_ru),
             description_en = COALESCE(?, description_en),
             tech_description = COALESCE(?, tech_description),
             uom = COALESCE(?, uom),
             tnved_code_id = ?,
             group_id = ?,
             has_drawing = COALESCE(?, has_drawing),
             is_overweight = COALESCE(?, is_overweight),
             is_oversize = COALESCE(?, is_oversize)
       WHERE id = ?
      `,
      [
        sqlValue(manufacturer_id),
        sqlValue(part_number),
        sqlValue(description_ru),
        sqlValue(description_en),
        sqlValue(tech_description),
        sqlValue(uom),
        tnved_code_id === undefined ? before.tnved_code_id : tnved_code_id,
        group_id === undefined ? before.group_id : group_id,
        sqlValue(has_drawing),
        sqlValue(is_overweight),
        sqlValue(is_oversize),
        id,
      ]
    )

    if (equipment_model_ids) {
      await conn.execute('DELETE FROM oem_part_model_fitments WHERE oem_part_id = ?', [id])
      if (equipment_model_ids.length) {
        const placeholders = equipment_model_ids.map(() => '(?, ?)').join(', ')
        const values = []
        equipment_model_ids.forEach((modelId) => values.push(id, modelId))
        await conn.execute(
          `INSERT IGNORE INTO oem_part_model_fitments (oem_part_id, equipment_model_id) VALUES ${placeholders}`,
          values
        )
      }
    }

    await conn.commit()

    const [[after]] = await db.execute('SELECT * FROM oem_parts WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'oem_parts',
      entity_id: id,
      oldData: before,
      newData: after,
    })

    res.json(after)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Такая OEM деталь уже существует у производителя' })
    }
    console.error('PUT /oem-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT id, part_number FROM oem_parts WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'OEM деталь не найдена' })

    await db.execute('DELETE FROM oem_parts WHERE id = ?', [id])
    await logActivity({
      req,
      action: 'delete',
      entity_type: 'oem_parts',
      entity_id: id,
      comment: `Удалена OEM деталь: ${before.part_number}`,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /oem-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
