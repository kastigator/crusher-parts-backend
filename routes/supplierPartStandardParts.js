const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const toPriorityRank = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 999) return null
  return n
}

const toPreferredFlag = (v) => {
  if (v === undefined || v === null || v === '') return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  if (Number.isInteger(n)) return n > 0 ? 1 : 0
  const s = String(v).trim().toLowerCase()
  if (!s) return 0
  if (['true', 'yes', 'y', 'да', 'on'].includes(s)) return 1
  return 0
}

const resolvePreferred = (body = {}) => {
  if (Object.prototype.hasOwnProperty.call(body, 'is_preferred')) {
    return toPreferredFlag(body.is_preferred)
  }
  return toPriorityRank(body.priority_rank) ? 1 : 0
}

router.get('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.query.supplier_part_id)
    if (!supplier_part_id) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика' })
    }

    const [rows] = await db.execute(
      `
      SELECT
        spsp.standard_part_id,
        spsp.priority_rank,
        spsp.is_preferred,
        spsp.note,
        sp.class_id,
        sp.display_name,
        sp.designation,
        sp.description_ru,
        sp.description_en,
        spc.name AS class_name
      FROM supplier_part_standard_parts spsp
      JOIN standard_parts sp ON sp.id = spsp.standard_part_id
      LEFT JOIN standard_part_classes spc ON spc.id = sp.class_id
      WHERE spsp.supplier_part_id = ?
      ORDER BY sp.display_name ASC, sp.id ASC
      `,
      [supplier_part_id]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-part-standard-parts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.body.supplier_part_id)
    const standard_part_id = toId(req.body.standard_part_id)
    const is_preferred = resolvePreferred(req.body)
    const note = req.body.note === undefined || req.body.note === null ? null : String(req.body.note).trim() || null

    if (!supplier_part_id || !standard_part_id) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика и стандартную деталь' })
    }

    const [[supplierPart]] = await db.execute('SELECT id FROM supplier_parts WHERE id = ?', [supplier_part_id])
    if (!supplierPart) {
      return res.status(400).json({ message: 'Деталь поставщика не найдена' })
    }

    const [[standardPart]] = await db.execute('SELECT id FROM standard_parts WHERE id = ?', [standard_part_id])
    if (!standardPart) {
      return res.status(400).json({ message: 'Стандартная деталь не найдена' })
    }

    await db.execute(
      `
      INSERT INTO supplier_part_standard_parts
        (supplier_part_id, standard_part_id, priority_rank, is_preferred, note)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        priority_rank = VALUES(priority_rank),
        is_preferred = VALUES(is_preferred),
        note = VALUES(note)
      `,
      [supplier_part_id, standard_part_id, null, is_preferred, note]
    )

    await logActivity({
      req,
      entity_type: 'supplier_part_standard_parts',
      entity_id: supplier_part_id,
      action: 'create',
      comment: `Связь со стандартной деталью ${standard_part_id}, приоритетная: ${is_preferred ? 'да' : 'нет'}`,
    })

    res.json({ success: true })
  } catch (e) {
    console.error('POST /supplier-part-standard-parts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.patch('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.body.supplier_part_id)
    const standard_part_id = toId(req.body.standard_part_id)
    const is_preferred = resolvePreferred(req.body)
    const note = req.body.note === undefined ? undefined : (req.body.note === null ? null : String(req.body.note).trim() || null)

    if (!supplier_part_id || !standard_part_id) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика и стандартную деталь' })
    }

    const [result] = await db.execute(
      `
      UPDATE supplier_part_standard_parts
         SET priority_rank = ?,
             is_preferred = ?,
             note = COALESCE(?, note)
       WHERE supplier_part_id = ? AND standard_part_id = ?
      `,
      [null, is_preferred, note, supplier_part_id, standard_part_id]
    )

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Связь не найдена' })
    }

    await logActivity({
      req,
      entity_type: 'supplier_part_standard_parts',
      entity_id: supplier_part_id,
      action: 'update',
      comment: `Обновлен флаг приоритетности для стандартной детали ${standard_part_id}: ${is_preferred ? 'да' : 'нет'}`,
    })

    res.json({ success: true, is_preferred })
  } catch (e) {
    console.error('PATCH /supplier-part-standard-parts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.query.supplier_part_id)
    const standard_part_id = toId(req.query.standard_part_id)
    if (!supplier_part_id || !standard_part_id) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика и стандартную деталь' })
    }

    await db.execute(
      'DELETE FROM supplier_part_standard_parts WHERE supplier_part_id = ? AND standard_part_id = ?',
      [supplier_part_id, standard_part_id]
    )

    await logActivity({
      req,
      entity_type: 'supplier_part_standard_parts',
      entity_id: supplier_part_id,
      action: 'delete',
      comment: `Удалена связь со стандартной деталью ${standard_part_id}`,
    })

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /supplier-part-standard-parts error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
