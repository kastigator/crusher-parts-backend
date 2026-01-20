const express = require('express')
const router = express.Router()
const db = require('../utils/db')

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
const boolToTinyint = (v) => {
  if (v === undefined || v === null || v === '') return 0
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'да'].includes(s)) return 1
  if (['0', 'false', 'no', 'нет'].includes(s)) return 0
  return 0
}
const dateOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}
const getField = (row, keys) => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
  }
  return undefined
}

const resolveImportRows = async (conn, rows, context) => {
  const manufacturerCache = new Map()
  const modelCache = new Map()
  const partCache = new Map()

  const defaultManufacturerId = toId(context?.manufacturer_id)
  const defaultModelId = toId(context?.equipment_model_id)

  const resolveManufacturer = async (name) => {
    if (!name) return null
    const key = String(name).trim().toLowerCase()
    if (manufacturerCache.has(key)) return manufacturerCache.get(key)
    const [rows] = await conn.execute(
      'SELECT * FROM equipment_manufacturers WHERE name = ? LIMIT 1',
      [String(name).trim()]
    )
    const found = rows[0] || null
    manufacturerCache.set(key, found)
    return found
  }

  const resolveModel = async (manufacturerId, modelName) => {
    if (!manufacturerId || !modelName) return null
    const key = `${manufacturerId}:${String(modelName).trim().toLowerCase()}`
    if (modelCache.has(key)) return modelCache.get(key)
    const [rows] = await conn.execute(
      'SELECT * FROM equipment_models WHERE manufacturer_id = ? AND model_name = ? LIMIT 1',
      [manufacturerId, String(modelName).trim()]
    )
    const found = rows[0] || null
    modelCache.set(key, found)
    return found
  }

  const resolvePart = async (modelId, catNumber) => {
    if (!modelId || !catNumber) return null
    const key = `${modelId}:${String(catNumber).trim().toLowerCase()}`
    if (partCache.has(key)) return partCache.get(key)
    const [rows] = await conn.execute(
      'SELECT * FROM original_parts WHERE equipment_model_id = ? AND cat_number = ? LIMIT 1',
      [modelId, String(catNumber).trim()]
    )
    const found = rows[0] || null
    partCache.set(key, found)
    return found
  }

  const resolved = []
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i] || {}
    const rowNumber = i + 2

    const manufacturerName = nz(
      getField(raw, ['manufacturer', 'manufacturer_name', 'Производитель'])
    )
    const modelName = nz(getField(raw, ['model', 'model_name', 'Модель']))
    const catNumber = nz(getField(raw, ['cat_number', 'Кат. номер*', 'Кат. номер']))
    const clientPartNumber = nz(getField(raw, ['client_part_number', '№ клиента']))
    const clientDescription = nz(
      getField(raw, ['client_description', 'Описание клиента'])
    )
    const requestedQty = numOrNull(
      getField(raw, ['requested_qty', 'Кол-во*', 'Кол-во'])
    )
    const uom = nz(getField(raw, ['uom', 'Ед.'])) || 'pcs'
    const requiredDate = dateOrNull(
      getField(raw, ['required_date', 'Срок (YYYY-MM-DD)', 'Срок'])
    )
    const priority = nz(getField(raw, ['priority', 'Приоритет']))
    const oemOnly = boolToTinyint(getField(raw, ['oem_only', 'OEM только']))
    const clientComment = nz(getField(raw, ['client_comment', 'Комментарий клиента']))
    const internalComment = nz(
      getField(raw, ['internal_comment', 'Комментарий внутр.'])
    )

    const issues = []
    const errorIssues = []
    const warningIssues = []
    if (!catNumber) errorIssues.push('Не заполнен каталожный номер')
    if (requestedQty === null) errorIssues.push('Не заполнено количество')

    let manufacturer = null
    let model = null
    let part = null

    if (manufacturerName) {
      manufacturer = await resolveManufacturer(manufacturerName)
      if (!manufacturer) warningIssues.push('Производитель не найден')
    } else if (defaultManufacturerId) {
      manufacturer = { id: defaultManufacturerId }
    }

    if (modelName) {
      if (manufacturer?.id) {
        model = await resolveModel(manufacturer.id, modelName)
        if (!model) warningIssues.push('Модель не найдена')
      } else {
        warningIssues.push('Не задан производитель для модели')
      }
    } else if (defaultModelId) {
      model = { id: defaultModelId }
    }

    if (catNumber && model?.id) {
      part = await resolvePart(model.id, catNumber)
      if (!part) warningIssues.push('Деталь не найдена')
    } else if (catNumber && !model?.id) {
      warningIssues.push('Не задана модель для детали')
    }

    issues.push(...errorIssues, ...warningIssues)
    const status = errorIssues.length ? 'error' : warningIssues.length ? 'warning' : 'ok'

    resolved.push({
      row_number: rowNumber,
      manufacturer_name: manufacturerName,
      model_name: modelName,
      cat_number: catNumber,
      client_part_number: clientPartNumber,
      client_description: clientDescription,
      requested_qty: requestedQty,
      uom,
      required_date: requiredDate,
      priority,
      oem_only: oemOnly,
      client_comment: clientComment,
      internal_comment: internalComment,
      manufacturer_id: manufacturer?.id || null,
      equipment_model_id: model?.id || null,
      original_part_id: part?.id || null,
      status,
      issues,
    })
  }

  const summary = resolved.reduce(
    (acc, row) => {
      acc.total += 1
      if (row.status === 'ok') acc.ok += 1
      if (row.status === 'warning') acc.warning += 1
      if (row.status === 'error') acc.error += 1
      return acc
    },
    { total: 0, ok: 0, warning: 0, error: 0 }
  )

  return { rows: resolved, summary }
}

