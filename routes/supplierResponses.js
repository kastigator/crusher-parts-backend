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

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

    const [[row]] = await db.execute('SELECT * FROM rfq_supplier_responses WHERE id = ?', [id])
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

    await conn.execute(
      `UPDATE rfq_suppliers
          SET status = 'responded',
              responded_at = COALESCE(responded_at, NOW())
        WHERE id = ?`,
      [rfq_supplier_id]
    )

    const [[created]] = await conn.execute(
      'SELECT * FROM rfq_supplier_responses WHERE id = ?',
      [result.insertId]
    )

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

router.put('/:id', async (req, res) => {
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

router.get('/:id/revisions', async (req, res) => {
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

router.post('/:id/revisions', async (req, res) => {
  try {
    const rfq_supplier_response_id = toId(req.params.id)
    if (!rfq_supplier_response_id) return res.status(400).json({ message: 'Некорректный ID' })

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

    const [[created]] = await db.execute('SELECT * FROM rfq_response_revisions WHERE id = ?', [result.insertId])
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

    const params = []
    const where = []
    if (rfqId) {
      where.push('ri.rfq_id = ?')
      params.push(rfqId)
    }
    if (supplierId) {
      where.push('rs.supplier_id = ?')
      params.push(supplierId)
    }

    const [rows] = await db.execute(
      `
      SELECT rl.*,
             ri.rfq_id,
             rs.supplier_id,
             ps.name AS supplier_name,
             cri.client_description,
             op.cat_number AS original_cat_number,
             sp.supplier_part_number
        FROM rfq_response_lines rl
        JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
        JOIN rfq_supplier_responses r ON r.id = rr.rfq_supplier_response_id
        JOIN rfq_suppliers rs ON rs.id = r.rfq_supplier_id
        JOIN part_suppliers ps ON ps.id = rs.supplier_id
        LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
        LEFT JOIN rfq_items ri ON ri.id = rl.rfq_item_id
        LEFT JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
        LEFT JOIN original_parts op ON op.id = cri.original_part_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY rl.id DESC
      `,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-responses/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/revisions/:revisionId/lines', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT rl.*,
              sp.supplier_part_number
         FROM rfq_response_lines rl
         LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
        WHERE rl.rfq_response_revision_id = ?
        ORDER BY rl.id DESC`,
      [revisionId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-responses/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/revisions/:revisionId/lines', async (req, res) => {
  try {
    const revisionId = toId(req.params.revisionId)
    if (!revisionId) return res.status(400).json({ message: 'Некорректный ID' })

    const offerType = normOfferType(req.body.offer_type)
    const supplierPartId = toId(req.body.supplier_part_id)
    const rfqItemId = toId(req.body.rfq_item_id)
    const price = numOrNull(req.body.price)
    const currency = normCurrency(req.body.currency)
    const leadTime = toId(req.body.lead_time_days)
    const moq = toId(req.body.moq)
    const packaging = nz(req.body.packaging)
    const validityDays = toId(req.body.validity_days)
    const note = nz(req.body.note)
    const created_by_user_id = toId(req.user?.id)

    let originalPartId = toId(req.body.original_part_id)
    const bundleId = toId(req.body.bundle_id)
    if (!originalPartId && rfqItemId) {
      const [[source]] = await db.execute(
        `SELECT cri.original_part_id
           FROM rfq_items ri
           JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
          WHERE ri.id = ?`,
        [rfqItemId]
      )
      originalPartId = source?.original_part_id || null
    }

    const [result] = await db.execute(
      `INSERT INTO rfq_response_lines
        (rfq_response_revision_id, rfq_item_id, supplier_part_id, original_part_id, bundle_id,
         offer_type, offered_qty, moq, packaging, lead_time_days, price, currency, validity_days, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        revisionId,
        rfqItemId,
        supplierPartId,
        originalPartId,
        bundleId,
        offerType,
        numOrNull(req.body.offered_qty),
        moq,
        packaging,
        leadTime,
        price,
        currency,
        validityDays,
        note,
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM rfq_response_lines WHERE id = ?', [result.insertId])

    if (supplierPartId && price !== null && currency) {
      await db.execute(
        `INSERT INTO supplier_part_prices
           (supplier_part_id, material_id, price, currency, date, comment,
            offer_type, lead_time_days, min_order_qty, packaging, validity_days,
            source_type, source_id, created_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          supplierPartId,
          null,
          price,
          currency,
          new Date(),
          note,
          offerType,
          leadTime,
          moq,
          packaging,
          validityDays,
          'RFQ',
          result.insertId,
          created_by_user_id,
        ]
      )
    }

    // Если это первая проверка ответа — переводим статус в "review"
    await db.execute(
      `UPDATE rfq_supplier_responses r
        JOIN rfq_response_revisions rr ON rr.rfq_supplier_response_id = r.id
         SET r.status = CASE WHEN r.status = 'received' THEN 'review' ELSE r.status END
       WHERE rr.id = ?`,
      [revisionId]
    )

    res.status(201).json(created)
  } catch (e) {
    console.error('POST /supplier-responses/revisions/:revisionId/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
