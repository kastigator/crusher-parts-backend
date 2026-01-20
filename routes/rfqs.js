const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const ExcelJS = require('exceljs')
const crypto = require('crypto')
const { bucket, bucketName } = require('../utils/gcsClient')
const {
  buildRfqStructure,
  ensureStrategiesAndComponents,
  rebuildComponentsForItem,
  normalizeStrategyMode,
} = require('../utils/rfqStructure')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const numOr = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const boolToTinyint = (v, fallback = null) => {
  if (v === undefined || v === null) return fallback
  return v ? 1 : 0
}
const safeSegment = (value) =>
  String(value || '')
    .trim()
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

const hashPayload = (payload) =>
  crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')

const fmtDate = (value) => {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.*,
              cr.client_request_id,
              cr.rev_number,
              req.client_id,
              req.internal_number AS client_request_number,
              req.client_reference,
              c.company_name AS client_name
       FROM rfqs r
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       JOIN client_requests req ON req.id = cr.client_request_id
       JOIN clients c ON c.id = req.client_id
       ORDER BY r.id DESC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const [[row]] = await db.execute('SELECT * FROM rfqs WHERE id = ?', [id])
    if (!row) return res.status(404).json({ message: 'Не найдено' })

    res.json(row)
  } catch (e) {
    console.error('GET /rfqs/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const client_request_revision_id = toId(req.body.client_request_revision_id)
    if (!client_request_revision_id) return res.status(400).json({ message: 'client_request_revision_id обязателен' })

    const created_by_user_id = toId(req.user?.id)
    const status = nz(req.body.status) || 'draft'
    const note = nz(req.body.note)
    const rfq_number = nz(req.body.rfq_number ?? req.body.rfqNumber)

    if (rfq_number) {
      const [existing] = await db.execute(
        'SELECT id FROM rfqs WHERE rfq_number = ? LIMIT 1',
        [rfq_number]
      )
      if (existing.length) {
        return res.status(409).json({ message: 'RFQ номер уже используется' })
      }
    }

    const [result] = await db.execute(
      `INSERT INTO rfqs (client_request_revision_id, status, created_by_user_id, note)
       VALUES (?,?,?,?)`,
      [client_request_revision_id, status, created_by_user_id, note]
    )

    const rfqNumber = rfq_number || `RFQ-${result.insertId}`
    await db.execute('UPDATE rfqs SET rfq_number = ? WHERE id = ?', [
      rfqNumber,
      result.insertId,
    ])

    const [[created]] = await db.execute('SELECT * FROM rfqs WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /rfqs error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/items', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT ri.*,
              cri.client_description,
              cri.client_part_number,
              cri.requested_qty AS client_requested_qty,
              cri.uom AS client_uom,
              cri.original_part_id,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.rfq_id = ?
        ORDER BY ri.line_number ASC`,
      [rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/structure', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const payload = await buildRfqStructure(db, rfqId, { includeSelf: true })
    res.json(payload)
  } catch (e) {
    console.error('GET /rfqs/:id/structure error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/items/:itemId/strategy', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный ID' })

    const [[item]] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.id = ? AND ri.rfq_id = ?`,
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const [[existing]] = await db.execute(
      'SELECT * FROM rfq_item_strategies WHERE rfq_item_id = ?',
      [itemId]
    )

    const mode = normalizeStrategyMode(req.body.mode, existing?.mode || 'SINGLE')
    const allow_oem = boolToTinyint(req.body.allow_oem, existing?.allow_oem ?? 1)
    const allow_analog = boolToTinyint(req.body.allow_analog, existing?.allow_analog ?? 1)
    const allow_kit = boolToTinyint(req.body.allow_kit, existing?.allow_kit ?? 1)
    const allow_partial = boolToTinyint(req.body.allow_partial, existing?.allow_partial ?? 0)
    const note = nz(req.body.note ?? existing?.note)

    await db.execute(
      `INSERT INTO rfq_item_strategies
         (rfq_item_id, mode, allow_oem, allow_analog, allow_kit, allow_partial, note)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         mode=VALUES(mode),
         allow_oem=VALUES(allow_oem),
         allow_analog=VALUES(allow_analog),
         allow_kit=VALUES(allow_kit),
         allow_partial=VALUES(allow_partial),
         note=VALUES(note)`,
      [itemId, mode, allow_oem, allow_analog, allow_kit, allow_partial, note]
    )

    if (req.body.rebuild_components) {
      await rebuildComponentsForItem(db, item, mode)
    }

    const [[updated]] = await db.execute(
      'SELECT * FROM rfq_item_strategies WHERE rfq_item_id = ?',
      [itemId]
    )
    res.json({ strategy: updated })
  } catch (e) {
    console.error('PUT /rfqs/:id/items/:itemId/strategy error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items/:itemId/components/rebuild', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный ID' })

    const [[item]] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.id = ? AND ri.rfq_id = ?`,
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const [[strategy]] = await db.execute(
      'SELECT mode FROM rfq_item_strategies WHERE rfq_item_id = ?',
      [itemId]
    )
    const mode = normalizeStrategyMode(req.body.mode, strategy?.mode || 'SINGLE')

    await rebuildComponentsForItem(db, item, mode)
    res.json({ success: true })
  } catch (e) {
    console.error('POST /rfqs/:id/items/:itemId/components/rebuild error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items/:itemId/components', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный ID' })

    const original_part_id = toId(req.body.original_part_id)
    if (!original_part_id) return res.status(400).json({ message: 'original_part_id обязателен' })

    const component_qty = numOrNull(req.body.component_qty) || 1
    const source_type = nz(req.body.source_type) || 'MANUAL'

    const [[item]] = await db.execute(
      'SELECT requested_qty FROM rfq_items WHERE id = ? AND rfq_id = ?',
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const required_qty = numOr(component_qty, 1) * numOr(item.requested_qty, 1)

    await db.execute(
      `INSERT INTO rfq_item_components
         (rfq_item_id, original_part_id, component_qty, required_qty, source_type, note)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         component_qty=VALUES(component_qty),
         required_qty=VALUES(required_qty),
         note=VALUES(note)`,
      [itemId, original_part_id, component_qty, required_qty, source_type, nz(req.body.note)]
    )

    res.status(201).json({ success: true })
  } catch (e) {
    console.error('POST /rfqs/:id/items/:itemId/components error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/items/:itemId/components/:componentId', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    const componentId = toId(req.params.componentId)
    if (!rfqId || !itemId || !componentId) return res.status(400).json({ message: 'Некорректный ID' })

    const [[item]] = await db.execute(
      'SELECT requested_qty FROM rfq_items WHERE id = ? AND rfq_id = ?',
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const component_qty = numOrNull(req.body.component_qty)
    if (component_qty === null) return res.status(400).json({ message: 'component_qty обязателен' })

    const required_qty = numOr(component_qty, 1) * numOr(item.requested_qty, 1)

    const [result] = await db.execute(
      `UPDATE rfq_item_components
          SET component_qty = ?, required_qty = ?, note = COALESCE(?, note)
        WHERE id = ? AND rfq_item_id = ?`,
      [component_qty, required_qty, nz(req.body.note), componentId, itemId]
    )

    if (!result.affectedRows) return res.status(404).json({ message: 'Компонент не найден' })

    res.json({ success: true })
  } catch (e) {
    console.error('PUT /rfqs/:id/items/:itemId/components/:componentId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/items/:itemId/components/:componentId', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    const componentId = toId(req.params.componentId)
    if (!rfqId || !itemId || !componentId) return res.status(400).json({ message: 'Некорректный ID' })

    const [result] = await db.execute(
      'DELETE FROM rfq_item_components WHERE id = ? AND rfq_item_id = ?',
      [componentId, itemId]
    )
    if (!result.affectedRows) return res.status(404).json({ message: 'Компонент не найден' })

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /rfqs/:id/items/:itemId/components/:componentId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const client_request_revision_item_id = toId(req.body.client_request_revision_item_id)
    if (!client_request_revision_item_id) {
      return res.status(400).json({ message: 'client_request_revision_item_id обязателен' })
    }

    const [[sourceItem]] = await db.execute(
      `SELECT requested_qty, uom, oem_only
         FROM client_request_revision_items
        WHERE id = ?`,
      [client_request_revision_item_id]
    )
    if (!sourceItem) {
      return res.status(404).json({ message: 'Позиция заявки не найдена' })
    }

    const resolvedQty = numOrNull(req.body.requested_qty)
    const resolvedUom = nz(req.body.uom)
    const resolvedOem =
      req.body.oem_only === undefined || req.body.oem_only === null
        ? sourceItem.oem_only
        : req.body.oem_only
        ? 1
        : 0
    const requestedQty =
      resolvedQty === null ? sourceItem.requested_qty ?? 1 : resolvedQty
    const uom = resolvedUom || sourceItem.uom || 'pcs'

    if (requestedQty === null) {
      return res.status(400).json({ message: 'requested_qty обязателен' })
    }

    const [[{ next_line }]] = await db.execute(
      `SELECT COALESCE(MAX(line_number), 0) + 1 AS next_line FROM rfq_items WHERE rfq_id = ?`,
      [rfqId]
    )

    const [result] = await db.execute(
      `INSERT INTO rfq_items (rfq_id, client_request_revision_item_id, line_number, requested_qty, uom, oem_only, note)
       VALUES (?,?,?,?,?,?,?)`,
      [
        rfqId,
        client_request_revision_item_id,
        next_line,
        requestedQty,
        uom,
        resolvedOem,
        nz(req.body.note),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM rfq_items WHERE id = ?', [result.insertId])
    const [itemRows] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.id = ?`,
      [result.insertId]
    )
    if (itemRows.length) {
      await ensureStrategiesAndComponents(db, itemRows)
    }
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /rfqs/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items/bulk', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const [[rfq]] = await db.execute(
      'SELECT client_request_revision_id FROM rfqs WHERE id = ?',
      [rfqId]
    )
    if (!rfq) return res.status(404).json({ message: 'RFQ не найден' })

    const [[{ max_line }]] = await db.execute(
      'SELECT COALESCE(MAX(line_number), 0) AS max_line FROM rfq_items WHERE rfq_id = ?',
      [rfqId]
    )

    const [result] = await db.execute(
      `
      INSERT INTO rfq_items
        (rfq_id, client_request_revision_item_id, line_number, requested_qty, uom, oem_only, note)
      SELECT
        ?, ri.id, ? + ROW_NUMBER() OVER (ORDER BY ri.line_number),
        ri.requested_qty, ri.uom, ri.oem_only, NULL
      FROM client_request_revision_items ri
      WHERE ri.client_request_revision_id = ?
        AND ri.id NOT IN (
          SELECT client_request_revision_item_id FROM rfq_items WHERE rfq_id = ?
        )
      `,
      [rfqId, max_line, rfq.client_request_revision_id, rfqId]
    )

    const [itemRows] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.rfq_id = ?`,
      [rfqId]
    )
    if (itemRows.length) {
      await ensureStrategiesAndComponents(db, itemRows)
    }

    res.json({ success: true, inserted: result.affectedRows || 0 })
  } catch (e) {
    console.error('POST /rfqs/:id/items/bulk error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/suppliers', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT rs.*, ps.name AS supplier_name,
              rsl.response_id,
              rsr.status AS response_status
       FROM rfq_suppliers rs
       JOIN part_suppliers ps ON ps.id = rs.supplier_id
       LEFT JOIN (
         SELECT rfq_supplier_id, MAX(id) AS response_id
         FROM rfq_supplier_responses
         GROUP BY rfq_supplier_id
       ) rsl ON rsl.rfq_supplier_id = rs.id
       LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rsl.response_id
       WHERE rs.rfq_id = ?
       ORDER BY rs.id DESC`,
      [rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/suppliers error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/suggested-suppliers', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `
      SELECT supplier_id,
             supplier_name,
             SUM(parts_count) AS parts_count,
             GROUP_CONCAT(DISTINCT match_type) AS match_types
        FROM (
          SELECT ps.id AS supplier_id,
                 ps.name AS supplier_name,
                 COUNT(DISTINCT sp.id) AS parts_count,
                 'link' AS match_type
            FROM rfq_items ri
            JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
            JOIN supplier_part_originals spo ON spo.original_part_id = cri.original_part_id
            JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
            JOIN part_suppliers ps ON ps.id = sp.supplier_id
           WHERE ri.rfq_id = ?
             AND cri.original_part_id IS NOT NULL
           GROUP BY ps.id, ps.name
          UNION ALL
          SELECT ps.id AS supplier_id,
                 ps.name AS supplier_name,
                 COUNT(DISTINCT sp.id) AS parts_count,
                 'cat_number' AS match_type
            FROM rfq_items ri
            JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
            JOIN original_parts op
              ON op.cat_number = cri.client_part_number
             AND (cri.equipment_model_id IS NULL OR op.equipment_model_id = cri.equipment_model_id)
            JOIN supplier_part_originals spo ON spo.original_part_id = op.id
            JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
            JOIN part_suppliers ps ON ps.id = sp.supplier_id
           WHERE ri.rfq_id = ?
             AND cri.original_part_id IS NULL
             AND cri.client_part_number IS NOT NULL
           GROUP BY ps.id, ps.name
        ) s
       GROUP BY supplier_id, supplier_name
       ORDER BY parts_count DESC, supplier_name ASC
      `,
      [rfqId, rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/suggested-suppliers error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/suppliers', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const supplier_id = toId(req.body.supplier_id)
    if (!rfqId || !supplier_id) return res.status(400).json({ message: 'rfq_id и supplier_id обязательны' })

    const status = nz(req.body.status) || 'invited'
    const invited_at = nz(req.body.invited_at)
    const note = nz(req.body.note)

    const [result] = await db.execute(
      `INSERT INTO rfq_suppliers (rfq_id, supplier_id, status, invited_at, note)
       VALUES (?,?,?,?,?)`,
      [rfqId, supplier_id, status, invited_at, note]
    )

    const [[created]] = await db.execute('SELECT * FROM rfq_suppliers WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /rfqs/:id/suppliers error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный ID' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    await conn.execute(
      `DELETE cc FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE l FROM sales_quote_lines l
       JOIN sales_quote_revisions r ON r.id = l.sales_quote_revision_id
       JOIN sales_quotes sq ON sq.id = r.sales_quote_id
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE r FROM sales_quote_revisions r
       JOIN sales_quotes sq ON sq.id = r.sales_quote_id
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sq FROM sales_quotes sq
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE pol FROM supplier_purchase_order_lines pol
       JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
       JOIN selections s ON s.id = po.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE po FROM supplier_purchase_orders po
       JOIN selections s ON s.id = po.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sl FROM selection_lines sl
       JOIN selections s ON s.id = sl.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM selections WHERE rfq_id = ?', [id])
    await conn.execute(
      `DELETE sgi FROM shipment_group_items sgi
       JOIN shipment_groups sg ON sg.id = sgi.shipment_group_id
       WHERE sg.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE es FROM economic_scenarios es
       JOIN shipment_groups sg ON sg.id = es.shipment_group_id
       WHERE sg.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM shipment_groups WHERE rfq_id = ?', [id])
    await conn.execute('DELETE FROM landed_cost_snapshots WHERE rfq_id = ?', [id])
    await conn.execute(
      `DELETE lsi FROM rfq_line_scorecard_items lsi
       JOIN rfq_line_scorecards lsc ON lsc.id = lsi.rfq_line_scorecard_id
       JOIN rfq_response_lines rl ON rl.id = lsc.rfq_response_line_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE lsc FROM rfq_line_scorecards lsc
       JOIN rfq_response_lines rl ON rl.id = lsc.rfq_response_line_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE ssi FROM rfq_supplier_scorecard_items ssi
       JOIN rfq_supplier_scorecards ssc ON ssc.id = ssi.rfq_supplier_scorecard_id
       WHERE ssc.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM rfq_supplier_scorecards WHERE rfq_id = ?', [id])
    await conn.execute(
      `DELETE spp FROM supplier_part_prices spp
       JOIN rfq_response_lines rl ON rl.id = spp.source_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?
         AND spp.source_type = 'RFQ'`,
      [id]
    )
    await conn.execute(
      `DELETE rl FROM rfq_response_lines rl
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rr FROM rfq_response_revisions rr
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rsr FROM rfq_supplier_responses rsr
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM rfq_suppliers WHERE rfq_id = ?', [id])
    try {
      await conn.execute(
        `DELETE ric FROM rfq_item_components ric
         JOIN rfq_items ri ON ri.id = ric.rfq_item_id
         WHERE ri.rfq_id = ?`,
        [id]
      )
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e
    }
    await conn.execute(
      `DELETE ris FROM rfq_item_strategies ris
       JOIN rfq_items ri ON ri.id = ris.rfq_item_id
       WHERE ri.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM rfq_items WHERE rfq_id = ?', [id])
    await conn.execute('DELETE FROM rfqs WHERE id = ?', [id])

    await conn.commit()
    res.json({ success: true })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /rfqs/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.post('/:id/suppliers/bulk', async (req, res) => {
  const rfqId = toId(req.params.id)
  if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

  const supplierIds = Array.isArray(req.body?.supplier_ids)
    ? req.body.supplier_ids.map(toId).filter(Boolean)
    : []
  if (!supplierIds.length) {
    return res.status(400).json({ message: 'supplier_ids обязателен' })
  }

  const status = nz(req.body.status) || 'invited'
  const invited_at = nz(req.body.invited_at)
  const note = nz(req.body.note)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    let inserted = 0

    for (const supplier_id of supplierIds) {
      const [result] = await conn.execute(
        `INSERT IGNORE INTO rfq_suppliers (rfq_id, supplier_id, status, invited_at, note)
         VALUES (?,?,?,?,?)`,
        [rfqId, supplier_id, status, invited_at, note]
      )
      inserted += result.affectedRows || 0
    }

    await conn.commit()
    res.json({ success: true, inserted })
  } catch (e) {
    await conn.rollback()
    console.error('POST /rfqs/:id/suppliers/bulk error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.get('/:id/documents', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `
      SELECT d.*,
             rs.supplier_id,
             ps.name AS supplier_name
        FROM rfq_documents d
        LEFT JOIN rfq_suppliers rs ON rs.id = d.rfq_supplier_id
        LEFT JOIN part_suppliers ps ON ps.id = rs.supplier_id
       WHERE d.rfq_id = ?
       ORDER BY d.created_at DESC, d.id DESC
      `,
      [rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/documents error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/send', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    if (!bucket || !bucketName) {
      return res.status(500).json({ message: 'GCS бакет не настроен на сервере' })
    }

    const [[rfq]] = await db.execute(
      `SELECT r.*,
              cr.rev_number,
              req.client_id,
              c.company_name AS client_name
         FROM rfqs r
         JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
        WHERE r.id = ?`,
      [rfqId]
    )
    if (!rfq) return res.status(404).json({ message: 'RFQ не найден' })

    const [items] = await db.execute(
      `SELECT ri.line_number,
              ri.requested_qty,
              ri.uom,
              ri.oem_only,
              ri.note,
              cri.client_description,
              cri.client_part_number,
              cri.original_part_id,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.rfq_id = ?
        ORDER BY ri.line_number ASC`,
      [rfqId]
    )

    if (!items.length) {
      return res.status(400).json({ message: 'В RFQ нет строк для отправки' })
    }

    const includeStructure = !!req.body?.include_structure
    const structure = includeStructure
      ? await buildRfqStructure(db, rfqId, { includeSelf: false })
      : null

    const supplierIds = Array.isArray(req.body?.supplier_ids)
      ? req.body.supplier_ids.map(toId).filter(Boolean)
      : []

    const [supplierRows] = await db.execute(
      `SELECT rs.*,
              ps.name AS supplier_name,
              ps.default_incoterms,
              ps.default_pickup_location
         FROM rfq_suppliers rs
         JOIN part_suppliers ps ON ps.id = rs.supplier_id
        WHERE rs.rfq_id = ?
        ORDER BY rs.id ASC`,
      [rfqId]
    )

    const selectedSuppliers = supplierIds.length
      ? supplierRows.filter((s) => supplierIds.includes(s.supplier_id))
      : supplierRows

    if (!selectedSuppliers.length) {
      return res.status(400).json({ message: 'Не выбраны поставщики для отправки' })
    }

    const originalIds = items
      .map((i) => i.original_part_id)
      .filter((id) => Number.isInteger(id) && id > 0)
    let linkRows = []
    if (originalIds.length) {
      const uniqueOriginalIds = [...new Set(originalIds)]
      const supplierIdList = [...new Set(selectedSuppliers.map((s) => s.supplier_id))]
      const placeholdersOrig = uniqueOriginalIds.map(() => '?').join(',')
      const placeholdersSup = supplierIdList.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT spo.original_part_id,
               sp.supplier_id,
               sp.supplier_part_number,
               sp.description_ru,
               sp.description_en,
               sp.part_type
          FROM supplier_part_originals spo
          JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
         WHERE spo.original_part_id IN (${placeholdersOrig})
           AND sp.supplier_id IN (${placeholdersSup})
        `,
        [...uniqueOriginalIds, ...supplierIdList]
      )
      linkRows = rows
    }

    const linksBySupplier = new Map()
    linkRows.forEach((row) => {
      const key = `${row.supplier_id}:${row.original_part_id}`
      if (!linksBySupplier.has(key)) linksBySupplier.set(key, [])
      linksBySupplier.get(key).push(row)
    })

    const documents = []
    const errors = []
    const created_by_user_id = toId(req.user?.id)

    for (const supplier of selectedSuppliers) {
      try {
        const workbook = new ExcelJS.Workbook()
        const sheet = workbook.addWorksheet('RFQ')

        sheet.addRow(['RFQ', rfq.rfq_number || `RFQ-${rfq.id}`])
        sheet.addRow(['Клиент', rfq.client_name || ''])
        sheet.addRow(['Ревизия', rfq.rev_number || ''])
        sheet.addRow(['Дата', fmtDate(new Date())])
        sheet.addRow(['Поставщик', supplier.supplier_name || ''])
        sheet.addRow([])

        sheet.addRow([
          '№',
          'Кат. номер',
          'Описание',
          'Кол-во',
          'Ед.',
          'OEM только',
          'Комментарий',
          'Аналоги поставщика (из базы)',
        ])

        sheet.getRow(7).font = { bold: true }

        items.forEach((item) => {
          const linkKey = `${supplier.supplier_id}:${item.original_part_id}`
          const links = linksBySupplier.get(linkKey) || []
          const linkText = links
            .map((l) => l.supplier_part_number || l.description_ru || l.description_en)
            .filter(Boolean)
            .join(', ')

          sheet.addRow([
            item.line_number,
            item.original_cat_number || item.client_part_number || '',
            item.client_description || item.original_description_ru || item.original_description_en || '',
            item.requested_qty,
            item.uom,
            item.oem_only ? 'Да' : '',
            item.note || '',
            linkText,
          ])
        })

        sheet.columns = [
          { width: 6 },
          { width: 18 },
          { width: 40 },
          { width: 10 },
          { width: 8 },
          { width: 10 },
          { width: 30 },
          { width: 40 },
        ]

        if (includeStructure && structure?.items?.length) {
          const structureSheet = workbook.addWorksheet('Structure')
          structureSheet.addRow([
            'Строка RFQ',
            'Родитель',
            'Компонент',
            'Описание компонента',
            'Кол-во',
            'Требуется',
            'Комплекты',
          ])
          structureSheet.getRow(1).font = { bold: true }

          structure.items.forEach((row) => {
            if (!row.components?.length) return
            row.components.forEach((comp) => {
              structureSheet.addRow([
                row.line_number,
                row.original_cat_number || row.client_part_number || '',
                comp.cat_number || '',
                comp.description || '',
                comp.component_qty ?? '',
                comp.required_qty ?? '',
                comp.bundle_count || '',
              ])
            })
          })

          structureSheet.columns = [
            { width: 10 },
            { width: 18 },
            { width: 18 },
            { width: 40 },
            { width: 10 },
            { width: 12 },
            { width: 10 },
          ]
        }

        const buffer = await workbook.xlsx.writeBuffer()
        const safeSupplier = safeSegment(supplier.supplier_name) || `supplier_${supplier.supplier_id}`
        const fileName = `rfq_${rfq.rfq_number || rfq.id}_${safeSupplier}_${fmtDate(new Date())}.xlsx`
        const objectPath = [
          'rfqs',
          String(rfq.id),
          'suppliers',
          String(supplier.supplier_id),
          `${Date.now()}_${safeSegment(fileName)}`
        ]
          .map((seg) => encodeURIComponent(seg))
          .join('/')

        await bucket.file(objectPath).save(buffer, {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })

        const fileUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
        const payload = {
          rfq_id: rfq.id,
          supplier_id: supplier.supplier_id,
          generated_at: new Date().toISOString(),
          include_structure: includeStructure ? 1 : 0,
          items: items.map((i) => ({
            line_number: i.line_number,
            original_part_id: i.original_part_id,
            original_cat_number: i.original_cat_number,
            client_part_number: i.client_part_number,
            client_description: i.client_description,
            requested_qty: i.requested_qty,
            uom: i.uom,
            oem_only: i.oem_only ? 1 : 0,
            note: i.note,
          })),
        }

        if (includeStructure && structure?.items?.length) {
          payload.structure = structure.items
        }

        const [docIns] = await db.execute(
          `
          INSERT INTO rfq_documents
            (rfq_id, rfq_supplier_id, document_type, file_name, file_type, file_size,
             file_url, template_version, payload_hash, payload_json, created_by_user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `,
          [
            rfq.id,
            supplier.id,
            'rfq',
            fileName,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer.length,
            fileUrl,
            'rfq-basic-v1',
            hashPayload(payload),
            JSON.stringify(payload),
            created_by_user_id,
          ]
        )

        await db.execute(
          `UPDATE rfq_suppliers
              SET status = 'sent',
                  invited_at = COALESCE(invited_at, NOW())
            WHERE id = ?`,
          [supplier.id]
        )

        const [[docRow]] = await db.execute(
          'SELECT * FROM rfq_documents WHERE id = ?',
          [docIns.insertId]
        )
        documents.push(docRow)
      } catch (err) {
        errors.push({
          supplier_id: supplier.supplier_id,
          supplier_name: supplier.supplier_name,
          message: err?.message || 'Ошибка генерации документа',
        })
      }
    }

    if (documents.length) {
      await db.execute(
        `UPDATE rfqs
            SET status = 'sent',
                sent_at = NOW(),
                sent_by_user_id = ?
          WHERE id = ?`,
        [created_by_user_id, rfqId]
      )
    }

    res.json({ success: errors.length === 0, documents, errors })
  } catch (e) {
    console.error('POST /rfqs/:id/send error:', e)
    res.status(500).json({ message: 'Ошибка отправки RFQ' })
  }
})

module.exports = router
