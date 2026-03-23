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
  sqlValue,
  normalizeFieldType,
  buildTree,
} = require('../utils/standardParts')

const baseNodeSelect = `
  SELECT c.*,
         p.name AS parent_name,
         (
           SELECT COUNT(*)
             FROM standard_part_classes x
            WHERE x.parent_id = c.id
         ) AS children_count,
         (
           SELECT COUNT(*)
             FROM standard_parts sp
            WHERE sp.class_id = c.id
         ) AS parts_count
    FROM standard_part_classes c
    LEFT JOIN standard_part_classes p ON p.id = c.parent_id
`

const fieldSelect = `
  SELECT f.*
    FROM standard_part_class_fields f
`

const fetchFieldsWithOptions = async (classId) => {
  const [fields] = await db.execute(
    `
    ${fieldSelect}
   WHERE f.class_id = ?
   ORDER BY f.sort_order ASC, f.id ASC
    `,
    [classId]
  )

  if (!fields.length) return []

  const fieldIds = fields.map((field) => field.id)
  const placeholders = fieldIds.map(() => '?').join(',')
  const [options] = await db.execute(
    `
    SELECT o.*
      FROM standard_part_field_options o
     WHERE o.field_id IN (${placeholders})
     ORDER BY o.sort_order ASC, o.id ASC
    `,
    fieldIds
  )

  const optionsByField = new Map()
  options.forEach((row) => {
    const list = optionsByField.get(Number(row.field_id)) || []
    list.push(row)
    optionsByField.set(Number(row.field_id), list)
  })

  return fields.map((field) => ({
    ...field,
    options: optionsByField.get(Number(field.id)) || [],
  }))
}

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const parentIdRaw = req.query.parent_id
    const asTree = toBool(req.query.tree)
    const activeRaw = req.query.is_active
    const limit = clampLimit(req.query.limit, asTree ? 5000 : 200)

    const where = []
    const params = []
    let sql = baseNodeSelect

    if (parentIdRaw !== undefined) {
      if (parentIdRaw === '' || parentIdRaw === 'null') {
        where.push('c.parent_id IS NULL')
      } else {
        const parentId = toId(parentIdRaw)
        if (!parentId) return res.status(400).json({ message: 'Некорректный parent_id' })
        where.push('c.parent_id = ?')
        params.push(parentId)
      }
    }

    if (activeRaw !== undefined) {
      where.push('c.is_active = ?')
      params.push(toBool(activeRaw) ? 1 : 0)
    }

    if (q) {
      where.push('(c.name LIKE ? OR c.code LIKE ? OR c.description LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY c.sort_order ASC, c.name ASC'
    if (!asTree) sql += ` LIMIT ${limit}`

    const [rows] = await db.execute(sql, params)
    res.json(asTree ? buildTree(rows) : rows)
  } catch (err) {
    console.error('GET /standard-part-classes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(`${baseNodeSelect} WHERE c.id = ?`, [id])
    if (!rows.length) return res.status(404).json({ message: 'Класс standard parts не найден' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /standard-part-classes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/fields', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    res.json(await fetchFieldsWithOptions(id))
  } catch (err) {
    console.error('GET /standard-part-classes/:id/fields error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/workspace', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[node]] = await db.execute(`${baseNodeSelect} WHERE c.id = ?`, [id])
    if (!node) return res.status(404).json({ message: 'Класс standard parts не найден' })

    const fields = await fetchFieldsWithOptions(id)
    const [parts] = await db.execute(
      `
      SELECT sp.id,
             sp.class_id,
             sp.display_name,
             sp.designation,
             sp.description_ru,
             sp.description_en,
             sp.is_active,
             (
               SELECT COUNT(*)
                 FROM oem_part_standard_parts x
                WHERE x.standard_part_id = sp.id
             ) AS oem_links_count,
             (
               SELECT COUNT(*)
                 FROM supplier_part_standard_parts x
                WHERE x.standard_part_id = sp.id
             ) AS supplier_links_count
        FROM standard_parts sp
       WHERE sp.class_id = ?
       ORDER BY sp.display_name ASC, sp.id ASC
       LIMIT 200
      `,
      [id]
    )

    const [oemRepresentations] = await db.execute(
      `
      SELECT op.id AS oem_part_id,
             op.part_number,
             op.description_ru,
             op.description_en,
             sp.id AS standard_part_id,
             sp.display_name AS standard_part_display_name,
             m.name AS manufacturer_name
        FROM oem_part_standard_parts opsp
        JOIN oem_parts op ON op.id = opsp.oem_part_id
        JOIN standard_parts sp ON sp.id = opsp.standard_part_id
        LEFT JOIN equipment_manufacturers m ON m.id = op.manufacturer_id
       WHERE sp.class_id = ?
       ORDER BY sp.display_name ASC, op.part_number ASC
       LIMIT 200
      `,
      [id]
    )

    const [supplierRepresentations] = await db.execute(
      `
      SELECT sp.id AS supplier_part_id,
             sp.supplier_part_number,
             sp.description_ru,
             sp.description_en,
             sp.part_type,
             sp.lead_time_days,
             sp.min_order_qty,
             spsp.is_preferred,
             spsp.note,
             std.id AS standard_part_id,
             std.display_name AS standard_part_display_name,
             ps.id AS supplier_id,
             ps.name AS supplier_name,
             lp.price AS latest_price,
             lp.currency AS latest_currency
        FROM supplier_part_standard_parts spsp
        JOIN supplier_parts sp ON sp.id = spsp.supplier_part_id
        JOIN standard_parts std ON std.id = spsp.standard_part_id
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
        ) lp ON lp.supplier_part_id = sp.id
       WHERE std.class_id = ?
       ORDER BY std.display_name ASC, ps.name ASC, sp.supplier_part_number ASC
       LIMIT 200
      `,
      [id]
    )

    res.json({
      node,
      fields,
      parts,
      oem_representations: oemRepresentations,
      supplier_representations: supplierRepresentations,
      stats: {
        fields_count: fields.length,
        parts_count: parts.length,
        oem_representations_count: oemRepresentations.length,
        supplier_representations_count: supplierRepresentations.length,
      },
    })
  } catch (err) {
    console.error('GET /standard-part-classes/:id/workspace error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const parent_id = req.body.parent_id === undefined ? null : toId(req.body.parent_id)
    const name = nz(req.body.name)
    const code = nz(req.body.code)
    const description = nz(req.body.description)
    const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : 0
    const is_active = req.body.is_active === undefined ? 1 : (toBool(req.body.is_active) ? 1 : 0)

    if (!name) return res.status(400).json({ message: 'name обязателен' })
    if (!code) return res.status(400).json({ message: 'code обязателен' })

    if (req.body.parent_id !== undefined && req.body.parent_id !== null && !parent_id) {
      return res.status(400).json({ message: 'Некорректный parent_id' })
    }

    if (parent_id) {
      const [[parent]] = await db.execute('SELECT id FROM standard_part_classes WHERE id = ?', [parent_id])
      if (!parent) return res.status(400).json({ message: 'Родительский класс не найден' })
    }

    const [ins] = await db.execute(
      `
      INSERT INTO standard_part_classes
        (parent_id, code, name, description, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [parent_id, code, name, description, sort_order, is_active]
    )

    const [[created]] = await db.execute('SELECT * FROM standard_part_classes WHERE id = ?', [ins.insertId])
    await logActivity({
      req,
      action: 'create',
      entity_type: 'standard_part_classes',
      entity_id: ins.insertId,
      comment: 'Создан класс standard parts',
    })

    res.status(201).json(created)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Класс с таким code уже существует' })
    }
    console.error('POST /standard-part-classes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM standard_part_classes WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Класс standard parts не найден' })

    const parent_id =
      req.body.parent_id !== undefined
        ? (req.body.parent_id === null || req.body.parent_id === '' ? null : toId(req.body.parent_id))
        : undefined
    if (req.body.parent_id !== undefined && req.body.parent_id !== null && req.body.parent_id !== '' && !parent_id) {
      return res.status(400).json({ message: 'Некорректный parent_id' })
    }
    if (parent_id && parent_id === id) {
      return res.status(400).json({ message: 'Нельзя указать класс родителем самого себя' })
    }
    if (parent_id) {
      const [[parent]] = await db.execute('SELECT id FROM standard_part_classes WHERE id = ?', [parent_id])
      if (!parent) return res.status(400).json({ message: 'Родительский класс не найден' })
    }

    const payload = {
      parent_id,
      code: req.body.code !== undefined ? nz(req.body.code) : undefined,
      name: req.body.name !== undefined ? nz(req.body.name) : undefined,
      description: req.body.description !== undefined ? nz(req.body.description) : undefined,
      sort_order:
        req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))
          ? Math.trunc(Number(req.body.sort_order))
          : undefined,
      is_active: req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : undefined,
    }

    if (payload.code !== undefined && !payload.code) return res.status(400).json({ message: 'code не может быть пустым' })
    if (payload.name !== undefined && !payload.name) return res.status(400).json({ message: 'name не может быть пустым' })

    await db.execute(
      `
      UPDATE standard_part_classes
         SET parent_id = COALESCE(?, parent_id),
             code = COALESCE(?, code),
             name = COALESCE(?, name),
             description = COALESCE(?, description),
             sort_order = COALESCE(?, sort_order),
             is_active = COALESCE(?, is_active)
       WHERE id = ?
      `,
      [
        sqlValue(payload.parent_id),
        sqlValue(payload.code),
        sqlValue(payload.name),
        sqlValue(payload.description),
        sqlValue(payload.sort_order),
        sqlValue(payload.is_active),
        id,
      ]
    )

    const [[after]] = await db.execute('SELECT * FROM standard_part_classes WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'standard_part_classes',
      entity_id: id,
      oldData: before,
      newData: after,
    })

    res.json(after)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Класс с таким code уже существует' })
    }
    console.error('PUT /standard-part-classes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM standard_part_classes WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Класс standard parts не найден' })

    await db.execute('DELETE FROM standard_part_classes WHERE id = ?', [id])
    await logActivity({
      req,
      action: 'delete',
      entity_type: 'standard_part_classes',
      entity_id: id,
      comment: `Удален класс standard parts ${before.name || before.code || id}`,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /standard-part-classes/:id error:', err)
    if (err?.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'Нельзя удалить класс, пока у него есть зависимые записи' })
    }
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/fields', async (req, res) => {
  try {
    const classId = toId(req.params.id)
    if (!classId) return res.status(400).json({ message: 'Некорректный идентификатор класса' })

    const [[cls]] = await db.execute('SELECT id FROM standard_part_classes WHERE id = ?', [classId])
    if (!cls) return res.status(404).json({ message: 'Класс standard parts не найден' })

    const code = nz(req.body.code)
    const label = nz(req.body.label)
    const field_type = normalizeFieldType(req.body.field_type)
    const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : 0
    if (!code) return res.status(400).json({ message: 'code обязателен' })
    if (!label) return res.status(400).json({ message: 'label обязателен' })
    if (!field_type) return res.status(400).json({ message: 'Некорректный field_type' })

    const [ins] = await db.execute(
      `
      INSERT INTO standard_part_class_fields
        (
          class_id, code, label, field_type, sort_order, is_required, is_active,
          is_in_title, is_in_list, is_in_filters, is_searchable, unit, placeholder,
          help_text, default_value, settings_json
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        classId,
        code,
        label,
        field_type,
        sort_order,
        toBool(req.body.is_required) ? 1 : 0,
        req.body.is_active === undefined ? 1 : (toBool(req.body.is_active) ? 1 : 0),
        toBool(req.body.is_in_title) ? 1 : 0,
        toBool(req.body.is_in_list) ? 1 : 0,
        toBool(req.body.is_in_filters) ? 1 : 0,
        toBool(req.body.is_searchable) ? 1 : 0,
        nz(req.body.unit),
        nz(req.body.placeholder),
        nz(req.body.help_text),
        nz(req.body.default_value),
        req.body.settings_json ? JSON.stringify(req.body.settings_json) : null,
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM standard_part_class_fields WHERE id = ?', [ins.insertId])
    res.status(201).json(created)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Поле с таким code уже существует в классе' })
    }
    console.error('POST /standard-part-classes/:id/fields error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/fields/:fieldId', async (req, res) => {
  try {
    const fieldId = toId(req.params.fieldId)
    if (!fieldId) return res.status(400).json({ message: 'Некорректный идентификатор поля' })

    const [[before]] = await db.execute('SELECT * FROM standard_part_class_fields WHERE id = ?', [fieldId])
    if (!before) return res.status(404).json({ message: 'Поле класса не найдено' })

    const field_type = req.body.field_type !== undefined ? normalizeFieldType(req.body.field_type) : undefined
    if (req.body.field_type !== undefined && !field_type) {
      return res.status(400).json({ message: 'Некорректный field_type' })
    }

    const payload = {
      code: req.body.code !== undefined ? nz(req.body.code) : undefined,
      label: req.body.label !== undefined ? nz(req.body.label) : undefined,
      field_type,
      sort_order:
        req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))
          ? Math.trunc(Number(req.body.sort_order))
          : undefined,
      is_required: req.body.is_required !== undefined ? (toBool(req.body.is_required) ? 1 : 0) : undefined,
      is_active: req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : undefined,
      is_in_title: req.body.is_in_title !== undefined ? (toBool(req.body.is_in_title) ? 1 : 0) : undefined,
      is_in_list: req.body.is_in_list !== undefined ? (toBool(req.body.is_in_list) ? 1 : 0) : undefined,
      is_in_filters: req.body.is_in_filters !== undefined ? (toBool(req.body.is_in_filters) ? 1 : 0) : undefined,
      is_searchable: req.body.is_searchable !== undefined ? (toBool(req.body.is_searchable) ? 1 : 0) : undefined,
      unit: req.body.unit !== undefined ? nz(req.body.unit) : undefined,
      placeholder: req.body.placeholder !== undefined ? nz(req.body.placeholder) : undefined,
      help_text: req.body.help_text !== undefined ? nz(req.body.help_text) : undefined,
      default_value: req.body.default_value !== undefined ? nz(req.body.default_value) : undefined,
      settings_json: req.body.settings_json !== undefined ? JSON.stringify(req.body.settings_json || null) : undefined,
    }

    if (payload.code !== undefined && !payload.code) return res.status(400).json({ message: 'code не может быть пустым' })
    if (payload.label !== undefined && !payload.label) return res.status(400).json({ message: 'label не может быть пустым' })

    await db.execute(
      `
      UPDATE standard_part_class_fields
         SET code = COALESCE(?, code),
             label = COALESCE(?, label),
             field_type = COALESCE(?, field_type),
             sort_order = COALESCE(?, sort_order),
             is_required = COALESCE(?, is_required),
             is_active = COALESCE(?, is_active),
             is_in_title = COALESCE(?, is_in_title),
             is_in_list = COALESCE(?, is_in_list),
             is_in_filters = COALESCE(?, is_in_filters),
             is_searchable = COALESCE(?, is_searchable),
             unit = COALESCE(?, unit),
             placeholder = COALESCE(?, placeholder),
             help_text = COALESCE(?, help_text),
             default_value = COALESCE(?, default_value),
             settings_json = COALESCE(?, settings_json)
       WHERE id = ?
      `,
      [
        sqlValue(payload.code),
        sqlValue(payload.label),
        sqlValue(payload.field_type),
        sqlValue(payload.sort_order),
        sqlValue(payload.is_required),
        sqlValue(payload.is_active),
        sqlValue(payload.is_in_title),
        sqlValue(payload.is_in_list),
        sqlValue(payload.is_in_filters),
        sqlValue(payload.is_searchable),
        sqlValue(payload.unit),
        sqlValue(payload.placeholder),
        sqlValue(payload.help_text),
        sqlValue(payload.default_value),
        sqlValue(payload.settings_json),
        fieldId,
      ]
    )

    const [[after]] = await db.execute('SELECT * FROM standard_part_class_fields WHERE id = ?', [fieldId])
    await logFieldDiffs({
      req,
      entity_type: 'standard_part_class_fields',
      entity_id: fieldId,
      oldData: before,
      newData: after,
    })

    res.json(after)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Поле с таким code уже существует в классе' })
    }
    console.error('PUT /standard-part-classes/fields/:fieldId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/fields/:fieldId', async (req, res) => {
  try {
    const fieldId = toId(req.params.fieldId)
    if (!fieldId) return res.status(400).json({ message: 'Некорректный идентификатор поля' })
    await db.execute('DELETE FROM standard_part_class_fields WHERE id = ?', [fieldId])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /standard-part-classes/fields/:fieldId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/fields/:fieldId/options', async (req, res) => {
  try {
    const fieldId = toId(req.params.fieldId)
    if (!fieldId) return res.status(400).json({ message: 'Некорректный идентификатор поля' })
    const [rows] = await db.execute(
      `
      SELECT *
        FROM standard_part_field_options
       WHERE field_id = ?
       ORDER BY sort_order ASC, id ASC
      `,
      [fieldId]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /standard-part-classes/fields/:fieldId/options error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/fields/:fieldId/options', async (req, res) => {
  try {
    const fieldId = toId(req.params.fieldId)
    if (!fieldId) return res.status(400).json({ message: 'Некорректный идентификатор поля' })

    const value_code = nz(req.body.value_code)
    const value_label = nz(req.body.value_label)
    const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : 0
    const is_active = req.body.is_active === undefined ? 1 : (toBool(req.body.is_active) ? 1 : 0)

    if (!value_code) return res.status(400).json({ message: 'value_code обязателен' })
    if (!value_label) return res.status(400).json({ message: 'value_label обязателен' })

    const [ins] = await db.execute(
      `
      INSERT INTO standard_part_field_options (field_id, value_code, value_label, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?)
      `,
      [fieldId, value_code, value_label, sort_order, is_active]
    )

    const [[created]] = await db.execute('SELECT * FROM standard_part_field_options WHERE id = ?', [ins.insertId])
    res.status(201).json(created)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Опция с таким value_code уже существует' })
    }
    console.error('POST /standard-part-classes/fields/:fieldId/options error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/field-options/:optionId', async (req, res) => {
  try {
    const optionId = toId(req.params.optionId)
    if (!optionId) return res.status(400).json({ message: 'Некорректный идентификатор опции' })

    const payload = {
      value_code: req.body.value_code !== undefined ? nz(req.body.value_code) : undefined,
      value_label: req.body.value_label !== undefined ? nz(req.body.value_label) : undefined,
      sort_order:
        req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))
          ? Math.trunc(Number(req.body.sort_order))
          : undefined,
      is_active: req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : undefined,
    }

    await db.execute(
      `
      UPDATE standard_part_field_options
         SET value_code = COALESCE(?, value_code),
             value_label = COALESCE(?, value_label),
             sort_order = COALESCE(?, sort_order),
             is_active = COALESCE(?, is_active)
       WHERE id = ?
      `,
      [
        sqlValue(payload.value_code),
        sqlValue(payload.value_label),
        sqlValue(payload.sort_order),
        sqlValue(payload.is_active),
        optionId,
      ]
    )

    const [[after]] = await db.execute('SELECT * FROM standard_part_field_options WHERE id = ?', [optionId])
    if (!after) return res.status(404).json({ message: 'Опция не найдена' })
    res.json(after)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Опция с таким value_code уже существует' })
    }
    console.error('PUT /standard-part-classes/field-options/:optionId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/field-options/:optionId', async (req, res) => {
  try {
    const optionId = toId(req.params.optionId)
    if (!optionId) return res.status(400).json({ message: 'Некорректный идентификатор опции' })
    await db.execute('DELETE FROM standard_part_field_options WHERE id = ?', [optionId])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /standard-part-classes/field-options/:optionId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
