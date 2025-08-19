// routes/originalParts.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === undefined || v === null ? null : String(v).trim() || null)

// helper: резолвим tnved_code_id (по id или строковому коду)
async function resolveTnvedId(db, tnved_code_id, tnved_code) {
  if (tnved_code_id !== undefined && tnved_code_id !== null) {
    const id = Number(tnved_code_id)
    if (Number.isFinite(id)) return id
  }
  const code = nz(tnved_code)
  if (!code) return null
  const [rows] = await db.execute('SELECT id FROM tnved_codes WHERE code=?', [code])
  if (!rows.length) throw new Error('TNVED_NOT_FOUND')
  return rows[0].id
}

// ------------------------------------------------------------------
// LIST с вычисляемыми полями + фильтрами
// GET /original-parts?manufacturer_id=1&equipment_model_id=10&q=bolt&only_assemblies=1
// ------------------------------------------------------------------
router.get('/', auth, async (req, res) => {
  try {
    const { manufacturer_id, equipment_model_id, q, only_assemblies, only_parts } = req.query
    const params = []
    const where = []

    let sql = `
      SELECT
        p.*,
        m.model_name,
        mf.name AS manufacturer_name,
        COALESCE(ch.cnt, 0)  AS children_count,
        COALESCE(pr.cnt, 0)  AS parent_count,
        (COALESCE(ch.cnt, 0) > 0) AS is_assembly
      FROM original_parts p
      JOIN equipment_models m ON m.id = p.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
      LEFT JOIN (
        SELECT parent_part_id, COUNT(*) cnt
        FROM original_part_bom
        GROUP BY parent_part_id
      ) ch ON ch.parent_part_id = p.id
      LEFT JOIN (
        SELECT child_part_id, COUNT(*) cnt
        FROM original_part_bom
        GROUP BY child_part_id
      ) pr ON pr.child_part_id = p.id
    `

    if (manufacturer_id !== undefined) {
      where.push('mf.id = ?'); params.push(Number(manufacturer_id))
    }
    if (equipment_model_id !== undefined) {
      where.push('m.id = ?'); params.push(Number(equipment_model_id))
    }
    if (q && String(q).trim() !== '') {
      where.push('(p.cat_number LIKE ? OR p.description_en LIKE ? OR p.description_ru LIKE ? OR p.tech_description LIKE ?)')
      params.push(`%${q.trim()}%`, `%${q.trim()}%`, `%${q.trim()}%`, `%${q.trim()}%`)
    }
    if (only_assemblies === '1' || only_assemblies === 'true') {
      where.push('COALESCE(ch.cnt,0) > 0')
    }
    if (only_parts === '1' || only_parts === 'true') {
      where.push('COALESCE(ch.cnt,0) = 0')
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY p.id DESC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении оригинальных деталей:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// CREATE
// ------------------------------------------------------------------
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const {
      cat_number,
      equipment_model_id,
      description_en,
      description_ru,
      tech_description,
      weight_kg,
      tnved_code_id,
      tnved_code
    } = req.body

    if (!nz(cat_number)) return res.status(400).json({ message: 'cat_number обязателен' })
    const modelId = Number(equipment_model_id)
    if (!Number.isFinite(modelId)) return res.status(400).json({ message: 'equipment_model_id обязателен' })

    let tnvedId = null
    try {
      tnvedId = await resolveTnvedId(db, tnved_code_id, tnved_code)
    } catch (e) {
      if (e.message === 'TNVED_NOT_FOUND') {
        return res.status(400).json({ message: 'Код ТН ВЭД не найден в справочнике' })
      }
      throw e
    }

    try {
      await db.execute(
        `INSERT INTO original_parts
         (equipment_model_id, cat_number, description_en, description_ru, tech_description, weight_kg, tnved_code_id)
         VALUES (?,?,?,?,?,?,?)`,
        [modelId, nz(cat_number), nz(description_en), nz(description_ru), nz(tech_description), weight_kg ?? null, tnvedId]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Дубликат cat_number' })
      }
      throw e
    }

    const [row] = await db.execute('SELECT * FROM original_parts WHERE id = LAST_INSERT_ID()')

    await logActivity({
      req,
      action: 'create',
      entity_type: 'original_parts',
      entity_id: row[0].id,
      comment: `Создана деталь: ${row[0].cat_number}`
    })

    res.status(201).json(row[0])
  } catch (err) {
    console.error('Ошибка при добавлении оригинальной детали:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// UPDATE
// ------------------------------------------------------------------
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const {
      cat_number,
      equipment_model_id,
      description_en,
      description_ru,
      tech_description,
      weight_kg,
      tnved_code_id,
      tnved_code
    } = req.body

    const modelId = equipment_model_id !== undefined ? Number(equipment_model_id) : undefined

    let tnvedId = undefined
    if (tnved_code_id !== undefined || tnved_code !== undefined) {
      try {
        tnvedId = await resolveTnvedId(db, tnved_code_id, tnved_code)
      } catch (e) {
        if (e.message === 'TNVED_NOT_FOUND') {
          return res.status(400).json({ message: 'Код ТН ВЭД не найден в справочнике' })
        }
        throw e
      }
    }

    const [oldRows] = await db.execute('SELECT * FROM original_parts WHERE id=?', [id])

    try {
      await db.execute(
        `UPDATE original_parts
           SET cat_number         = COALESCE(?, cat_number),
               equipment_model_id = COALESCE(?, equipment_model_id),
               description_en     = COALESCE(?, description_en),
               description_ru     = COALESCE(?, description_ru),
               tech_description   = COALESCE(?, tech_description),
               weight_kg          = COALESCE(?, weight_kg),
               tnved_code_id      = COALESCE(?, tnved_code_id)
         WHERE id = ?`,
        [nz(cat_number), modelId, nz(description_en), nz(description_ru), nz(tech_description), weight_kg ?? null, tnvedId ?? null, id]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Дубликат cat_number' })
      }
      throw e
    }

    const [fresh] = await db.execute('SELECT * FROM original_parts WHERE id=?', [id])

    await logFieldDiffs({
      req,
      oldData: oldRows[0],
      newData: fresh[0],
      entity_type: 'original_parts',
      entity_id: id
    })

    res.json(fresh[0])
  } catch (err) {
    console.error('Ошибка при обновлении оригинальной детали:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// PATCH: привязать/снять ТН ВЭД у детали
// PATCH /original-parts/:id/tnved  body: { tnved_code_id? | tnved_code? | null }
// ------------------------------------------------------------------
router.patch('/:id/tnved', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const { tnved_code_id, tnved_code } = req.body

    let tnvedId = null
    if (tnved_code_id === null || tnved_code === null) {
      tnvedId = null // снять привязку
    } else if (tnved_code_id !== undefined || tnved_code !== undefined) {
      tnvedId = await resolveTnvedId(db, tnved_code_id, tnved_code)
      if (tnvedId == null) return res.status(400).json({ message: 'Код ТН ВЭД не указан' })
    } else {
      return res.status(400).json({ message: 'Укажите tnved_code_id или tnved_code (или null, чтобы снять)' })
    }

    const [before] = await db.execute('SELECT * FROM original_parts WHERE id=?', [id])
    if (!before.length) return res.status(404).json({ message: 'Деталь не найдена' })

    await db.execute('UPDATE original_parts SET tnved_code_id=? WHERE id=?', [tnvedId, id])

    const [after] = await db.execute('SELECT * FROM original_parts WHERE id=?', [id])

    await logFieldDiffs({
      req,
      oldData: before[0],
      newData: after[0],
      entity_type: 'original_parts',
      entity_id: id,
      comment: 'Привязка ТН ВЭД'
    })

    res.json(after[0])
  } catch (e) {
    if (e.message === 'TNVED_NOT_FOUND') {
      return res.status(400).json({ message: 'Указанный код ТН ВЭД не найден в справочнике' })
    }
    console.error('PATCH /original-parts/:id/tnved error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// DELETE
// ------------------------------------------------------------------
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT * FROM original_parts WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Деталь не найдена' })

    try {
      await db.execute('DELETE FROM original_parts WHERE id=?', [id])
    } catch (fkErr) {
      console.error('FK error:', fkErr)
      return res.status(409).json({
        message: 'Удаление невозможно: есть связанные записи (BOM/замены/и т.п.)'
      })
    }

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'original_parts',
      entity_id: id,
      comment: `Удалена деталь: ${exists[0].cat_number}`
    })

    res.json({ message: 'Деталь удалена' })
  } catch (err) {
    console.error('Ошибка при удалении оригинальной детали:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
