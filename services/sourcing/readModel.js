const db = require('../../utils/db')
const { SourcingDomainError } = require('./domainError')
const { toId } = require('./helpers')

const NEXT_ACTION = {
  new: 'accept_case',
  in_progress: 'prepare_inquiries',
  waiting_responses: 'register_supplier_offer',
  offer_review: 'build_coverage',
  decision_pending: 'resolve_coverage_blockers',
  decision_ready: 'finalize_decision',
  decided: 'handoff_to_pricing',
  blocked: 'resolve_case_blocker',
  on_hold: 'resume_case',
}

const parseJson = (value) => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

async function listCases(filters = {}) {
  const params = []
  const where = []
  if (filters.status) { where.push('sc.status = ?'); params.push(String(filters.status)) }
  const ownerId = toId(filters.owner_user_id)
  if (ownerId) { where.push('sc.owner_user_id = ?'); params.push(ownerId) }
  const [rows] = await db.execute(
    `SELECT sc.*, u.full_name AS owner_name,
            COUNT(DISTINCT sd.id) AS demand_count,
            COUNT(DISTINCT si.id) AS inquiry_count,
            COUNT(DISTINCT so.id) AS offer_count,
            COUNT(DISTINCT sco.id) AS coverage_option_count,
            MAX(se.created_at) AS last_activity_at
       FROM sourcing_cases sc
       LEFT JOIN users u ON u.id = sc.owner_user_id
       LEFT JOIN sourcing_demands sd ON sd.sourcing_case_id = sc.id
       LEFT JOIN supplier_inquiries si ON si.sourcing_case_id = sc.id
       LEFT JOIN supplier_offers so ON so.sourcing_case_id = sc.id
       LEFT JOIN sourcing_coverage_options sco ON sco.sourcing_case_id = sc.id
       LEFT JOIN sourcing_case_events se ON se.sourcing_case_id = sc.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY sc.id, u.full_name
      ORDER BY FIELD(sc.priority, 'urgent', 'high', 'normal', 'low'),
               sc.response_deadline IS NULL, sc.response_deadline, sc.updated_at DESC`,
    params
  )
  return rows.map((row) => ({ ...row, next_action: NEXT_ACTION[row.status] || null }))
}

async function listReleaseIntake() {
  const [rows] = await db.execute(
    `SELECT pr.id AS release_id, pr.release_number, pr.title, pr.released_at,
            cr.internal_number AS request_number, c.company_name AS client_name,
            pri.id AS release_item_id, pri.line_number_snapshot, pri.requested_quantity_snapshot,
            pri.uom_snapshot, pri.source_data_snapshot_json,
            cp.manufacturer_part_number AS catalog_part_number,
            COALESCE(cp.display_name_ru, cp.display_name, cp.display_name_en) AS catalog_position_name,
            GREATEST(pri.requested_quantity_snapshot - COALESCE(SUM(CASE WHEN sc.status IN
              ('new','in_progress','waiting_responses','offer_review','decision_pending','decision_ready','decided','released_to_pricing','blocked','on_hold')
              THEN sd.admitted_quantity ELSE 0 END), 0), 0) AS available_quantity
       FROM procurement_releases pr
       JOIN procurement_release_items pri ON pri.procurement_release_id=pr.id
       JOIN client_requests cr ON cr.id=pr.client_request_id
       JOIN clients c ON c.id=cr.client_id
       LEFT JOIN catalog_positions cp ON cp.id=pri.catalog_position_id_snapshot
       LEFT JOIN sourcing_demands sd ON sd.procurement_release_item_id=pri.id
       LEFT JOIN sourcing_cases sc ON sc.id=sd.sourcing_case_id
      WHERE pr.status='released'
      GROUP BY pr.id, pri.id
     HAVING available_quantity > 0
      ORDER BY pr.released_at DESC, pri.line_number_snapshot`
  )
  const releases = new Map()
  for (const row of rows) {
    const source = parseJson(row.source_data_snapshot_json)
    if (!releases.has(row.release_id)) releases.set(row.release_id, {
      id: row.release_id, release_number: row.release_number, title: row.title,
      released_at: row.released_at, request_number: row.request_number,
      client_name: row.client_name, items: [],
    })
    releases.get(row.release_id).items.push({
      id: row.release_item_id, line_number: row.line_number_snapshot,
      quantity: Number(row.available_quantity), uom: row.uom_snapshot,
      part_number: row.catalog_part_number || source.client_part_number,
      description: row.catalog_position_name || source.client_description,
    })
  }
  return [...releases.values()]
}

