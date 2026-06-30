const express = require('express')
const router = express.Router()

const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const { createTrashEntry } = require('../utils/trashStore')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const toPreferredFlag = (v) => {
  if (v === undefined || v === null || v === '') return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  if (Number.isInteger(n)) return n > 0 ? 1 : 0
  const s = String(v).trim().toLowerCase()
  if (!s) return 0
  return ['true', 'yes', 'y', 'да', 'on'].includes(s) ? 1 : 0
}

const nz = (v) =>
  v === undefined || v === null ? null : String(v).trim() || null

const normalizeRelationshipType = (v) => {
  const s = String(v || '').trim().toLowerCase()
  if (['exact', 'analog', 'can_supply'].includes(s)) return s
  return 'can_supply'
}

router.get('/', async (req, res) => {
  try {
    const supplierPartId = toId(req.query.supplier_part_id)
    if (!supplierPartId) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика' })
    }

    const [rows] = await db.execute(
      `
      SELECT
        spcp.catalog_position_id,
        spcp.relationship_type,
        spcp.confidence,
        spcp.priority_rank,
        spcp.is_preferred,
        spcp.notes,
        cp.position_code,
        cp.manufacturer_part_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.position_kind,
        cp.source_kind,
        cp.uom,
        cp.description,
        cp.equipment_model_id,
        cp.manufacturer_id,
        n.name AS classifier_node_name,
        em.model_name,
        mf.name AS manufacturer_name
      FROM supplier_part_catalog_positions spcp
      JOIN catalog_positions cp ON cp.id = spcp.catalog_position_id
      LEFT JOIN equipment_classifier_nodes n ON n.id = cp.classifier_node_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      WHERE spcp.supplier_part_id = ?
        AND cp.is_active = 1
      ORDER BY spcp.is_preferred DESC, mf.name, em.model_name, cp.position_code, cp.display_name
      `,
      [supplierPartId]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-part-catalog-positions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/of-position', async (req, res) => {
  try {
    const catalogPositionId = toId(req.query.catalog_position_id)
    if (!catalogPositionId) {
      return res.status(400).json({ message: 'Не выбрана позиция каталога' })
    }

    const [rows] = await db.execute(
      `
      SELECT
        sp.id AS supplier_part_id,
        spcp.relationship_type,
        spcp.confidence,
        spcp.priority_rank,
        spcp.is_preferred,
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
        ps.id AS supplier_id,
        ps.name AS supplier_name
      FROM supplier_part_catalog_positions spcp
      JOIN supplier_parts sp ON sp.id = spcp.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
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
      WHERE spcp.catalog_position_id = ?
      ORDER BY spcp.is_preferred DESC, ps.name, sp.supplier_part_number
      `,
      [catalogPositionId]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-part-catalog-positions/of-position error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const supplierPartId = toId(req.body.supplier_part_id)
    const catalogPositionId = toId(req.body.catalog_position_id)
    if (!supplierPartId || !catalogPositionId) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика и позицию каталога' })
    }

    const [[sp]] = await db.execute('SELECT id FROM supplier_parts WHERE id = ?', [supplierPartId])
    if (!sp) return res.status(400).json({ message: 'Деталь поставщика не найдена' })

    const [[cp]] = await db.execute('SELECT id FROM catalog_positions WHERE id = ? AND is_active = 1', [
      catalogPositionId,
    ])
    if (!cp) return res.status(400).json({ message: 'Позиция каталога не найдена' })

    const relationshipType = normalizeRelationshipType(req.body.relationship_type)
    const isPreferred = toPreferredFlag(req.body.is_preferred)
    const notes = nz(req.body.notes)

    await db.execute(
      `
      INSERT INTO supplier_part_catalog_positions
        (supplier_part_id, catalog_position_id, relationship_type, is_preferred, notes)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        relationship_type = VALUES(relationship_type),
        is_preferred = VALUES(is_preferred),
        notes = VALUES(notes)
      `,
      [supplierPartId, catalogPositionId, relationshipType, isPreferred, notes]
    )

    await logActivity({
      req,
      entity_type: 'supplier_part_catalog_positions',
      entity_id: supplierPartId,
      action: 'create',
      comment: `Связь детали поставщика с позицией каталога ${catalogPositionId}`,
    })

    res.json({ success: true })
  } catch (e) {
    console.error('POST /supplier-part-catalog-positions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.patch('/', async (req, res) => {
  try {
    const supplierPartId = toId(req.body.supplier_part_id)
    const catalogPositionId = toId(req.body.catalog_position_id)
    if (!supplierPartId || !catalogPositionId) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика и позицию каталога' })
    }

    const relationshipType = normalizeRelationshipType(req.body.relationship_type)
    const isPreferred = toPreferredFlag(req.body.is_preferred)
    const notes = nz(req.body.notes)

    const [result] = await db.execute(
      `
      UPDATE supplier_part_catalog_positions
         SET relationship_type = ?, is_preferred = ?, notes = ?
       WHERE supplier_part_id = ? AND catalog_position_id = ?
      `,
      [relationshipType, isPreferred, notes, supplierPartId, catalogPositionId]
    )

    if (!result.affectedRows) return res.status(404).json({ message: 'Связь не найдена' })

    await logActivity({
      req,
      entity_type: 'supplier_part_catalog_positions',
      entity_id: supplierPartId,
      action: 'update',
      comment: `Обновлена связь детали поставщика с позицией каталога ${catalogPositionId}`,
    })

    res.json({ success: true, is_preferred: isPreferred, relationship_type: relationshipType })
  } catch (e) {
    console.error('PATCH /supplier-part-catalog-positions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const supplierPartId = toId(req.query.supplier_part_id)
    const catalogPositionId = toId(req.query.catalog_position_id)
    if (!supplierPartId || !catalogPositionId) {
      return res.status(400).json({ message: 'Нужно выбрать деталь поставщика и позицию каталога' })
    }

    await conn.beginTransaction()
    const [[row]] = await conn.execute(
      `
      SELECT
        spcp.*,
        sp.supplier_part_number,
        cp.position_code,
        cp.display_name
      FROM supplier_part_catalog_positions spcp
      JOIN supplier_parts sp ON sp.id = spcp.supplier_part_id
      JOIN catalog_positions cp ON cp.id = spcp.catalog_position_id
      WHERE spcp.supplier_part_id = ? AND spcp.catalog_position_id = ?
      FOR UPDATE
      `,
      [supplierPartId, catalogPositionId]
    )
    if (!row) {
      await conn.rollback()
      return res.status(404).json({ message: 'Связь не найдена' })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'supplier_part_catalog_positions',
      entityId: supplierPartId,
      rootEntityType: 'supplier_parts',
      rootEntityId: supplierPartId,
      deleteMode: 'relation_delete',
      title: `${row.supplier_part_number || `Supplier part #${supplierPartId}`} -> ${row.position_code || row.display_name || `Catalog position #${catalogPositionId}`}`,
      subtitle: 'Supplier part catalog position link',
      snapshot: row,
      context: { catalog_position_id: catalogPositionId },
    })

    await conn.execute(
      'DELETE FROM supplier_part_catalog_positions WHERE supplier_part_id = ? AND catalog_position_id = ?',
      [supplierPartId, catalogPositionId]
    )

    await logActivity({
      req,
      entity_type: 'supplier_part_catalog_positions',
      entity_id: supplierPartId,
      action: 'delete',
      old_value: String(trashEntryId),
      comment: `Удалена связь детали поставщика с позицией каталога ${catalogPositionId}`,
    })

    await conn.commit()
    res.json({ success: true, trash_entry_id: trashEntryId })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /supplier-part-catalog-positions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
