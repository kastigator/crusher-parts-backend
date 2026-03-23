const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const {
  nz,
  toId,
  toBool,
  clampLimit,
  parseCanonicalUom,
  normalizeAttributeInput,
  normalizeFieldInput,
  buildDisplayName,
  buildSearchText,
} = require('../utils/standardParts')

const listSelect = `
  SELECT sp.id,
         sp.class_id,
         c.name AS class_name,
         c.code AS class_code,
         sp.display_name,
         sp.designation,
         sp.uom,
         sp.description_ru,
         sp.description_en,
         sp.notes,
         sp.is_active,
         sp.created_at,
         sp.updated_at,
         (
           SELECT COUNT(*)
             FROM oem_part_standard_parts opsp
            WHERE opsp.standard_part_id = sp.id
         ) AS oem_links_count,
         (
           SELECT COUNT(*)
             FROM supplier_part_standard_parts spsp
            WHERE spsp.standard_part_id = sp.id
         ) AS supplier_links_count
    FROM standard_parts sp
    JOIN standard_part_classes c ON c.id = sp.class_id
`

const parseOptionalCurrency = (value) => {
  const raw = nz(value)
  if (!raw) return null
  return String(raw).trim().toUpperCase().slice(0, 3) || null
}

const numOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null
  const num = Number(String(value).replace(',', '.'))
  return Number.isFinite(num) ? num : null
}

const canonicalSupplierPartNumber = (value) => {
  const raw = nz(value)
  if (!raw) return null
  return String(raw)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_./\\]/g, '')
}

const fetchClassBundle = async (classId) => {
  const [[classRow]] = await db.execute('SELECT * FROM standard_part_classes WHERE id = ?', [classId])
  if (!classRow) return null

  const [fields] = await db.execute(
    `
    SELECT *
      FROM standard_part_class_fields
     WHERE class_id = ?
     ORDER BY sort_order ASC, id ASC
    `,
    [classId]
  )

  const fieldIds = fields.map((field) => field.id)
  const optionsByFieldId = new Map()

  if (fieldIds.length) {
    const placeholders = fieldIds.map(() => '?').join(',')
    const [optionRows] = await db.execute(
      `
      SELECT *
        FROM standard_part_field_options
       WHERE field_id IN (${placeholders})
       ORDER BY sort_order ASC, id ASC
      `,
      fieldIds
    )

    optionRows.forEach((row) => {
      const list = optionsByFieldId.get(Number(row.field_id)) || []
      list.push(row)
      optionsByFieldId.set(Number(row.field_id), list)
    })
  }

  const fieldsByCode = new Map()
  const fieldsById = new Map()
  fields.forEach((field) => {
    fieldsByCode.set(String(field.code), field)
    fieldsById.set(Number(field.id), field)
  })

  return { classRow, fields, fieldsByCode, fieldsById, optionsByFieldId }
}

const fetchDescendantClassIds = async (rootClassId) => {
  const [rows] = await db.execute(
    `
    SELECT id, parent_id
      FROM standard_part_classes
    `
  )

  const childrenByParent = new Map()
  rows.forEach((row) => {
    const parentId = row.parent_id == null ? null : Number(row.parent_id)
    const list = childrenByParent.get(parentId) || []
    list.push(Number(row.id))
    childrenByParent.set(parentId, list)
  })

  const result = []
  const queue = [Number(rootClassId)]
  const seen = new Set()

  while (queue.length) {
    const classId = queue.shift()
    if (!classId || seen.has(classId)) continue
    seen.add(classId)
    result.push(classId)
    const children = childrenByParent.get(classId) || []
    children.forEach((childId) => queue.push(childId))
  }

  return result
}

