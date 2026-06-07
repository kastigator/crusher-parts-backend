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

const toNorm = (v) =>
  nz(v)
    ?.toUpperCase()
    .replace(/[\s.\-/]/g, '') || null

const clampLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const sqlValue = (v) => (v === undefined ? null : v)

const baseSelect = `
  SELECT cp.*,
         c.company_name AS client_name,
         ecn.name AS classifier_node_name,
         op.part_number AS base_oem_part_number,
         op.description_ru AS base_oem_description_ru,
         op.description_en AS base_oem_description_en,
         omf.name AS base_oem_manufacturer_name,
         (
           SELECT COUNT(*)
             FROM client_part_applications cpa
            WHERE cpa.client_part_id = cp.id
         ) AS applications_count
    FROM client_parts cp
    JOIN clients c ON c.id = cp.client_id
    LEFT JOIN equipment_classifier_nodes ecn ON ecn.id = cp.classifier_node_id
    LEFT JOIN oem_parts op ON op.id = cp.base_oem_part_id
    LEFT JOIN equipment_manufacturers omf ON omf.id = op.manufacturer_id
`

async function ensureClient(id) {
  if (!id) return false
  const [[row]] = await db.execute('SELECT id FROM clients WHERE id = ?', [id])
  return !!row
}

async function ensureClassifierNode(id) {
  if (!id) return true
  const [[row]] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [id])
  return !!row
}

async function ensureEquipmentModel(id) {
  if (!id) return true
  const [[row]] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [id])
  return !!row
}

async function ensureOemPart(id) {
  if (!id) return true
  const [[row]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [id])
  return !!row
}

async function ensureClientEquipmentUnit(id, clientId) {
  if (!id) return true
  const params = [id]
  let sql = 'SELECT id FROM client_equipment_units WHERE id = ?'
  if (clientId) {
    sql += ' AND client_id = ?'
    params.push(clientId)
  }
  const [[row]] = await db.execute(sql, params)
  return !!row
}

