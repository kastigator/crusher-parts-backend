// routes/originalPartMaterials.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function resolveOemPartId(rawId) {
  const id = toId(rawId)
  if (!id) return null

  const [[oem]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [id])
  return oem ? Number(oem.id) : null
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
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[row]] = await conn.execute(
      `
      SELECT
        opm.*,
        p.part_number,
        m.name AS material_name,
        m.code AS material_code
      FROM oem_part_materials opm
      JOIN oem_parts p ON p.id = opm.oem_part_id
      JOIN materials m ON m.id = opm.material_id
      WHERE opm.oem_part_id = ?
        AND opm.material_id = ?
      FOR UPDATE
      `,
      [original_part_id, material_id]
    )
    if (!row) {
      await conn.rollback()
      return res.status(404).json({ message: 'Связь не найдена' })
    }

    const [[spec]] = await conn.execute(
      'SELECT * FROM oem_part_material_specs WHERE oem_part_id = ? AND material_id = ?',
      [original_part_id, material_id]
    )

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'oem_part_materials',
      entityId: original_part_id,
      rootEntityType: 'oem_parts',
      rootEntityId: original_part_id,
      deleteMode: 'relation_delete',
      title: `${row.part_number} / ${row.material_name || row.material_code || `Материал #${material_id}`}`,
      subtitle: 'OEM material link',
      snapshot: row,
      context: {
        material_id: material_id,
      },
    })

    if (spec) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'oem_part_material_specs',
        itemId: null,
        itemRole: 'material_specs',
        title: `Material specs ${original_part_id}:${material_id}`,
        snapshot: spec,
        sortOrder: 0,
      })
    }

    await conn.execute(
      'DELETE FROM oem_part_material_specs WHERE oem_part_id = ? AND material_id = ?',
      [original_part_id, material_id]
    )
    await conn.execute(
      'DELETE FROM oem_part_materials WHERE oem_part_id = ? AND material_id = ?',
      [original_part_id, material_id]
    )
    await conn.commit()
    res.json({ message: 'Связь материала удалена', trash_entry_id: trashEntryId })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /original-part-materials error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