router.get('/', async (req, res) => {
  try {
    const clientId = toId(req.query.client_id)
    const where = []
    const params = []
    if (clientId) {
      where.push('cr.client_id = ?')
      params.push(clientId)
    }

    const [rows] = await db.execute(
      `
      SELECT cr.*, c.company_name AS client_name
      FROM client_requests cr
      JOIN clients c ON c.id = cr.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY cr.id DESC
      `,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /client-requests error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const [[row]] = await db.execute('SELECT * FROM client_requests WHERE id = ?', [id])
    if (!row) return res.status(404).json({ message: 'Не найдено' })

    res.json(row)
  } catch (e) {
    console.error('GET /client-requests/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const client_id = toId(req.body.client_id)
    if (!client_id) return res.status(400).json({ message: 'client_id обязателен' })

    const status = nz(req.body.status) || 'draft'
    const source_type = nz(req.body.source_type)
    const created_at = nz(req.body.created_at)
    const created_by_user_id = toId(req.user?.id)
    const assigned_to_user_id = toId(req.body.assigned_to_user_id)
    const internal_number = nz(req.body.internal_number ?? req.body.internalNumber)
    const client_reference = nz(req.body.client_reference)
    const contact_name = nz(req.body.contact_name)
    const contact_email = nz(req.body.contact_email)
    const contact_phone = nz(req.body.contact_phone)
    const comment_internal = nz(req.body.comment_internal)
    const comment_client = nz(req.body.comment_client)

    const columns = [
      'client_id',
      'status',
      'source_type',
      'created_by_user_id',
      'assigned_to_user_id',
      'internal_number',
      'client_reference',
      'contact_name',
      'contact_email',
      'contact_phone',
      'comment_internal',
      'comment_client',
    ]
    const values = [
      client_id,
      status,
      source_type,
      created_by_user_id,
      assigned_to_user_id,
      internal_number,
      client_reference,
      contact_name,
      contact_email,
      contact_phone,
      comment_internal,
      comment_client,
    ]
    if (created_at) {
      columns.push('created_at')
      values.push(created_at)
    }

    const [result] = await db.execute(
      `
      INSERT INTO client_requests (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
      `,
      values
    )

    const [[created]] = await db.execute('SELECT * FROM client_requests WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /client-requests error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const fields = {
      status: nz(req.body.status),
      source_type: nz(req.body.source_type),
      assigned_to_user_id: toId(req.body.assigned_to_user_id),
      internal_number: nz(req.body.internal_number ?? req.body.internalNumber),
      client_reference: nz(req.body.client_reference),
      contact_name: nz(req.body.contact_name),
      contact_email: nz(req.body.contact_email),
      contact_phone: nz(req.body.contact_phone),
      comment_internal: nz(req.body.comment_internal),
      comment_client: nz(req.body.comment_client),
      created_at: nz(req.body.created_at),
    }

    const updates = []
    const params = []
    Object.entries(fields).forEach(([k, v]) => {
      if (v !== null) {
        updates.push(`${k} = ?`)
        params.push(v)
      }
    })

    if (!updates.length) return res.status(400).json({ message: 'Нет данных для обновления' })

    params.push(id)
    await db.execute(`UPDATE client_requests SET ${updates.join(', ')} WHERE id = ?`, params)

    const [[updated]] = await db.execute('SELECT * FROM client_requests WHERE id = ?', [id])
    res.json(updated)
  } catch (e) {
    console.error('PUT /client-requests/:id error:', e)
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
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE l FROM sales_quote_lines l
       JOIN sales_quote_revisions r ON r.id = l.sales_quote_revision_id
       JOIN sales_quotes sq ON sq.id = r.sales_quote_id
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE r FROM sales_quote_revisions r
       JOIN sales_quotes sq ON sq.id = r.sales_quote_id
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sq FROM sales_quotes sq
       JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE pol FROM supplier_purchase_order_lines pol
       JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
       JOIN selections s ON s.id = po.selection_id
       JOIN rfqs r ON r.id = s.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE po FROM supplier_purchase_orders po
       JOIN selections s ON s.id = po.selection_id
       JOIN rfqs r ON r.id = s.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sl FROM selection_lines sl
       JOIN selections s ON s.id = sl.selection_id
       JOIN rfqs r ON r.id = s.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE s FROM selections s
       JOIN rfqs r ON r.id = s.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sgi FROM shipment_group_items sgi
       JOIN shipment_groups sg ON sg.id = sgi.shipment_group_id
       JOIN rfqs r ON r.id = sg.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE es FROM economic_scenarios es
       JOIN shipment_groups sg ON sg.id = es.shipment_group_id
       JOIN rfqs r ON r.id = sg.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sg FROM shipment_groups sg
       JOIN rfqs r ON r.id = sg.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE lcs FROM landed_cost_snapshots lcs
       JOIN rfqs r ON r.id = lcs.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE lsi FROM rfq_line_scorecard_items lsi
       JOIN rfq_line_scorecards lsc ON lsc.id = lsi.rfq_line_scorecard_id
       JOIN rfq_response_lines rl ON rl.id = lsc.rfq_response_line_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       JOIN rfqs r ON r.id = rs.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE lsc FROM rfq_line_scorecards lsc
       JOIN rfq_response_lines rl ON rl.id = lsc.rfq_response_line_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       JOIN rfqs r ON r.id = rs.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE ssi FROM rfq_supplier_scorecard_items ssi
       JOIN rfq_supplier_scorecards ssc ON ssc.id = ssi.rfq_supplier_scorecard_id
       JOIN rfqs r ON r.id = ssc.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE ssc FROM rfq_supplier_scorecards ssc
       JOIN rfqs r ON r.id = ssc.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rl FROM rfq_response_lines rl
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       JOIN rfqs r ON r.id = rs.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rr FROM rfq_response_revisions rr
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       JOIN rfqs r ON r.id = rs.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rsr FROM rfq_supplier_responses rsr
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       JOIN rfqs r ON r.id = rs.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rs FROM rfq_suppliers rs
       JOIN rfqs r ON r.id = rs.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    try {
      await conn.execute(
        `DELETE ric FROM rfq_item_components ric
         JOIN rfq_items ri ON ri.id = ric.rfq_item_id
         JOIN rfqs r ON r.id = ri.rfq_id
         JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
         WHERE cr.client_request_id = ?`,
        [id]
      )
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e
    }
    await conn.execute(
      `DELETE ris FROM rfq_item_strategies ris
       JOIN rfq_items ri ON ri.id = ris.rfq_item_id
       JOIN rfqs r ON r.id = ri.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE ri FROM rfq_items ri
       JOIN rfqs r ON r.id = ri.rfq_id
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE r FROM rfqs r
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE cri FROM client_request_revision_items cri
       JOIN client_request_revisions cr ON cr.id = cri.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM client_request_revisions WHERE client_request_id = ?', [id])
    await conn.execute('DELETE FROM client_requests WHERE id = ?', [id])

    await conn.commit()
    res.json({ success: true })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /client-requests/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.get('/:id/revisions', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT * FROM client_request_revisions WHERE client_request_id = ? ORDER BY rev_number DESC`,
      [id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /client-requests/:id/revisions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/revisions', async (req, res) => {
  try {
    const client_request_id = toId(req.params.id)
    if (!client_request_id) return res.status(400).json({ message: 'Некорректный ID' })

    const created_by_user_id = toId(req.user?.id)
    const note = nz(req.body.note)

    const [[{ next_rev }]] = await db.execute(
      `SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev FROM client_request_revisions WHERE client_request_id = ?`,
      [client_request_id]
    )

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      const [result] = await conn.execute(
        `INSERT INTO client_request_revisions (client_request_id, rev_number, created_by_user_id, note)
         VALUES (?,?,?,?)`,
        [client_request_id, next_rev, created_by_user_id, note]
      )

      if (next_rev > 1) {
        const [[prev]] = await conn.execute(
          `SELECT id FROM client_request_revisions
           WHERE client_request_id = ? AND rev_number = ?`,
          [client_request_id, next_rev - 1]
        )
        if (prev?.id) {
          await conn.execute(
            `
            INSERT INTO client_request_revision_items
              (client_request_revision_id, line_number, original_part_id, equipment_model_id,
               client_part_number, client_description, client_line_text, requested_qty, uom,
               required_date, priority, oem_only, client_comment, internal_comment)
            SELECT
              ?, line_number, original_part_id, equipment_model_id,
              client_part_number, client_description, client_line_text, requested_qty, uom,
              required_date, priority, oem_only, client_comment, internal_comment
            FROM client_request_revision_items
            WHERE client_request_revision_id = ?
            ORDER BY line_number
            `,
            [result.insertId, prev.id]
          )
        }
      }

      await conn.commit()
      const [[created]] = await conn.execute(
        'SELECT * FROM client_request_revisions WHERE id = ?',
        [result.insertId]
      )
      return res.status(201).json(created)
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('POST /client-requests/:id/revisions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/revisions/:revisionId/items', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT ri.*,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM client_request_revision_items ri
         LEFT JOIN original_parts op ON op.id = ri.original_part_id
        WHERE ri.client_request_revision_id = ?
        ORDER BY ri.line_number ASC`,
      [revisionId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /client-requests/revisions/:revisionId/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/revisions/:revisionId/items', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const [[{ next_line }]] = await db.execute(
      `SELECT COALESCE(MAX(line_number), 0) + 1 AS next_line
       FROM client_request_revision_items
       WHERE client_request_revision_id = ?`,
      [revisionId]
    )

    const [result] = await db.execute(
      `
      INSERT INTO client_request_revision_items
        (client_request_revision_id, line_number, original_part_id, equipment_model_id,
         client_part_number, client_description, client_line_text, requested_qty, uom,
         required_date, priority, oem_only, client_comment, internal_comment)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
      [
        revisionId,
        next_line,
        toId(req.body.original_part_id),
        toId(req.body.equipment_model_id),
        nz(req.body.client_part_number),
        nz(req.body.client_description),
        nz(req.body.client_line_text),
        numOrNull(req.body.requested_qty),
        nz(req.body.uom) || 'pcs',
        nz(req.body.required_date),
        nz(req.body.priority),
        req.body.oem_only ? 1 : 0,
        nz(req.body.client_comment),
        nz(req.body.internal_comment),
      ]
    )

    const [[created]] = await db.execute(
      'SELECT * FROM client_request_revision_items WHERE id = ?',
      [result.insertId]
    )
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /client-requests/revisions/:revisionId/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// =========================================================
// BULK IMPORT PREVIEW (Excel)
// POST /client-requests/:id/items/import/preview
// body: { rows: [...], context: { manufacturer_id?, equipment_model_id? } }
// =========================================================
router.post('/:id/items/import/preview', async (req, res) => {
  const requestId = toId(req.params.id)
  if (!requestId) return res.status(400).json({ message: 'Некорректный ID' })

  const rows = Array.isArray(req.body?.rows)
    ? req.body.rows
    : Array.isArray(req.body)
    ? req.body
    : []
  if (!rows.length) {
    return res.status(400).json({ message: 'Нет данных для проверки' })
  }

  const conn = await db.getConnection()
  try {
    const { rows: resolved, summary } = await resolveImportRows(
      conn,
      rows,
      req.body?.context || {}
    )
    res.json({ rows: resolved, summary })
  } catch (e) {
    console.error('POST /client-requests/:id/items/import/preview error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

// =========================================================
// BULK IMPORT COMMIT
// POST /client-requests/:id/items/import/commit
// body: { rows: [...], revision_id, create_missing, context: { ... } }
// =========================================================
router.post('/:id/items/import/commit', async (req, res) => {
  const requestId = toId(req.params.id)
  if (!requestId) return res.status(400).json({ message: 'Некорректный ID' })

  const rows = Array.isArray(req.body?.rows)
    ? req.body.rows
    : Array.isArray(req.body)
    ? req.body
    : []
  if (!rows.length) {
    return res.status(400).json({ message: 'Нет данных для импорта' })
  }

  const revisionId = toId(req.body?.revision_id)
  if (!revisionId) {
    return res.status(400).json({ message: 'Не передана ревизия' })
  }

  const createMissing = !!req.body?.create_missing

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const { rows: resolved, summary } = await resolveImportRows(
      conn,
      rows,
      req.body?.context || {}
    )

    const errors = resolved.filter((r) => r.status === 'error')
    if (errors.length) {
      await conn.rollback()
      return res.status(400).json({
        message: 'Есть ошибки в данных',
        rows: resolved,
        summary,
      })
    }

    const warnings = resolved.filter((r) => r.status === 'warning')
    if (warnings.length && !createMissing) {
      await conn.rollback()
      return res.status(409).json({
        message: 'Есть строки с отсутствующими справочниками',
        rows: resolved,
        summary,
      })
    }

    const manufacturerCache = new Map()
    const modelCache = new Map()
    const partCache = new Map()

    const ensureManufacturer = async (name) => {
      const key = String(name).trim().toLowerCase()
      if (manufacturerCache.has(key)) {
        return { id: manufacturerCache.get(key), created: false }
      }
      const [rows] = await conn.execute(
        'SELECT id FROM equipment_manufacturers WHERE name = ? LIMIT 1',
        [String(name).trim()]
      )
      if (rows.length) {
        manufacturerCache.set(key, rows[0].id)
        return { id: rows[0].id, created: false }
      }
      const [ins] = await conn.execute(
        'INSERT INTO equipment_manufacturers (name) VALUES (?)',
        [String(name).trim()]
      )
      manufacturerCache.set(key, ins.insertId)
      return { id: ins.insertId, created: true }
    }

    const ensureModel = async (manufacturerId, modelName) => {
      const key = `${manufacturerId}:${String(modelName).trim().toLowerCase()}`
      if (modelCache.has(key)) {
        return { id: modelCache.get(key), created: false }
      }
      const [rows] = await conn.execute(
        'SELECT id FROM equipment_models WHERE manufacturer_id = ? AND model_name = ? LIMIT 1',
        [manufacturerId, String(modelName).trim()]
      )
      if (rows.length) {
        modelCache.set(key, rows[0].id)
        return { id: rows[0].id, created: false }
      }
      const [ins] = await conn.execute(
        'INSERT INTO equipment_models (manufacturer_id, model_name) VALUES (?, ?)',
        [manufacturerId, String(modelName).trim()]
      )
      modelCache.set(key, ins.insertId)
      return { id: ins.insertId, created: true }
    }

    const ensurePart = async (modelId, catNumber, description, uom) => {
      const key = `${modelId}:${String(catNumber).trim().toLowerCase()}`
      if (partCache.has(key)) {
        return { id: partCache.get(key), created: false }
      }
      const [rows] = await conn.execute(
        'SELECT id FROM original_parts WHERE equipment_model_id = ? AND cat_number = ? LIMIT 1',
        [modelId, String(catNumber).trim()]
      )
      if (rows.length) {
        partCache.set(key, rows[0].id)
        return { id: rows[0].id, created: false }
      }
      const [ins] = await conn.execute(
        `INSERT INTO original_parts
           (equipment_model_id, cat_number, description_ru, uom)
         VALUES (?,?,?,?)`,
        [modelId, String(catNumber).trim(), description || null, uom || 'pcs']
      )
      partCache.set(key, ins.insertId)
      return { id: ins.insertId, created: true }
    }

    const [[{ next_line }]] = await conn.execute(
      'SELECT COALESCE(MAX(line_number), 0) + 1 AS next_line FROM client_request_revision_items WHERE client_request_revision_id = ?',
      [revisionId]
    )
    let lineNumber = next_line || 1

    let createdManufacturers = 0
    let createdModels = 0
    let createdParts = 0

    for (const row of resolved) {
      let manufacturerId = row.manufacturer_id
      let modelId = row.equipment_model_id
      let partId = row.original_part_id

      if (row.status === 'warning' && createMissing) {
        if (!manufacturerId && row.manufacturer_name) {
          const created = await ensureManufacturer(row.manufacturer_name)
          manufacturerId = created.id
          if (created.created) createdManufacturers += 1
        }

        if (!modelId && manufacturerId && row.model_name) {
          const created = await ensureModel(manufacturerId, row.model_name)
          modelId = created.id
          if (created.created) createdModels += 1
        }

        if (!partId && modelId && row.cat_number) {
          const created = await ensurePart(
            modelId,
            row.cat_number,
            row.client_description,
            row.uom
          )
          partId = created.id
          if (created.created) createdParts += 1
        }
      }

      await conn.execute(
        `
        INSERT INTO client_request_revision_items
          (client_request_revision_id, line_number, original_part_id, equipment_model_id,
           client_part_number, client_description, client_line_text, requested_qty, uom,
           required_date, priority, oem_only, client_comment, internal_comment)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `,
        [
          revisionId,
          lineNumber,
          partId || null,
          modelId || null,
          row.client_part_number || null,
          row.client_description || null,
          null,
          row.requested_qty,
          row.uom || 'pcs',
          row.required_date || null,
          row.priority || null,
          row.oem_only ? 1 : 0,
          row.client_comment || null,
          row.internal_comment || null,
        ]
      )
      lineNumber += 1
    }

    await conn.commit()
    res.json({
      inserted: resolved.length,
      created: {
        manufacturers: createdManufacturers,
        models: createdModels,
        parts: createdParts,
      },
    })
  } catch (e) {
    await conn.rollback()
    console.error('POST /client-requests/:id/items/import/commit error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.put('/revisions/:revisionId/items/:itemId', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    const itemId = toId(req.params.itemId)
    if (!revisionId || !itemId) {
      return res.status(400).json({ message: 'Некорректный ID' })
    }

    const fields = {
      original_part_id: toId(req.body.original_part_id),
      equipment_model_id: toId(req.body.equipment_model_id),
      client_part_number: nz(req.body.client_part_number),
      client_description: nz(req.body.client_description),
      client_line_text: nz(req.body.client_line_text),
      requested_qty: numOrNull(req.body.requested_qty),
      uom: nz(req.body.uom),
      required_date: nz(req.body.required_date),
      priority: nz(req.body.priority),
      oem_only: req.body.oem_only ? 1 : 0,
      client_comment: nz(req.body.client_comment),
      internal_comment: nz(req.body.internal_comment),
    }

    const updates = []
    const params = []
    Object.entries(fields).forEach(([key, val]) => {
      if (val !== null) {
        updates.push(`${key} = ?`)
        params.push(val)
      }
    })
    if (!updates.length) {
      return res.status(400).json({ message: 'Нет данных для обновления' })
    }

    params.push(itemId, revisionId)
    const [result] = await db.execute(
      `UPDATE client_request_revision_items
       SET ${updates.join(', ')}
       WHERE id = ? AND client_request_revision_id = ?`,
      params
    )
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [[updated]] = await db.execute(
      'SELECT * FROM client_request_revision_items WHERE id = ?',
      [itemId]
    )
    res.json(updated)
  } catch (e) {
    console.error('PUT /client-requests/revisions/:revisionId/items/:itemId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/revisions/:revisionId/items/:itemId', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    const itemId = toId(req.params.itemId)
    if (!revisionId || !itemId) {
      return res.status(400).json({ message: 'Некорректный ID' })
    }

    const [result] = await db.execute(
      `DELETE FROM client_request_revision_items
       WHERE id = ? AND client_request_revision_id = ?`,
      [itemId, revisionId]
    )
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /client-requests/revisions/:revisionId/items/:itemId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
