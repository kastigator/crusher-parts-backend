// routes/originalParts.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

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

// ----------------------------------------------
// LIST с фильтрами
// GET /original-parts?manufacturer_id=1&equipment_model_id=10&q=bolt
// ----------------------------------------------
router.get('/', auth, async (req, res) => {
  try {
    const { manufacturer_id, equipment_model_id, q } = req.query
    const params = []
    const where = []
    let sql =
      `SELECT p.*, m.model_name, mf.name AS manufacturer_name
       FROM original_parts p
       JOIN equipment_models m ON m.id = p.equipment_model_id
       JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id`

    if (manufacturer_id !== undefined) {
      where.push('mf.id = ?'); params.push(Number(manufacturer_id))
    }
    if (equipment_model_id !== undefined) {
      where.push('m.id = ?'); params.push(Number(equipment_model_id))
    }
    if (q && String(q).trim() !== '') {
      where.push('(p.cat_number LIKE ? OR p.description_en LIKE ? OR p.description_ru LIKE ?)')
      params.push(`%${q.trim()}%`, `%${q.trim()}%`, `%${q.trim()}%`)
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

// ----------------------------------------------
// CREATE
// ----------------------------------------------
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const {
      cat_number,
      equipment_model_id,
      description_en,
      description_ru,
      weight_kg,
      tnved_code_id,
      tnved_code
    } = req.body

    if (!nz(cat_number)) return res.status(400).json({ message: 'cat_number обязателен' })
    const modelId = Number(equipment_model_id)
    if (!Number.isFinite(modelId)) return res.status(400).json({ message: 'equipment_model_id обязателен' })

    let tnvedId = null
    try { tnvedId = await resolveTnvedId(db, tnved_code_id, tnved_code) }
    catch (e) {
      if (e.message === 'TNVED_NOT_FOUND') {
        return res.status(400).json({ message: 'Код ТН ВЭД не найден в справочнике' })
      }
      throw e
    }

    await db.execute(
      `INSERT INTO original_parts
       (equipment_model_id, cat_number, description_en, description_ru, weight_kg, tnved_code_id)
       VALUES (?,?,?,?,?,?)`,
      [modelId, nz(cat_number), nz(description_en), nz(description_ru), weight_kg ?? null, tnvedId]
    )

    const [row] = await db.execute('SELECT * FROM original_parts WHERE id = LAST_INSERT_ID()')
    res.status(201).json(row[0])
  } catch (err) {
    console.error('Ошибка при добавлении оригинальной детали:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// UPDATE
// ----------------------------------------------
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const {
      cat_number,
      equipment_model_id,
      description_en,
      description_ru,
      weight_kg,
      tnved_code_id,
      tnved_code
    } = req.body

    const modelId = equipment_model_id !== undefined ? Number(equipment_model_id) : undefined

    let tnvedId = undefined
    if (tnved_code_id !== undefined || tnved_code !== undefined) {
      try { tnvedId = await resolveTnvedId(db, tnved_code_id, tnved_code) }
      catch (e) {
        if (e.message === 'TNVED_NOT_FOUND') {
          return res.status(400).json({ message: 'Код ТН ВЭД не найден в справочнике' })
        }
        throw e
      }
    }

    await db.execute(
      `UPDATE original_parts
         SET cat_number        = COALESCE(?, cat_number),
             equipment_model_id= COALESCE(?, equipment_model_id),
             description_en    = COALESCE(?, description_en),
             description_ru    = COALESCE(?, description_ru),
             weight_kg         = COALESCE(?, weight_kg),
             tnved_code_id     = COALESCE(?, tnved_code_id)
       WHERE id = ?`,
      [nz(cat_number), modelId, nz(description_en), nz(description_ru), weight_kg ?? null, tnvedId ?? null, id]
    )

    const [row] = await db.execute('SELECT * FROM original_parts WHERE id=?', [id])
    res.json(row[0])
  } catch (err) {
    console.error('Ошибка при обновлении оригинальной детали:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// DELETE
// ----------------------------------------------
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT id FROM original_parts WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Деталь не найдена' })

    try {
      await db.execute('DELETE FROM original_parts WHERE id=?', [id])
      res.json({ message: 'Деталь удалена' })
    } catch (fkErr) {
      console.error('FK error:', fkErr)
      return res.status(409).json({
        message: 'Удаление невозможно: есть связанные записи (BOM/замены/и т.п.)'
      })
    }
  } catch (err) {
    console.error('Ошибка при удалении оригинальной детали:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
