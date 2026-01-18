const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null

async function resolveOriginalPartId({
  original_part_id,
  original_part_cat_number,
  equipment_model_id,
}) {
  const pid = original_part_id ? toId(original_part_id) : null
  const cat = nz(original_part_cat_number)

  if (pid) return pid
  if (!cat) throw new Error('ORIGINAL_CAT_REQUIRED')

  const [rows] = await db.execute(
    `
    SELECT op.id, op.equipment_model_id
      FROM original_parts op
     WHERE op.cat_number = ?
    `,
    [cat]
  )
  if (!rows.length) throw new Error('ORIGINAL_NOT_FOUND')
  if (rows.length === 1) return rows[0].id

  const emid = toId(equipment_model_id)
  if (!emid) throw new Error('ORIGINAL_AMBIGUOUS')

  const hit = rows.find((r) => r.equipment_model_id === emid)
  if (!hit) throw new Error('ORIGINAL_NOT_FOUND_IN_MODEL')
  return hit.id
}

router.get('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.query.supplier_part_id)
    if (!supplier_part_id) {
      return res
        .status(400)
        .json({ message: 'supplier_part_id обязателен' })
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

router.get('/of-original', async (req, res) => {
  try {
    const original_part_id = toId(req.query.original_part_id)
    if (!original_part_id) {
      return res
        .status(400)
        .json({ message: 'original_part_id обязателен' })
    }

    const [rows] = await db.execute(
      `
      SELECT
        sp.id  AS supplier_part_id,
        sp.supplier_part_number,
        sp.description_ru,
        sp.description_en,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        spp.price,
        spp.currency,
        COALESCE(spp.lead_time_days, sp.lead_time_days) AS lead_time_days,
        COALESCE(spp.min_order_qty, sp.min_order_qty) AS min_order_qty,
        COALESCE(spp.packaging, sp.packaging) AS packaging,
        COALESCE(spp.offer_type, sp.part_type) AS part_type,
        ps.id  AS supplier_id,
        ps.name AS supplier_name
      FROM supplier_part_originals spo
      JOIN supplier_parts    sp ON sp.id = spo.supplier_part_id
      JOIN part_suppliers    ps ON ps.id = sp.supplier_id
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
      WHERE spo.original_part_id = ?
      ORDER BY ps.name, sp.supplier_part_number
      `,
      [original_part_id]
    )

    const partIds = rows.map((r) => r.supplier_part_id)
    let materialsByPart = {}
    if (partIds.length) {
      const [matRows] = await db.query(
        `
          SELECT
            spm.supplier_part_id,
            spm.material_id,
            spm.is_default,
            m.name AS material_name,
            m.code AS material_code
          FROM supplier_part_materials spm
          LEFT JOIN materials m ON m.id = spm.material_id
          WHERE spm.supplier_part_id IN (?)
          ORDER BY spm.supplier_part_id, spm.is_default DESC, m.name
        `,
        [partIds],
      )
      materialsByPart = matRows.reduce((acc, row) => {
        if (!acc[row.supplier_part_id]) acc[row.supplier_part_id] = []
        acc[row.supplier_part_id].push(row)
        return acc
      }, {})
    }

    const enriched = rows.map((r) => ({
      ...r,
      materials: materialsByPart[r.supplier_part_id] || [],
    }))

    res.json(enriched)
  } catch (e) {
    console.error('GET /supplier-part-originals/of-original error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.body.supplier_part_id)
    if (!supplier_part_id) {
      return res
        .status(400)
        .json({ message: 'supplier_part_id обязателен' })
    }

    const [[sp]] = await db.execute(
      'SELECT id FROM supplier_parts WHERE id = ?',
      [supplier_part_id]
    )
    if (!sp) {
      return res
        .status(400)
        .json({ message: 'Деталь поставщика не найдена' })
    }

    let original_part_id
    try {
      original_part_id = await resolveOriginalPartId({
        original_part_id: req.body.original_part_id,
        original_part_cat_number: req.body.original_part_cat_number,
        equipment_model_id: req.body.equipment_model_id,
      })
    } catch (e) {
      const map = {
        ORIGINAL_ID_INVALID: 'Некорректный original_part_id',
        ORIGINAL_CAT_REQUIRED:
          'Укажите original_part_id или original_part_cat_number',
        ORIGINAL_NOT_FOUND: 'Оригинальная деталь не найдена',
        ORIGINAL_AMBIGUOUS:
          'Найдено несколько оригиналов — укажите equipment_model_id',
        ORIGINAL_NOT_FOUND_IN_MODEL: 'Оригинал не найден в указанной модели',
      }
      return res.status(400).json({ message: map[e.message] || e.message })
    }

    await db.execute(
      `INSERT IGNORE INTO supplier_part_originals (supplier_part_id, original_part_id)
       VALUES (?, ?)`
      ,
      [supplier_part_id, original_part_id]
    )

    await logActivity({
      req,
      entity_type: 'supplier_part_originals',
      entity_id: supplier_part_id,
      action: 'create',
      comment: `Связь с оригиналом ${original_part_id}`,
    })

    res.json({ success: true })
  } catch (e) {
    console.error('POST /supplier-part-originals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.query.supplier_part_id)
    const original_part_id = toId(req.query.original_part_id)
    if (!supplier_part_id || !original_part_id) {
      return res.status(400).json({ message: 'supplier_part_id и original_part_id обязательны' })
    }

    await db.execute(
      `DELETE FROM supplier_part_originals WHERE supplier_part_id = ? AND original_part_id = ?`,
      [supplier_part_id, original_part_id]
    )

    await logActivity({
      req,
      entity_type: 'supplier_part_originals',
      entity_id: supplier_part_id,
      action: 'delete',
      comment: `Удалена связь с оригиналом ${original_part_id}`,
    })

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /supplier-part-originals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
