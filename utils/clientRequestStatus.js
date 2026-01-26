const resolveCurrentRevisionId = async (conn, requestId) => {
  const [[row]] = await conn.execute(
    `SELECT id FROM client_request_revisions
     WHERE client_request_id = ?
     ORDER BY rev_number DESC, id DESC
     LIMIT 1`,
    [requestId]
  )
  return row?.id || null
}

const updateRequestStatus = async (conn, requestId, opts = {}) => {
  const [[request]] = await conn.execute(
    `SELECT id, status, current_revision_id FROM client_requests WHERE id = ?`,
    [requestId]
  )
  if (!request) return null
  if (request.status === 'cancelled') return request.status

  let currentRevisionId = request.current_revision_id
  if (!currentRevisionId) {
    currentRevisionId = await resolveCurrentRevisionId(conn, requestId)
    if (currentRevisionId) {
      await conn.execute(
        `UPDATE client_requests SET current_revision_id = ? WHERE id = ?`,
        [currentRevisionId, requestId]
      )
    }
  }

  let status = 'draft'
  if (currentRevisionId) {
    const [[{ item_count }]] = await conn.execute(
      `SELECT COUNT(*) AS item_count
       FROM client_request_revision_items
       WHERE client_request_revision_id = ?`,
      [currentRevisionId]
    )
    if (item_count > 0) status = 'in_progress'

    const [[{ rfq_count, rfq_sent_count }]] = await conn.execute(
      `SELECT COUNT(*) AS rfq_count,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS rfq_sent_count
       FROM rfqs
       WHERE client_request_revision_id = ?`,
      [currentRevisionId]
    )
    if (rfq_count > 0) status = 'rfq_created'
    if (rfq_sent_count > 0) status = 'rfq_sent'

    const [[{ response_count }]] = await conn.execute(
      `SELECT COUNT(*) AS response_count
       FROM rfq_supplier_responses rsr
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       JOIN rfqs r ON r.id = rs.rfq_id
       WHERE r.client_request_revision_id = ?`,
      [currentRevisionId]
    )
    if (response_count > 0) status = 'responses_received'

    const [[{ selection_count }]] = await conn.execute(
      `SELECT COUNT(*) AS selection_count
       FROM selections s
       JOIN rfqs r ON r.id = s.rfq_id
       WHERE r.client_request_revision_id = ?`,
      [currentRevisionId]
    )
    if (selection_count > 0) status = 'selection_done'

    const [[{ quote_count }]] = await conn.execute(
      `SELECT COUNT(*) AS quote_count
       FROM sales_quotes
       WHERE client_request_revision_id = ?`,
      [currentRevisionId]
    )
    if (quote_count > 0) status = 'quote_prepared'

    const [[{ contract_count }]] = await conn.execute(
      `SELECT COUNT(*) AS contract_count
       FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
       WHERE sq.client_request_revision_id = ?`,
      [currentRevisionId]
    )
    if (contract_count > 0) status = 'contracted'
  }

  if (!opts.skipPersist && status !== request.status) {
    await conn.execute(
      `UPDATE client_requests SET status = ?, status_updated_at = NOW() WHERE id = ?`,
      [status, requestId]
    )
  }

  return status
}

const fetchRequestIdByRevisionId = async (conn, revisionId) => {
  const [[row]] = await conn.execute(
    `SELECT client_request_id FROM client_request_revisions WHERE id = ?`,
    [revisionId]
  )
  return row?.client_request_id || null
}

const fetchRequestIdByRfqId = async (conn, rfqId) => {
  const [[row]] = await conn.execute(
    `SELECT cr.client_request_id
     FROM rfqs r
     JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
     WHERE r.id = ?`,
    [rfqId]
  )
  return row?.client_request_id || null
}

const fetchRequestIdBySupplierResponseId = async (conn, responseId) => {
  const [[row]] = await conn.execute(
    `SELECT cr.client_request_id
     FROM rfq_supplier_responses rsr
     JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
     JOIN rfqs r ON r.id = rs.rfq_id
     JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
     WHERE rsr.id = ?`,
    [responseId]
  )
  return row?.client_request_id || null
}

const fetchRequestIdBySelectionId = async (conn, selectionId) => {
  const [[row]] = await conn.execute(
    `SELECT cr.client_request_id
     FROM selections s
     JOIN rfqs r ON r.id = s.rfq_id
     JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
     WHERE s.id = ?`,
    [selectionId]
  )
  return row?.client_request_id || null
}

const fetchRequestIdBySalesQuoteId = async (conn, salesQuoteId) => {
  const [[row]] = await conn.execute(
    `SELECT cr.client_request_id
     FROM sales_quotes sq
     JOIN client_request_revisions cr ON cr.id = sq.client_request_revision_id
     WHERE sq.id = ?`,
    [salesQuoteId]
  )
  return row?.client_request_id || null
}

module.exports = {
  resolveCurrentRevisionId,
  updateRequestStatus,
  fetchRequestIdByRevisionId,
  fetchRequestIdByRfqId,
  fetchRequestIdBySupplierResponseId,
  fetchRequestIdBySelectionId,
  fetchRequestIdBySalesQuoteId,
}