const fetchPartValues = async (standardPartId, classBundle) => {
  const [rows] = await db.execute(
    `
    SELECT *
      FROM standard_part_values
     WHERE standard_part_id = ?
    `,
    [standardPartId]
  )

  const valuesByFieldId = new Map()
  rows.forEach((row) => valuesByFieldId.set(Number(row.field_id), row))

  const attributes = classBundle.fields.map((field) => {
    const valueRow = valuesByFieldId.get(Number(field.id)) || null
    let value = null

    if (valueRow) {
      if (valueRow.value_number !== null && valueRow.value_number !== undefined) value = Number(valueRow.value_number)
      else if (valueRow.value_boolean !== null && valueRow.value_boolean !== undefined) value = Number(valueRow.value_boolean) === 1
      else if (valueRow.value_date) value = valueRow.value_date
      else if (valueRow.value_json) {
        try {
          value = JSON.parse(valueRow.value_json)
        } catch {
          value = valueRow.value_json
        }
      } else value = valueRow.value_text || null
    }

    return {
      field_id: field.id,
      field_code: field.code,
      label: field.label,
      field_type: field.field_type,
      unit: field.unit || null,
      is_required: Number(field.is_required || 0),
      is_in_title: Number(field.is_in_title || 0),
      is_in_list: Number(field.is_in_list || 0),
      is_in_filters: Number(field.is_in_filters || 0),
      is_searchable: Number(field.is_searchable || 0),
      value,
      options: optionsByFieldIdToPayload(classBundle.optionsByFieldId.get(Number(field.id)) || []),
    }
  })

  return { rows, valuesByFieldId, attributes }
}

const optionsByFieldIdToPayload = (rows = []) =>
  rows.map((row) => ({
    id: row.id,
    value_code: row.value_code,
    value_label: row.value_label,
    sort_order: row.sort_order,
    is_active: row.is_active,
  }))

