// routes/originalPartMaterialSpecs.js
// CRUD for per-material numeric specs (weight/dimensions) for an original part.
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// GET /original-part-material-specs/:original_part_id
// Returns only existing specs (not the materials list).
router.get('/:original_part_id', async (req, res) => {
  const original_part_id = toId(req.params.original_part_id)
  if (!original_part_id) return res.status(400).json({ message: 'Некорректная оригинальная деталь' })

  try {
    const [rows] = await db.execute(
      `
      SELECT opms.*,
             m.name AS material_name,
             m.code AS material_code,
             m.standard AS material_standard
        FROM original_part_material_specs opms
        JOIN materials m ON m.id = opms.material_id
       WHERE opms.original_part_id = ?
       ORDER BY m.name
      `,
      [original_part_id]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /original-part-material-specs/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// PUT /original-part-material-specs
// body: { original_part_id, material_id, weight_kg?, length_cm?, width_cm?, height_cm? }
// Upserts the record; if all numeric fields are null -> deletes the record.
router.put('/', async (req, res) => {
  const original_part_id = toId(req.body.original_part_id)
  const material_id = toId(req.body.material_id)
  if (!original_part_id || !material_id) {
    return res.status(400).json({ message: 'Нужно выбрать оригинальную деталь и материал' })
  }

  const weight_kg = numOrNull(req.body.weight_kg)
  const length_cm = numOrNull(req.body.length_cm)
  const width_cm = numOrNull(req.body.width_cm)
  const height_cm = numOrNull(req.body.height_cm)

  try {
    // ensure the material is linked to the part
    const [[link]] = await db.execute(
      'SELECT 1 FROM original_part_materials WHERE original_part_id=? AND material_id=?',
      [original_part_id, material_id]
    )
    if (!link) {
      return res.status(409).json({
        message: 'Сначала добавьте материал в список материалов детали',
      })
    }

    const allNull = weight_kg == null && length_cm == null && width_cm == null && height_cm == null
    if (allNull) {
      await db.execute(
        'DELETE FROM original_part_material_specs WHERE original_part_id=? AND material_id=?',
        [original_part_id, material_id]
      )
      return res.json({ message: 'Удалено (пустые значения)' })
    }

    await db.execute(
      `
      INSERT INTO original_part_material_specs
        (original_part_id, material_id, weight_kg, length_cm, width_cm, height_cm)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        weight_kg = VALUES(weight_kg),
        length_cm = VALUES(length_cm),
        width_cm  = VALUES(width_cm),
        height_cm = VALUES(height_cm)
      `,
      [original_part_id, material_id, weight_kg, length_cm, width_cm, height_cm]
    )

    const [rows] = await db.execute(
      `
      SELECT opms.*,
             m.name AS material_name,
             m.code AS material_code,
             m.standard AS material_standard
        FROM original_part_material_specs opms
        JOIN materials m ON m.id = opms.material_id
       WHERE opms.original_part_id = ? AND opms.material_id = ?
      `,
      [original_part_id, material_id]
    )

    res.json(rows[0] || null)
  } catch (err) {
    console.error('PUT /original-part-material-specs error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// DELETE /original-part-material-specs/:original_part_id/:material_id
router.delete('/:original_part_id/:material_id', async (req, res) => {
  const original_part_id = toId(req.params.original_part_id)
  const material_id = toId(req.params.material_id)
  if (!original_part_id || !material_id) {
    return res.status(400).json({ message: 'Некорректные ids' })
  }
  try {
    const [del] = await db.execute(
      'DELETE FROM original_part_material_specs WHERE original_part_id=? AND material_id=?',
      [original_part_id, material_id]
    )
    if (!del.affectedRows) return res.status(404).json({ message: 'Не найдено' })
    res.json({ message: 'Удалено' })
  } catch (err) {
    console.error('DELETE /original-part-material-specs error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router

