const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const clampLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const toYearOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

const sqlValue = (v) => (v === undefined ? null : v)

const ALLOWED_STATUS = new Set(['active', 'inactive', 'archived'])
const ALLOWED_BOM_OVERRIDE_STATUS = new Set([
  'as_original',
  'replaced',
  'client_drawing',
  'unknown_oem',
  'not_applicable',
  'needs_review',
])

const formatBomQuantity = (value) => {
  if (value === null || value === undefined) return '1'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '').replace(/\.$/, '')
}

const baseSelect = `
  SELECT ceu.*,
         c.company_name AS client_name,
         em.model_name,
         em.model_code,
         em.classifier_node_id,
         ecn.name AS classifier_node_name,
         m.id AS manufacturer_id,
         m.name AS manufacturer_name
    FROM client_equipment_units ceu
    JOIN clients c ON c.id = ceu.client_id
    JOIN equipment_models em ON em.id = ceu.equipment_model_id
    JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
    LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = em.classifier_node_id
`

router.get('/', async (req, res) => {
  try {
    const clientId = req.query.client_id !== undefined ? toId(req.query.client_id) : null
    const modelId = req.query.equipment_model_id !== undefined ? toId(req.query.equipment_model_id) : null
    const status = nz(req.query.status)
    const q = nz(req.query.q)
    const limit = clampLimit(req.query.limit, 200)

    if (req.query.client_id !== undefined && !clientId) {
      return res.status(400).json({ message: 'Некорректный client_id' })
    }
    if (req.query.equipment_model_id !== undefined && !modelId) {
      return res.status(400).json({ message: 'Некорректный equipment_model_id' })
    }
    if (status && !ALLOWED_STATUS.has(status)) {
      return res.status(400).json({ message: 'Некорректный статус' })
    }

    const where = []
    const params = []
    let sql = baseSelect

    if (clientId) {
      where.push('ceu.client_id = ?')
      params.push(clientId)
    }
    if (modelId) {
      where.push('ceu.equipment_model_id = ?')
      params.push(modelId)
    }
    if (status) {
      where.push('ceu.status = ?')
      params.push(status)
    }
    if (q) {
      where.push(
        `(ceu.serial_number LIKE ? OR ceu.internal_name LIKE ? OR ceu.site_name LIKE ? OR em.model_name LIKE ? OR m.name LIKE ?)`
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY c.company_name ASC, m.name ASC, em.model_name ASC, ceu.id DESC'
    sql += ` LIMIT ${limit}`

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /client-equipment-units error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(`${baseSelect} WHERE ceu.id = ?`, [id])
    if (!rows.length) return res.status(404).json({ message: 'Единица оборудования не найдена' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /client-equipment-units/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/bom', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[unit]] = await db.execute(`${baseSelect} WHERE ceu.id = ?`, [id])
    if (!unit) return res.status(404).json({ message: 'Единица оборудования не найдена' })

    const [items] = await db.execute(
      `
      SELECT
        item.id,
        item.equipment_model_id,
        item.parent_item_id,
        item.row_kind,
        item.item_type,
        item.item_no,
        item.manufacturer_part_number,
        item.manufacturer_part_name,
        item.manufacturer_part_name_en,
        item.manufacturer_part_name_ru,
        item.drawing_number,
        NULL AS oem_part_id,
        item.catalog_position_id,
        item.client_part_id AS bom_client_part_id,
        item.title,
        item.quantity,
        item.sort_order,
        item.notes,
        part.part_number,
        part.description_ru,
        part.description_en,
        part.uom,
        part.manufacturer_id,
        manufacturer.name AS manufacturer_name,
        catalog.display_name AS catalog_position_name,
        catalog.position_code AS catalog_position_code,
        catalog.description AS catalog_position_description,
        catalog.uom AS catalog_position_uom,
        catalog_node.name AS catalog_classifier_node_name,
        override_row.id AS override_id,
        override_row.status AS override_status,
        override_row.difference_summary,
        override_row.client_part_number,
        override_row.client_drawing_number,
        override_row.client_revision,
        override_row.replacement_oem_part_id,
        replacement_part.part_number AS replacement_oem_part_number,
        COALESCE(replacement_part.description_ru, replacement_part.description_en) AS replacement_oem_part_name,
        override_row.replacement_catalog_position_id,
        replacement_catalog.display_name AS replacement_catalog_position_name,
        replacement_catalog.position_code AS replacement_catalog_position_code,
        override_row.client_part_id,
        client_part.display_name AS client_part_name,
        override_row.notes AS override_notes
      FROM equipment_model_bom_items item
      LEFT JOIN (SELECT NULL AS id, NULL AS part_number, NULL AS description_ru, NULL AS description_en, NULL AS manufacturer_id WHERE FALSE) part ON FALSE
      LEFT JOIN equipment_manufacturers manufacturer ON manufacturer.id = part.manufacturer_id
      LEFT JOIN catalog_positions catalog ON catalog.id = item.catalog_position_id
      LEFT JOIN equipment_classifier_nodes catalog_node ON catalog_node.id = catalog.classifier_node_id
      LEFT JOIN client_equipment_unit_bom_overrides override_row
        ON override_row.equipment_model_bom_item_id = item.id
       AND override_row.client_equipment_unit_id = ?
      LEFT JOIN (SELECT NULL AS id, NULL AS part_number, NULL AS description_ru, NULL AS description_en, NULL AS manufacturer_id WHERE FALSE) replacement_part ON FALSE
      LEFT JOIN catalog_positions replacement_catalog ON replacement_catalog.id = override_row.replacement_catalog_position_id
      LEFT JOIN client_parts client_part ON client_part.id = override_row.client_part_id
      WHERE item.equipment_model_id = ?
      ORDER BY
        COALESCE(item.parent_item_id, 0),
        item.sort_order,
        item.id
      `,
      [id, unit.equipment_model_id]
    )

    res.json({
      unit,
      model_id: unit.equipment_model_id,
      items: items.map((row) => ({
        ...row,
        quantity: formatBomQuantity(row.quantity),
        effective_status: row.override_status || 'as_original',
      })),
    })
  } catch (err) {
    console.error('GET /client-equipment-units/:id/bom error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/bom/items/:itemId/override', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!id || !itemId) return res.status(400).json({ message: 'Некорректные идентификаторы' })

    const [[unit]] = await db.execute('SELECT * FROM client_equipment_units WHERE id = ?', [id])
    if (!unit) return res.status(404).json({ message: 'Единица оборудования не найдена' })

    const [[bomItem]] = await db.execute(
      'SELECT * FROM equipment_model_bom_items WHERE id = ? AND equipment_model_id = ?',
      [itemId, unit.equipment_model_id]
    )
    if (!bomItem) return res.status(404).json({ message: 'Строка BOM не найдена в модели этой машины' })

    const status = nz(req.body.status) || 'as_original'
    if (!ALLOWED_BOM_OVERRIDE_STATUS.has(status)) {
      return res.status(400).json({ message: 'Некорректный статус отличия' })
    }

    const replacementOemPartId =
      req.body.replacement_oem_part_id === null || req.body.replacement_oem_part_id === ''
        ? null
        : toId(req.body.replacement_oem_part_id)
    const replacementCatalogPositionId =
      req.body.replacement_catalog_position_id === null || req.body.replacement_catalog_position_id === ''
        ? null
        : toId(req.body.replacement_catalog_position_id)
    const clientPartId =
      req.body.client_part_id === null || req.body.client_part_id === ''
        ? null
        : toId(req.body.client_part_id)

    if (replacementOemPartId) {
      return res.status(400).json({
        message: 'Старый OEM-каталог отключен. Выберите замещающую позицию классификатора.',
      })
    }
    if (replacementCatalogPositionId) {
      const [[replacement]] = await db.execute('SELECT id FROM catalog_positions WHERE id = ? AND is_active = 1', [
        replacementCatalogPositionId,
      ])
      if (!replacement) return res.status(400).json({ message: 'Замещающая позиция классификатора не найдена' })
    }
    if (clientPartId) {
      const [[clientPart]] = await db.execute('SELECT id FROM client_parts WHERE id = ? AND client_id = ?', [
        clientPartId,
        unit.client_id,
      ])
      if (!clientPart) return res.status(400).json({ message: 'Деталь клиента не найдена у этого клиента' })
    }

    await db.execute(
      `
      INSERT INTO client_equipment_unit_bom_overrides
        (
          client_equipment_unit_id, equipment_model_bom_item_id, status, difference_summary,
          client_part_number, client_drawing_number, client_revision,
          replacement_oem_part_id, replacement_catalog_position_id, client_part_id, notes
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        difference_summary = VALUES(difference_summary),
        client_part_number = VALUES(client_part_number),
        client_drawing_number = VALUES(client_drawing_number),
        client_revision = VALUES(client_revision),
        replacement_oem_part_id = VALUES(replacement_oem_part_id),
        replacement_catalog_position_id = VALUES(replacement_catalog_position_id),
        client_part_id = VALUES(client_part_id),
        notes = VALUES(notes)
      `,
      [
        id,
        itemId,
        status,
        nz(req.body.difference_summary),
        nz(req.body.client_part_number),
        nz(req.body.client_drawing_number),
        nz(req.body.client_revision),
        replacementOemPartId,
        replacementCatalogPositionId,
        clientPartId,
        nz(req.body.notes),
      ]
    )

    await logActivity({
      req,
      action: 'update',
      entity_type: 'client_equipment_unit_bom_overrides',
      entity_id: itemId,
      comment: 'Изменено отличие строки BOM машины клиента',
      client_id: unit.client_id,
    })

    const [[row]] = await db.execute(
      `
      SELECT *
      FROM client_equipment_unit_bom_overrides
      WHERE client_equipment_unit_id = ?
        AND equipment_model_bom_item_id = ?
      `,
      [id, itemId]
    )
    res.json(row)
  } catch (err) {
    console.error('PUT /client-equipment-units/:id/bom/items/:itemId/override error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/bom/items/:itemId/override', async (req, res) => {
  try {
    const id = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!id || !itemId) return res.status(400).json({ message: 'Некорректные идентификаторы' })

    await db.execute(
      `
      DELETE override_row
      FROM client_equipment_unit_bom_overrides override_row
      JOIN client_equipment_units ceu ON ceu.id = override_row.client_equipment_unit_id
      JOIN equipment_model_bom_items item ON item.id = override_row.equipment_model_bom_item_id
      WHERE override_row.client_equipment_unit_id = ?
        AND override_row.equipment_model_bom_item_id = ?
        AND item.equipment_model_id = ceu.equipment_model_id
      `,
      [id, itemId]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /client-equipment-units/:id/bom/items/:itemId/override error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const client_id = toId(req.body.client_id)
    const equipment_model_id = toId(req.body.equipment_model_id)
    const serial_number = nz(req.body.serial_number)
    const manufacture_year = toYearOrNull(req.body.manufacture_year)
    const site_name = nz(req.body.site_name)
    const internal_name = nz(req.body.internal_name)
    const commissioning_date = nz(req.body.commissioning_date)
    const decommissioned_date = nz(req.body.decommissioned_date)
    const status = nz(req.body.status) || 'active'
    const notes = nz(req.body.notes)

    if (!client_id) return res.status(400).json({ message: 'client_id обязателен' })
    if (!equipment_model_id) {
      return res.status(400).json({ message: 'equipment_model_id обязателен' })
    }
    if (
      manufacture_year === null &&
      req.body.manufacture_year !== undefined &&
      req.body.manufacture_year !== null &&
      req.body.manufacture_year !== ''
    ) {
      return res.status(400).json({ message: 'Некорректный manufacture_year' })
    }
    if (!ALLOWED_STATUS.has(status)) return res.status(400).json({ message: 'Некорректный статус' })

    const [[client]] = await db.execute('SELECT id FROM clients WHERE id = ?', [client_id])
    if (!client) return res.status(400).json({ message: 'Клиент не найден' })

    const [[model]] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [equipment_model_id])
    if (!model) return res.status(400).json({ message: 'Модель оборудования не найдена' })

    const [ins] = await db.execute(
      `
      INSERT INTO client_equipment_units
        (
          client_id, equipment_model_id, serial_number, manufacture_year, site_name,
          internal_name, commissioning_date, decommissioned_date, status, notes
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        client_id,
        equipment_model_id,
        serial_number,
        manufacture_year,
        site_name,
        internal_name,
        commissioning_date,
        decommissioned_date,
        status,
        notes,
      ]
    )

    const [[created]] = await db.execute(`${baseSelect} WHERE ceu.id = ?`, [ins.insertId])
    await logActivity({
      req,
      action: 'create',
      entity_type: 'client_equipment_units',
      entity_id: ins.insertId,
      comment: 'Добавлена единица оборудования клиента',
      client_id,
    })

    res.status(201).json(created)
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'Такая единица оборудования уже существует у клиента',
      })
    }
    console.error('POST /client-equipment-units error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM client_equipment_units WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Единица оборудования не найдена' })

    const client_id = req.body.client_id !== undefined ? toId(req.body.client_id) : undefined
    const equipment_model_id =
      req.body.equipment_model_id !== undefined ? toId(req.body.equipment_model_id) : undefined
    const serial_number = req.body.serial_number !== undefined ? nz(req.body.serial_number) : undefined
    const manufacture_year =
      req.body.manufacture_year !== undefined ? toYearOrNull(req.body.manufacture_year) : undefined
    const site_name = req.body.site_name !== undefined ? nz(req.body.site_name) : undefined
    const internal_name = req.body.internal_name !== undefined ? nz(req.body.internal_name) : undefined
    const commissioning_date =
      req.body.commissioning_date !== undefined ? nz(req.body.commissioning_date) : undefined
    const decommissioned_date =
      req.body.decommissioned_date !== undefined ? nz(req.body.decommissioned_date) : undefined
    const status = req.body.status !== undefined ? nz(req.body.status) : undefined
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : undefined

    if (req.body.client_id !== undefined && !client_id) {
      return res.status(400).json({ message: 'Некорректный client_id' })
    }
    if (req.body.equipment_model_id !== undefined && !equipment_model_id) {
      return res.status(400).json({ message: 'Некорректный equipment_model_id' })
    }
    if (
      manufacture_year === null &&
      req.body.manufacture_year !== undefined &&
      req.body.manufacture_year !== null &&
      req.body.manufacture_year !== ''
    ) {
      return res.status(400).json({ message: 'Некорректный manufacture_year' })
    }
    if (status !== undefined && !ALLOWED_STATUS.has(status)) {
      return res.status(400).json({ message: 'Некорректный статус' })
    }

    if (client_id) {
      const [[client]] = await db.execute('SELECT id FROM clients WHERE id = ?', [client_id])
      if (!client) return res.status(400).json({ message: 'Клиент не найден' })
    }
    if (equipment_model_id) {
      const [[model]] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [equipment_model_id])
      if (!model) return res.status(400).json({ message: 'Модель оборудования не найдена' })
    }

    await db.execute(
      `
      UPDATE client_equipment_units
         SET client_id = COALESCE(?, client_id),
             equipment_model_id = COALESCE(?, equipment_model_id),
             serial_number = COALESCE(?, serial_number),
             manufacture_year = ?,
             site_name = COALESCE(?, site_name),
             internal_name = COALESCE(?, internal_name),
             commissioning_date = ?,
             decommissioned_date = ?,
             status = COALESCE(?, status),
             notes = COALESCE(?, notes)
       WHERE id = ?
      `,
      [
        sqlValue(client_id),
        sqlValue(equipment_model_id),
        sqlValue(serial_number),
        manufacture_year === undefined ? before.manufacture_year : manufacture_year,
        sqlValue(site_name),
        sqlValue(internal_name),
        commissioning_date === undefined ? before.commissioning_date : commissioning_date,
        decommissioned_date === undefined ? before.decommissioned_date : decommissioned_date,
        sqlValue(status),
        sqlValue(notes),
        id,
      ]
    )

    const [[after]] = await db.execute('SELECT * FROM client_equipment_units WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'client_equipment_units',
      entity_id: id,
      oldData: before,
      newData: after,
      client_id: after.client_id,
    })

    const [[fresh]] = await db.execute(`${baseSelect} WHERE ceu.id = ?`, [id])
    res.json(fresh)
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'Такая единица оборудования уже существует у клиента',
      })
    }
    console.error('PUT /client-equipment-units/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    await conn.beginTransaction()

    const [[before]] = await conn.execute('SELECT * FROM client_equipment_units WHERE id = ?', [id])
    if (!before) {
      await conn.rollback()
      return res.status(404).json({ message: 'Единица оборудования не найдена' })
    }

    const [[contextRow]] = await conn.execute(
      `
      SELECT c.company_name, em.model_name
        FROM client_equipment_units ceu
        JOIN clients c ON c.id = ceu.client_id
        JOIN equipment_models em ON em.id = ceu.equipment_model_id
       WHERE ceu.id = ?
      `,
      [id]
    )

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'client_equipment_units',
      entityId: id,
      rootEntityType: 'clients',
      rootEntityId: Number(before.client_id),
      title: contextRow?.model_name || `Единица оборудования #${id}`,
      subtitle: contextRow?.company_name || null,
      snapshot: before,
      context: {
        client_id: Number(before.client_id),
        client_name: contextRow?.company_name || null,
        model_name: contextRow?.model_name || null,
      },
    })

    const [bomOverrideRows] = await conn.execute(
      'SELECT * FROM client_equipment_unit_bom_overrides WHERE client_equipment_unit_id = ? ORDER BY id ASC',
      [id]
    )

    let sortOrder = 0
    for (const row of bomOverrideRows) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'client_equipment_unit_bom_overrides',
        itemId: row.id,
        itemRole: 'bom_override',
        title: `BOM override #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }

    await conn.execute('DELETE FROM client_equipment_units WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'client_equipment_units',
      entity_id: id,
      old_value: String(trashEntryId),
      client_id: before.client_id,
      comment: 'Единица оборудования клиента перемещена в корзину',
    })

    await conn.commit()
    res.json({ success: true, trash_entry_id: trashEntryId })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /client-equipment-units/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
