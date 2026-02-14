const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  fetchRevisionItems,
  ensureStrategiesAndComponents,
  rebuildComponentsForItem,
  buildRevisionStructure,
} = require('../utils/clientRequestStructure')
const { updateRequestStatus } = require('../utils/clientRequestStatus')
const { createNotification } = require('../utils/notifications')

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
const markRfqNeedsSync = async (conn, requestId) => {
  const id = toId(requestId)
  if (!id) return
  await conn.execute(
    `UPDATE rfqs
        SET rfq_sync_status = 'needs_sync'
      WHERE client_request_id = ?`,
    [id]
  )
}
const boolToTinyint = (v) => {
  if (v === undefined || v === null || v === '') return 0
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'да'].includes(s)) return 1
  if (['0', 'false', 'no', 'нет'].includes(s)) return 0
  return 0
}
const { normalizeUom } = require('../utils/uom')
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

const roleOf = (user) => String(user?.role || '').toLowerCase()
const isAdmin = (user) => roleOf(user) === 'admin'
const isProcurementHead = (user) => roleOf(user) === 'nachalnik-otdela-zakupok'
const canReleaseRequest = (user) =>
  ['admin', 'prodavec', 'nachalnik-otdela-zakupok'].includes(roleOf(user))
const canAssignRfq = (user) => isAdmin(user) || isProcurementHead(user)

const fetchRequestHeader = async (conn, requestId) => {
  const [[row]] = await conn.execute(
    `SELECT cr.id,
            cr.client_id,
            cr.internal_number,
            cr.current_revision_id,
            cr.processing_deadline,
            cr.is_locked_after_release,
            cr.released_to_procurement_at,
            c.company_name AS client_name
       FROM client_requests cr
       JOIN clients c ON c.id = cr.client_id
      WHERE cr.id = ?`,
    [requestId]
  )
  return row || null
}

const ensureRequestUnlocked = async (conn, requestId) => {
  const [[row]] = await conn.execute(
    `SELECT id
       FROM client_requests
      WHERE id = ?`,
    [requestId]
  )
  if (!row) return { ok: false, code: 404, message: 'Заявка не найдена' }
  return { ok: true }
}

const findRequestByInternalNumber = async (conn, internalNumber, excludeId = null) => {
  if (!internalNumber) return null
  const params = [internalNumber]
  let sql = `
    SELECT cr.id,
           cr.internal_number,
           cr.client_id,
           c.company_name AS client_name
      FROM client_requests cr
      JOIN clients c ON c.id = cr.client_id
     WHERE cr.internal_number = ?
  `
  if (excludeId) {
    sql += ' AND cr.id <> ?'
    params.push(excludeId)
  }
  sql += ' ORDER BY cr.id DESC LIMIT 1'
  const [[row]] = await conn.execute(sql, params)
  return row || null
}

const fetchRequestIdByRevisionId = async (conn, revisionId) => {
  const [[row]] = await conn.execute(
    `SELECT client_request_id
       FROM client_request_revisions
      WHERE id = ?`,
    [revisionId]
  )
  return row?.client_request_id || null
}

const ensureRfqRevisionSnapshot = async (
  conn,
  { rfqId, clientRequestRevisionId, createdByUserId, revisionType = 'base' }
) => {
  const [[existing]] = await conn.execute(
    `SELECT id
       FROM rfq_revisions
      WHERE rfq_id = ?
        AND client_request_revision_id = ?
      ORDER BY rev_number DESC, id DESC
      LIMIT 1`,
    [rfqId, clientRequestRevisionId]
  )
  if (existing?.id) return existing.id

  const [[{ next_rev }]] = await conn.execute(
    `SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev
       FROM rfq_revisions
      WHERE rfq_id = ?`,
    [rfqId]
  )

  const [ins] = await conn.execute(
    `INSERT INTO rfq_revisions
      (rfq_id, rev_number, client_request_revision_id, revision_type, sync_status, created_by_user_id)
     VALUES (?,?,?,?, 'synced', ?)`,
    [rfqId, next_rev, clientRequestRevisionId, revisionType, createdByUserId || null]
  )

  return ins.insertId
}

const ensureRfqItemsFromRevision = async (conn, rfqId, clientRequestRevisionId) => {
  if (!rfqId || !clientRequestRevisionId) return 0
  const [[{ cnt }]] = await conn.execute(
    'SELECT COUNT(*) AS cnt FROM rfq_items WHERE rfq_id = ?',
    [rfqId]
  )
  if (Number(cnt) > 0) return 0
  const [ins] = await conn.execute(
    `
    INSERT INTO rfq_items
      (rfq_id, client_request_revision_item_id, line_number, requested_qty, uom, oem_only, note)
    SELECT ?, cri.id, cri.line_number, cri.requested_qty, cri.uom, cri.oem_only, NULL
      FROM client_request_revision_items cri
     WHERE cri.client_request_revision_id = ?
    `,
    [rfqId, clientRequestRevisionId]
  )
  return Number(ins?.affectedRows || 0)
}

