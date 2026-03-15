const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

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

const baseSelect = `
  SELECT sp.*,
         (
           SELECT COUNT(*)
             FROM oem_part_standard_parts opsp
            WHERE opsp.standard_part_id = sp.id
         ) AS oem_links_count,
         (
           SELECT COUNT(*)
             FROM supplier_part_standard_parts spsp
            WHERE spsp.standard_part_id = sp.id
         ) AS supplier_links_count
    FROM standard_parts sp
`

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const partType = nz(req.query.part_type)
    const standardSystem = nz(req.query.standard_system)
    const activeRaw = req.query.is_active
    const linkedToOemId = req.query.oem_part_id !== undefined ? toId(req.query.oem_part_id) : null
    const limit = clampLimit(req.query.limit, 200)
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Math.trunc(Number(req.query.offset))) : 0

    if (req.query.oem_part_id !== undefined && !linkedToOemId) {
      return res.status(400).json({ message: 'Некорректный oem_part_id' })
    }

    const where = []
    const params = []
    let sql = baseSelect

    if (q) {
      where.push(
        `(sp.designation LIKE ? OR sp.part_type LIKE ? OR sp.standard_system LIKE ? OR sp.material_spec LIKE ? OR sp.description_ru LIKE ? OR sp.description_en LIKE ?)`
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }
    if (partType) {
      where.push('sp.part_type = ?')
      params.push(partType)
    }
    if (standardSystem) {
      where.push('sp.standard_system = ?')
      params.push(standardSystem)
    }
    if (activeRaw !== undefined) {
      where.push('sp.is_active = ?')
      params.push(toBool(activeRaw) ? 1 : 0)
    }
    if (linkedToOemId) {
      where.push('EXISTS (SELECT 1 FROM oem_part_standard_parts opsp WHERE opsp.standard_part_id = sp.id AND opsp.oem_part_id = ?)')
      params.push(linkedToOemId)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY sp.part_type ASC, sp.designation ASC'
    sql += ` LIMIT ${limit} OFFSET ${offset}`

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /standard-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(`${baseSelect} WHERE sp.id = ?`, [id])
    if (!rows.length) return res.status(404).json({ message: 'Стандартная деталь не найдена' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /standard-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const payload = {
      part_type: nz(req.body.part_type),
      designation: nz(req.body.designation),
      standard_system: nz(req.body.standard_system),
      strength_class: nz(req.body.strength_class),
      material_spec: nz(req.body.material_spec),
      coating: nz(req.body.coating),
      thread_spec: nz(req.body.thread_spec),
      size_note: nz(req.body.size_note),
      uom: nz(req.body.uom) || 'pcs',
      description_ru: nz(req.body.description_ru),
      description_en: nz(req.body.description_en),
      notes: nz(req.body.notes),
      is_active: req.body.is_active === undefined ? 1 : (toBool(req.body.is_active) ? 1 : 0),
    }

    if (!payload.part_type) return res.status(400).json({ message: 'part_type обязателен' })
    if (!payload.designation) return res.status(400).json({ message: 'designation обязателен' })

    const [ins] = await db.execute(
      `
      INSERT INTO standard_parts
        (
          part_type, designation, standard_system, strength_class, material_spec,
          coating, thread_spec, size_note, uom, description_ru, description_en, notes, is_active
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        payload.part_type,
        payload.designation,
        payload.standard_system,
        payload.strength_class,
        payload.material_spec,
        payload.coating,
        payload.thread_spec,
        payload.size_note,
        payload.uom,
        payload.description_ru,
        payload.description_en,
        payload.notes,
        payload.is_active,
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM standard_parts WHERE id = ?', [ins.insertId])
    await logActivity({
      req,
      action: 'create',
      entity_type: 'standard_parts',
      entity_id: ins.insertId,
      comment: 'Создана стандартная деталь',
    })

    res.status(201).json(created)
  } catch (err) {
    console.error('POST /standard-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM standard_parts WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Стандартная деталь не найдена' })

    const payload = {
      part_type: req.body.part_type !== undefined ? nz(req.body.part_type) : undefined,
      designation: req.body.designation !== undefined ? nz(req.body.designation) : undefined,
      standard_system: req.body.standard_system !== undefined ? nz(req.body.standard_system) : undefined,
      strength_class: req.body.strength_class !== undefined ? nz(req.body.strength_class) : undefined,
      material_spec: req.body.material_spec !== undefined ? nz(req.body.material_spec) : undefined,
      coating: req.body.coating !== undefined ? nz(req.body.coating) : undefined,
      thread_spec: req.body.thread_spec !== undefined ? nz(req.body.thread_spec) : undefined,
      size_note: req.body.size_note !== undefined ? nz(req.body.size_note) : undefined,
      uom: req.body.uom !== undefined ? nz(req.body.uom) : undefined,
      description_ru: req.body.description_ru !== undefined ? nz(req.body.description_ru) : undefined,
      description_en: req.body.description_en !== undefined ? nz(req.body.description_en) : undefined,
      notes: req.body.notes !== undefined ? nz(req.body.notes) : undefined,
      is_active: req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : undefined,
    }

    if (payload.part_type !== undefined && !payload.part_type) {
      return res.status(400).json({ message: 'part_type не может быть пустым' })
    }
    if (payload.designation !== undefined && !payload.designation) {
      return res.status(400).json({ message: 'designation не может быть пустым' })
    }

    await db.execute(
      `
      UPDATE standard_parts
         SET part_type = COALESCE(?, part_type),
             designation = COALESCE(?, designation),
             standard_system = COALESCE(?, standard_system),
             strength_class = COALESCE(?, strength_class),
             material_spec = COALESCE(?, material_spec),
             coating = COALESCE(?, coating),
             thread_spec = COALESCE(?, thread_spec),
             size_note = COALESCE(?, size_note),
             uom = COALESCE(?, uom),
             description_ru = COALESCE(?, description_ru),
             description_en = COALESCE(?, description_en),
             notes = COALESCE(?, notes),
             is_active = COALESCE(?, is_active)
       WHERE id = ?
      `,
      [
        sqlValue(payload.part_type),
        sqlValue(payload.designation),
        sqlValue(payload.standard_system),
        sqlValue(payload.strength_class),
        sqlValue(payload.material_spec),
        sqlValue(payload.coating),
        sqlValue(payload.thread_spec),
        sqlValue(payload.size_note),
        sqlValue(payload.uom),
        sqlValue(payload.description_ru),
        sqlValue(payload.description_en),
        sqlValue(payload.notes),
        sqlValue(payload.is_active),
        id,
      ]
    )

    const [[after]] = await db.execute('SELECT * FROM standard_parts WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'standard_parts',
      entity_id: id,
      oldData: before,
      newData: after,
    })

    res.json(after)
  } catch (err) {
    console.error('PUT /standard-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM standard_parts WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Стандартная деталь не найдена' })

    await db.execute('DELETE FROM standard_parts WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'standard_parts',
      entity_id: id,
      comment: `Удалена стандартная деталь: ${before.designation}`,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /standard-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
