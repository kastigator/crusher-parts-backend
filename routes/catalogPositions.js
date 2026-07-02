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

const parseJson = (value) => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const nodeId = req.query.classifier_node_id !== undefined ? toId(req.query.classifier_node_id) : null
    const manufacturerId = req.query.manufacturer_id !== undefined ? toId(req.query.manufacturer_id) : null
    const equipmentModelId = req.query.equipment_model_id !== undefined ? toId(req.query.equipment_model_id) : null
    const modelBomModelId = req.query.model_bom_model_id !== undefined ? toId(req.query.model_bom_model_id) : null
    const excludeModelBom = String(req.query.exclude_model_bom || '').trim() === '1'
    const onlyAssemblies = String(req.query.only_assemblies || '').trim() === '1'
    const onlyParts = String(req.query.only_parts || '').trim() === '1'
    const limit = clampLimit(req.query.limit)

    if (req.query.classifier_node_id !== undefined && !nodeId) {
      return res.status(400).json({ message: 'Некорректный раздел классификатора' })
    }
    if (req.query.manufacturer_id !== undefined && !manufacturerId) {
      return res.status(400).json({ message: 'Некорректный производитель' })
    }
    if (req.query.equipment_model_id !== undefined && !equipmentModelId) {
      return res.status(400).json({ message: 'Некорректная модель оборудования' })
    }
    if (req.query.model_bom_model_id !== undefined && !modelBomModelId) {
      return res.status(400).json({ message: 'Некорректная модель BOM' })
    }

    const params = []
    const where = ['cp.is_active = 1']
    if (nodeId) {
      where.push('cp.classifier_node_id = ?')
      params.push(nodeId)
    }
    if (manufacturerId) {
      where.push('COALESCE(cp.manufacturer_id, em.manufacturer_id) = ?')
      params.push(manufacturerId)
    }
    if (equipmentModelId) {
      where.push('cp.equipment_model_id = ?')
      params.push(equipmentModelId)
    }
    if (excludeModelBom) {
      where.push("cp.source_kind <> 'model_bom'")
    } else if (modelBomModelId) {
      where.push("(cp.source_kind <> 'model_bom' OR cp.equipment_model_id = ?)")
      params.push(modelBomModelId)
    }
    if (onlyAssemblies && !onlyParts) {
      where.push("LOWER(cp.position_kind) IN ('assembly', 'node', 'unit')")
    }
    if (onlyParts && !onlyAssemblies) {
      where.push("LOWER(cp.position_kind) IN ('part', 'material', 'service', 'kit', 'document')")
    }
    if (q) {
      where.push('(cp.display_name LIKE ? OR cp.display_name_en LIKE ? OR cp.display_name_ru LIKE ? OR cp.position_code LIKE ? OR cp.manufacturer_part_number LIKE ? OR cp.description LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }
    params.push(limit)

    const [rows] = await db.query(
      `
      SELECT
        cp.*,
        JSON_UNQUOTE(JSON_EXTRACT(cp.meta_json, '$.source_bom_item_id')) AS source_bom_item_id,
        n.name AS classifier_node_name,
        em.model_name,
        mf.name AS manufacturer_name
      FROM catalog_positions cp
      JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      WHERE ${where.join(' AND ')}
      ORDER BY mf.name, em.model_name, cp.position_code, cp.display_name
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

router.get('/:id/card', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[position]] = await db.execute(
      `
      SELECT
        cp.*,
        n.name AS classifier_node_name,
        em.model_name,
        em.model_code,
        mf.name AS manufacturer_name
      FROM catalog_positions cp
      LEFT JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      WHERE cp.id = ?
        AND cp.is_active = 1
      `,
      [id]
    )
    if (!position) return res.status(404).json({ message: 'Карточка товара не найдена' })

    position.meta = parseJson(position.meta_json)
    delete position.meta_json

    const [usage] = await db.execute(
      `
      SELECT
        item.id AS bom_item_id,
        item.equipment_model_id,
        item.parent_item_id,
        item.item_type,
        item.row_kind,
        item.item_no,
        item.manufacturer_part_number,
        item.manufacturer_part_name,
        item.manufacturer_part_name_en,
        item.manufacturer_part_name_ru,
        item.title,
        item.quantity,
        parent.manufacturer_part_number AS parent_manufacturer_part_number,
        parent.manufacturer_part_name AS parent_manufacturer_part_name,
        parent.title AS parent_title,
        em.model_name,
        mf.name AS manufacturer_name
      FROM equipment_model_bom_items item
      JOIN equipment_models em ON em.id = item.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
      LEFT JOIN equipment_model_bom_items parent ON parent.id = item.parent_item_id
      WHERE item.catalog_position_id = ?
      ORDER BY mf.name, em.model_name, item.sort_order, item.id
      `,
      [id]
    )

    const [supplierParts] = await db.execute(
      `
      SELECT
        sp.id,
        sp.supplier_id,
        ps.name AS supplier_name,
        ps.country AS supplier_country,
        sp.supplier_part_number,
        sp.description_ru,
        sp.description_en,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        sp.uom,
        sp.part_type,
        sp.lead_time_days,
        sp.min_order_qty,
        sp.packaging,
        sp.weight_kg,
        sp.length_cm,
        sp.width_cm,
        sp.height_cm,
        sp.is_overweight,
        sp.is_oversize,
        spcp.relationship_type,
        spcp.is_preferred,
        spcp.notes AS link_notes,
        dm.id AS default_material_id,
        dm.name AS default_material_name,
        dm.code AS default_material_code,
        dm.standard AS default_material_standard,
        lp.price,
        lp.currency,
        lp.date AS price_date,
        COALESCE(lp.lead_time_days, sp.lead_time_days) AS effective_lead_time_days,
        COALESCE(lp.min_order_qty, sp.min_order_qty) AS effective_min_order_qty,
        COALESCE(lp.packaging, sp.packaging) AS effective_packaging,
        COALESCE(lp.offer_type, sp.part_type) AS effective_part_type
      FROM supplier_part_catalog_positions spcp
      JOIN supplier_parts sp ON sp.id = spcp.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN materials dm ON dm.id = sp.default_material_id
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
      ) lp ON lp.supplier_part_id = sp.id
      WHERE spcp.catalog_position_id = ?
      ORDER BY spcp.is_preferred DESC, ps.name, sp.supplier_part_number
      `,
      [id]
    )

    const [materials] = await db.execute(
      `
      SELECT DISTINCT
        m.id,
        m.name,
        m.code,
        m.standard,
        m.description,
        spm.is_default,
        spm.note,
        sp.id AS supplier_part_id,
        sp.supplier_part_number,
        ps.name AS supplier_name
      FROM supplier_part_catalog_positions spcp
      JOIN supplier_parts sp ON sp.id = spcp.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      JOIN supplier_part_materials spm ON spm.supplier_part_id = sp.id
      JOIN materials m ON m.id = spm.material_id
      WHERE spcp.catalog_position_id = ?
      ORDER BY spm.is_default DESC, m.name, ps.name
      `,
      [id]
    )

    const meta = position.meta || {}
    const tnvedCodeId = toId(meta.tnved_code_id)
    let tnved = null
    if (tnvedCodeId) {
      const [[code]] = await db.execute('SELECT * FROM tnved_codes WHERE id = ?', [tnvedCodeId])
      tnved = code || null
    } else if (nz(meta.tnved_code)) {
      const [[code]] = await db.execute('SELECT * FROM tnved_codes WHERE code = ? LIMIT 1', [nz(meta.tnved_code)])
      tnved = code || { code: nz(meta.tnved_code), description: meta.tnved_description || null }
    }

    res.json({
      position,
      usage,
      supplier_parts: supplierParts,
      materials,
      tnved,
    })
  } catch (err) {
    console.error('GET /catalog-positions/:id/card error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
