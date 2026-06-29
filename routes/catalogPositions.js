const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const clampLimit = (v, def = 50, max = 200) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const nodeId = req.query.classifier_node_id !== undefined ? toId(req.query.classifier_node_id) : null
    const limit = clampLimit(req.query.limit)

    if (req.query.classifier_node_id !== undefined && !nodeId) {
      return res.status(400).json({ message: 'Некорректный раздел классификатора' })
    }

    const params = []
    const where = ['cp.is_active = 1']
    if (nodeId) {
      where.push('cp.classifier_node_id = ?')
      params.push(nodeId)
    }
    if (q) {
      where.push('(cp.display_name LIKE ? OR cp.position_code LIKE ? OR cp.description LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }
    params.push(limit)

    const [rows] = await db.query(
      `
      SELECT
        cp.*,
        n.name AS classifier_node_name
      FROM catalog_positions cp
      JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      WHERE ${where.join(' AND ')}
      ORDER BY cp.display_name
      LIMIT ?
      `,
      params
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /catalog-positions error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/usage', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[position]] = await db.execute(
      `
      SELECT cp.*, n.name AS classifier_node_name
      FROM catalog_positions cp
      LEFT JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      WHERE cp.id = ?
        AND cp.is_active = 1
      `,
      [id]
    )
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    const [rows] = await db.execute(
      `
      SELECT
        item.id AS bom_item_id,
        item.equipment_model_id,
        item.parent_item_id,
        item.item_type,
        item.item_no,
        item.manufacturer_part_number,
        item.manufacturer_part_name,
        item.manufacturer_part_name_en,
        item.manufacturer_part_name_ru,
        item.drawing_number,
        item.title,
        item.quantity,
        item.notes,
        parent.item_no AS parent_item_no,
        parent.title AS parent_title,
        parent.manufacturer_part_name AS parent_manufacturer_part_name,
        parent_catalog.display_name AS parent_catalog_position_name,
        em.model_name,
        em.model_code,
        em.classifier_node_id AS model_classifier_node_id,
        model_node.name AS model_classifier_node_name,
        mf.id AS manufacturer_id,
        mf.name AS manufacturer_name,
        COUNT(DISTINCT ceu.id) AS client_units_count
      FROM equipment_model_bom_items item
      JOIN equipment_models em ON em.id = item.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
      LEFT JOIN equipment_classifier_nodes model_node ON model_node.id = em.classifier_node_id
      LEFT JOIN equipment_model_bom_items parent ON parent.id = item.parent_item_id
      LEFT JOIN catalog_positions parent_catalog ON parent_catalog.id = parent.catalog_position_id
      LEFT JOIN client_equipment_units ceu ON ceu.equipment_model_id = em.id
      WHERE item.catalog_position_id = ?
      GROUP BY
        item.id, item.equipment_model_id, item.parent_item_id, item.item_type,
        item.item_no, item.manufacturer_part_number, item.manufacturer_part_name,
        item.manufacturer_part_name_en, item.manufacturer_part_name_ru,
        item.drawing_number, item.title, item.quantity, item.notes,
        parent.item_no, parent.title, parent.manufacturer_part_name,
        parent_catalog.display_name,
        em.model_name, em.model_code, em.classifier_node_id, model_node.name,
        mf.id, mf.name
      ORDER BY mf.name, em.model_name, item.sort_order, item.id
      `,
      [id]
    )

    res.json({ position, rows })
  } catch (err) {
    console.error('GET /catalog-positions/:id/usage error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
