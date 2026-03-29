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
    if (manufacture_year === null && req.body.manufacture_year !== undefined && req.body.manufacture_year !== '') {
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
    if (manufacture_year === null && req.body.manufacture_year !== undefined && req.body.manufacture_year !== '') {
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

    const [overrideRows] = await conn.execute(
      'SELECT * FROM oem_part_unit_overrides WHERE client_equipment_unit_id = ? ORDER BY id ASC',
      [id]
    )
    const [materialOverrideRows] = await conn.execute(
      `
      SELECT *
        FROM oem_part_unit_material_overrides
       WHERE client_equipment_unit_id = ?
       ORDER BY oem_part_id ASC, material_id ASC
      `,
      [id]
    )
    const [materialSpecRows] = await conn.execute(
      `
      SELECT *
        FROM oem_part_unit_material_specs
       WHERE client_equipment_unit_id = ?
       ORDER BY oem_part_id ASC, material_id ASC
      `,
      [id]
    )

    let sortOrder = 0
    for (const row of overrideRows) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'oem_part_unit_overrides',
        itemId: row.id,
        itemRole: 'override',
        title: `OEM override #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of materialOverrideRows) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'oem_part_unit_material_overrides',
        itemId: null,
        itemRole: 'material_override',
        title: `OEM material override ${row.oem_part_id}:${row.material_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }
    for (const row of materialSpecRows) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'oem_part_unit_material_specs',
        itemId: null,
        itemRole: 'material_spec',
        title: `OEM material spec ${row.oem_part_id}:${row.material_id}`,
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
