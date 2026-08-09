const db = require('../../utils/db')
const { evaluateItemReadiness } = require('./readinessPolicy')
const { ClientRequestDomainError } = require('./domainError')

const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

async function getRevisionItems(revisionIdInput, executor = db) {
  const revisionId = toId(revisionIdInput)
  if (!revisionId) throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректная ревизия')
  const [rows] = await executor.execute(
    `SELECT i.*,
            ident.id AS identification_id,
            ident.catalog_position_id AS identification_catalog_position_id,
            ident.identification_status,
            ident.match_method,
            ident.confidence,
            ident.basis_note,
            ident.confirmed_by_user_id,
            ident.confirmed_at,
            reqs.id AS requirements_id,
            reqs.substitution_policy,
            reqs.required_manufacturer_id,
            reqs.required_brand_text,
            reqs.manufacture_to_drawing_allowed,
            reqs.kit_allowed,
            reqs.partial_supply_allowed,
            reqs.required_documents_json,
            reqs.technical_requirements,
            reqs.procurement_note,
            cp.position_code AS catalog_position_code,
            cp.manufacturer_part_number AS catalog_position_part_number,
            COALESCE(cp.display_name_ru, cp.display_name, cp.display_name_en) AS catalog_position_name,
            (SELECT COUNT(*)
               FROM procurement_release_items pri
               JOIN procurement_releases pr ON pr.id = pri.procurement_release_id
              WHERE pri.client_request_revision_item_id = i.id AND pr.status = 'released') AS already_released_count
       FROM client_request_revision_items i
       LEFT JOIN client_request_item_identifications ident
         ON ident.client_request_revision_item_id = i.id
       LEFT JOIN client_request_item_requirements reqs
         ON reqs.client_request_revision_item_id = i.id
       LEFT JOIN catalog_positions cp
         ON cp.id = ident.catalog_position_id
      WHERE i.client_request_revision_id = ?
      ORDER BY i.line_number, i.id`,
    [revisionId]
  )
  return rows.map((row) => ({ ...row, readiness: evaluateItemReadiness(row) }))
}

async function getRevisionReadiness(revisionIdInput, executor = db) {
  const revisionId = toId(revisionIdInput)
  const [[revision]] = await executor.execute(
    `SELECT r.*, cr.internal_number, cr.client_id
       FROM client_request_revisions r
       JOIN client_requests cr ON cr.id = r.client_request_id
      WHERE r.id = ?`,
    [revisionId]
  )
  if (!revision) throw new ClientRequestDomainError('REVISION_NOT_FOUND', 'Ревизия не найдена', 404)
  const items = await getRevisionItems(revisionId, executor)
  const readyCount = items.filter((item) => item.readiness.ready).length
  const alreadyReleasedCount = items.filter((item) => Number(item.already_released_count) > 0).length
  return {
    revision,
    items,
    summary: {
      total_active: items.filter((item) => String(item.item_status || 'active') === 'active').length,
      ready_count: readyCount,
      blocked_count: items.length - readyCount,
      already_released_count: alreadyReleasedCount,
      available_for_release_count: readyCount,
      revision_finalized: revision.status === 'finalized',
    },
  }
}

async function getDownstreamProjection(requestId, executor = db) {
  const [sourcingCases] = await executor.execute(
    `SELECT DISTINCT sc.id, sc.case_number, sc.title, sc.status, sc.owner_user_id,
            sc.response_deadline, sc.updated_at
       FROM sourcing_cases sc
       JOIN sourcing_demands sd ON sd.sourcing_case_id = sc.id
      WHERE sd.client_request_id = ?
      ORDER BY sc.updated_at DESC`,
    [requestId]
  )
  const [rfqs] = await executor.execute(
    `SELECT id, rfq_number, status, rfq_sync_status, procurement_release_id, assigned_to_user_id, sent_at
       FROM rfqs WHERE client_request_id = ? ORDER BY id DESC`,
    [requestId]
  )
  const [[counts]] = await executor.execute(
    `SELECT
       (SELECT COUNT(*) FROM selections s JOIN rfqs r ON r.id = s.rfq_id WHERE r.client_request_id = ?) AS selection_count,
       (SELECT COUNT(*) FROM sales_quotes sq JOIN client_request_revisions rr ON rr.id = sq.client_request_revision_id WHERE rr.client_request_id = ?) AS offer_count,
       (SELECT COUNT(*) FROM client_contracts cc JOIN sales_quotes sq ON sq.id = cc.sales_quote_id JOIN client_request_revisions rr ON rr.id = sq.client_request_revision_id WHERE rr.client_request_id = ?) AS contract_count`,
    [requestId, requestId, requestId]
  )
  return {
    authoritative: false,
    read_only: true,
    owner: 'downstream_domains',
    sourcing_cases: sourcingCases,
    rfqs,
    counts: {
      sourcing: sourcingCases.length,
      selections: Number(counts.selection_count || 0),
      offers: Number(counts.offer_count || 0),
      contracts: Number(counts.contract_count || 0),
    },
  }
}

async function listReleases(requestId, executor = db) {
  const [rows] = await executor.execute(
    `SELECT pr.*,
            r.rev_number,
            COUNT(pri.id) AS item_count,
            SUM(pri.requested_quantity_snapshot) AS total_quantity
       FROM procurement_releases pr
       JOIN client_request_revisions r ON r.id = pr.client_request_revision_id
       LEFT JOIN procurement_release_items pri ON pri.procurement_release_id = pr.id
      WHERE pr.client_request_id = ?
      GROUP BY pr.id, r.rev_number
      ORDER BY pr.release_number DESC`,
    [requestId]
  )
  return rows
}

async function getWorkspace(requestIdInput) {
  const requestId = toId(requestIdInput)
  const [[request]] = await db.execute(
    `SELECT cr.*, c.company_name AS client_name,
            cc.name AS client_contact_name,
            ceu.internal_name AS client_installation_name,
            ceu.site_name AS client_installation_site_name
       FROM client_requests cr
       JOIN clients c ON c.id = cr.client_id
       LEFT JOIN client_contacts cc ON cc.id = cr.client_contact_id
       LEFT JOIN client_equipment_units ceu ON ceu.id = cr.client_installation_id
      WHERE cr.id = ?`,
    [requestId]
  )
  if (!request) throw new ClientRequestDomainError('REQUEST_NOT_FOUND', 'Заявка не найдена', 404)
  const [revisions] = await db.execute(
    `SELECT r.*, COUNT(i.id) AS items_count
       FROM client_request_revisions r
       LEFT JOIN client_request_revision_items i ON i.client_request_revision_id = r.id
      WHERE r.client_request_id = ?
      GROUP BY r.id ORDER BY r.rev_number DESC`,
    [requestId]
  )
  const revisionId = toId(request.current_revision_id) || toId(revisions[0]?.id)
  const readiness = revisionId ? await getRevisionReadiness(revisionId) : null
  const releases = await listReleases(requestId)
  const downstream = await getDownstreamProjection(requestId)
  return {
    request,
    revisions,
    current_revision_id: revisionId,
    items: readiness?.items || [],
    readiness: readiness?.summary || null,
    procurement_releases: releases,
    downstream,
  }
}

module.exports = {
  getDownstreamProjection,
  getRevisionItems,
  getRevisionReadiness,
  getWorkspace,
  listReleases,
}