router.get('/', async (req, res) => {
  try {
    const clientId = req.query.client_id !== undefined ? toId(req.query.client_id) : null
    const classifierNodeId =
      req.query.classifier_node_id !== undefined ? toId(req.query.classifier_node_id) : null
    const q = nz(req.query.q)
    const status = nz(req.query.status)
    const relationshipType = nz(req.query.relationship_type)
    const limit = clampLimit(req.query.limit, 200)

    if (req.query.client_id !== undefined && !clientId) {
      return res.status(400).json({ message: 'Некорректный client_id' })
    }
    if (req.query.classifier_node_id !== undefined && !classifierNodeId) {
      return res.status(400).json({ message: 'Некорректный classifier_node_id' })
    }
    if (status && !['active', 'inactive', 'archived'].includes(status)) {
      return res.status(400).json({ message: 'Некорректный статус' })
    }
    if (relationshipType && !['client_drawing', 'oem_variant', 'oem_replacement', 'unknown_oem'].includes(relationshipType)) {
      return res.status(400).json({ message: 'Некорректный тип детали клиента' })
    }

    const where = []
    const params = []
    let sql = baseSelect

    if (clientId) {
      where.push('cp.client_id = ?')
      params.push(clientId)
    }
    if (classifierNodeId) {
      where.push('cp.classifier_node_id = ?')
      params.push(classifierNodeId)
    }
    if (status) {
      where.push('cp.status = ?')
      params.push(status)
    }
    if (relationshipType) {
      where.push('cp.relationship_type = ?')
      params.push(relationshipType)
    }
    if (q) {
      where.push(
        '(cp.client_part_number LIKE ? OR cp.drawing_number LIKE ? OR cp.display_name LIKE ? OR cp.description_ru LIKE ? OR cp.difference_summary LIKE ? OR op.part_number LIKE ?)'
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY c.company_name ASC, cp.display_name ASC, cp.id ASC'
    sql += ` LIMIT ${limit}`

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /client-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[part]] = await db.execute(`${baseSelect} WHERE cp.id = ?`, [id])
    if (!part) return res.status(404).json({ message: 'Деталь клиента не найдена' })

    const [applications] = await db.execute(
      `
      SELECT cpa.*,
             em.model_name,
             em.model_code,
             mf.name AS manufacturer_name,
             ceu.serial_number,
             ceu.internal_name,
             ceu.site_name
        FROM client_part_applications cpa
        LEFT JOIN equipment_models em ON em.id = cpa.equipment_model_id
        LEFT JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
        LEFT JOIN client_equipment_units ceu ON ceu.id = cpa.client_equipment_unit_id
       WHERE cpa.client_part_id = ?
       ORDER BY cpa.id ASC
      `,
      [id]
    )

    res.json({ ...part, applications })
  } catch (err) {
    console.error('GET /client-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const client_id = toId(req.body.client_id)
    const classifier_node_id =
      req.body.classifier_node_id === undefined || req.body.classifier_node_id === null || req.body.classifier_node_id === ''
        ? null
        : toId(req.body.classifier_node_id)
    const client_part_number = nz(req.body.client_part_number)
    const base_oem_part_id =
      req.body.base_oem_part_id === undefined || req.body.base_oem_part_id === null || req.body.base_oem_part_id === ''
        ? null
        : toId(req.body.base_oem_part_id)
    const relationship_type = nz(req.body.relationship_type) || 'client_drawing'
    const revision_code = nz(req.body.revision_code)
    const drawing_number = nz(req.body.drawing_number)
    const display_name = nz(req.body.display_name)
    const description_ru = nz(req.body.description_ru)
    const difference_summary = nz(req.body.difference_summary)
    const uom = nz(req.body.uom) || 'шт'
    const material_note = nz(req.body.material_note)
    const status = nz(req.body.status) || 'active'
    const notes = nz(req.body.notes)

    if (!client_id) return res.status(400).json({ message: 'client_id обязателен' })
    if (!display_name) return res.status(400).json({ message: 'Название детали обязательно' })
    if (!['active', 'inactive', 'archived'].includes(status)) {
      return res.status(400).json({ message: 'Некорректный статус' })
    }
    if (!['client_drawing', 'oem_variant', 'oem_replacement', 'unknown_oem'].includes(relationship_type)) {
      return res.status(400).json({ message: 'Некорректный тип детали клиента' })
    }
    if (!(await ensureClient(client_id))) return res.status(400).json({ message: 'Клиент не найден' })
    if (!(await ensureClassifierNode(classifier_node_id))) {
      return res.status(400).json({ message: 'Узел НСИ не найден' })
    }
    if (!(await ensureOemPart(base_oem_part_id))) {
      return res.status(400).json({ message: 'Базовая OEM-деталь не найдена' })
    }

    const [ins] = await db.execute(
      `
      INSERT INTO client_parts
        (
          client_id, classifier_node_id, base_oem_part_id, relationship_type,
          client_part_number, client_part_number_norm,
          revision_code, drawing_number, display_name, description_ru, difference_summary, uom,
          material_note, status, notes
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        client_id,
        classifier_node_id,
        base_oem_part_id,
        relationship_type,
        client_part_number,
        toNorm(client_part_number || drawing_number || display_name),
        revision_code,
        drawing_number,
        display_name,
        description_ru,
        difference_summary,
        uom,
        material_note,
        status,
        notes,
      ]
    )

    const [[created]] = await db.execute(`${baseSelect} WHERE cp.id = ?`, [ins.insertId])
    await logActivity({
      req,
      action: 'create',
      entity_type: 'client_parts',
      entity_id: ins.insertId,
      client_id,
      comment: 'Добавлена деталь клиента по чертежу',
    })

    res.status(201).json(created)
  } catch (err) {
    console.error('POST /client-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM client_parts WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Деталь клиента не найдена' })

    const client_id = req.body.client_id !== undefined ? toId(req.body.client_id) : undefined
    const base_oem_part_id =
      req.body.base_oem_part_id !== undefined
        ? (req.body.base_oem_part_id === null || req.body.base_oem_part_id === ''
            ? null
            : toId(req.body.base_oem_part_id))
        : undefined
    const relationship_type = req.body.relationship_type !== undefined ? nz(req.body.relationship_type) : undefined
    const classifier_node_id =
      req.body.classifier_node_id !== undefined
        ? (req.body.classifier_node_id === null || req.body.classifier_node_id === ''
            ? null
            : toId(req.body.classifier_node_id))
        : undefined
    const client_part_number = req.body.client_part_number !== undefined ? nz(req.body.client_part_number) : undefined
    const revision_code = req.body.revision_code !== undefined ? nz(req.body.revision_code) : undefined
    const drawing_number = req.body.drawing_number !== undefined ? nz(req.body.drawing_number) : undefined
    const display_name = req.body.display_name !== undefined ? nz(req.body.display_name) : undefined
    const description_ru = req.body.description_ru !== undefined ? nz(req.body.description_ru) : undefined
    const difference_summary = req.body.difference_summary !== undefined ? nz(req.body.difference_summary) : undefined
    const uom = req.body.uom !== undefined ? nz(req.body.uom) || 'шт' : undefined
    const material_note = req.body.material_note !== undefined ? nz(req.body.material_note) : undefined
    const status = req.body.status !== undefined ? nz(req.body.status) : undefined
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : undefined

    if (client_id !== undefined && !client_id) return res.status(400).json({ message: 'Некорректный client_id' })
    if (classifier_node_id !== undefined && req.body.classifier_node_id !== null && !classifier_node_id) {
      return res.status(400).json({ message: 'Некорректный classifier_node_id' })
    }
    if (display_name !== undefined && !display_name) {
      return res.status(400).json({ message: 'Название детали обязательно' })
    }
    if (status !== undefined && !['active', 'inactive', 'archived'].includes(status)) {
      return res.status(400).json({ message: 'Некорректный статус' })
    }
    if (relationship_type !== undefined && !['client_drawing', 'oem_variant', 'oem_replacement', 'unknown_oem'].includes(relationship_type)) {
      return res.status(400).json({ message: 'Некорректный тип детали клиента' })
    }
    if (client_id && !(await ensureClient(client_id))) return res.status(400).json({ message: 'Клиент не найден' })
    if (!(await ensureClassifierNode(classifier_node_id))) {
      return res.status(400).json({ message: 'Узел НСИ не найден' })
    }
    if (!(await ensureOemPart(base_oem_part_id))) {
      return res.status(400).json({ message: 'Базовая OEM-деталь не найдена' })
    }

    const nextNumber = client_part_number === undefined ? before.client_part_number : client_part_number
    const nextDrawing = drawing_number === undefined ? before.drawing_number : drawing_number
    const nextName = display_name === undefined ? before.display_name : display_name

    await db.execute(
      `
      UPDATE client_parts
         SET client_id = COALESCE(?, client_id),
             classifier_node_id = ?,
             base_oem_part_id = ?,
             relationship_type = COALESCE(?, relationship_type),
             client_part_number = ?,
             client_part_number_norm = ?,
             revision_code = ?,
             drawing_number = ?,
             display_name = COALESCE(?, display_name),
             description_ru = ?,
             difference_summary = ?,
             uom = COALESCE(?, uom),
             material_note = ?,
             status = COALESCE(?, status),
             notes = ?
       WHERE id = ?
      `,
      [
        sqlValue(client_id),
        classifier_node_id === undefined ? before.classifier_node_id : classifier_node_id,
        base_oem_part_id === undefined ? before.base_oem_part_id : base_oem_part_id,
        sqlValue(relationship_type),
        client_part_number === undefined ? before.client_part_number : client_part_number,
        toNorm(nextNumber || nextDrawing || nextName),
        revision_code === undefined ? before.revision_code : revision_code,
        drawing_number === undefined ? before.drawing_number : drawing_number,
        sqlValue(display_name),
        description_ru === undefined ? before.description_ru : description_ru,
        difference_summary === undefined ? before.difference_summary : difference_summary,
        sqlValue(uom),
        material_note === undefined ? before.material_note : material_note,
        sqlValue(status),
        notes === undefined ? before.notes : notes,
        id,
      ]
    )

    const [[afterRaw]] = await db.execute('SELECT * FROM client_parts WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'client_parts',
      entity_id: id,
      oldData: before,
      newData: afterRaw,
      client_id: afterRaw.client_id,
    })

    const [[after]] = await db.execute(`${baseSelect} WHERE cp.id = ?`, [id])
    res.json(after)
  } catch (err) {
    console.error('PUT /client-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/applications', async (req, res) => {
  try {
    const client_part_id = toId(req.params.id)
    const equipment_model_id =
      req.body.equipment_model_id === undefined || req.body.equipment_model_id === null || req.body.equipment_model_id === ''
        ? null
        : toId(req.body.equipment_model_id)
    const client_equipment_unit_id =
      req.body.client_equipment_unit_id === undefined || req.body.client_equipment_unit_id === null || req.body.client_equipment_unit_id === ''
        ? null
        : toId(req.body.client_equipment_unit_id)
    const note = nz(req.body.note)

    if (!client_part_id) return res.status(400).json({ message: 'Некорректная деталь клиента' })
    const [[part]] = await db.execute('SELECT * FROM client_parts WHERE id = ?', [client_part_id])
    if (!part) return res.status(404).json({ message: 'Деталь клиента не найдена' })
    if (!equipment_model_id && !client_equipment_unit_id) {
      return res.status(400).json({ message: 'Выберите модель или конкретную машину клиента' })
    }
    if (!(await ensureEquipmentModel(equipment_model_id))) {
      return res.status(400).json({ message: 'Модель оборудования не найдена' })
    }
    if (!(await ensureClientEquipmentUnit(client_equipment_unit_id, part.client_id))) {
      return res.status(400).json({ message: 'Машина клиента не найдена или принадлежит другому клиенту' })
    }

    const [ins] = await db.execute(
      `
      INSERT INTO client_part_applications
        (client_part_id, equipment_model_id, client_equipment_unit_id, note)
      VALUES (?, ?, ?, ?)
      `,
      [client_part_id, equipment_model_id, client_equipment_unit_id, note]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'client_part_applications',
      entity_id: ins.insertId,
      client_id: part.client_id,
      comment: 'Добавлена применяемость детали клиента',
    })

    res.status(201).json({ id: ins.insertId })
  } catch (err) {
    console.error('POST /client-parts/:id/applications error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/applications/:applicationId', async (req, res) => {
  try {
    const client_part_id = toId(req.params.id)
    const applicationId = toId(req.params.applicationId)
    if (!client_part_id || !applicationId) return res.status(400).json({ message: 'Некорректные идентификаторы' })

    await db.execute(
      'DELETE FROM client_part_applications WHERE id = ? AND client_part_id = ?',
      [applicationId, client_part_id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /client-parts/:id/applications/:applicationId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    await conn.beginTransaction()
    const [[before]] = await conn.execute('SELECT * FROM client_parts WHERE id = ? FOR UPDATE', [id])
    if (!before) {
      await conn.rollback()
      return res.status(404).json({ message: 'Деталь клиента не найдена' })
    }

    const [applications] = await conn.execute(
      'SELECT * FROM client_part_applications WHERE client_part_id = ? ORDER BY id ASC',
      [id]
    )

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'client_parts',
      entityId: id,
      rootEntityType: 'clients',
      rootEntityId: Number(before.client_id),
      title: before.display_name || before.client_part_number || `Деталь клиента #${id}`,
      subtitle: 'Деталь клиента по чертежу',
      snapshot: before,
      context: {
        client_id: Number(before.client_id),
      },
    })

    let sortOrder = 0
    for (const row of applications) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'client_part_applications',
        itemId: row.id,
        itemRole: 'application',
        title: `Применяемость детали клиента #${row.id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
    }

    await conn.execute('DELETE FROM client_parts WHERE id = ?', [id])
    await logActivity({
      req,
      action: 'delete',
      entity_type: 'client_parts',
      entity_id: id,
      old_value: String(trashEntryId),
      client_id: before.client_id,
      comment: 'Деталь клиента перемещена в корзину',
    })

    await conn.commit()
    res.json({ success: true, trash_entry_id: trashEntryId })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /client-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