async function listSuppliers() {
  const [rows] = await db.execute(
    `SELECT id, name, public_code, country, preferred_currency
       FROM part_suppliers ORDER BY name, id`
  )
  return rows
}

async function getWorkspace(caseIdInput) {
  const caseId = toId(caseIdInput)
  const [[sourcingCase]] = await db.execute(
    `SELECT sc.*, u.full_name AS owner_name, r.rfq_number AS legacy_rfq_number,
            r.status AS legacy_rfq_status
       FROM sourcing_cases sc
       LEFT JOIN users u ON u.id = sc.owner_user_id
       LEFT JOIN rfqs r ON r.id = sc.legacy_rfq_id
      WHERE sc.id = ?`,
    [caseId]
  )
  if (!sourcingCase) throw new SourcingDomainError('CASE_NOT_FOUND', 'Sourcing Case не найден', 404)
  const [releaseLinks, demands, inquiries, inquiryRevisions, dispatches, offers, offerRevisions, offerLines,
    offerLineDemands, options, optionLines, decisions, decisionLines, events, promotionRequests] = await Promise.all([
    db.execute(`SELECT l.*, pr.release_key, pr.release_number, pr.client_request_id, pr.client_request_revision_id, pr.status AS release_status FROM sourcing_case_release_links l JOIN procurement_releases pr ON pr.id = l.procurement_release_id WHERE l.sourcing_case_id = ? ORDER BY l.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT sd.*, cp.position_code AS catalog_position_code, cp.manufacturer_part_number AS catalog_part_number, COALESCE(cp.display_name_ru, cp.display_name, cp.display_name_en) AS catalog_position_name FROM sourcing_demands sd LEFT JOIN catalog_positions cp ON cp.id = sd.catalog_position_id_snapshot WHERE sd.sourcing_case_id = ? ORDER BY sd.line_number_snapshot, sd.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT si.*, ps.name AS supplier_master_name, ps.public_code AS supplier_public_code FROM supplier_inquiries si LEFT JOIN part_suppliers ps ON ps.id = si.supplier_id WHERE si.sourcing_case_id = ? ORDER BY si.id`, [caseId]).then(([rows]) => rows.map((row) => {
      const identity = parseJson(row.supplier_identity_snapshot_json)
      return { ...row, supplier_identity_snapshot_json: identity, supplier_name: row.supplier_master_name || identity.supplier_name || `Legacy supplier #${identity.legacy_supplier_id || 'unknown'}` }
    })),
    db.execute(`SELECT sir.* FROM supplier_inquiry_revisions sir JOIN supplier_inquiries si ON si.id = sir.supplier_inquiry_id WHERE si.sourcing_case_id = ? ORDER BY sir.supplier_inquiry_id, sir.revision_number`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT d.* FROM supplier_inquiry_dispatches d JOIN supplier_inquiries si ON si.id = d.supplier_inquiry_id WHERE si.sourcing_case_id = ? ORDER BY d.dispatched_at`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT so.*, ps.name AS supplier_name, ps.public_code AS supplier_public_code FROM supplier_offers so JOIN part_suppliers ps ON ps.id = so.supplier_id WHERE so.sourcing_case_id = ? ORDER BY so.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT sor.* FROM supplier_offer_revisions sor JOIN supplier_offers so ON so.id = sor.supplier_offer_id WHERE so.sourcing_case_id = ? ORDER BY sor.supplier_offer_id, sor.revision_number`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT sol.*, sor.supplier_offer_id FROM supplier_offer_lines sol JOIN supplier_offer_revisions sor ON sor.id = sol.supplier_offer_revision_id JOIN supplier_offers so ON so.id = sor.supplier_offer_id WHERE so.sourcing_case_id = ? ORDER BY sol.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT sold.* FROM supplier_offer_line_demands sold JOIN sourcing_demands sd ON sd.id = sold.sourcing_demand_id WHERE sd.sourcing_case_id = ? ORDER BY sold.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT * FROM sourcing_coverage_options WHERE sourcing_case_id = ? ORDER BY id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT col.* FROM sourcing_coverage_option_lines col JOIN sourcing_coverage_options co ON co.id = col.sourcing_coverage_option_id WHERE co.sourcing_case_id = ? ORDER BY col.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT * FROM sourcing_decisions WHERE sourcing_case_id = ? ORDER BY revision_number`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT dl.* FROM sourcing_decision_lines dl JOIN sourcing_decisions d ON d.id = dl.sourcing_decision_id WHERE d.sourcing_case_id = ? ORDER BY dl.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT e.*, u.full_name AS actor_name FROM sourcing_case_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.sourcing_case_id = ? ORDER BY e.created_at, e.id`, [caseId]).then(([rows]) => rows),
    db.execute(`SELECT p.* FROM supplier_master_data_promotion_requests p JOIN supplier_offer_lines sol ON sol.id = p.supplier_offer_line_id JOIN supplier_offer_revisions sor ON sor.id = sol.supplier_offer_revision_id JOIN supplier_offers so ON so.id = sor.supplier_offer_id WHERE so.sourcing_case_id = ? ORDER BY p.id`, [caseId]).then(([rows]) => rows),
  ])

  const inquiryRevisionLines = inquiryRevisions.length
    ? await db.execute(`SELECT * FROM supplier_inquiry_revision_lines WHERE supplier_inquiry_revision_id IN (${inquiryRevisions.map(() => '?').join(',')}) ORDER BY id`, inquiryRevisions.map((row) => row.id)).then(([rows]) => rows)
    : []
  return {
    case: { ...sourcingCase, next_action: NEXT_ACTION[sourcingCase.status] || null },
    release_links: releaseLinks,
    demands,
    inquiries: inquiries.map((inquiry) => ({
      ...inquiry,
      revisions: inquiryRevisions.filter((revision) => Number(revision.supplier_inquiry_id) === Number(inquiry.id)).map((revision) => ({
        ...revision,
        lines: inquiryRevisionLines.filter((line) => Number(line.supplier_inquiry_revision_id) === Number(revision.id)),
        dispatches: dispatches.filter((dispatch) => Number(dispatch.supplier_inquiry_revision_id) === Number(revision.id)),
      })),
    })),
    offers: offers.map((offer) => ({
      ...offer,
      revisions: offerRevisions.filter((revision) => Number(revision.supplier_offer_id) === Number(offer.id)).map((revision) => ({
        ...revision,
        lines: offerLines.filter((line) => Number(line.supplier_offer_revision_id) === Number(revision.id)).map((line) => ({
          ...line,
          demand_links: offerLineDemands.filter((link) => Number(link.supplier_offer_line_id) === Number(line.id)),
        })),
      })),
    })),
    coverage_options: options.map((option) => ({ ...option, lines: optionLines.filter((line) => Number(line.sourcing_coverage_option_id) === Number(option.id)) })),
    decisions: decisions.map((decision) => ({ ...decision, lines: decisionLines.filter((line) => Number(line.sourcing_decision_id) === Number(decision.id)) })),
    promotion_requests: promotionRequests,
    history: events,
    legacy: sourcingCase.legacy_rfq_id ? {
      read_only: true,
      rfq_id: sourcingCase.legacy_rfq_id,
      rfq_number: sourcingCase.legacy_rfq_number,
      rfq_status: sourcingCase.legacy_rfq_status,
    } : null,
  }
}

module.exports = { getWorkspace, listCases, listReleaseIntake, listSuppliers }
