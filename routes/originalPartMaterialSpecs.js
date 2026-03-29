// routes/originalPartMaterialSpecs.js
// CRUD for per-material numeric specs (weight/dimensions) for an original part.
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { createTrashEntry } = require('../utils/trashStore')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function resolveOemPartId(rawId) {
  const id = toId(rawId)
  if (!id) return null

  const [[oem]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [id])
  return oem ? Number(oem.id) : null
}

// GET /original-part-material-specs/:original_part_id
// Returns only existing specs (not the materials list).
router.get('/:original_part_id', async (req, res) => {
  const original_part_id = await resolveOemPartId(req.params.original_part_id)
  if (!original_part_id) return res.status(400).json({ message: 'Некорректная OEM деталь' })

  try {
    const [rows] = await db.execute(
      `
      SELECT opms.oem_part_id AS original_part_id, opms.material_id, opms.weight_kg, opms.length_cm, opms.width_cm, opms.height_cm,
             m.name AS material_name,
             m.code AS material_code,
             m.standard AS material_standard
        FROM oem_part_material_specs opms
        JOIN materials m ON m.id = opms.material_id
       WHERE opms.oem_part_id = ?
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
  const original_part_id = await resolveOemPartId(req.body.original_part_id)
  const material_id = toId(req.body.material_id)
  if (!original_part_id || !material_id) {
    return res.status(400).json({ message: 'Нужно выбрать OEM деталь и материал' })
  }

  const weight_kg = numOrNull(req.body.weight_kg)
  const length_cm = numOrNull(req.body.length_cm)
  const width_cm = numOrNull(req.body.width_cm)
  const height_cm = numOrNull(req.body.height_cm)

  try {
    // ensure the material is linked to the part
    const [[link]] = await db.execute(
      'SELECT 1 FROM oem_part_materials WHERE oem_part_id=? AND material_id=?',
      [original_part_id, material_id]
    )
    if (!link) {
      return res.status(409).json({
        message: 'Сначала добавьте материал в список материалов OEM детали',
      })
    }

    const allNull = weight_kg == null && length_cm == null && width_cm == null && height_cm == null
    if (allNull) {
      await db.execute(
        'DELETE FROM oem_part_material_specs WHERE oem_part_id=? AND material_id=?',
        [original_part_id, material_id]
      )
      return res.json({ message: 'Удалено (пустые значения)' })
    }

    await db.execute(
      `
      INSERT INTO oem_part_material_specs
        (oem_part_id, material_id, weight_kg, length_cm, width_cm, height_cm)
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
      SELECT opms.oem_part_id AS original_part_id, opms.material_id, opms.weight_kg, opms.length_cm, opms.width_cm, opms.height_cm,
             m.name AS material_name,
             m.code AS material_code,
             m.standard AS material_standard
        FROM oem_part_material_specs opms
        JOIN materials m ON m.id = opms.material_id
       WHERE opms.oem_part_id = ? AND opms.material_id = ?
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
  const original_part_id = await resolveOemPartId(req.params.original_part_id)
  const material_id = toId(req.params.material_id)
  if (!original_part_id || !material_id) {
    return res.status(400).json({ message: 'Некорректные ids' })
  }
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[row]] = await conn.execute(
      `
      SELECT s.*,
             p.part_number,
             m.name AS material_name,
             m.code AS material_code
        FROM oem_part_material_specs s
        JOIN oem_parts p ON p.id = s.oem_part_id
        JOIN materials m ON m.id = s.material_id
       WHERE s.oem_part_id = ?
         AND s.material_id = ?
      `,
      [original_part_id, material_id]
    )
    if (!row) {
      await conn.rollback()
      return res.status(404).json({ message: 'Не найдено' })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'oem_part_material_specs',
      entityId: original_part_id,
      rootEntityType: 'oem_parts',
      rootEntityId: original_part_id,
      deleteMode: 'relation_delete',
      title: `${row.part_number} / ${row.material_name || row.material_code || `Материал #${material_id}`}`,
      subtitle: 'OEM material specs',
      snapshot: row,
      context: { material_id },
    })

    const [del] = await conn.execute(
      'DELETE FROM oem_part_material_specs WHERE oem_part_id=? AND material_id=?',
      [original_part_id, material_id]
    )
    if (!del.affectedRows) {
      await conn.rollback()
      return res.status(404).json({ message: 'Не найдено' })
    }

    await conn.commit()
    res.json({ message: 'Удалено', trash_entry_id: trashEntryId })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /original-part-material-specs error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