const syncPartValues = async ({ conn, partId, classBundle, attributes, basePayload }) => {
  const normalizedAttributes = normalizeAttributeInput(attributes)
  const explicitFieldIds = new Set()
  const valueRows = []

  classBundle.fields.forEach((field) => {
    const incoming =
      normalizedAttributes.find((entry) => entry.field_id === Number(field.id)) ||
      normalizedAttributes.find((entry) => entry.field_code && entry.field_code === field.code) ||
      null

    const rawValue =
      incoming && Object.prototype.hasOwnProperty.call(incoming, 'value')
        ? incoming.value
        : field.code === 'designation'
        ? basePayload.designation
        : undefined

    if (incoming) explicitFieldIds.add(Number(field.id))

    const normalized = normalizeFieldInput(field, rawValue)
    if (normalized.error) {
      const err = new Error(normalized.error)
      err.status = 400
      throw err
    }

    const hasAnyValue = ['value_text', 'value_number', 'value_boolean', 'value_date', 'value_json'].some(
      (key) => normalized[key] !== undefined && normalized[key] !== null
    )

    if (Number(field.is_required || 0) === 1 && !hasAnyValue) {
      const err = new Error(`Поле "${field.label}" обязательно`)
      err.status = 400
      throw err
    }

    if (!hasAnyValue) return

    valueRows.push({
      field_id: Number(field.id),
      ...normalized,
    })
  })

  await conn.execute('DELETE FROM standard_part_values WHERE standard_part_id = ?', [partId])

  if (valueRows.length) {
    const placeholders = valueRows.map(() => '(?,?,?,?,?,?,?)').join(',')
    const values = []
    valueRows.forEach((row) => {
      values.push(
        partId,
        row.field_id,
        row.value_text === undefined ? null : row.value_text || null,
        row.value_number === undefined ? null : row.value_number,
        row.value_boolean === undefined ? null : row.value_boolean,
        row.value_date === undefined ? null : row.value_date,
        row.value_json === undefined ? null : row.value_json
      )
    })

    await conn.execute(
      `
      INSERT INTO standard_part_values
        (standard_part_id, field_id, value_text, value_number, value_boolean, value_date, value_json)
      VALUES ${placeholders}
      `,
      values
    )
  }

  const valuesByFieldId = new Map(valueRows.map((row) => [Number(row.field_id), row]))
  const optionsLabelMap = new Map()
  classBundle.optionsByFieldId.forEach((rows, fieldId) => {
    optionsLabelMap.set(
      Number(fieldId),
      new Map(rows.map((row) => [String(row.value_code), row.value_label]))
    )
  })

  const displayName = buildDisplayName({
    classRow: classBundle.classRow,
    fields: classBundle.fields,
    valuesByFieldId,
    optionsByFieldId: optionsLabelMap,
    designation: basePayload.designation,
  })

  const searchText = buildSearchText({
    classRow: classBundle.classRow,
    displayName,
    designation: basePayload.designation,
    descriptions: [basePayload.description_ru, basePayload.description_en, basePayload.notes],
    values: valueRows.map((row) => ({
      field_id: row.field_id,
      value_text: row.value_text || null,
      value_number: row.value_number === undefined ? null : row.value_number,
      value_boolean: row.value_boolean === undefined ? null : row.value_boolean,
      value_date: row.value_date || null,
      value_json: row.value_json || null,
    })),
    fieldsById: classBundle.fieldsById,
    optionsByFieldId: optionsLabelMap,
  })

  const displayNameNorm = String(displayName || '')
    .trim()
    .toUpperCase()
    .replace(/[\s.-]+/g, '')

  await conn.execute(
    `
    UPDATE standard_parts
       SET display_name = ?,
           display_name_norm = ?,
           attributes_search_text = ?
     WHERE id = ?
    `,
    [displayName, displayNameNorm || null, searchText, partId]
  )
}

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const classId = req.query.class_id !== undefined ? toId(req.query.class_id) : null
    const includeDescendants = req.query.include_descendants === undefined ? true : toBool(req.query.include_descendants)
    const activeRaw = req.query.is_active
    const linkedToOemId = req.query.oem_part_id !== undefined ? toId(req.query.oem_part_id) : null
    const limit = clampLimit(req.query.limit, 200)
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Math.trunc(Number(req.query.offset))) : 0

    if (req.query.class_id !== undefined && !classId) {
      return res.status(400).json({ message: 'Некорректный class_id' })
    }
    if (req.query.oem_part_id !== undefined && !linkedToOemId) {
      return res.status(400).json({ message: 'Некорректный oem_part_id' })
    }

    const where = []
    const params = []
    let sql = listSelect

    if (q) {
      where.push(
        '(sp.display_name LIKE ? OR sp.designation LIKE ? OR c.name LIKE ? OR sp.description_ru LIKE ? OR sp.description_en LIKE ? OR sp.attributes_search_text LIKE ?)'
      )
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }
    if (classId) {
      if (includeDescendants) {
        const classIds = await fetchDescendantClassIds(classId)
        if (!classIds.length) {
          return res.json([])
        }
        const placeholders = classIds.map(() => '?').join(',')
        where.push(`sp.class_id IN (${placeholders})`)
        params.push(...classIds)
      } else {
        where.push('sp.class_id = ?')
        params.push(classId)
      }
    }
    if (activeRaw !== undefined) {
      where.push('sp.is_active = ?')
      params.push(toBool(activeRaw) ? 1 : 0)
    }
    if (linkedToOemId) {
      where.push('EXISTS (SELECT 1 FROM oem_part_standard_parts x WHERE x.standard_part_id = sp.id AND x.oem_part_id = ?)')
      params.push(linkedToOemId)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY c.name ASC, sp.display_name ASC, sp.id ASC'
    sql += ` LIMIT ${limit} OFFSET ${offset}`

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /standard-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[part]] = await db.execute(`${listSelect} WHERE sp.id = ?`, [id])
    if (!part) return res.status(404).json({ message: 'Standard part не найдена' })

    const classBundle = await fetchClassBundle(part.class_id)
    const { attributes } = await fetchPartValues(id, classBundle)
    res.json({
      ...part,
      attributes,
    })
  } catch (err) {
    console.error('GET /standard-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/oem-representations', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [rows] = await db.execute(
      `
      SELECT op.id AS oem_part_id,
             op.part_number,
             op.description_ru,
             op.description_en,
             op.uom,
             opsp.is_primary,
             opsp.note,
             m.name AS manufacturer_name
        FROM oem_part_standard_parts opsp
        JOIN oem_parts op ON op.id = opsp.oem_part_id
        LEFT JOIN equipment_manufacturers m ON m.id = op.manufacturer_id
       WHERE opsp.standard_part_id = ?
       ORDER BY opsp.is_primary DESC, m.name ASC, op.part_number ASC
      `,
      [id]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /standard-parts/:id/oem-representations error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/supplier-parts', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [rows] = await db.execute(
      `
      SELECT sp.id AS supplier_part_id,
             sp.supplier_part_number,
             sp.description_ru,
             sp.description_en,
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
             spsp.is_preferred,
             spsp.note,
             ps.id AS supplier_id,
             ps.name AS supplier_name,
             lp.price AS latest_price,
             lp.currency AS latest_currency,
             lp.date AS latest_price_date
        FROM supplier_part_standard_parts spsp
        JOIN supplier_parts sp ON sp.id = spsp.supplier_part_id
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
        LEFT JOIN (
          SELECT spp1.*
            FROM supplier_part_prices spp1
            JOIN (
              SELECT supplier_part_id, MAX(id) AS max_id
                FROM supplier_part_prices
               GROUP BY supplier_part_id
            ) latest ON latest.max_id = spp1.id
        ) lp ON lp.supplier_part_id = sp.id
       WHERE spsp.standard_part_id = ?
       ORDER BY spsp.is_preferred DESC, ps.name ASC, sp.supplier_part_number ASC
      `,
      [id]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /standard-parts/:id/supplier-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const class_id = toId(req.body.class_id)
    if (!class_id) return res.status(400).json({ message: 'class_id обязателен' })

    const classBundle = await fetchClassBundle(class_id)
    if (!classBundle) return res.status(400).json({ message: 'Класс standard parts не найден' })

    const { uom, error: uomError } = parseCanonicalUom(req.body.uom || 'pcs')
    if (uomError) return res.status(400).json({ message: uomError })

    const basePayload = {
      class_id,
      designation: nz(req.body.designation),
      uom,
      description_ru: nz(req.body.description_ru),
      description_en: nz(req.body.description_en),
      notes: nz(req.body.notes),
      is_active: req.body.is_active === undefined ? 1 : (toBool(req.body.is_active) ? 1 : 0),
    }

    await conn.beginTransaction()
    const [ins] = await conn.execute(
      `
      INSERT INTO standard_parts
        (class_id, display_name, display_name_norm, designation, uom, description_ru, description_en, notes, attributes_search_text, is_active)
      VALUES (?, '', NULL, ?, ?, ?, ?, ?, NULL, ?)
      `,
      [
        basePayload.class_id,
        basePayload.designation,
        basePayload.uom,
        basePayload.description_ru,
        basePayload.description_en,
        basePayload.notes,
        basePayload.is_active,
      ]
    )

    await syncPartValues({
      conn,
      partId: ins.insertId,
      classBundle,
      attributes: req.body.attributes,
      basePayload,
    })

    await conn.commit()

    const [[created]] = await db.execute(`${listSelect} WHERE sp.id = ?`, [ins.insertId])
    await logActivity({
      req,
      action: 'create',
      entity_type: 'standard_parts',
      entity_id: ins.insertId,
      comment: 'Создана canonical standard part',
    })

    res.status(201).json(created)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('POST /standard-parts error:', err)
    res.status(err?.status || 500).json({ message: err?.message || 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.put('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await conn.execute('SELECT * FROM standard_parts WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Standard part не найдена' })

    const class_id = req.body.class_id !== undefined ? toId(req.body.class_id) : Number(before.class_id)
    if (!class_id) return res.status(400).json({ message: 'Некорректный class_id' })

    const classBundle = await fetchClassBundle(class_id)
    if (!classBundle) return res.status(400).json({ message: 'Класс standard parts не найден' })

    const uomParsed = req.body.uom !== undefined ? parseCanonicalUom(req.body.uom) : { uom: before.uom, error: null }
    if (uomParsed.error) return res.status(400).json({ message: uomParsed.error })

    const basePayload = {
      class_id,
      designation: req.body.designation !== undefined ? nz(req.body.designation) : before.designation,
      uom: uomParsed.uom,
      description_ru: req.body.description_ru !== undefined ? nz(req.body.description_ru) : before.description_ru,
      description_en: req.body.description_en !== undefined ? nz(req.body.description_en) : before.description_en,
      notes: req.body.notes !== undefined ? nz(req.body.notes) : before.notes,
      is_active: req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : Number(before.is_active || 0),
    }

    await conn.beginTransaction()
    await conn.execute(
      `
      UPDATE standard_parts
         SET class_id = ?,
             designation = ?,
             uom = ?,
             description_ru = ?,
             description_en = ?,
             notes = ?,
             is_active = ?
       WHERE id = ?
      `,
      [
        basePayload.class_id,
        basePayload.designation,
        basePayload.uom,
        basePayload.description_ru,
        basePayload.description_en,
        basePayload.notes,
        basePayload.is_active,
        id,
      ]
    )

    await syncPartValues({
      conn,
      partId: id,
      classBundle,
      attributes: req.body.attributes,
      basePayload,
    })

    await conn.commit()

    const [[after]] = await db.execute('SELECT * FROM standard_parts WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'standard_parts',
      entity_id: id,
      oldData: before,
      newData: after,
    })

    const [[fresh]] = await db.execute(`${listSelect} WHERE sp.id = ?`, [id])
    res.json(fresh)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('PUT /standard-parts/:id error:', err)
    res.status(err?.status || 500).json({ message: err?.message || 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM standard_parts WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Standard part не найдена' })

    await db.execute('DELETE FROM standard_parts WHERE id = ?', [id])
    await logActivity({
      req,
      action: 'delete',
      entity_type: 'standard_parts',
      entity_id: id,
      comment: `Удалена canonical standard part ${before.display_name || id}`,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /standard-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/create-oem-representation', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const standardPartId = toId(req.params.id)
    const manufacturer_id = toId(req.body.manufacturer_id)
    const equipment_model_ids = Array.isArray(req.body.equipment_model_ids)
      ? req.body.equipment_model_ids.map(toId).filter(Boolean)
      : []
    const part_number = nz(req.body.part_number)
    const description_ru = nz(req.body.description_ru)
    const description_en = nz(req.body.description_en)
    const tech_description = nz(req.body.tech_description)
    const { uom, error: uomError } = parseCanonicalUom(req.body.uom || 'pcs')

    if (!standardPartId) return res.status(400).json({ message: 'Некорректный standard_part_id' })
    if (!manufacturer_id) return res.status(400).json({ message: 'manufacturer_id обязателен' })
    if (!part_number) return res.status(400).json({ message: 'part_number обязателен' })
    if (!equipment_model_ids.length) return res.status(400).json({ message: 'Нужно выбрать хотя бы одну модель' })
    if (uomError) return res.status(400).json({ message: uomError })

    const [[standardPart]] = await conn.execute('SELECT id FROM standard_parts WHERE id = ?', [standardPartId])
    if (!standardPart) return res.status(404).json({ message: 'Standard part не найдена' })

    const [[manufacturer]] = await conn.execute('SELECT id FROM equipment_manufacturers WHERE id = ?', [manufacturer_id])
    if (!manufacturer) return res.status(400).json({ message: 'Производитель не найден' })

    const placeholders = equipment_model_ids.map(() => '?').join(',')
    const [models] = await conn.execute(
      `
      SELECT id, manufacturer_id
        FROM equipment_models
       WHERE id IN (${placeholders})
      `,
      equipment_model_ids
    )
    if (models.length !== equipment_model_ids.length) {
      return res.status(400).json({ message: 'Одна или несколько моделей не найдены' })
    }
    if (models.some((model) => Number(model.manufacturer_id) !== manufacturer_id)) {
      return res.status(400).json({ message: 'Все модели должны принадлежать выбранному производителю' })
    }

    await conn.beginTransaction()
    const [ins] = await conn.execute(
      `
      INSERT INTO oem_parts
        (manufacturer_id, part_number, description_ru, description_en, tech_description, uom)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [manufacturer_id, part_number, description_ru, description_en, tech_description, uom]
    )

    if (equipment_model_ids.length) {
      const values = []
      const fitmentPlaceholders = equipment_model_ids.map(() => '(?, ?)').join(',')
      equipment_model_ids.forEach((modelId) => {
        values.push(ins.insertId, modelId)
      })
      await conn.execute(
        `
        INSERT INTO oem_part_model_fitments (oem_part_id, equipment_model_id)
        VALUES ${fitmentPlaceholders}
        `,
        values
      )
    }

    await conn.execute(
      `
      INSERT INTO oem_part_standard_parts (oem_part_id, standard_part_id, is_primary, note)
      VALUES (?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE
        is_primary = VALUES(is_primary),
        note = VALUES(note)
      `,
      [ins.insertId, standardPartId, nz(req.body.note)]
    )

    await conn.commit()
    const [[created]] = await db.execute('SELECT * FROM oem_parts WHERE id = ?', [ins.insertId])
    res.status(201).json(created)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('POST /standard-parts/:id/create-oem-representation error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.post('/:id/create-supplier-representation', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const standardPartId = toId(req.params.id)
    const supplier_id = toId(req.body.supplier_id)
    const supplier_part_number = nz(req.body.supplier_part_number)
    const description_ru = nz(req.body.description_ru)
    const description_en = nz(req.body.description_en)
    const comment = nz(req.body.comment)
    const { uom, error: uomError } = parseCanonicalUom(req.body.uom || 'pcs')
    const lead_time_days = numOrNull(req.body.lead_time_days)
    const min_order_qty = numOrNull(req.body.min_order_qty)
    const packaging = nz(req.body.packaging)
    const weight_kg = numOrNull(req.body.weight_kg)
    const length_cm = numOrNull(req.body.length_cm)
    const width_cm = numOrNull(req.body.width_cm)
    const height_cm = numOrNull(req.body.height_cm)
    const is_overweight = toBool(req.body.is_overweight) ? 1 : 0
    const is_oversize = toBool(req.body.is_oversize) ? 1 : 0
    const normalizedPartType = String(req.body.part_type || '').trim().toUpperCase()
    const part_type = ['OEM', 'ANALOG', 'UNKNOWN'].includes(normalizedPartType)
      ? normalizedPartType
      : 'ANALOG'
    const is_preferred = toBool(req.body.is_preferred) ? 1 : 0
    const note = nz(req.body.note)
    const initial_price = numOrNull(req.body.initial_price)
    const initial_currency = parseOptionalCurrency(req.body.initial_currency)
    const initial_price_date = nz(req.body.initial_price_date)

    if (!standardPartId) return res.status(400).json({ message: 'Некорректный standard_part_id' })
    if (!supplier_id) return res.status(400).json({ message: 'supplier_id обязателен' })
    if (!supplier_part_number) return res.status(400).json({ message: 'supplier_part_number обязателен' })
    if (uomError) return res.status(400).json({ message: uomError })
    if (initial_price !== null && !initial_currency) {
      return res.status(400).json({ message: 'Для стартовой цены нужно указать валюту' })
    }

    const [[standardPart]] = await conn.execute('SELECT id FROM standard_parts WHERE id = ?', [standardPartId])
    if (!standardPart) return res.status(404).json({ message: 'Standard part не найдена' })

    const [[supplier]] = await conn.execute('SELECT id FROM part_suppliers WHERE id = ?', [supplier_id])
    if (!supplier) return res.status(400).json({ message: 'Поставщик не найден' })

    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `
      INSERT INTO supplier_parts
        (
          supplier_id, supplier_part_number, canonical_part_number, description_ru, description_en,
          uom, comment, lead_time_days, min_order_qty, packaging, active,
          weight_kg, length_cm, width_cm, height_cm, is_overweight, is_oversize, part_type
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        supplier_id,
        supplier_part_number,
        canonicalSupplierPartNumber(supplier_part_number),
        description_ru,
        description_en,
        uom,
        comment,
        lead_time_days,
        min_order_qty,
        packaging,
        weight_kg,
        length_cm,
        width_cm,
        height_cm,
        is_overweight,
        is_oversize,
        part_type,
      ]
    )

    await conn.execute(
      `
      INSERT INTO supplier_part_standard_parts
        (supplier_part_id, standard_part_id, priority_rank, is_preferred, note)
      VALUES (?, ?, NULL, ?, ?)
      ON DUPLICATE KEY UPDATE
        is_preferred = VALUES(is_preferred),
        note = VALUES(note)
      `,
      [ins.insertId, standardPartId, is_preferred, note]
    )

    if (initial_price !== null && initial_currency) {
      await conn.execute(
        `
        INSERT INTO supplier_part_prices
          (supplier_part_id, price, currency, date, offer_type, lead_time_days, min_order_qty, packaging, source_type, source_subtype, created_by_user_id)
        VALUES (?, ?, ?, COALESCE(?, CURRENT_DATE()), ?, ?, ?, ?, 'MANUAL', 'STANDARD_PART_CREATE', ?)
        `,
        [
          ins.insertId,
          initial_price,
          initial_currency,
          initial_price_date,
          part_type,
          lead_time_days,
          min_order_qty,
          packaging,
          toId(req.user?.id),
        ]
      )
    }

    await conn.commit()

    const [[created]] = await db.execute(
      `
      SELECT sp.*,
             ps.name AS supplier_name
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
       WHERE sp.id = ?
      `,
      [ins.insertId]
    )

    res.status(201).json(created)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'У этого поставщика уже есть деталь с таким номером' })
    }
    console.error('POST /standard-parts/:id/create-supplier-representation error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.post('/:id/link-existing-oem', async (req, res) => {
  try {
    const standardPartId = toId(req.params.id)
    const oemPartId = toId(req.body.oem_part_id)
    if (!standardPartId || !oemPartId) {
      return res.status(400).json({ message: 'Нужно указать standard_part_id и oem_part_id' })
    }

    const [[standardPart]] = await db.execute('SELECT id FROM standard_parts WHERE id = ?', [standardPartId])
    if (!standardPart) return res.status(404).json({ message: 'Standard part не найдена' })

    const [[oemPart]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [oemPartId])
    if (!oemPart) return res.status(404).json({ message: 'OEM деталь не найдена' })

    await db.execute(
      `
      INSERT INTO oem_part_standard_parts (oem_part_id, standard_part_id, is_primary, note)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        is_primary = VALUES(is_primary),
        note = VALUES(note)
      `,
      [oemPartId, standardPartId, toBool(req.body.is_primary) ? 1 : 0, nz(req.body.note)]
    )

    res.json({ success: true })
  } catch (err) {
    console.error('POST /standard-parts/:id/link-existing-oem error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