const syncRfqLineStatuses = async (conn, rfqId) => {
  const [suppliers] = await conn.execute('SELECT id FROM rfq_suppliers WHERE rfq_id = ?', [rfqId])
  const [items] = await conn.execute(
    `
    SELECT ri.id
      FROM rfq_items ri
      JOIN rfqs r ON r.id = ri.rfq_id
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
     WHERE ri.rfq_id = ?
       AND cri.client_request_revision_id = r.client_request_revision_id
    `,
    [rfqId]
  )
  const supplierIds = suppliers.map((row) => row.id)
  const itemIds = items.map((row) => row.id)
  if (!supplierIds.length) return

  if (itemIds.length) {
    const pairs = []
    supplierIds.forEach((sid) => itemIds.forEach((iid) => pairs.push([sid, iid])))
    const values = pairs.map(() => '(?, ?, "REQUEST")').join(',')
    const flat = pairs.flat()
    await conn.execute(
      `
      INSERT INTO rfq_supplier_line_status (rfq_supplier_id, rfq_item_id, status)
      VALUES ${values}
      ON DUPLICATE KEY UPDATE
        status = IF(rfq_supplier_line_status.status = 'ARCHIVED', 'REQUEST', rfq_supplier_line_status.status),
        updated_at = CURRENT_TIMESTAMP
      `,
      flat
    )
  }

  const placeholdersSup = supplierIds.map(() => '?').join(',')
  await conn.execute(
    `
    UPDATE rfq_supplier_line_status rsl
    LEFT JOIN rfq_items ri ON ri.id = rsl.rfq_item_id
    LEFT JOIN rfqs r ON r.id = ri.rfq_id
    LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
       SET rsl.status = 'ARCHIVED',
           rsl.updated_at = CURRENT_TIMESTAMP
     WHERE rsl.rfq_supplier_id IN (${placeholdersSup})
       AND (
             ri.id IS NULL
          OR r.id IS NULL
          OR cri.id IS NULL
          OR ri.rfq_id <> ?
          OR cri.client_request_revision_id <> r.client_request_revision_id
       )
    `,
    [...supplierIds, rfqId]
  )
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
    const rawUom = nz(getField(raw, ['uom', 'Ед.']))
    const { uom, error: uomError } = normalizeUom(rawUom || '', { allowEmpty: true })
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
    if (uomError) errorIssues.push(uomError)

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
      uom: uom || 'pcs',
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
      SELECT cr.*,
             c.company_name AS client_name,
             r.id AS rfq_id,
             r.rfq_number,
             r.rfq_sync_status
      FROM client_requests cr
      JOIN clients c ON c.id = cr.client_id
      LEFT JOIN rfqs r ON r.client_request_id = cr.id
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
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[row]] = await db.execute(
      `SELECT cr.*,
              r.id AS rfq_id,
              r.rfq_number,
              r.rfq_sync_status
         FROM client_requests cr
         LEFT JOIN rfqs r ON r.client_request_id = cr.id
        WHERE cr.id = ?`,
      [id]
    )
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
    if (!client_id) return res.status(400).json({ message: 'Не выбран клиент' })

    const source_type = nz(req.body.source_type)
    const received_at = nz(req.body.received_at)
    const processing_deadline = nz(req.body.processing_deadline)
    const created_at = nz(req.body.created_at)
    const created_by_user_id = toId(req.user?.id)
    const assigned_to_user_id = toId(req.body.assigned_to_user_id) || created_by_user_id
    const internal_number = nz(req.body.internal_number ?? req.body.internalNumber)
    const client_reference = nz(req.body.client_reference)
    const contact_name = nz(req.body.contact_name)
    const contact_email = nz(req.body.contact_email)
    const contact_phone = nz(req.body.contact_phone)
    const comment_internal = nz(req.body.comment_internal)
    const comment_client = nz(req.body.comment_client)

    const columns = [
      'client_id',
      'source_type',
      'received_at',
      'processing_deadline',
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
      source_type,
      received_at,
      processing_deadline,
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

    if (!internal_number) {
      return res.status(400).json({ message: 'internal_number обязателен' })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()
      const duplicate = await findRequestByInternalNumber(conn, internal_number)
      if (duplicate) {
        await conn.rollback()
        return res.status(409).json({
          code: 'DUPLICATE_INTERNAL_NUMBER',
          message: `Номер заявки ${internal_number} уже используется клиентом "${duplicate.client_name}"`,
          duplicate_request: duplicate,
        })
      }

      const [result] = await conn.execute(
        `
        INSERT INTO client_requests (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
        `,
        values
      )
      if (assigned_to_user_id && assigned_to_user_id !== created_by_user_id) {
        await createNotification(conn, {
          userId: assigned_to_user_id,
          type: 'assignment',
          title: 'Назначена заявка',
          message: `Заявка ${internal_number || `#${result.insertId}`}`,
          entityType: 'client_request',
          entityId: result.insertId,
        })
      }
      await updateRequestStatus(conn, result.insertId)
      await conn.commit()

      const [[created]] = await conn.execute(
        'SELECT * FROM client_requests WHERE id = ?',
        [result.insertId]
      )
      return res.status(201).json(created)
    } catch (e) {
      await conn.rollback()
      if (e?.code === 'ER_DUP_ENTRY') {
        const duplicate = await findRequestByInternalNumber(conn, internal_number)
        return res.status(409).json({
          code: 'DUPLICATE_INTERNAL_NUMBER',
          message: duplicate
            ? `Номер заявки ${internal_number} уже используется клиентом "${duplicate.client_name}"`
            : `Номер заявки ${internal_number} уже используется`,
          duplicate_request: duplicate || undefined,
        })
      }
      throw e
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('POST /client-requests error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[prev]] = await db.execute(
      `SELECT assigned_to_user_id,
              internal_number
         FROM client_requests
        WHERE id = ?`,
      [id]
    )
    if (!prev) return res.status(404).json({ message: 'Не найдено' })

    const fields = {
      source_type: nz(req.body.source_type),
      received_at: nz(req.body.received_at),
      processing_deadline: nz(req.body.processing_deadline),
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

    if (fields.internal_number && fields.internal_number !== prev.internal_number) {
      const duplicate = await findRequestByInternalNumber(db, fields.internal_number, id)
      if (duplicate) {
        return res.status(409).json({
          code: 'DUPLICATE_INTERNAL_NUMBER',
          message: `Номер заявки ${fields.internal_number} уже используется клиентом "${duplicate.client_name}"`,
          duplicate_request: duplicate,
        })
      }
    }

    params.push(id)
    try {
      await db.execute(`UPDATE client_requests SET ${updates.join(', ')} WHERE id = ?`, params)
    } catch (e) {
      if (e?.code === 'ER_DUP_ENTRY') {
        const duplicate = await findRequestByInternalNumber(db, fields.internal_number, id)
        return res.status(409).json({
          code: 'DUPLICATE_INTERNAL_NUMBER',
          message: duplicate
            ? `Номер заявки ${fields.internal_number} уже используется клиентом "${duplicate.client_name}"`
            : `Номер заявки ${fields.internal_number} уже используется`,
          duplicate_request: duplicate || undefined,
        })
      }
      throw e
    }

    if (fields.assigned_to_user_id && fields.assigned_to_user_id !== prev.assigned_to_user_id) {
      if (prev.assigned_to_user_id) {
        await db.execute(
          `DELETE FROM notifications
           WHERE user_id = ?
             AND type = 'assignment'
             AND entity_type = 'client_request'
             AND entity_id = ?`,
          [prev.assigned_to_user_id, id]
        )
      }
      await createNotification(db, {
        userId: fields.assigned_to_user_id,
        type: 'assignment',
        title: 'Назначена заявка',
        message: `Заявка ${prev.internal_number || `#${id}`}`,
        entityType: 'client_request',
        entityId: id,
      })
    }

    const [[updated]] = await db.execute('SELECT * FROM client_requests WHERE id = ?', [id])
    res.json(updated)
  } catch (e) {
    console.error('PUT /client-requests/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/release', async (req, res) => {
  const requestId = toId(req.params.id)
  if (!requestId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  if (!canReleaseRequest(req.user)) {
    return res.status(403).json({ message: 'Недостаточно прав для отправки заявки в закупку' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const request = await fetchRequestHeader(conn, requestId)
    if (!request) {
      await conn.rollback()
      return res.status(404).json({ message: 'Заявка не найдена' })
    }

    if (request.released_to_procurement_at) {
      await conn.commit()
      return res.json({ success: true, already_sent: true, request })
    }

    let revisionId = request.current_revision_id
    if (!revisionId) {
      const [[latestRev]] = await conn.execute(
        `SELECT id
           FROM client_request_revisions
          WHERE client_request_id = ?
          ORDER BY rev_number DESC, id DESC
          LIMIT 1`,
        [requestId]
      )
      revisionId = latestRev?.id || null
      if (revisionId) {
        await conn.execute(
          `UPDATE client_requests
              SET current_revision_id = ?
            WHERE id = ?`,
          [revisionId, requestId]
        )
      }
    }

    if (!revisionId) {
      await conn.rollback()
      return res.status(409).json({ message: 'Нельзя отправить релиз: нет ревизии заявки' })
    }

    const [[{ item_count }]] = await conn.execute(
      `SELECT COUNT(*) AS item_count
         FROM client_request_revision_items
        WHERE client_request_revision_id = ?`,
      [revisionId]
    )

    if (!item_count) {
      await conn.rollback()
      return res
        .status(409)
        .json({ message: 'Нельзя отправить релиз: в текущей ревизии нет позиций' })
    }

    await conn.execute(
      `UPDATE client_requests
          SET is_locked_after_release = 0,
              released_to_procurement_at = NOW(),
              released_to_procurement_by_user_id = ?,
              status = 'released_to_procurement',
              status_updated_at = NOW()
        WHERE id = ?`,
      [toId(req.user?.id), requestId]
    )

    await conn.execute(
      `INSERT INTO client_request_events (client_request_id, event_type, actor_user_id, payload_json)
       VALUES (?, 'released_to_procurement', ?, JSON_OBJECT('revision_id', ?, 'item_count', ?))`,
      [requestId, toId(req.user?.id), revisionId, item_count]
    )

    // Менеджеру достаточно видеть релизы в блоке "Релизы заявок (назначение RFQ)" на дашборде,
    // поэтому отдельные уведомления о релизе не создаём.

    await updateRequestStatus(conn, requestId)

    const [[updated]] = await conn.execute('SELECT * FROM client_requests WHERE id = ?', [requestId])
    await conn.commit()
    return res.json({ success: true, request: updated })
  } catch (e) {
    await conn.rollback()
    console.error('POST /client-requests/:id/release error:', e)
    return res.status(500).json({ message: 'Ошибка отправки заявки в закупку' })
  } finally {
    conn.release()
  }
})

router.post('/:id/assign-rfq', async (req, res) => {
  const requestId = toId(req.params.id)
  const assigneeId = toId(req.body.assigned_to_user_id)
  if (!requestId || !assigneeId) {
    return res.status(400).json({ message: 'Нужно указать заявку и ответственного' })
  }
  if (!canAssignRfq(req.user)) {
    return res.status(403).json({ message: 'Недостаточно прав для назначения RFQ' })
  }

  const processingDeadline = nz(req.body.processing_deadline)
  const note = nz(req.body.note)
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const request = await fetchRequestHeader(conn, requestId)
    if (!request) {
      await conn.rollback()
      return res.status(404).json({ message: 'Заявка не найдена' })
    }

    if (!request.released_to_procurement_at) {
      await conn.rollback()
      return res.status(409).json({
        message: 'RFQ можно назначить только после отправки заявки в закупку',
      })
    }

    const [[assignee]] = await conn.execute(
      `SELECT u.id, u.full_name, u.is_active
         FROM users u
        WHERE u.id = ?`,
      [assigneeId]
    )
    if (!assignee || !assignee.is_active) {
      await conn.rollback()
      return res.status(400).json({ message: 'Назначаемый пользователь не найден или неактивен' })
    }

    let revisionId = request.current_revision_id
    if (!revisionId) {
      const [[latestRev]] = await conn.execute(
        `SELECT id
           FROM client_request_revisions
          WHERE client_request_id = ?
          ORDER BY rev_number DESC, id DESC
          LIMIT 1`,
        [requestId]
      )
      revisionId = latestRev?.id || null
      if (revisionId) {
        await conn.execute('UPDATE client_requests SET current_revision_id = ? WHERE id = ?', [
          revisionId,
          requestId,
        ])
      }
    }
    if (!revisionId) {
      await conn.rollback()
      return res.status(409).json({ message: 'Нельзя создать RFQ: у заявки нет ревизии' })
    }

    const [[{ item_count }]] = await conn.execute(
      `SELECT COUNT(*) AS item_count
         FROM client_request_revision_items
        WHERE client_request_revision_id = ?`,
      [revisionId]
    )
    if (!item_count) {
      await conn.rollback()
      return res
        .status(409)
        .json({ message: 'Нельзя создать RFQ: в текущей ревизии нет позиций' })
    }

    if (processingDeadline !== null) {
      await conn.execute(
        `UPDATE client_requests
            SET processing_deadline = ?
          WHERE id = ?`,
        [processingDeadline || null, requestId]
      )
    }

    const [[existingRfq]] = await conn.execute(
      `SELECT id, rfq_number, created_by_user_id, assigned_to_user_id
         FROM rfqs
        WHERE client_request_id = ?
        LIMIT 1`,
      [requestId]
    )

    let rfqId = existingRfq?.id || null
    const createdByUserId = toId(req.user?.id)
    const previousRfqAssigneeId = toId(existingRfq?.assigned_to_user_id)
    const rfqNumber = `RFQ-${request.internal_number}`

    if (existingRfq) {
      await conn.execute(
        `UPDATE rfqs
            SET assigned_to_user_id = ?,
                client_request_revision_id = ?,
                note = COALESCE(?, note)
          WHERE id = ?`,
        [assigneeId, revisionId, note, rfqId]
      )
    } else {
      const [[rfqNumberConflict]] = await conn.execute(
        `SELECT id
           FROM rfqs
          WHERE rfq_number = ?
          LIMIT 1`,
        [rfqNumber]
      )
      if (rfqNumberConflict) {
        await conn.rollback()
        return res.status(409).json({
          message: `RFQ номер ${rfqNumber} уже используется`,
        })
      }

      const [ins] = await conn.execute(
        `INSERT INTO rfqs
          (rfq_number, client_request_id, client_request_revision_id, status, created_by_user_id, assigned_to_user_id, note)
         VALUES (?,?,?,?,?,?,?)`,
        [rfqNumber, requestId, revisionId, 'draft', createdByUserId, assigneeId, note]
      )
      rfqId = ins.insertId
    }

    const rfqRevisionId = await ensureRfqRevisionSnapshot(conn, {
      rfqId,
      clientRequestRevisionId: revisionId,
      createdByUserId,
      revisionType: existingRfq ? 'delta' : 'base',
    })
    await conn.execute(
      `UPDATE rfqs
          SET current_rfq_revision_id = ?,
              rfq_sync_status = 'synced',
              last_sync_at = NOW(),
              last_synced_client_request_revision_id = ?
        WHERE id = ?`,
      [rfqRevisionId, revisionId, rfqId]
    )
    await ensureRfqItemsFromRevision(conn, rfqId, revisionId)
    await syncRfqLineStatuses(conn, rfqId)

    await conn.execute(
      `UPDATE client_requests
          SET rfq_assigned_at = NOW(),
              rfq_assigned_by_user_id = ?
        WHERE id = ?`,
      [createdByUserId, requestId]
    )

    await conn.execute(
      `INSERT INTO client_request_events (client_request_id, event_type, actor_user_id, payload_json)
       VALUES (?, 'rfq_assigned', ?, JSON_OBJECT('assigned_to_user_id', ?, 'rfq_id', ?, 'revision_id', ?))`,
      [requestId, createdByUserId, assigneeId, rfqId, revisionId]
    )

    if (previousRfqAssigneeId && previousRfqAssigneeId !== assigneeId) {
      await conn.execute(
        `DELETE FROM notifications
         WHERE user_id = ?
           AND type = 'assignment'
           AND entity_type = 'rfq'
           AND entity_id = ?`,
        [previousRfqAssigneeId, rfqId]
      )
    }

    if (!existingRfq || previousRfqAssigneeId !== assigneeId) {
      await createNotification(conn, {
        userId: assigneeId,
        type: 'assignment',
        title: 'Назначен RFQ',
        message: `${rfqNumber} · ${request.client_name} ${request.internal_number}`.trim(),
        entityType: 'rfq',
        entityId: rfqId,
      })
    }

    await updateRequestStatus(conn, requestId)

    const [[rfq]] = await conn.execute('SELECT * FROM rfqs WHERE id = ?', [rfqId])
    const [[updatedRequest]] = await conn.execute('SELECT * FROM client_requests WHERE id = ?', [
      requestId,
    ])

    await conn.commit()
    return res.json({
      success: true,
      created: !existingRfq,
      rfq,
      request: updatedRequest,
    })
  } catch (e) {
    await conn.rollback()
    console.error('POST /client-requests/:id/assign-rfq error:', e)
    return res.status(500).json({ message: 'Ошибка назначения RFQ' })
  } finally {
    conn.release()
  }
})

router.post('/:id/sync-rfq', async (req, res) => {
  const requestId = toId(req.params.id)
  if (!requestId) {
    return res.status(400).json({ message: 'Некорректный идентификатор заявки' })
  }
  if (!canAssignRfq(req.user)) {
    return res.status(403).json({ message: 'Недостаточно прав для синхронизации RFQ' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const request = await fetchRequestHeader(conn, requestId)
    if (!request) {
      await conn.rollback()
      return res.status(404).json({ message: 'Заявка не найдена' })
    }
    if (!request.released_to_procurement_at) {
      await conn.rollback()
      return res.status(409).json({ message: 'Синхронизация доступна только после отправки заявки в закупку' })
    }

    let revisionId = request.current_revision_id
    if (!revisionId) {
      const [[latestRev]] = await conn.execute(
        `SELECT id
           FROM client_request_revisions
          WHERE client_request_id = ?
          ORDER BY rev_number DESC, id DESC
          LIMIT 1`,
        [requestId]
      )
      revisionId = latestRev?.id || null
      if (revisionId) {
        await conn.execute(
          `UPDATE client_requests
              SET current_revision_id = ?
            WHERE id = ?`,
          [revisionId, requestId]
        )
      }
    }
    if (!revisionId) {
      await conn.rollback()
      return res.status(409).json({ message: 'Невозможно синхронизировать: у заявки нет ревизии' })
    }

    const [[{ item_count }]] = await conn.execute(
      `SELECT COUNT(*) AS item_count
         FROM client_request_revision_items
        WHERE client_request_revision_id = ?`,
      [revisionId]
    )
    if (!item_count) {
      await conn.rollback()
      return res.status(409).json({ message: 'Невозможно синхронизировать: в ревизии нет позиций' })
    }

    const [[rfq]] = await conn.execute(
      `SELECT id, assigned_to_user_id, status
         FROM rfqs
        WHERE client_request_id = ?
        LIMIT 1`,
      [requestId]
    )
    if (!rfq?.id) {
      await conn.rollback()
      return res.status(404).json({ message: 'Для заявки не найден RFQ' })
    }

    await conn.execute(
      `UPDATE rfqs
          SET client_request_revision_id = ?
        WHERE id = ?`,
      [revisionId, rfq.id]
    )

    // Синхронизируем строки RFQ так, чтобы линии и их номера полностью соответствовали
    // актуальной ревизии заявки. Лишние строки удаляем, существующие обновляем, новые добавляем.
    const [revisionItems] = await conn.execute(
      `SELECT id, line_number, requested_qty, uom, oem_only, original_part_id, client_part_number
         FROM client_request_revision_items
        WHERE client_request_revision_id = ?
        ORDER BY line_number, id`,
      [revisionId]
    )

    const [rfqItems] = await conn.execute(
      `SELECT ri.*,
              cri.original_part_id,
              cri.client_part_number
         FROM rfq_items ri
         LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
        WHERE ri.rfq_id = ?
        ORDER BY ri.line_number, ri.id`,
      [rfq.id]
    )

    const itemsByLine = new Map()
    rfqItems.forEach((row) => {
      const key = Number(row.line_number)
      if (!itemsByLine.has(key)) itemsByLine.set(key, [])
      itemsByLine.get(key).push(row)
    })

    const toDelete = []
    const toUpdate = []
    const toInsert = []

    revisionItems.forEach((revItem) => {
      const key = Number(revItem.line_number)
      const existingList = itemsByLine.get(key) || []
      let keepIndex = existingList.findIndex(
        (row) =>
          Number(row.original_part_id || 0) === Number(revItem.original_part_id || 0) &&
          String(row.client_part_number || '') === String(revItem.client_part_number || '')
      )
      if (keepIndex < 0) {
        keepIndex = existingList.findIndex(
          (row) => Number(row.original_part_id || 0) === Number(revItem.original_part_id || 0)
        )
      }
      const keep = keepIndex >= 0 ? existingList.splice(keepIndex, 1)[0] : null

      if (keep) {
        toUpdate.push({
          id: keep.id,
          client_request_revision_item_id: revItem.id,
          line_number: revItem.line_number,
          requested_qty: revItem.requested_qty,
          uom: revItem.uom,
          oem_only: revItem.oem_only,
        })
      } else {
        toInsert.push({
          rfq_id: rfq.id,
          client_request_revision_item_id: revItem.id,
          line_number: revItem.line_number,
          requested_qty: revItem.requested_qty,
          uom: revItem.uom,
          oem_only: revItem.oem_only,
        })
      }

      // what remains in existingList are duplicates for this line
      itemsByLine.set(key, existingList)
    })

    // всё, что осталось в itemsByLine, либо дубликаты, либо строки удалённые в новой ревизии
    for (const list of itemsByLine.values()) {
      list.forEach((row) => toDelete.push(row.id))
    }

    if (toDelete.length) {
      const placeholders = toDelete.map(() => '?').join(',')
      await conn.execute(
        `
        UPDATE rfq_supplier_line_status rsl
        JOIN rfq_suppliers rs ON rs.id = rsl.rfq_supplier_id
           SET rsl.status = 'ARCHIVED',
               rsl.updated_at = CURRENT_TIMESTAMP
         WHERE rs.rfq_id = ?
           AND rsl.rfq_item_id IN (${placeholders})
        `,
        [rfq.id, ...toDelete]
      )
    }

    for (const row of toUpdate) {
      await conn.execute(
        `UPDATE rfq_items
            SET client_request_revision_item_id = ?,
                line_number = ?,
                requested_qty = ?,
                uom = ?,
                oem_only = ?
          WHERE id = ?`,
        [
          row.client_request_revision_item_id,
          row.line_number,
          row.requested_qty,
          row.uom,
          row.oem_only,
          row.id,
        ]
      )
    }

    if (toInsert.length) {
      const placeholders = toInsert.map(() => '(?,?,?,?,?, ?, NULL)').join(',')
      const params = toInsert.flatMap((row) => [
        row.rfq_id,
        row.client_request_revision_item_id,
        row.line_number,
        row.requested_qty,
        row.uom,
        row.oem_only,
      ])
      await conn.execute(
        `INSERT INTO rfq_items
          (rfq_id, client_request_revision_item_id, line_number, requested_qty, uom, oem_only, note)
         VALUES ${placeholders}`,
        params
      )
    }
    const addedItemsCount = toInsert.length

    // Актуализируем статусы строк для активного набора позиций RFQ
    await syncRfqLineStatuses(conn, rfq.id)

    const rfqRevisionId = await ensureRfqRevisionSnapshot(conn, {
      rfqId: rfq.id,
      clientRequestRevisionId: revisionId,
      createdByUserId: toId(req.user?.id),
      revisionType: 'delta',
    })

    await conn.execute(
      `UPDATE rfqs
          SET current_rfq_revision_id = ?,
              rfq_sync_status = 'synced',
              last_sync_at = NOW(),
              last_synced_client_request_revision_id = ?
        WHERE id = ?`,
      [rfqRevisionId, revisionId, rfq.id]
    )

    await conn.execute(
      `INSERT INTO client_request_events (client_request_id, event_type, actor_user_id, payload_json)
       VALUES (?, 'rfq_synced', ?, JSON_OBJECT('rfq_id', ?, 'revision_id', ?, 'added_items', ?))`,
      [requestId, toId(req.user?.id), rfq.id, revisionId, addedItemsCount]
    )

    await updateRequestStatus(conn, requestId)

    const [[updatedRequest]] = await conn.execute(
      `SELECT cr.*,
              c.company_name AS client_name,
              r.id AS rfq_id,
              r.rfq_number,
              r.rfq_sync_status
         FROM client_requests cr
         JOIN clients c ON c.id = cr.client_id
         LEFT JOIN rfqs r ON r.client_request_id = cr.id
        WHERE cr.id = ?`,
      [requestId]
    )
    const [[updatedRfq]] = await conn.execute(`SELECT * FROM rfqs WHERE id = ?`, [rfq.id])

    await conn.commit()
    return res.json({
      success: true,
      added_items: addedItemsCount,
      request: updatedRequest,
      rfq: updatedRfq,
    })
  } catch (e) {
    await conn.rollback()
    console.error('POST /client-requests/:id/sync-rfq error:', e)
    return res.status(500).json({ message: 'Ошибка синхронизации RFQ' })
  } finally {
    conn.release()
  }
})

router.post('/:id/mark-rfq-needs-sync', async (req, res) => {
  const requestId = toId(req.params.id)
  if (!requestId) {
    return res.status(400).json({ message: 'Некорректный идентификатор заявки' })
  }

  const conn = await db.getConnection()
  try {
    const request = await fetchRequestHeader(conn, requestId)
    if (!request) {
      return res.status(404).json({ message: 'Заявка не найдена' })
    }
    const lockState = await ensureRequestUnlocked(conn, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

    await markRfqNeedsSync(conn, requestId)
    res.json({ success: true })
  } catch (e) {
    console.error('POST /client-requests/:id/mark-rfq-needs-sync error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    await conn.execute(
      `DELETE FROM notifications
       WHERE entity_type = 'client_request' AND entity_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE n FROM notifications n
       JOIN rfqs r ON r.id = n.entity_id AND n.entity_type = 'rfq'
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )

    await conn.execute('DELETE FROM client_request_events WHERE client_request_id = ?', [id])

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
      `DELETE cric FROM client_request_revision_item_components cric
       JOIN client_request_revision_items cri ON cri.id = cric.client_request_revision_item_id
       JOIN client_request_revisions cr ON cr.id = cri.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE cris FROM client_request_revision_item_strategies cris
       JOIN client_request_revision_items cri ON cri.id = cris.client_request_revision_item_id
       JOIN client_request_revisions cr ON cr.id = cri.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE cri FROM client_request_revision_items cri
       JOIN client_request_revisions cr ON cr.id = cri.client_request_revision_id
       WHERE cr.client_request_id = ?`,
      [id]
    )
    await conn.execute(
      `UPDATE client_requests
       SET current_revision_id = NULL
       WHERE id = ?`,
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
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

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
    if (!client_request_id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const lockState = await ensureRequestUnlocked(db, client_request_id)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

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
      await conn.execute(
        `UPDATE client_requests SET current_revision_id = ? WHERE id = ?`,
        [result.insertId, client_request_id]
      )

      const [affectedRfqs] = await conn.execute(
        `SELECT id
           FROM rfqs
          WHERE client_request_id = ?`,
        [client_request_id]
      )
      if (affectedRfqs.length) {
        await conn.execute(
          `INSERT INTO client_request_events (client_request_id, event_type, actor_user_id, payload_json)
           VALUES (?, 'request_revision_created', ?, JSON_OBJECT('revision_id', ?, 'rfq_count', ?))`,
          [client_request_id, created_by_user_id, result.insertId, affectedRfqs.length]
        )
      }

      await updateRequestStatus(conn, client_request_id)
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
    if (!revisionId) return res.status(400).json({ message: 'Некорректный идентификатор' })

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
    if (!revisionId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const requestId = await fetchRequestIdByRevisionId(db, revisionId)
    const lockState = await ensureRequestUnlocked(db, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

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
    const [itemRows] = await db.execute(
      `SELECT ri.id AS revision_item_id,
              ri.requested_qty,
              ri.original_part_id,
              ri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM client_request_revision_items ri
         LEFT JOIN original_parts op ON op.id = ri.original_part_id
        WHERE ri.id = ?`,
      [result.insertId]
    )
    if (itemRows.length) {
      await ensureStrategiesAndComponents(db, itemRows)
    }
    const [[reqRow]] = await db.execute(
      `SELECT client_request_id FROM client_request_revisions WHERE id = ?`,
      [revisionId]
    )
    if (reqRow?.client_request_id) {
      const conn = await db.getConnection()
      try {
        await updateRequestStatus(conn, reqRow.client_request_id)
      } finally {
        conn.release()
      }
    }
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
  if (!requestId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  const lockState = await ensureRequestUnlocked(db, requestId)
  if (!lockState.ok) {
    return res.status(lockState.code).json({ message: lockState.message })
  }

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
  if (!requestId) return res.status(400).json({ message: 'Некорректный идентификатор' })
  const lockState = await ensureRequestUnlocked(db, requestId)
  if (!lockState.ok) {
    return res.status(lockState.code).json({ message: lockState.message })
  }

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

    const [itemRows] = await conn.execute(
      `SELECT ri.id AS revision_item_id,
              ri.requested_qty,
              ri.original_part_id,
              ri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM client_request_revision_items ri
         LEFT JOIN original_parts op ON op.id = ri.original_part_id
        WHERE ri.client_request_revision_id = ?`,
      [revisionId]
    )
    if (itemRows.length) {
      await ensureStrategiesAndComponents(conn, itemRows)
    }
    const [[reqRow]] = await conn.execute(
      `SELECT client_request_id FROM client_request_revisions WHERE id = ?`,
      [revisionId]
    )
    if (reqRow?.client_request_id) {
      await updateRequestStatus(conn, reqRow.client_request_id)
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
      return res.status(400).json({ message: 'Некорректный идентификатор' })
    }
    const requestId = await fetchRequestIdByRevisionId(db, revisionId)
    const lockState = await ensureRequestUnlocked(db, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
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
    const [[reqRow]] = await db.execute(
      `SELECT client_request_id FROM client_request_revisions WHERE id = ?`,
      [revisionId]
    )
    if (reqRow?.client_request_id) {
      const conn = await db.getConnection()
      try {
        await updateRequestStatus(conn, reqRow.client_request_id)
      } finally {
        conn.release()
      }
    }
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
      return res.status(400).json({ message: 'Некорректный идентификатор' })
    }
    const requestId = await fetchRequestIdByRevisionId(db, revisionId)
    const lockState = await ensureRequestUnlocked(db, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

    await db.execute(
      `DELETE FROM client_request_revision_item_components
       WHERE client_request_revision_item_id = ?`,
      [itemId]
    )
    await db.execute(
      `DELETE FROM client_request_revision_item_strategies
       WHERE client_request_revision_item_id = ?`,
      [itemId]
    )

    const [result] = await db.execute(
      `DELETE FROM client_request_revision_items
       WHERE id = ? AND client_request_revision_id = ?`,
      [itemId, revisionId]
    )
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [[reqRow]] = await db.execute(
      `SELECT client_request_id FROM client_request_revisions WHERE id = ?`,
      [revisionId]
    )
    if (reqRow?.client_request_id) {
      const conn = await db.getConnection()
      try {
        await updateRequestStatus(conn, reqRow.client_request_id)
      } finally {
        conn.release()
      }
    }
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /client-requests/revisions/:revisionId/items/:itemId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/revisions/:revisionId/structure', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const items = await fetchRevisionItems(db, revisionId)
    if (items.length) {
      await ensureStrategiesAndComponents(db, items)
    }

    const payload = await buildRevisionStructure(db, revisionId)
    res.json(payload)
  } catch (e) {
    console.error('GET /client-requests/revisions/:revisionId/structure error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/revisions/:revisionId/items/:itemId/strategy', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    const itemId = toId(req.params.itemId)
    if (!revisionId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const requestId = await fetchRequestIdByRevisionId(db, revisionId)
    const lockState = await ensureRequestUnlocked(db, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

    const mode = nz(req.body.mode)
    const allow_oem = req.body.allow_oem ? 1 : 0
    const allow_analog = req.body.allow_analog ? 1 : 0
    const allow_kit = req.body.allow_kit ? 1 : 0
    const allow_partial = req.body.allow_partial ? 1 : 0
    const note = nz(req.body.note)

    await db.execute(
      `
      INSERT INTO client_request_revision_item_strategies
        (client_request_revision_item_id, mode, allow_oem, allow_analog, allow_kit, allow_partial, note)
      VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        mode = VALUES(mode),
        allow_oem = VALUES(allow_oem),
        allow_analog = VALUES(allow_analog),
        allow_kit = VALUES(allow_kit),
        allow_partial = VALUES(allow_partial),
        note = VALUES(note)
      `,
      [itemId, mode || 'SINGLE', allow_oem, allow_analog, allow_kit, allow_partial, note]
    )

    const [itemRows] = await db.execute(
      `SELECT ri.id AS revision_item_id,
              ri.requested_qty,
              ri.original_part_id,
              ri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM client_request_revision_items ri
         LEFT JOIN original_parts op ON op.id = ri.original_part_id
        WHERE ri.id = ? AND ri.client_request_revision_id = ?`,
      [itemId, revisionId]
    )
    if (itemRows.length) {
      await rebuildComponentsForItem(db, itemRows[0], mode)
    }

    res.json({ success: true })
  } catch (e) {
    console.error('PUT /client-requests/revisions/:revisionId/items/:itemId/strategy error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/revisions/:revisionId/items/:itemId/components/rebuild', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    const itemId = toId(req.params.itemId)
    if (!revisionId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const requestId = await fetchRequestIdByRevisionId(db, revisionId)
    const lockState = await ensureRequestUnlocked(db, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

    const mode = nz(req.body.mode)
    const [itemRows] = await db.execute(
      `SELECT ri.id AS revision_item_id,
              ri.requested_qty,
              ri.original_part_id,
              ri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM client_request_revision_items ri
         LEFT JOIN original_parts op ON op.id = ri.original_part_id
        WHERE ri.id = ? AND ri.client_request_revision_id = ?`,
      [itemId, revisionId]
    )
    if (!itemRows.length) {
      return res.status(404).json({ message: 'Позиция не найдена' })
    }
    await rebuildComponentsForItem(db, itemRows[0], mode)
    res.json({ success: true })
  } catch (e) {
    console.error(
      'POST /client-requests/revisions/:revisionId/items/:itemId/components/rebuild error:',
      e
    )
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/revisions/:revisionId/items/:itemId/components/:componentId', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    const itemId = toId(req.params.itemId)
    const componentId = toId(req.params.componentId)
    if (!revisionId || !itemId || !componentId) {
      return res.status(400).json({ message: 'Некорректный идентификатор' })
    }
    const requestId = await fetchRequestIdByRevisionId(db, revisionId)
    const lockState = await ensureRequestUnlocked(db, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

    const component_qty = numOrNull(req.body.component_qty)
    const required_qty = numOrNull(req.body.required_qty)
    const note = nz(req.body.note)

    const updates = []
    const params = []
    if (component_qty !== null) {
      updates.push('component_qty = ?')
      params.push(component_qty)
    }
    if (required_qty !== null) {
      updates.push('required_qty = ?')
      params.push(required_qty)
    }
    if (note !== null) {
      updates.push('note = ?')
      params.push(note)
    }
    if (!updates.length) {
      return res.status(400).json({ message: 'Нет данных для обновления' })
    }

    params.push(componentId, itemId)
    const [result] = await db.execute(
      `UPDATE client_request_revision_item_components
       SET ${updates.join(', ')}
       WHERE id = ? AND client_request_revision_item_id = ?`,
      params
    )
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Компонент не найден' })
    }
    res.json({ success: true })
  } catch (e) {
    console.error(
      'PUT /client-requests/revisions/:revisionId/items/:itemId/components/:componentId error:',
      e
    )
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/revisions/:revisionId/items/:itemId/components/:componentId', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    const itemId = toId(req.params.itemId)
    const componentId = toId(req.params.componentId)
    if (!revisionId || !itemId || !componentId) {
      return res.status(400).json({ message: 'Некорректный идентификатор' })
    }
    const requestId = await fetchRequestIdByRevisionId(db, revisionId)
    const lockState = await ensureRequestUnlocked(db, requestId)
    if (!lockState.ok) {
      return res.status(lockState.code).json({ message: lockState.message })
    }

    const [result] = await db.execute(
      `DELETE FROM client_request_revision_item_components
       WHERE id = ? AND client_request_revision_item_id = ?`,
      [componentId, itemId]
    )
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Компонент не найден' })
    }
    res.json({ success: true })
  } catch (e) {
    console.error(
      'DELETE /client-requests/revisions/:revisionId/items/:itemId/components/:componentId error:',
      e
    )
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/workspace', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const conn = await db.getConnection()
    try {
      const [[request]] = await conn.execute(
        `SELECT cr.*, c.company_name AS client_name
         FROM client_requests cr
         JOIN clients c ON c.id = cr.client_id
         WHERE cr.id = ?`,
        [id]
      )
      if (!request) return res.status(404).json({ message: 'Не найдено' })

      const [revisions] = await conn.execute(
        `SELECT r.*, (
           SELECT COUNT(*) FROM client_request_revision_items i
           WHERE i.client_request_revision_id = r.id
         ) AS items_count
         FROM client_request_revisions r
         WHERE r.client_request_id = ?
         ORDER BY r.rev_number DESC`,
        [id]
      )

      const currentRevisionId =
        request.current_revision_id ||
        (revisions.length ? revisions[0].id : null)
      if (currentRevisionId && request.current_revision_id !== currentRevisionId) {
        await conn.execute(
          `UPDATE client_requests SET current_revision_id = ? WHERE id = ?`,
          [currentRevisionId, id]
        )
        request.current_revision_id = currentRevisionId
      }

      const items = currentRevisionId
        ? await fetchRevisionItems(conn, currentRevisionId)
        : []
      if (items.length) {
        await ensureStrategiesAndComponents(conn, items)
      }
      const structure = currentRevisionId
        ? await buildRevisionStructure(conn, currentRevisionId)
        : { revision_id: currentRevisionId, items: [] }

      const status = await updateRequestStatus(conn, id, { skipPersist: false })
      request.status = status

      res.json({
        request,
        revisions,
        current_revision_id: currentRevisionId,
        items: structure.items,
      })
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('GET /client-requests/:id/workspace error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
