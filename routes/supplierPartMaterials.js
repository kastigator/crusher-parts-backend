// routes/supplierPartMaterials.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

// GET /supplier-part-materials/:supplier_part_id
router.get('/:supplier_part_id', async (req, res) => {
  const partId = toId(req.params.supplier_part_id)
  if (!partId) return res.status(400).json({ message: 'Некорректная деталь поставщика' })

  try {
    const [rows] = await db.execute(
      `
      SELECT spm.*, m.name AS material_name, m.code AS material_code, m.standard AS material_standard, m.description AS material_description
        FROM supplier_part_materials spm
        JOIN materials m ON m.id = spm.material_id
       WHERE spm.supplier_part_id = ?
       ORDER BY spm.is_default DESC, m.name
      `,
      [partId]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /supplier-part-materials/:supplier_part_id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// POST /supplier-part-materials
// body: { supplier_part_id, material_id, is_default?, note? }
router.post('/', async (req, res) => {
  const supplier_part_id = toId(req.body.supplier_part_id)
  const material_id = toId(req.body.material_id)
  const is_default = req.body.is_default ? 1 : 0
  const note = req.body.note || null

  if (!supplier_part_id || !material_id) {
    return res.status(400).json({ message: 'Нужно выбрать деталь поставщика и материал' })
  }

  try {
    const [[part]] = await db.execute('SELECT id FROM supplier_parts WHERE id=?', [supplier_part_id])
    if (!part) return res.status(404).json({ message: 'Деталь поставщика не найдена' })

    const [[mat]] = await db.execute('SELECT id FROM materials WHERE id=?', [material_id])
    if (!mat) return res.status(404).json({ message: 'Материал не найден' })

    if (is_default) {
      await db.execute(
        'UPDATE supplier_part_materials SET is_default = 0 WHERE supplier_part_id = ?',
        [supplier_part_id]
      )
    }

    await db.execute(
      `
      INSERT INTO supplier_part_materials (supplier_part_id, material_id, is_default, note)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE is_default = VALUES(is_default), note = VALUES(note)
      `,
      [supplier_part_id, material_id, is_default, note]
    )

    const [rows] = await db.execute(
      `
      SELECT spm.*, m.name AS material_name, m.code AS material_code, m.standard AS material_standard, m.description AS material_description
        FROM supplier_part_materials spm
        JOIN materials m ON m.id = spm.material_id
       WHERE spm.supplier_part_id = ? AND spm.material_id = ?
      `,
      [supplier_part_id, material_id]
    )

    res.status(201).json(rows[0])
  } catch (err) {
    console.error('POST /supplier-part-materials error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// DELETE /supplier-part-materials/:supplier_part_id/:material_id
router.delete('/:supplier_part_id/:material_id', async (req, res) => {
  const supplier_part_id = toId(req.params.supplier_part_id)
  const material_id = toId(req.params.material_id)
  if (!supplier_part_id || !material_id) {
    return res.status(400).json({ message: 'Некорректные ids' })
  }
  try {
    const [del] = await db.execute(
      'DELETE FROM supplier_part_materials WHERE supplier_part_id = ? AND material_id = ?',
      [supplier_part_id, material_id]
    )
    if (!del.affectedRows) {
      return res.status(404).json({ message: 'Связь не найдена' })
    }
    res.json({ message: 'Удалено' })
  } catch (err) {
    console.error('DELETE /supplier-part-materials error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
