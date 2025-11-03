// routes/supplierPartOriginals.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// 🧾 лог истории
const logActivity = require('../utils/logActivity')

// helpers
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)

/** ------------------------------------------------------------------
 * Резолвер оригинальной детали:
 *  - по id
 *  - или по cat_number (+ equipment_model_id при множественных совпадениях)
 * Сообщения ошибок согласованы с фронтом и другими роутами.
 * ------------------------------------------------------------------ */
async function resolveOriginalPartId({ original_part_id, original_part_cat_number, equipment_model_id }) {
  if (original_part_id !== undefined && original_part_id !== null) {
    const id = toId(original_part_id)
    if (!id) throw new Error('ORIGINAL_ID_INVALID')
    const [[row]] = await db.execute('SELECT id FROM original_parts WHERE id = ?', [id])
    if (!row) throw new Error('ORIGINAL_NOT_FOUND')
    return id
  }

  const cat = nz(original_part_cat_number)
  if (!cat) throw new Error('ORIGINAL_CAT_REQUIRED')

  const [rows] = await db.execute(
    'SELECT id, equipment_model_id FROM original_parts WHERE cat_number = ?',
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

/* ================================================================
   GET /supplier-part-originals?supplier_part_id=123
   Список привязок «деталь поставщика → оригинальная деталь»
   Возвращает: cat_number, описания, а также модель/производителя.
   ================================================================ */
router.get('/', auth, async (req, res) => {
  try {
    const supplier_part_id = toId(req.query.supplier_part_id)
    if (!supplier_part_id) {
      return res.status(400).json({ message: 'supplier_part_id обязателен' })
    }

    const [rows] = await db.execute(
      `SELECT
         spo.original_part_id,
         op.cat_number,
         op.description_ru,
         op.description_en,
         op.equipment_model_id,
         m.model_name,
         m.manufacturer_id,
         mf.name AS manufacturer_name
       FROM supplier_part_originals spo
       JOIN original_parts op          ON op.id = spo.original_part_id
       JOIN equipment_models m         ON m.id = op.equipment_model_id
       JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
       WHERE spo.supplier_part_id = ?
       ORDER BY mf.name, m.model_name, op.cat_number`,
      [supplier_part_id]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-part-originals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   POST /supplier-part-originals
   body:
     - supplier_part_id (required)
     - либо original_part_id
     - либо original_part_cat_number (+ equipment_model_id при дубликатах)
   ================================================================ */
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const supplier_part_id = toId(req.body.supplier_part_id)
    if (!supplier_part_id) {
      return res.status(400).json({ message: 'supplier_part_id обязателен' })
    }

    // проверим, что деталь поставщика существует
    const [[sp]] = await db.execute('SELECT id FROM supplier_parts WHERE id = ?', [supplier_part_id])
    if (!sp) return res.status(400).json({ message: 'Деталь поставщика не найдена' })

    // резолвим оригинал
    let original_part_id
    try {
      original_part_id = await resolveOriginalPartId({
        original_part_id: req.body.original_part_id,
        original_part_cat_number: req.body.original_part_cat_number,
        equipment_model_id: req.body.equipment_model_id
      })
    } catch (e) {
      const map = {
        ORIGINAL_ID_INVALID:        'Некорректный original_part_id',
        ORIGINAL_CAT_REQUIRED:      'Укажите original_part_id или original_part_cat_number',
        ORIGINAL_AMBIGUOUS:         'Найдено несколько деталей с таким cat_number. Укажите equipment_model_id.',
        ORIGINAL_NOT_FOUND:         'Оригинальная деталь не найдена',
        ORIGINAL_NOT_FOUND_IN_MODEL:'В указанной модели такая деталь не найдена'
      }
      return res.status(400).json({ message: map[e.message] || 'Ошибка в данных для привязки' })
    }

    // создаём связь
    try {
      await db.execute(
        'INSERT INTO supplier_part_originals (supplier_part_id, original_part_id) VALUES (?, ?)',
        [supplier_part_id, original_part_id]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Такая привязка уже существует' })
      }
      throw e
    }

    // лог
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

    res.status(201).json({ message: 'Привязка добавлена' })
  } catch (e) {
    console.error('POST /supplier-part-originals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   DELETE /supplier-part-originals
   body: { supplier_part_id, original_part_id }
   ================================================================ */
router.delete('/', auth, adminOnly, async (req, res) => {
  try {
    const supplier_part_id = toId(req.body.supplier_part_id)
    const original_part_id = toId(req.body.original_part_id)
    if (!supplier_part_id || !original_part_id) {
      return res.status(400).json({ message: 'supplier_part_id и original_part_id обязательны' })
    }

    const [del] = await db.execute(
      'DELETE FROM supplier_part_originals WHERE supplier_part_id = ? AND original_part_id = ?',
      [supplier_part_id, original_part_id]
    )
    if (del.affectedRows === 0) {
      return res.status(404).json({ message: 'Привязка не найдена' })
    }

    // лог
    await logActivity({
      req,
      action: 'update',
      entity_type: 'supplier_parts',
      entity_id: supplier_part_id,
      field_changed: 'original_link_removed',
      old_value: String(original_part_id),
      new_value: '',
      comment: 'Удалена привязка к оригинальной детали'
    })

    res.json({ message: 'Привязка удалена' })
  } catch (e) {
    console.error('DELETE /supplier-part-originals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
