// routes/originalPartMaterials.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function resolveOemPartId(rawId) {
  const id = toId(rawId)
  if (!id) return null

  const [[oem]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [id])
  if (oem) return Number(oem.id)

  try {
    const [[mapped]] = await db.execute(
      `
      SELECT new_oem_part_id AS id
      FROM migration_original_to_oem
      WHERE old_original_part_id = ?
         OR original_part_id = ?
      LIMIT 1
      `,
      [id, id]
    )
    return mapped?.id ? Number(mapped.id) : null
  } catch {
    return null
  }
}

// GET /original-part-materials/:original_part_id
router.get('/:original_part_id', async (req, res) => {
  const original_part_id = await resolveOemPartId(req.params.original_part_id)
  if (!original_part_id) return res.status(400).json({ message: 'Некорректная OEM деталь' })

  try {
    const [rows] = await db.execute(
      `
      SELECT
        opm.*,
        m.name AS material_name,
        m.code AS material_code,
        m.standard AS material_standard,
        m.description AS material_description,
        opms.weight_kg AS spec_weight_kg,
        opms.length_cm AS spec_length_cm,
        opms.width_cm  AS spec_width_cm,
        opms.height_cm AS spec_height_cm
        FROM oem_part_materials opm
        JOIN materials m ON m.id = opm.material_id
        LEFT JOIN oem_part_material_specs opms
               ON opms.oem_part_id = opm.oem_part_id
              AND opms.material_id = opm.material_id
       WHERE opm.oem_part_id = ?
       ORDER BY opm.is_default DESC, m.name
      `,
      [original_part_id]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /original-part-materials/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// POST /original-part-materials
// body: { original_part_id, material_id, is_default?, note? }
router.post('/', async (req, res) => {
  const original_part_id = await resolveOemPartId(req.body.original_part_id)
  const material_id = toId(req.body.material_id)
  const is_default = req.body.is_default ? 1 : 0
  const note = req.body.note || null

  if (!original_part_id || !material_id) {
      return res.status(400).json({ message: 'Нужно выбрать OEM деталь и материал' })
  }

  try {
    const [[op]] = await db.execute('SELECT id FROM oem_parts WHERE id=?', [original_part_id])
    if (!op) return res.status(404).json({ message: 'Оригинальная деталь не найдена' })

    const [[mat]] = await db.execute('SELECT id FROM materials WHERE id=?', [material_id])
    if (!mat) return res.status(404).json({ message: 'Материал не найден' })

    if (is_default) {
      await db.execute(
        'UPDATE oem_part_materials SET is_default = 0 WHERE oem_part_id = ?',
        [original_part_id]
      )
    }

    await db.execute(
      `
      INSERT INTO oem_part_materials (oem_part_id, material_id, is_default, note)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE is_default = VALUES(is_default), note = VALUES(note)
      `,
      [original_part_id, material_id, is_default, note]
    )

    const [rows] = await db.execute(
      `
      SELECT
        opm.*,
        m.name AS material_name,
        m.code AS material_code,
        m.standard AS material_standard,
        m.description AS material_description,
        opms.weight_kg AS spec_weight_kg,
        opms.length_cm AS spec_length_cm,
        opms.width_cm  AS spec_width_cm,
        opms.height_cm AS spec_height_cm
        FROM oem_part_materials opm
        JOIN materials m ON m.id = opm.material_id
        LEFT JOIN oem_part_material_specs opms
               ON opms.oem_part_id = opm.oem_part_id
              AND opms.material_id = opm.material_id
       WHERE opm.oem_part_id = ? AND opm.material_id = ?
      `,
      [original_part_id, material_id]
    )

    res.status(201).json(rows[0])
  } catch (err) {
    console.error('POST /original-part-materials error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// DELETE /original-part-materials/:original_part_id/:material_id
router.delete('/:original_part_id/:material_id', async (req, res) => {
  const original_part_id = await resolveOemPartId(req.params.original_part_id)
  const material_id = toId(req.params.material_id)
  if (!original_part_id || !material_id) {
    return res.status(400).json({ message: 'Некорректные ids' })
  }
  try {
    const [del] = await db.execute(
      'DELETE FROM oem_part_materials WHERE oem_part_id = ? AND material_id = ?',
      [original_part_id, material_id]
    )
    if (!del.affectedRows) {
      return res.status(404).json({ message: 'Связь не найдена' })
    }
    res.json({ message: 'Удалено' })
  } catch (err) {
    console.error('DELETE /original-part-materials error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
