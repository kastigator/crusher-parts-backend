const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  updateRequestStatus,
  fetchRequestIdBySupplierResponseId,
} = require('../utils/clientRequestStatus')

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)

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
const normCurrency = (v) => {
  const s = nz(v)
  return s ? s.toUpperCase().slice(0, 3) : null
}
const normOfferType = (v) => {
  const s = nz(v)
  if (!s) return 'UNKNOWN'
  const upper = s.toUpperCase()
  return upper === 'OEM' || upper === 'ANALOG' || upper === 'UNKNOWN'
    ? upper
    : 'UNKNOWN'
}
const canonicalPartNumber = (v) => {
  const s = nz(v)
  if (!s) return null
  return s
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_./\\]/g, '')
}

const markSupplierAsResponded = async (conn, rfqSupplierId) => {
  await conn.execute(
    `UPDATE rfq_suppliers
        SET status = 'responded',
            responded_at = COALESCE(responded_at, NOW())
      WHERE id = ?`,
    [rfqSupplierId]
  )
}

const upsertLineStatus = async (
  conn,
  {
    rfqSupplierId,
    rfqItemId,
    status = 'NONE',
    sourceType = null,
    sourceRef = null,
    lastRequestRfqRevisionId = null,
    lastResponseRevisionId = null,
    note = null,
  }
) => {
  await conn.execute(
    `
    INSERT INTO rfq_supplier_line_status
      (rfq_supplier_id, rfq_item_id, status, source_type, source_ref, last_request_rfq_revision_id, last_response_revision_id, note)
    VALUES (?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      source_type = VALUES(source_type),
      source_ref = VALUES(source_ref),
      last_request_rfq_revision_id = COALESCE(
        VALUES(last_request_rfq_revision_id),
        rfq_supplier_line_status.last_request_rfq_revision_id
      ),
      last_response_revision_id = COALESCE(
        VALUES(last_response_revision_id),
        rfq_supplier_line_status.last_response_revision_id
      ),
      note = COALESCE(VALUES(note), rfq_supplier_line_status.note),
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      rfqSupplierId,
      rfqItemId,
      status,
      sourceType,
      sourceRef,
      lastRequestRfqRevisionId,
      lastResponseRevisionId,
      note,
    ]
  )
}

const ensureSupplierResponseRevision = async (
  conn,
  rfqSupplierId,
  { status = 'received', note = null, userId = null } = {}
) => {
  const [[existingResponse]] = await conn.execute(
    'SELECT id FROM rfq_supplier_responses WHERE rfq_supplier_id = ? LIMIT 1',
    [rfqSupplierId]
  )

  let responseId = existingResponse?.id || null
  if (!responseId) {
    const [ins] = await conn.execute(
      `INSERT INTO rfq_supplier_responses (rfq_supplier_id, status, created_by_user_id)
       VALUES (?,?,?)`,
      [rfqSupplierId, status, userId]
    )
    responseId = ins.insertId
  }

  const [[latestRevision]] = await conn.execute(
    `
    SELECT *
      FROM rfq_response_revisions
     WHERE rfq_supplier_response_id = ?
     ORDER BY rev_number DESC, id DESC
     LIMIT 1
    `,
    [responseId]
  )
  if (latestRevision) {
    return { responseId, revisionId: latestRevision.id, revision: latestRevision }
  }

  const [insRevision] = await conn.execute(
    `
    INSERT INTO rfq_response_revisions
      (rfq_supplier_response_id, rev_number, note, created_by_user_id)
    VALUES (?,?,?,?)
    `,
    [responseId, 1, note, userId]
  )
  const [[createdRevision]] = await conn.execute(
    'SELECT * FROM rfq_response_revisions WHERE id = ?',
    [insRevision.insertId]
  )
  return { responseId, revisionId: createdRevision.id, revision: createdRevision }
}

const createSupplierResponseRevision = async (
  conn,
  rfqSupplierId,
  { status = 'received', note = null, userId = null } = {}
) => {
  const base = await ensureSupplierResponseRevision(conn, rfqSupplierId, {
    status,
    note,
    userId,
  })
  const [[{ next_rev }]] = await conn.execute(
    `
    SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev
      FROM rfq_response_revisions
     WHERE rfq_supplier_response_id = ?
    `,
    [base.responseId]
  )
  const [ins] = await conn.execute(
    `
    INSERT INTO rfq_response_revisions
      (rfq_supplier_response_id, rev_number, note, created_by_user_id)
    VALUES (?,?,?,?)
    `,
    [base.responseId, next_rev, note, userId]
  )
  const [[revision]] = await conn.execute(
    'SELECT * FROM rfq_response_revisions WHERE id = ?',
    [ins.insertId]
  )
  return { responseId: base.responseId, revisionId: revision.id, revision }
}

const resolveActiveRfqItem = async (conn, rfqId, { rfqItemId = null, lineNumber = null } = {}) => {
  if (!rfqId) return null

  if (rfqItemId) {
    const [[row]] = await conn.execute(
      `
      SELECT
        ri.id,
        ri.line_number,
        ri.client_request_revision_item_id,
        cri.original_part_id AS requested_original_part_id,
        cri.client_description
      FROM rfq_items ri
      JOIN rfqs r ON r.id = ri.rfq_id
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
      WHERE ri.rfq_id = ?
        AND ri.id = ?
        AND cri.client_request_revision_id = r.client_request_revision_id
      `,
      [rfqId, rfqItemId]
    )
    if (row) return row
  }

  if (lineNumber) {
    const [[row]] = await conn.execute(
      `
      SELECT
        ri.id,
        ri.line_number,
        ri.client_request_revision_item_id,
        cri.original_part_id AS requested_original_part_id,
        cri.client_description
      FROM rfq_items ri
      JOIN rfqs r ON r.id = ri.rfq_id
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
      WHERE ri.rfq_id = ?
        AND ri.line_number = ?
        AND cri.client_request_revision_id = r.client_request_revision_id
      ORDER BY ri.id
      LIMIT 1
      `,
      [rfqId, lineNumber]
    )
    if (row) return row
  }

  return null
}

const resolveComponent = async (conn, componentId) => {
  if (!componentId) return null
  const [[component]] = await conn.execute(
    `
    SELECT id, rfq_item_id, original_part_id
      FROM rfq_item_components
     WHERE id = ?
    `,
    [componentId]
  )
  return component || null
}

const resolveOrCreateSupplierPart = async (
  conn,
  {
    supplierId,
    supplierPartId = null,
    supplierPartNumber = null,
    descriptionRu = null,
    descriptionEn = null,
    partType = null,
    originalPartId = null,
  }
) => {
  if (supplierPartId) {
    return { supplierPartId, created: false }
  }
  const partNumber = nz(supplierPartNumber)
  if (!supplierId || !partNumber) {
    return { supplierPartId: null, created: false }
  }

  const canonical = canonicalPartNumber(partNumber)
  const [[existing]] = await conn.execute(
    `
    SELECT id
      FROM supplier_parts
     WHERE supplier_id = ?
       AND (
         (canonical_part_number IS NOT NULL AND canonical_part_number = ?)
         OR supplier_part_number = ?
       )
     LIMIT 1
    `,
    [supplierId, canonical, partNumber]
  )
  let resultId = existing?.id || null
  let created = false

  if (!resultId) {
    const [ins] = await conn.execute(
      `
      INSERT INTO supplier_parts
        (supplier_id, supplier_part_number, canonical_part_number, description_ru, description_en, part_type, active)
      VALUES (?,?,?,?,?,?,1)
      `,
      [
        supplierId,
        partNumber,
        canonical,
        nz(descriptionRu),
        nz(descriptionEn),
        nz(partType) ? String(partType).toUpperCase() : null,
      ]
    )
    resultId = ins.insertId
    created = true
  }

  if (resultId && originalPartId) {
    await conn.execute(
      `
      INSERT IGNORE INTO supplier_part_originals (supplier_part_id, original_part_id)
      VALUES (?,?)
      `,
      [resultId, originalPartId]
    )
  }

  return { supplierPartId: resultId, created }
}

const insertResponseLine = async (
  conn,
  {
    revisionId,
    rfqItemId,
    selectionKey = null,
    supplierPartId = null,
    originalPartId = null,
    requestedOriginalPartId = null,
    bundleId = null,
    offerType = 'UNKNOWN',
    offeredQty = null,
    moq = null,
    packaging = null,
    leadTimeDays = null,
    price = null,
    currency = null,
    validityDays = null,
    paymentTerms = null,
    note = null,
    rfqItemComponentId = null,
    basedOnResponseLineId = null,
    entrySource = 'SUPPLIER_FILE',
    changeReason = null,
  }
) => {
  const [ins] = await conn.execute(
    `
    INSERT INTO rfq_response_lines
      (rfq_response_revision_id, rfq_item_id, selection_key, supplier_part_id, original_part_id, requested_original_part_id, bundle_id,
       offer_type, offered_qty, moq, packaging, lead_time_days, price, currency, validity_days, payment_terms, note,
       rfq_item_component_id, based_on_response_line_id, entry_source, change_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,
    [
      revisionId,
      rfqItemId,
      selectionKey,
      supplierPartId,
      originalPartId,
      requestedOriginalPartId,
      bundleId,
      offerType,
      offeredQty,
      moq,
      packaging,
      leadTimeDays,
      price,
      currency,
      validityDays,
      paymentTerms,
      note,
      rfqItemComponentId,
      basedOnResponseLineId,
      entrySource,
      changeReason,
    ]
  )
  const [[created]] = await conn.execute(
    'SELECT * FROM rfq_response_lines WHERE id = ?',
    [ins.insertId]
  )
  return created
}

const appendSupplierPartPrice = async (
  conn,
  {
    supplierPartId = null,
    responseLineId = null,
    price = null,
    currency = null,
    offerType = 'UNKNOWN',
    leadTimeDays = null,
    moq = null,
    packaging = null,
    validityDays = null,
    note = null,
    createdByUserId = null,
  }
) => {
  if (!supplierPartId || price === null || !currency || !responseLineId) return
  await conn.execute(
    `
    INSERT INTO supplier_part_prices
      (supplier_part_id, material_id, price, currency, date, comment,
       offer_type, lead_time_days, min_order_qty, packaging, validity_days,
       source_type, source_id, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,
    [
      supplierPartId,
      null,
      price,
      currency,
      new Date(),
      note,
      offerType,
      leadTimeDays,
      moq,
      packaging,
      validityDays,
      'RFQ_RESPONSE',
      responseLineId,
      createdByUserId,
    ]
  )
}

const writeLineAction = async (
  conn,
  { responseLineId, actionType = 'CREATE', payload = null, reason = null, createdByUserId = null }
) => {
  if (!responseLineId) return
  await conn.execute(
    `
    INSERT INTO rfq_response_line_actions
      (rfq_response_line_id, action_type, payload_json, reason, created_by_user_id)
    VALUES (?,?,?,?,?)
    `,
    [
      responseLineId,
      actionType,
      payload ? JSON.stringify(payload) : null,
      nz(reason),
      createdByUserId,
    ]
  )
}

const fetchResponseLinePayload = async (conn, lineId) => {
  const [[line]] = await conn.execute(
    'SELECT * FROM rfq_response_lines WHERE id = ?',
    [lineId]
  )
  return line || null
}

router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.*, rs.rfq_id, rs.supplier_id, ps.name AS supplier_name
       FROM rfq_supplier_responses r
       JOIN rfq_suppliers rs ON rs.id = r.rfq_supplier_id
       JOIN part_suppliers ps ON ps.id = rs.supplier_id
       ORDER BY r.id DESC`
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-responses error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const [[row]] = await db.execute(
      'SELECT * FROM rfq_supplier_responses WHERE id = ?',
      [id]
    )
    if (!row) return res.status(404).json({ message: 'Не найдено' })

    res.json(row)
  } catch (e) {
    console.error('GET /supplier-responses/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const rfq_supplier_id = toId(req.body.rfq_supplier_id)
    if (!rfq_supplier_id) {
      return res.status(400).json({ message: 'rfq_supplier_id обязателен' })
    }

    const status = nz(req.body.status) || 'received'
    const created_by_user_id = toId(req.user?.id)
    const createRevision = req.body.create_revision !== false

    await conn.beginTransaction()

    const [result] = await conn.execute(
      `INSERT INTO rfq_supplier_responses (rfq_supplier_id, status, created_by_user_id)
       VALUES (?,?,?)`,
      [rfq_supplier_id, status, created_by_user_id]
    )

    let revision = null
    if (createRevision) {
      const [revIns] = await conn.execute(
        `INSERT INTO rfq_response_revisions
           (rfq_supplier_response_id, rev_number, note, created_by_user_id)
         VALUES (?,?,?,?)`,
        [result.insertId, 1, nz(req.body.note), created_by_user_id]
      )
      const [[revRow]] = await conn.execute(
        'SELECT * FROM rfq_response_revisions WHERE id = ?',
        [revIns.insertId]
      )
      revision = revRow
    }

    await markSupplierAsResponded(conn, rfq_supplier_id)

    const [[created]] = await conn.execute(
      'SELECT * FROM rfq_supplier_responses WHERE id = ?',
      [result.insertId]
    )

    const requestId = await fetchRequestIdBySupplierResponseId(conn, result.insertId)
    if (requestId) {
      await updateRequestStatus(conn, requestId)
    }

    await conn.commit()
    res.status(201).json({ ...created, revision })
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-responses error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const status = nz(req.body.status)
    if (!status) {
      return res.status(400).json({ message: 'status обязателен' })
    }

    await db.execute(
      `UPDATE rfq_supplier_responses
          SET status = ?
        WHERE id = ?`,
      [status, id]
    )

    const requestId = await fetchRequestIdBySupplierResponseId(db, id)
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    const [[updated]] = await db.execute(
      'SELECT * FROM rfq_supplier_responses WHERE id = ?',
      [id]
    )
    res.json(updated)
  } catch (e) {
    console.error('PUT /supplier-responses/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id(\\d+)/revisions', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT * FROM rfq_response_revisions WHERE rfq_supplier_response_id = ? ORDER BY rev_number DESC`,
      [id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-responses/:id/revisions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id(\\d+)/revisions', async (req, res) => {
  try {
    const rfq_supplier_response_id = toId(req.params.id)
    if (!rfq_supplier_response_id) {
      return res.status(400).json({ message: 'Некорректный ID' })
    }

    const created_by_user_id = toId(req.user?.id)
    const note = nz(req.body.note)

    const [[{ next_rev }]] = await db.execute(
      `SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev
       FROM rfq_response_revisions
       WHERE rfq_supplier_response_id = ?`,
      [rfq_supplier_response_id]
    )

    const [result] = await db.execute(
      `INSERT INTO rfq_response_revisions (rfq_supplier_response_id, rev_number, note, created_by_user_id)
       VALUES (?,?,?,?)`,
      [rfq_supplier_response_id, next_rev, note, created_by_user_id]
    )

    const [[created]] = await db.execute(
      'SELECT * FROM rfq_response_revisions WHERE id = ?',
      [result.insertId]
    )
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /supplier-responses/:id/revisions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/lines', async (req, res) => {
  try {
    const rfqId = toId(req.query.rfq_id)
    const supplierId = toId(req.query.supplier_id)
    const includeArchived = String(req.query.include_archived || '').trim() === '1'

    if (!rfqId) {
      return res.json([])
    }

    const params = [rfqId]
    const where = ['ri.rfq_id = ?']
    if (supplierId) {
      where.push('rs.supplier_id = ?')
      params.push(supplierId)
    }

    const [rows] = await db.execute(
      `
      SELECT
        rl.*,
        ri.rfq_id,
        ri.line_number AS rfq_line_number,
        rs.supplier_id,
        rs.id AS rfq_supplier_id,
        ps.name AS supplier_name,
        rr.rev_number AS response_rev_number,
        rr.created_at AS response_rev_created_at,
        r.status AS response_status,
        COALESCE(rl.requested_original_part_id, rlsel.original_part_id, cri.original_part_id) AS requested_original_part_id_resolved,
        cri.client_description,
        reqop.cat_number AS requested_original_cat_number,
        reqop.description_ru AS requested_original_description_ru,
        reqop.description_en AS requested_original_description_en,
        sp.supplier_part_number,
        COALESCE(comp.original_part_id, rlsel.original_part_id) AS component_original_part_id,
        cop.cat_number AS component_cat_number,
        cop.description_ru AS component_description_ru,
        cop.description_en AS component_description_en,
        rop.cat_number AS response_original_cat_number,
        rop.description_ru AS response_original_description_ru,
        rop.description_en AS response_original_description_en,
        CASE
          WHEN cri.client_request_revision_id = rfq.client_request_revision_id THEN 0
          ELSE 1
        END AS is_archived,
        rsl.status AS line_status,
        CASE
          WHEN EXISTS (
            SELECT 1
              FROM rfq_supplier_line_selections rls
             WHERE rls.rfq_supplier_id = rs.id
               AND rls.rfq_item_id = rl.rfq_item_id
               AND rls.use_existing_price = 1
               AND (rls.bundle_id <=> rl.bundle_id)
               AND (
                 (rls.alt_original_part_id IS NOT NULL AND rls.alt_original_part_id = rl.original_part_id)
                 OR (rls.alt_original_part_id IS NULL AND (rls.original_part_id <=> rl.original_part_id))
               )
          ) THEN 1 ELSE 0
        END AS accepted_from_existing_price
      FROM rfq_response_lines rl
      JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
      JOIN rfq_supplier_responses r ON r.id = rr.rfq_supplier_response_id
      JOIN rfq_suppliers rs ON rs.id = r.rfq_supplier_id
      JOIN part_suppliers ps ON ps.id = rs.supplier_id
      LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
      LEFT JOIN rfq_items ri ON ri.id = rl.rfq_item_id
      LEFT JOIN rfqs rfq ON rfq.id = ri.rfq_id
      LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
      LEFT JOIN rfq_supplier_line_selections rlsel
        ON rlsel.rfq_supplier_id = rs.id
       AND rlsel.rfq_item_id = rl.rfq_item_id
       AND rlsel.selection_key = rl.selection_key
      LEFT JOIN original_parts reqop
        ON reqop.id = COALESCE(rl.requested_original_part_id, rlsel.original_part_id, cri.original_part_id)
      LEFT JOIN rfq_item_components comp ON comp.id = rl.rfq_item_component_id
      LEFT JOIN original_parts cop ON cop.id = COALESCE(comp.original_part_id, rlsel.original_part_id)
      LEFT JOIN original_parts rop ON rop.id = rl.original_part_id
      LEFT JOIN rfq_supplier_line_status rsl
        ON rsl.rfq_supplier_id = rs.id
       AND rsl.rfq_item_id = rl.rfq_item_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ${includeArchived ? '' : 'AND cri.client_request_revision_id = rfq.client_request_revision_id'}
      ORDER BY rs.supplier_id, ri.line_number, rr.rev_number DESC, rl.id DESC
      `,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-responses/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/line-actions', async (req, res) => {
  try {
    const rfqId = toId(req.query.rfq_id)
    if (!rfqId) return res.json([])
    const supplierId = toId(req.query.supplier_id)
    const lineNumber = toId(req.query.line_number)

    const where = ['ri.rfq_id = ?']
    const params = [rfqId]
    if (supplierId) {
      where.push('rs.supplier_id = ?')
      params.push(supplierId)
    }
    if (lineNumber) {
      where.push('ri.line_number = ?')
      params.push(lineNumber)
    }

    const [rows] = await db.execute(
      `
      SELECT
        a.*,
        rl.rfq_item_id,
        rl.price,
        rl.currency,
        rl.offer_type,
        rl.lead_time_days,
        rl.moq,
        rl.packaging,
        rl.validity_days,
        rl.note,
        rl.entry_source,
        rl.change_reason,
        ri.line_number AS rfq_line_number,
        rs.supplier_id,
        ps.name AS supplier_name,
        rr.rev_number AS response_rev_number
      FROM rfq_response_line_actions a
      JOIN rfq_response_lines rl ON rl.id = a.rfq_response_line_id
      JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
      JOIN rfq_supplier_responses r ON r.id = rr.rfq_supplier_response_id
      JOIN rfq_suppliers rs ON rs.id = r.rfq_supplier_id
      JOIN part_suppliers ps ON ps.id = rs.supplier_id
      JOIN rfq_items ri ON ri.id = rl.rfq_item_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC, a.id DESC
      `,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-responses/line-actions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/revisions/:revisionId/lines', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `
      SELECT rl.*,
             sp.supplier_part_number,
             comp.original_part_id AS component_original_part_id,
             cop.cat_number AS component_cat_number,
             cop.description_ru AS component_description_ru,
             cop.description_en AS component_description_en
        FROM rfq_response_lines rl
        LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
        LEFT JOIN rfq_item_components comp ON comp.id = rl.rfq_item_component_id
        LEFT JOIN original_parts cop ON cop.id = comp.original_part_id
       WHERE rl.rfq_response_revision_id = ?
       ORDER BY rl.id DESC
      `,
      [revisionId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-responses/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/manual-line', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const rfqId = toId(req.body.rfq_id)
    const supplierId = toId(req.body.supplier_id)
    const rfqItemIdRaw = toId(req.body.rfq_item_id)
    const lineNumberRaw = toId(req.body.line_number)
    const rfqItemComponentId = toId(req.body.rfq_item_component_id)
    const createdByUserId = toId(req.user?.id)
    const price = numOrNull(req.body.price)
    const currency = normCurrency(req.body.currency)
    const offerType = normOfferType(req.body.offer_type)
    const leadTimeDays = toId(req.body.lead_time_days)
    const moq = toId(req.body.moq)
    const packaging = nz(req.body.packaging)
    const validityDays = toId(req.body.validity_days)
    const paymentTerms = nz(req.body.payment_terms)
    const note = nz(req.body.note)
    const changeReason = nz(req.body.change_reason) || nz(req.body.reason)
    const createNewRevision = req.body?.new_revision === true

    if (!rfqId || !supplierId || (!rfqItemIdRaw && !lineNumberRaw)) {
      return res
        .status(400)
        .json({ message: 'Нужны rfq_id, supplier_id и rfq_item_id или line_number' })
    }
    if (price === null || !currency) {
      return res.status(400).json({ message: 'Нужны price и currency' })
    }

    await conn.beginTransaction()

    const [[rfqSupplier]] = await conn.execute(
      `
      SELECT id
        FROM rfq_suppliers
       WHERE rfq_id = ? AND supplier_id = ?
       LIMIT 1
      `,
      [rfqId, supplierId]
    )
    if (!rfqSupplier?.id) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не привязан к RFQ' })
    }

    const item = await resolveActiveRfqItem(conn, rfqId, {
      rfqItemId: rfqItemIdRaw,
      lineNumber: lineNumberRaw,
    })
    if (!item?.id) {
      await conn.rollback()
      return res.status(400).json({ message: 'Строка RFQ не найдена в активной ревизии' })
    }

    let originalPartId = toId(req.body.original_part_id) || item.requested_original_part_id || null
    if (rfqItemComponentId) {
      const component = await resolveComponent(conn, rfqItemComponentId)
      if (!component) {
        await conn.rollback()
        return res.status(400).json({ message: 'Компонент RFQ не найден' })
      }
      if (Number(component.rfq_item_id) !== Number(item.id)) {
        await conn.rollback()
        return res
          .status(400)
          .json({ message: 'Компонент не относится к выбранной строке RFQ' })
      }
      originalPartId = component.original_part_id || originalPartId
    }

    const supplierPartSourceId = toId(req.body.supplier_part_id)
    const supplierPartPayload = req.body?.supplier_part || {}
    const supplierPartResult = await resolveOrCreateSupplierPart(conn, {
      supplierId,
      supplierPartId: supplierPartSourceId,
      supplierPartNumber:
        supplierPartPayload.supplier_part_number || req.body.supplier_part_number,
      descriptionRu:
        supplierPartPayload.description_ru || req.body.supplier_part_description_ru,
      descriptionEn:
        supplierPartPayload.description_en || req.body.supplier_part_description_en,
      partType: supplierPartPayload.part_type || req.body.supplier_part_type || offerType,
      originalPartId:
        req.body.link_supplier_part_to_original === false
          ? null
          : originalPartId || item.requested_original_part_id || null,
    })
    const supplierPartId = supplierPartResult.supplierPartId || null

    const revisionPayload = createNewRevision
      ? await createSupplierResponseRevision(conn, rfqSupplier.id, {
          status: 'review',
          note,
          userId: createdByUserId,
        })
      : await ensureSupplierResponseRevision(conn, rfqSupplier.id, {
          status: 'review',
          note,
          userId: createdByUserId,
        })

    const line = await insertResponseLine(conn, {
      revisionId: revisionPayload.revisionId,
      rfqItemId: item.id,
      selectionKey: nz(req.body.selection_key),
      supplierPartId,
      originalPartId,
      requestedOriginalPartId: item.requested_original_part_id || null,
      bundleId: toId(req.body.bundle_id),
      offerType,
      offeredQty: numOrNull(req.body.offered_qty),
      moq,
      packaging,
      leadTimeDays,
      price,
      currency,
      validityDays,
      paymentTerms,
      note,
      rfqItemComponentId,
      basedOnResponseLineId: null,
      entrySource: 'SUPPLIER_MANUAL',
      changeReason,
    })

    await appendSupplierPartPrice(conn, {
      supplierPartId,
      responseLineId: line.id,
      price,
      currency,
      offerType,
      leadTimeDays,
      moq,
      packaging,
      validityDays,
      note,
      createdByUserId,
    })

    await writeLineAction(conn, {
      responseLineId: line.id,
      actionType: 'CREATE',
      reason: changeReason,
      payload: {
        source: 'SUPPLIER_MANUAL',
        line_number: item.line_number,
        price,
        currency,
        offer_type: offerType,
        lead_time_days: leadTimeDays,
        moq,
        packaging,
        validity_days: validityDays,
        supplier_part_id: supplierPartId,
      },
      createdByUserId,
    })

    if (supplierPartResult.created) {
      await writeLineAction(conn, {
        responseLineId: line.id,
        actionType: 'LINK_SUPPLIER_PART',
        reason: 'Создана и привязана новая деталь поставщика',
        payload: {
          supplier_part_id: supplierPartId,
          supplier_part_number:
            supplierPartPayload.supplier_part_number || req.body.supplier_part_number,
          original_part_id: originalPartId || item.requested_original_part_id || null,
        },
        createdByUserId,
      })
    }

    await upsertLineStatus(conn, {
      rfqSupplierId: rfqSupplier.id,
      rfqItemId: item.id,
      status: 'NONE',
      sourceType: 'RFQ_RESPONSE',
      sourceRef: String(line.id),
      lastResponseRevisionId: revisionPayload.revisionId,
      note,
    })

    await conn.execute(
      `UPDATE rfq_supplier_responses
          SET status = 'review'
        WHERE id = ?`,
      [revisionPayload.responseId]
    )

    await markSupplierAsResponded(conn, rfqSupplier.id)

    const requestId = await fetchRequestIdBySupplierResponseId(
      conn,
      revisionPayload.responseId
    )
    if (requestId) {
      await updateRequestStatus(conn, requestId)
    }

    await conn.commit()
    res.status(201).json({
      ...line,
      rfq_line_number: item.line_number,
      supplier_part_created: supplierPartResult.created,
    })
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-responses/manual-line error:', e)
    res.status(500).json({ message: 'Ошибка сохранения ручного ответа' })
  } finally {
    conn.release()
  }
})

router.post('/lines/:id(\\d+)/revise', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const baseLineId = toId(req.params.id)
    const createdByUserId = toId(req.user?.id)
    const reason = nz(req.body.reason) || nz(req.body.change_reason)
    const createNewRevision = req.body?.new_revision !== false

    if (!baseLineId) return res.status(400).json({ message: 'Некорректный ID строки' })
    if (!reason) {
      return res
        .status(400)
        .json({ message: 'Для переговорной правки укажите причину изменения' })
    }

    await conn.beginTransaction()

    const [[baseLine]] = await conn.execute(
      `
      SELECT
        rl.*,
        rr.rfq_supplier_response_id,
        rs.id AS rfq_supplier_id
      FROM rfq_response_lines rl
      JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
      JOIN rfq_supplier_responses r ON r.id = rr.rfq_supplier_response_id
      JOIN rfq_suppliers rs ON rs.id = r.rfq_supplier_id
      WHERE rl.id = ?
      `,
      [baseLineId]
    )
    if (!baseLine) {
      await conn.rollback()
      return res.status(404).json({ message: 'Базовая строка ответа не найдена' })
    }

    const revisionPayload = createNewRevision
      ? await createSupplierResponseRevision(conn, baseLine.rfq_supplier_id, {
          status: 'review',
          note: nz(req.body.note) || reason,
          userId: createdByUserId,
        })
      : await ensureSupplierResponseRevision(conn, baseLine.rfq_supplier_id, {
          status: 'review',
          note: nz(req.body.note) || reason,
          userId: createdByUserId,
        })

    const next = {
      selectionKey: hasOwn(req.body, 'selection_key')
        ? nz(req.body.selection_key)
        : baseLine.selection_key,
      supplierPartId: hasOwn(req.body, 'supplier_part_id')
        ? toId(req.body.supplier_part_id)
        : baseLine.supplier_part_id,
      originalPartId: hasOwn(req.body, 'original_part_id')
        ? toId(req.body.original_part_id)
        : baseLine.original_part_id,
      requestedOriginalPartId: hasOwn(req.body, 'requested_original_part_id')
        ? toId(req.body.requested_original_part_id)
        : baseLine.requested_original_part_id,
      bundleId: hasOwn(req.body, 'bundle_id') ? toId(req.body.bundle_id) : baseLine.bundle_id,
      offerType: hasOwn(req.body, 'offer_type')
        ? normOfferType(req.body.offer_type)
        : baseLine.offer_type,
      offeredQty: hasOwn(req.body, 'offered_qty')
        ? numOrNull(req.body.offered_qty)
        : baseLine.offered_qty,
      moq: hasOwn(req.body, 'moq') ? toId(req.body.moq) : baseLine.moq,
      packaging: hasOwn(req.body, 'packaging') ? nz(req.body.packaging) : baseLine.packaging,
      leadTimeDays: hasOwn(req.body, 'lead_time_days')
        ? toId(req.body.lead_time_days)
        : baseLine.lead_time_days,
      price: hasOwn(req.body, 'price') ? numOrNull(req.body.price) : baseLine.price,
      currency: hasOwn(req.body, 'currency')
        ? normCurrency(req.body.currency)
        : baseLine.currency,
      validityDays: hasOwn(req.body, 'validity_days')
        ? toId(req.body.validity_days)
        : baseLine.validity_days,
      paymentTerms: hasOwn(req.body, 'payment_terms')
        ? nz(req.body.payment_terms)
        : baseLine.payment_terms,
      note: hasOwn(req.body, 'note') ? nz(req.body.note) : baseLine.note,
      rfqItemComponentId: hasOwn(req.body, 'rfq_item_component_id')
        ? toId(req.body.rfq_item_component_id)
        : baseLine.rfq_item_component_id,
    }

    if (next.price === null || !next.currency) {
      await conn.rollback()
      return res.status(400).json({ message: 'После правки должны остаться price и currency' })
    }

    const created = await insertResponseLine(conn, {
      revisionId: revisionPayload.revisionId,
      rfqItemId: baseLine.rfq_item_id,
      selectionKey: next.selectionKey,
      supplierPartId: next.supplierPartId,
      originalPartId: next.originalPartId,
      requestedOriginalPartId: next.requestedOriginalPartId,
      bundleId: next.bundleId,
      offerType: next.offerType,
      offeredQty: next.offeredQty,
      moq: next.moq,
      packaging: next.packaging,
      leadTimeDays: next.leadTimeDays,
      price: next.price,
      currency: next.currency,
      validityDays: next.validityDays,
      paymentTerms: next.paymentTerms,
      note: next.note,
      rfqItemComponentId: next.rfqItemComponentId,
      basedOnResponseLineId: baseLine.id,
      entrySource: 'NEGOTIATION',
      changeReason: reason,
    })

    await appendSupplierPartPrice(conn, {
      supplierPartId: next.supplierPartId,
      responseLineId: created.id,
      price: next.price,
      currency: next.currency,
      offerType: next.offerType,
      leadTimeDays: next.leadTimeDays,
      moq: next.moq,
      packaging: next.packaging,
      validityDays: next.validityDays,
      note: next.note || reason,
      createdByUserId,
    })

    await writeLineAction(conn, {
      responseLineId: created.id,
      actionType: 'NEGOTIATION',
      reason,
      payload: {
        based_on_response_line_id: baseLine.id,
        previous_price: baseLine.price,
        previous_currency: baseLine.currency,
        next_price: next.price,
        next_currency: next.currency,
        next_lead_time_days: next.leadTimeDays,
        next_moq: next.moq,
      },
      createdByUserId,
    })

    await upsertLineStatus(conn, {
      rfqSupplierId: baseLine.rfq_supplier_id,
      rfqItemId: baseLine.rfq_item_id,
      status: 'NONE',
      sourceType: 'RFQ_RESPONSE',
      sourceRef: String(created.id),
      lastResponseRevisionId: revisionPayload.revisionId,
      note: reason,
    })

    await conn.execute(
      `UPDATE rfq_supplier_responses
          SET status = 'review'
        WHERE id = ?`,
      [revisionPayload.responseId]
    )

    await conn.commit()
    res.status(201).json(created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-responses/lines/:id/revise error:', e)
    res.status(500).json({ message: 'Ошибка переговорной правки ответа' })
  } finally {
    conn.release()
  }
})

router.post('/revisions/:revisionId/lines', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const offerType = normOfferType(req.body.offer_type)
    const supplierPartId = toId(req.body.supplier_part_id)
    const rfqItemId = toId(req.body.rfq_item_id)
    const rfqItemComponentId = toId(req.body.rfq_item_component_id)
    const price = numOrNull(req.body.price)
    const currency = normCurrency(req.body.currency)
    const leadTime = toId(req.body.lead_time_days)
    const moq = toId(req.body.moq)
    const packaging = nz(req.body.packaging)
    const validityDays = toId(req.body.validity_days)
    const paymentTerms = nz(req.body.payment_terms)
    const note = nz(req.body.note)
    const createdByUserId = toId(req.user?.id)
    const changeReason = nz(req.body.change_reason) || nz(req.body.reason)

    if (!rfqItemId) return res.status(400).json({ message: 'rfq_item_id обязателен' })

    await conn.beginTransaction()

    let originalPartId = toId(req.body.original_part_id)
    const bundleId = toId(req.body.bundle_id)
    let requestedOriginalPartId = toId(req.body.requested_original_part_id)

    if (rfqItemComponentId) {
      const component = await resolveComponent(conn, rfqItemComponentId)
      if (!component) {
        await conn.rollback()
        return res.status(400).json({ message: 'Компонент RFQ не найден' })
      }
      if (component.rfq_item_id && component.rfq_item_id !== rfqItemId) {
        await conn.rollback()
        return res.status(400).json({ message: 'Компонент не относится к выбранной строке RFQ' })
      }
      originalPartId = component.original_part_id || originalPartId
    }
    if (!originalPartId || !requestedOriginalPartId) {
      const [[source]] = await conn.execute(
        `
        SELECT cri.original_part_id
          FROM rfq_items ri
          JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         WHERE ri.id = ?
        `,
        [rfqItemId]
      )
      if (!requestedOriginalPartId) {
        requestedOriginalPartId = source?.original_part_id || null
      }
      if (!originalPartId) {
        originalPartId = source?.original_part_id || null
      }
    }

    const created = await insertResponseLine(conn, {
      revisionId,
      rfqItemId,
      selectionKey: nz(req.body.selection_key),
      supplierPartId,
      originalPartId,
      requestedOriginalPartId,
      bundleId,
      offerType,
      offeredQty: numOrNull(req.body.offered_qty),
      moq,
      packaging,
      leadTimeDays: leadTime,
      price,
      currency,
      validityDays,
      paymentTerms,
      note,
      rfqItemComponentId,
      basedOnResponseLineId: toId(req.body.based_on_response_line_id),
      entrySource: nz(req.body.entry_source) || 'SUPPLIER_MANUAL',
      changeReason,
    })

    await appendSupplierPartPrice(conn, {
      supplierPartId,
      responseLineId: created.id,
      price,
      currency,
      offerType,
      leadTimeDays: leadTime,
      moq,
      packaging,
      validityDays,
      note,
      createdByUserId,
    })

    await writeLineAction(conn, {
      responseLineId: created.id,
      actionType: 'CREATE',
      reason: changeReason,
      payload: await fetchResponseLinePayload(conn, created.id),
      createdByUserId,
    })

    await conn.execute(
      `UPDATE rfq_supplier_responses r
      JOIN rfq_response_revisions rr ON rr.rfq_supplier_response_id = r.id
      SET r.status = CASE WHEN r.status = 'received' THEN 'review' ELSE r.status END
      WHERE rr.id = ?`,
      [revisionId]
    )

    await conn.commit()
    res.status(201).json(created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-responses/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
