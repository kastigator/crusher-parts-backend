const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const ExcelJS = require('exceljs')
const crypto = require('crypto')
const { bucket, bucketName } = require('../utils/gcsClient')
const logger = require('../utils/logger')
const {
  buildRfqMasterStructure,
  buildRfqStructure,
  ensureStrategiesAndComponents,
  rebuildComponentsForItem,
  normalizeStrategyMode,
} = require('../utils/rfqStructure')
const {
  updateRequestStatus,
  fetchRequestIdByRevisionId,
  fetchRequestIdByRfqId,
} = require('../utils/clientRequestStatus')
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
const numOr = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const boolToTinyint = (v, fallback = null) => {
  if (v === undefined || v === null) return fallback
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return fallback
    if (trimmed === '0') return 0
    if (trimmed === '1') return 1
  }
  return v ? 1 : 0
}
const parseFlagTinyint = (v) => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') {
    if (v === 1) return 1
    if (v === 0) return 0
    return null
  }
  const raw = String(v).trim().toLowerCase()
  if (!raw) return null
  if (['1', 'true', 'yes', 'y', 'да', 'есть'].includes(raw)) return 1
  if (['0', 'false', 'no', 'n', 'нет'].includes(raw)) return 0
  return null
}
const normalizeIncoterms = (value) => {
  const v = nz(value)
  return v ? v.toUpperCase().slice(0, 16) : null
}
const safeSegment = (value) =>
  String(value || '')
    .trim()
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

const normalizeRfqFormat = (value) => {
  const normalized = String(value || 'auto').trim().toLowerCase()
  if (['auto', 'whole', 'bom', 'kit'].includes(normalized)) return normalized
  return 'auto'
}

const roleOf = (user) => String(user?.role || '').toLowerCase()
const isAdmin = (user) => roleOf(user) === 'admin'
const isProcurementHead = (user) => roleOf(user) === 'nachalnik-otdela-zakupok'
const canManageRfqs = (user) => isAdmin(user) || isProcurementHead(user)

const hashPayload = (payload) =>
  crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')

const COMPANY_INFO = {
  name: nz(process.env.RFQ_COMPANY_NAME),
  email: nz(process.env.RFQ_COMPANY_EMAIL),
  phone: nz(process.env.RFQ_COMPANY_PHONE),
  website: nz(process.env.RFQ_COMPANY_WEBSITE),
  address: nz(process.env.RFQ_COMPANY_ADDRESS),
}

const fmtDate = (value) => {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

const fetchPricedLineNumbers = async (rfqId, supplierId) => {
  if (!rfqId || !supplierId) return new Set()

  const [rows] = await db.execute(
    `
    SELECT DISTINCT cri.line_number
      FROM rfq_response_lines rl
      JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
      JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
      JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
      JOIN rfq_items ri ON ri.id = rl.rfq_item_id
      JOIN rfqs r ON r.id = ri.rfq_id
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
     WHERE rs.rfq_id = ?
       AND rs.supplier_id = ?
       AND cri.client_request_revision_id = r.client_request_revision_id
       AND rl.price IS NOT NULL
       AND rl.currency IS NOT NULL
    `,
    [rfqId, supplierId]
  )
  const priced = rows.map((r) => Number(r.line_number))

  // Учтём строки, по которым приняли уже существующую цену (ACCEPTED_EXISTING)
  const [accepted] = await db.execute(
    `
    SELECT DISTINCT cri.line_number
      FROM rfq_supplier_line_status rsl
      JOIN rfq_suppliers rs ON rs.id = rsl.rfq_supplier_id
      JOIN rfq_items ri ON ri.id = rsl.rfq_item_id
      JOIN rfqs r ON r.id = ri.rfq_id
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
     WHERE rs.rfq_id = ?
       AND rs.supplier_id = ?
       AND cri.client_request_revision_id = r.client_request_revision_id
       AND rsl.status = 'ACCEPTED_EXISTING'
    `,
    [rfqId, supplierId]
  )
  const acceptedLines = accepted.map((r) => Number(r.line_number))

  return new Set([...priced, ...acceptedLines])
}

const fetchActiveRfqItems = async (conn, rfqId) => {
  if (!rfqId) return []
  const [rows] = await conn.execute(
    `
    SELECT ri.id, ri.line_number
      FROM rfq_items ri
      JOIN rfqs r ON r.id = ri.rfq_id
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
     WHERE ri.rfq_id = ?
       AND cri.client_request_revision_id = r.client_request_revision_id
     ORDER BY ri.line_number, ri.id
    `,
    [rfqId]
  )
  return rows
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

const syncLineStatusesForRfq = async (conn, rfqId) => {
  const [suppliers] = await conn.execute('SELECT id FROM rfq_suppliers WHERE rfq_id = ?', [rfqId])
  const items = await fetchActiveRfqItems(conn, rfqId)
  const supplierIds = suppliers.map((s) => s.id)
  const itemIds = items.map((i) => i.id)
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

const ensureSupplierResponseRevision = async (conn, rfqSupplierId, { status = 'received', note = null, userId = null } = {}) => {
  const [[resp]] = await conn.execute(
    'SELECT * FROM rfq_supplier_responses WHERE rfq_supplier_id = ? LIMIT 1',
    [rfqSupplierId]
  )
  let responseId = resp?.id || null
  if (!responseId) {
    const [ins] = await conn.execute(
      `INSERT INTO rfq_supplier_responses (rfq_supplier_id, status, created_by_user_id)
       VALUES (?,?,?)`,
      [rfqSupplierId, status, userId]
    )
    responseId = ins.insertId
  }
  const [[latestRev]] = await conn.execute(
    `SELECT * FROM rfq_response_revisions
      WHERE rfq_supplier_response_id = ?
      ORDER BY rev_number DESC, id DESC
      LIMIT 1`,
    [responseId]
  )
  if (latestRev) return { responseId, revisionId: latestRev.id, revision: latestRev }

  const [revIns] = await conn.execute(
    `INSERT INTO rfq_response_revisions
      (rfq_supplier_response_id, rev_number, note, created_by_user_id)
     VALUES (?,?,?,?)`,
    [responseId, 1, note, userId]
  )
  const [[createdRev]] = await conn.execute(
    'SELECT * FROM rfq_response_revisions WHERE id = ?',
    [revIns.insertId]
  )
  return { responseId, revisionId: createdRev.id, revision: createdRev }
}

const createSupplierResponseRevision = async (conn, rfqSupplierId, { status = 'received', note = null, userId = null } = {}) => {
  const base = await ensureSupplierResponseRevision(conn, rfqSupplierId, { status, note, userId })
  const [[{ next_rev }]] = await conn.execute(
    `SELECT COALESCE(MAX(rev_number), 0) + 1 AS next_rev
       FROM rfq_response_revisions
      WHERE rfq_supplier_response_id = ?`,
    [base.responseId]
  )
  const [ins] = await conn.execute(
    `INSERT INTO rfq_response_revisions (rfq_supplier_response_id, rev_number, note, created_by_user_id)
     VALUES (?,?,?,?)`,
    [base.responseId, next_rev, note, userId]
  )
  const [[rev]] = await conn.execute('SELECT * FROM rfq_response_revisions WHERE id = ?', [ins.insertId])
  return { responseId: base.responseId, revisionId: rev.id, revision: rev }
}

const normalizeOfferType = (value, fallback = 'UNKNOWN') => {
  const normalized = String(value || '').trim().toUpperCase()
  if (normalized === 'АНАЛОГ') return 'ANALOG'
  if (normalized === 'ОРИГИНАЛ' || normalized === 'OEM (ОРИГИНАЛ)') return 'OEM'
  if (normalized === 'НЕ УКАЗАН' || normalized === 'НЕ УКАЗАНО') return 'UNKNOWN'
  if (normalized === 'OEM' || normalized === 'ANALOG' || normalized === 'UNKNOWN') return normalized
  return fallback
}

const SUPPLIER_REPLY_STATUS_SET = new Set([
  'QUOTED',
  'NO_STOCK',
  'DISCONTINUED',
  'NEEDS_CLARIFICATION',
  'NO_RESPONSE',
])

const normalizeSupplierReplyStatus = (value, fallback = 'QUOTED') => {
  const normalized = String(value || '').trim().toUpperCase()
  if (!normalized) return fallback
  if (SUPPLIER_REPLY_STATUS_SET.has(normalized)) return normalized
  if (['ЦЕНА ПРЕДОСТАВЛЕНА', 'PRICE PROVIDED', 'QUOTED'].includes(normalized)) return 'QUOTED'
  if (['НЕТ В НАЛИЧИИ', 'OUT OF STOCK', 'NO STOCK'].includes(normalized)) return 'NO_STOCK'
  if (['СНЯТ С ПРОИЗВОДСТВА', 'DISCONTINUED'].includes(normalized)) return 'DISCONTINUED'
  if (['ТРЕБУЕТ УТОЧНЕНИЯ', 'NEEDS CLARIFICATION'].includes(normalized))
    return 'NEEDS_CLARIFICATION'
  if (['БЕЗ ОТВЕТА', 'NO RESPONSE'].includes(normalized)) return 'NO_RESPONSE'
  return fallback
}

const supplierReplyStatusRequiresPrice = (value) =>
  normalizeSupplierReplyStatus(value) === 'QUOTED'

const canonicalSupplierPartNumber = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  return raw.replace(/[^A-Za-z0-9]+/g, '').toUpperCase() || null
}

const findSupplierPartByNumberForImport = async (conn, supplierId, supplierPartNumber) => {
  const supplierPartNo = nz(supplierPartNumber)
  if (!supplierId || !supplierPartNo) return null
  const canonical = canonicalSupplierPartNumber(supplierPartNo)
  const [rows] = await conn.execute(
    `
    SELECT id,
           supplier_part_number,
           canonical_part_number
      FROM supplier_parts
     WHERE supplier_id = ?
       AND (
         supplier_part_number = ?
         OR (? IS NOT NULL AND canonical_part_number = ?)
       )
     ORDER BY CASE WHEN supplier_part_number = ? THEN 0 ELSE 1 END,
              id ASC
     LIMIT 1
    `,
    [supplierId, supplierPartNo, canonical, canonical, supplierPartNo]
  )
  const found = rows?.[0] || null
  if (!found) return null
  if (canonical && !nz(found.canonical_part_number)) {
    await conn.execute(
      `
      UPDATE supplier_parts
         SET canonical_part_number = ?
       WHERE id = ?
         AND (canonical_part_number IS NULL OR canonical_part_number = '')
      `,
      [canonical, found.id]
    )
  }
  return {
    id: Number(found.id),
    supplier_part_number: found.supplier_part_number,
    canonical_part_number: found.canonical_part_number || canonical || null,
    matched_by:
      nz(found.supplier_part_number) === supplierPartNo ? 'EXACT' : 'CANONICAL',
  }
}

const resolveOrCreateSupplierPartForImport = async (
  conn,
  {
    supplierId,
    supplierPartId = null,
    supplierPartNumber = null,
    descriptionRu = null,
    descriptionEn = null,
    partType = 'UNKNOWN',
    leadTimeDays = null,
    minOrderQty = null,
    packaging = null,
    weightKg = null,
    lengthCm = null,
    widthCm = null,
    heightCm = null,
    isOverweight = null,
    isOversize = null,
    requestedOriginalPartId = null,
    createdByUserId = null,
    createIfMissing = true,
  }
) => {
  const explicitId = toId(supplierPartId)
  if (explicitId) return { partId: explicitId, created: false, matchedBy: 'ID' }
  const supplierPartNo = nz(supplierPartNumber)
  if (!supplierId || !supplierPartNo) return { partId: null, created: false, matchedBy: null }

  const existing = await findSupplierPartByNumberForImport(conn, supplierId, supplierPartNo)

  let partId = existing?.id ? Number(existing.id) : null
  const normalizedLeadTime = numOrNull(leadTimeDays)
  const normalizedMinOrderQty = numOrNull(minOrderQty)
  const normalizedPackaging = nz(packaging)
  const normalizedWeight = numOrNull(weightKg)
  const normalizedLength = numOrNull(lengthCm)
  const normalizedWidth = numOrNull(widthCm)
  const normalizedHeight = numOrNull(heightCm)
  const normalizedOverweight = parseFlagTinyint(isOverweight) ?? 0
  const normalizedOversize = parseFlagTinyint(isOversize) ?? 0
  const normalizedPartType = normalizeOfferType(partType)
  let created = false
  if (!partId && !createIfMissing) {
    return {
      partId: null,
      created: false,
      matchedBy: null,
      wouldCreate: true,
      supplierPartNumber: supplierPartNo,
    }
  }
  if (!partId) {
    const [insPart] = await conn.execute(
      `
      INSERT INTO supplier_parts
        (
          supplier_id, supplier_part_number, canonical_part_number, description_ru, description_en, part_type,
          lead_time_days, min_order_qty, packaging, weight_kg, length_cm, width_cm, height_cm,
          is_overweight, is_oversize, active
        )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
      `,
      [
        supplierId,
        supplierPartNo,
        canonicalSupplierPartNumber(supplierPartNo),
        nz(descriptionRu),
        nz(descriptionEn) || nz(descriptionRu),
        normalizedPartType,
        normalizedLeadTime,
        normalizedMinOrderQty,
        normalizedPackaging,
        normalizedWeight,
        normalizedLength,
        normalizedWidth,
        normalizedHeight,
        normalizedOverweight,
        normalizedOversize,
      ]
    )
    partId = Number(insPart.insertId)
    created = true
  } else {
    await conn.execute(
      `
      UPDATE supplier_parts
         SET part_type = COALESCE(part_type, ?),
             lead_time_days = COALESCE(lead_time_days, ?),
             min_order_qty = COALESCE(min_order_qty, ?),
             packaging = COALESCE(packaging, ?),
             weight_kg = COALESCE(weight_kg, ?),
             length_cm = COALESCE(length_cm, ?),
             width_cm = COALESCE(width_cm, ?),
             height_cm = COALESCE(height_cm, ?),
             is_overweight = COALESCE(is_overweight, ?),
             is_oversize = COALESCE(is_oversize, ?)
       WHERE id = ?
      `,
      [
        normalizedPartType,
        normalizedLeadTime,
        normalizedMinOrderQty,
        normalizedPackaging,
        normalizedWeight,
        normalizedLength,
        normalizedWidth,
        normalizedHeight,
        normalizedOverweight,
        normalizedOversize,
        partId,
      ]
    )
  }

  const originalPartId = toId(requestedOriginalPartId)
  if (partId && originalPartId) {
    await conn.execute(
      `
      INSERT INTO supplier_original_links
        (supplier_part_id, original_part_id, confidence, source, comment, created_by_user_id)
      VALUES (?, ?, 80, 'RFQ_RESPONSE', 'Auto-linked during RFQ response import', ?)
      ON DUPLICATE KEY UPDATE
        confidence = GREATEST(COALESCE(confidence, 0), VALUES(confidence)),
        source = VALUES(source),
        comment = COALESCE(VALUES(comment), comment),
        created_by_user_id = COALESCE(VALUES(created_by_user_id), created_by_user_id)
      `,
      [partId, originalPartId, createdByUserId]
    )
  }

  return {
    partId,
    created,
    matchedBy: existing?.matched_by || (created ? 'CREATED' : null),
    supplierPartNumber: supplierPartNo,
  }
}

const writeResponseLineAction = async (
  conn,
  {
    responseLineId,
    actionType = 'CREATE',
    payload = null,
    reason = null,
    createdByUserId = null,
  }
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

const fetchClientRevisionLines = async (clientRequestRevisionId) => {
  if (!clientRequestRevisionId) return []
  const [rows] = await db.execute(
    `SELECT line_number,
            original_part_id,
            client_part_number,
            client_description,
            requested_qty,
            uom,
            oem_only
       FROM client_request_revision_items
      WHERE client_request_revision_id = ?
      ORDER BY line_number`,
    [clientRequestRevisionId]
  )
  return rows || []
}

const diffRevisionLines = (currentLines, prevLines) => {
  const prevByLine = new Map(prevLines.map((row) => [Number(row.line_number), row]))
  const statuses = new Map()
  currentLines.forEach((row) => {
    const line = Number(row.line_number)
    const prev = prevByLine.get(line)
    if (!prev) {
      statuses.set(line, 'NEW')
      return
    }
    const changed =
      Number(row.original_part_id || 0) !== Number(prev.original_part_id || 0) ||
      Number(row.requested_qty || 0) !== Number(prev.requested_qty || 0) ||
      String(row.uom || '') !== String(prev.uom || '') ||
      String(row.client_part_number || '') !== String(prev.client_part_number || '') ||
      String(row.client_description || '') !== String(prev.client_description || '') ||
      Number(row.oem_only || 0) !== Number(prev.oem_only || 0)
    if (changed) {
      statuses.set(line, 'CHANGED')
    }
  })
  return statuses
}

const addMatchType = (map, key, type) => {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(type)
}

const collectSuggestionSources = (structure) => {
  const originalTypeMap = new Map()
  const bundleItemIds = new Set()

  const collectBom = (nodes) => {
    if (!Array.isArray(nodes)) return
    nodes.forEach((node) => {
      const id = toId(node.original_part_id)
      if (id) addMatchType(originalTypeMap, id, 'BOM')
      if (node.children?.length) collectBom(node.children)
    })
  }

  structure?.items?.forEach((item) => {
    const originalId = toId(item.original_part_id)
    if (!originalId) return
    const options = Array.isArray(item.options) ? item.options : []
    const optionMap = new Map(options.map((opt) => [opt.type, opt]))
    const whole = optionMap.get('WHOLE')
    const bom = optionMap.get('BOM')
    const kit = optionMap.get('KIT')

    if (whole?.enabled) addMatchType(originalTypeMap, originalId, 'WHOLE')
    if (bom?.enabled) collectBom(bom.children || [])
    if (kit?.enabled) {
      ;(kit.children || []).forEach((role) => {
        const id = toId(role.bundle_item_id)
        if (id) bundleItemIds.add(id)
      })
    }
  })

  return { originalTypeMap, bundleItemIds }
}

const buildSuggestedSupplierRows = async (db, structure) => {
  const { originalTypeMap, bundleItemIds } = collectSuggestionSources(structure)
  const supplierMap = new Map()
  const latestPriceJoin = `
    LEFT JOIN (
      SELECT spp1.*
      FROM supplier_part_prices spp1
      JOIN (
        SELECT supplier_part_id, MAX(id) AS max_id
        FROM supplier_part_prices
        GROUP BY supplier_part_id
      ) latest ON latest.max_id = spp1.id
    ) lp ON lp.supplier_part_id = sp.id
  `

  const ensureSupplier = (supplier_id, supplier_name) => {
    if (!supplierMap.has(supplier_id)) {
      supplierMap.set(supplier_id, {
        supplier_id,
        supplier_name,
        match_types: new Set(),
        match_keys: new Set(),
        priced_match_keys: new Set(),
      })
    }
    return supplierMap.get(supplier_id)
  }

  if (originalTypeMap.size) {
    const originalIds = [...originalTypeMap.keys()]
    const placeholders = originalIds.map(() => '?').join(',')
    const [rows] = await db.execute(
      `
        SELECT spo.original_part_id,
               sp.supplier_id,
               ps.name AS supplier_name,
               sp.id AS supplier_part_id,
               CASE WHEN lp.id IS NULL THEN 0 ELSE 1 END AS has_price
          FROM supplier_part_originals spo
          JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
          ${latestPriceJoin}
         WHERE spo.original_part_id IN (${placeholders})
      `,
      originalIds
    )

    rows.forEach((row) => {
      const supplier = ensureSupplier(row.supplier_id, row.supplier_name)
      const types = originalTypeMap.get(row.original_part_id) || new Set()
      types.forEach((type) => {
        const key = `${type}:${row.original_part_id}`
        supplier.match_types.add(type)
        supplier.match_keys.add(key)
        if (Number(row.has_price) === 1) supplier.priced_match_keys.add(key)
      })
    })
  }

  if (bundleItemIds.size) {
    const bundleIds = [...bundleItemIds]
    const placeholders = bundleIds.map(() => '?').join(',')
    const [rows] = await db.execute(
      `
        SELECT sbl.item_id AS bundle_item_id,
               sp.supplier_id,
               ps.name AS supplier_name,
               CASE WHEN lp.id IS NULL THEN 0 ELSE 1 END AS has_price
          FROM supplier_bundle_item_links sbl
          JOIN supplier_parts sp ON sp.id = sbl.supplier_part_id
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
          ${latestPriceJoin}
         WHERE sbl.item_id IN (${placeholders})
      `,
      bundleIds
    )

    rows.forEach((row) => {
      const supplier = ensureSupplier(row.supplier_id, row.supplier_name)
      supplier.match_types.add('KIT')
      const key = `KIT:${row.bundle_item_id}`
      supplier.match_keys.add(key)
      if (Number(row.has_price) === 1) supplier.priced_match_keys.add(key)
    })
  }

  return [...supplierMap.values()]
    .map((row) => ({
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      parts_count: row.match_keys.size,
      priced_parts_count: row.priced_match_keys.size,
      match_types: [...row.match_types].join(','),
    }))
    .sort(
      (a, b) =>
        b.parts_count - a.parts_count ||
        a.supplier_name.localeCompare(b.supplier_name)
    )
}

const buildRfqExcelRows = (structure) => {
  const rows = []
  const displayUom = (value) => {
    if (!value) return ''
    const normalized = String(value).trim().toLowerCase()
    if (normalized === 'pcs') return 'шт'
    return value
  }

  const addRow = (row) => rows.push(row)
  const addBomRows = (item, nodes, depth = 1) => {
    if (!Array.isArray(nodes)) return
    nodes.forEach((node) => {
      addRow({
        line_number: item.line_number,
        type: 'BOM_COMPONENT',
        level_label: 'Компонент',
        indent: depth + 1,
        original_part_id: node.original_part_id || null,
        bundle_item_id: null,
        label: node.cat_number || '',
        description: node.description || '',
        qty: node.required_qty ?? '',
        uom: displayUom(node.uom || item.uom || ''),
      })
      if (node.children?.length) addBomRows(item, node.children, depth + 1)
    })
  }

  structure?.items?.forEach((item) => {
    addRow({
      line_number: item.line_number,
      type: 'DEMAND',
      level_label: 'Заявка',
      indent: 0,
      original_part_id: item.original_part_id || null,
      bundle_item_id: null,
      label: item.original_cat_number || item.client_part_number || '',
      description: item.description || '',
      qty: item.requested_qty ?? '',
      uom: displayUom(item.uom || ''),
    })

    const options = Array.isArray(item.options) ? item.options : []
    const availableOptions = options.filter((opt) => opt.available)
    const enabledOptions = options.filter((opt) => opt.available && opt.enabled)
    const skipWholeRow =
      enabledOptions.length === 1 &&
      enabledOptions[0].type === 'WHOLE' &&
      availableOptions.length === 1

    options.forEach((opt) => {
      if (!opt.available || !opt.enabled) return
      if (opt.type === 'WHOLE' && skipWholeRow) return
      addRow({
        line_number: item.line_number,
        type: opt.type,
        level_label: 'Вариант',
        indent: 1,
        original_part_id: item.original_part_id || null,
        bundle_item_id: null,
        label: '',
        description: '',
        qty: opt.type === 'WHOLE' ? item.requested_qty ?? '' : '',
        uom: opt.type === 'WHOLE' ? displayUom(item.uom || '') : '',
      })

      if (opt.type === 'BOM') addBomRows(item, opt.children || [])
      if (opt.type === 'KIT') {
        ;(opt.children || []).forEach((role) => {
          addRow({
            line_number: item.line_number,
            type: 'KIT_ROLE',
            level_label: 'Роль',
            indent: 2,
            original_part_id: null,
            bundle_item_id: role.bundle_item_id || null,
            label: role.role_label || '',
            description: role.role_label ? `Роль: ${role.role_label}` : '',
            qty: role.required_qty ?? '',
            uom: displayUom(role.uom || item.uom || ''),
          })
        })
      }
    })
  })

  return rows
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

router.get('/', async (req, res) => {
  try {
    const userId = toId(req.user?.id)
    const manager = canManageRfqs(req.user)
    const where = []
    const params = []
    if (!manager) {
      where.push('r.assigned_to_user_id = ?')
      params.push(userId || 0)
    }

    const [rows] = await db.execute(
      `SELECT r.*,
              cr.client_request_id,
              cr.rev_number,
              req.client_id,
              req.internal_number AS client_request_number,
              req.client_reference,
              req.status AS client_request_status,
              req.received_at AS request_received_at,
              req.processing_deadline,
              c.company_name AS client_name,
              u.full_name AS assigned_user_name
       FROM rfqs r
       JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
       JOIN client_requests req ON req.id = cr.client_request_id
       JOIN clients c ON c.id = req.client_id
       LEFT JOIN users u ON u.id = r.assigned_to_user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.id DESC`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[row]] = await db.execute('SELECT * FROM rfqs WHERE id = ?', [id])
    if (!row) return res.status(404).json({ message: 'Не найдено' })

    res.json(row)
  } catch (e) {
    console.error('GET /rfqs/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    if (!canManageRfqs(req.user)) {
      return res.status(403).json({ message: 'Создание RFQ доступно только руководителю закупок или администратору' })
    }

    const client_request_revision_id = toId(req.body.client_request_revision_id)
    if (!client_request_revision_id) return res.status(400).json({ message: 'Не выбрана ревизия заявки клиента' })

    const created_by_user_id = toId(req.user?.id)
    const assigned_to_user_id = toId(req.body.assigned_to_user_id) || created_by_user_id
    const status = nz(req.body.status) || 'draft'
    const note = nz(req.body.note)
    const [[requestRow]] = await db.execute(
      `SELECT req.id AS client_request_id,
              req.internal_number AS request_number,
              req.released_to_procurement_at,
              c.company_name AS client_name
         FROM client_request_revisions cr
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
        WHERE cr.id = ?`,
      [client_request_revision_id]
    )
    if (!requestRow) {
      return res.status(404).json({ message: 'Ревизия заявки не найдена' })
    }
    if (!requestRow.released_to_procurement_at) {
      return res.status(409).json({ message: 'Создать RFQ можно только после отправки заявки в закупку' })
    }

    const client_request_id = toId(requestRow.client_request_id)
    const rfq_number = `RFQ-${requestRow.request_number}`

    const [existingByRequest] = await db.execute(
      'SELECT id FROM rfqs WHERE client_request_id = ? LIMIT 1',
      [client_request_id]
    )
    if (existingByRequest.length) {
      return res.status(409).json({ message: 'Для этой заявки RFQ уже создан' })
    }
    const [existingByNumber] = await db.execute(
      'SELECT id FROM rfqs WHERE rfq_number = ? LIMIT 1',
      [rfq_number]
    )
    if (existingByNumber.length) {
      return res.status(409).json({ message: `RFQ номер ${rfq_number} уже используется` })
    }

    const [result] = await db.execute(
      `INSERT INTO rfqs
          (rfq_number, client_request_id, client_request_revision_id, status, created_by_user_id, assigned_to_user_id, note)
       VALUES (?,?,?,?,?,?,?)`,
      [rfq_number, client_request_id, client_request_revision_id, status, created_by_user_id, assigned_to_user_id, note]
    )

    const rfqRevisionId = await ensureRfqRevisionSnapshot(db, {
      rfqId: result.insertId,
      clientRequestRevisionId: client_request_revision_id,
      createdByUserId: created_by_user_id,
      revisionType: 'base',
    })
    await db.execute(
      `UPDATE rfqs
          SET current_rfq_revision_id = ?,
              rfq_sync_status = 'synced',
              last_sync_at = NOW(),
              last_synced_client_request_revision_id = ?
        WHERE id = ?`,
      [rfqRevisionId, client_request_revision_id, result.insertId]
    )

    // создаём строки RFQ сразу на основе текущей ревизии заявки
    await ensureRfqItemsFromRevision(db, result.insertId, client_request_revision_id)
    const conn = await db.getConnection()
    try {
      await syncLineStatusesForRfq(conn, result.insertId)
    } finally {
      conn.release()
    }

    if (assigned_to_user_id && assigned_to_user_id !== created_by_user_id) {
      await createNotification(db, {
        userId: assigned_to_user_id,
        type: 'assignment',
        title: 'Назначен RFQ',
        message: `RFQ ${rfq_number} · ${requestRow?.client_name || ''} ${requestRow?.request_number || ''}`.trim(),
        entityType: 'rfq',
        entityId: result.insertId,
      })
    }

    const requestId = await fetchRequestIdByRevisionId(
      db,
      client_request_revision_id
    )
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    const [[created]] = await db.execute('SELECT * FROM rfqs WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /rfqs error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/items', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const conn = await db.getConnection()
    try {
      const [[rfq]] = await conn.execute(
        'SELECT id, client_request_revision_id FROM rfqs WHERE id = ?',
        [rfqId]
      )
      if (!rfq) {
        conn.release()
        return res.status(404).json({ message: 'RFQ не найден' })
      }
      await ensureRfqItemsFromRevision(conn, rfq.id, rfq.client_request_revision_id)
      await syncLineStatusesForRfq(conn, rfq.id)
    } finally {
      conn.release()
    }

    const [rows] = await db.execute(
      `SELECT ri.*,
              cri.client_description,
              cri.client_part_number,
              cri.requested_qty AS client_requested_qty,
              cri.uom AS client_uom,
              cri.original_part_id,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN rfqs r ON r.id = ri.rfq_id
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.rfq_id = ?
          AND cri.client_request_revision_id = r.client_request_revision_id
        ORDER BY ri.line_number ASC`,
      [rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/items error:', e.message || e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/structure', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const view = String(req.query.view || '').trim().toLowerCase()
    const payload =
      view === 'master' || view === 'stage1'
        ? await buildRfqMasterStructure(db, rfqId)
        : await buildRfqStructure(db, rfqId, { includeSelf: true })
    res.json(payload)
  } catch (e) {
    console.error('GET /rfqs/:id/structure error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/structure/confirm', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const payload = await buildRfqMasterStructure(db, rfqId)
    const items = payload?.items || []
    if (!items.length) {
      return res.status(400).json({ message: 'В RFQ нет строк для подтверждения' })
    }

    for (const item of items) {
      const enabledOptions = (item.options || []).filter((opt) => opt.enabled)
      if (!enabledOptions.length) {
        return res
          .status(400)
          .json({ message: `Для позиции ${item.line_number} не выбран ни один вариант` })
      }
      const kitOpt = (item.options || []).find((opt) => opt.type === 'KIT')
      if (kitOpt?.enabled && kitOpt.selection_required) {
        return res.status(400).json({
          message: `Выберите комплект для позиции ${item.line_number}`,
        })
      }
    }

    await db.execute(`UPDATE rfqs SET status = 'structured' WHERE id = ? AND status <> 'sent'`, [
      rfqId,
    ])
    const [[updated]] = await db.execute('SELECT * FROM rfqs WHERE id = ?', [rfqId])
    res.json({ rfq: updated })
  } catch (e) {
    console.error('POST /rfqs/:id/structure/confirm error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/items/:itemId/strategy', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[item]] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.id = ? AND ri.rfq_id = ?`,
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const [[existing]] = await db.execute(
      'SELECT * FROM rfq_item_strategies WHERE rfq_item_id = ?',
      [itemId]
    )

    const mode = normalizeStrategyMode(req.body.mode, existing?.mode || 'SINGLE')
    const allow_oem = boolToTinyint(req.body.allow_oem, existing?.allow_oem ?? 1)
    const allow_analog = boolToTinyint(req.body.allow_analog, existing?.allow_analog ?? 1)
    const allow_kit = boolToTinyint(req.body.allow_kit, existing?.allow_kit ?? 1)
    const allow_partial = boolToTinyint(req.body.allow_partial, existing?.allow_partial ?? 0)
    const note = nz(req.body.note ?? existing?.note)
    const hasSelectedBundle = Object.prototype.hasOwnProperty.call(
      req.body,
      'selected_bundle_id'
    )
    const selected_bundle_id = hasSelectedBundle
      ? toId(req.body.selected_bundle_id)
      : existing?.selected_bundle_id ?? null

    await db.execute(
      `INSERT INTO rfq_item_strategies
         (rfq_item_id, mode, allow_oem, allow_analog, allow_kit, allow_partial, note, selected_bundle_id)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         mode=VALUES(mode),
         allow_oem=VALUES(allow_oem),
         allow_analog=VALUES(allow_analog),
         allow_kit=VALUES(allow_kit),
         allow_partial=VALUES(allow_partial),
         note=VALUES(note),
         selected_bundle_id=VALUES(selected_bundle_id)`,
      [itemId, mode, allow_oem, allow_analog, allow_kit, allow_partial, note, selected_bundle_id]
    )

    if (req.body.rebuild_components) {
      await rebuildComponentsForItem(db, item, mode)
    }

    await db.execute(`UPDATE rfqs SET status = 'draft' WHERE id = ? AND status = 'structured'`, [
      rfqId,
    ])

    const [[updated]] = await db.execute(
      'SELECT * FROM rfq_item_strategies WHERE rfq_item_id = ?',
      [itemId]
    )
    res.json({ strategy: updated })
  } catch (e) {
    console.error('PUT /rfqs/:id/items/:itemId/strategy error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items/:itemId/components/rebuild', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[item]] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.id = ? AND ri.rfq_id = ?`,
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const [[strategy]] = await db.execute(
      'SELECT mode FROM rfq_item_strategies WHERE rfq_item_id = ?',
      [itemId]
    )
    const mode = normalizeStrategyMode(req.body.mode, strategy?.mode || 'SINGLE')

    await rebuildComponentsForItem(db, item, mode)
    res.json({ success: true })
  } catch (e) {
    console.error('POST /rfqs/:id/items/:itemId/components/rebuild error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items/:itemId/components', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const original_part_id = toId(req.body.original_part_id)
    if (!original_part_id) return res.status(400).json({ message: 'Не выбрана оригинальная деталь' })

    const component_qty = numOrNull(req.body.component_qty) || 1
    const source_type = nz(req.body.source_type) || 'MANUAL'

    const [[item]] = await db.execute(
      'SELECT requested_qty FROM rfq_items WHERE id = ? AND rfq_id = ?',
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const required_qty = numOr(component_qty, 1) * numOr(item.requested_qty, 1)

    await db.execute(
      `INSERT INTO rfq_item_components
         (rfq_item_id, original_part_id, component_qty, required_qty, source_type, note)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         component_qty=VALUES(component_qty),
         required_qty=VALUES(required_qty),
         note=VALUES(note)`,
      [itemId, original_part_id, component_qty, required_qty, source_type, nz(req.body.note)]
    )

    res.status(201).json({ success: true })
  } catch (e) {
    console.error('POST /rfqs/:id/items/:itemId/components error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/items/:itemId/components/:componentId', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    const componentId = toId(req.params.componentId)
    if (!rfqId || !itemId || !componentId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[item]] = await db.execute(
      'SELECT requested_qty FROM rfq_items WHERE id = ? AND rfq_id = ?',
      [itemId, rfqId]
    )
    if (!item) return res.status(404).json({ message: 'Строка RFQ не найдена' })

    const component_qty = numOrNull(req.body.component_qty)
    if (component_qty === null) return res.status(400).json({ message: 'component_qty обязателен' })

    const required_qty = numOr(component_qty, 1) * numOr(item.requested_qty, 1)

    const [result] = await db.execute(
      `UPDATE rfq_item_components
          SET component_qty = ?, required_qty = ?, note = COALESCE(?, note)
        WHERE id = ? AND rfq_item_id = ?`,
      [component_qty, required_qty, nz(req.body.note), componentId, itemId]
    )

    if (!result.affectedRows) return res.status(404).json({ message: 'Компонент не найден' })

    res.json({ success: true })
  } catch (e) {
    console.error('PUT /rfqs/:id/items/:itemId/components/:componentId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/items/:itemId/components/:componentId', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const itemId = toId(req.params.itemId)
    const componentId = toId(req.params.componentId)
    if (!rfqId || !itemId || !componentId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [result] = await db.execute(
      'DELETE FROM rfq_item_components WHERE id = ? AND rfq_item_id = ?',
      [componentId, itemId]
    )
    if (!result.affectedRows) return res.status(404).json({ message: 'Компонент не найден' })

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /rfqs/:id/items/:itemId/components/:componentId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const client_request_revision_item_id = toId(req.body.client_request_revision_item_id)
    if (!client_request_revision_item_id) {
      return res.status(400).json({ message: 'Не выбрана строка заявки клиента' })
    }

    const [[sourceItem]] = await db.execute(
      `SELECT requested_qty, uom, oem_only
         FROM client_request_revision_items
        WHERE id = ?`,
      [client_request_revision_item_id]
    )
    if (!sourceItem) {
      return res.status(404).json({ message: 'Позиция заявки не найдена' })
    }

    const resolvedQty = numOrNull(req.body.requested_qty)
    const resolvedUom = nz(req.body.uom)
    const resolvedOem =
      req.body.oem_only === undefined || req.body.oem_only === null
        ? sourceItem.oem_only
        : req.body.oem_only
        ? 1
        : 0
    const requestedQty =
      resolvedQty === null ? sourceItem.requested_qty ?? 1 : resolvedQty
    const uom = resolvedUom || sourceItem.uom || 'pcs'

    if (requestedQty === null) {
      return res.status(400).json({ message: 'requested_qty обязателен' })
    }

    const [[{ next_line }]] = await db.execute(
      `SELECT COALESCE(MAX(line_number), 0) + 1 AS next_line FROM rfq_items WHERE rfq_id = ?`,
      [rfqId]
    )

    const [result] = await db.execute(
      `INSERT INTO rfq_items (rfq_id, client_request_revision_item_id, line_number, requested_qty, uom, oem_only, note)
       VALUES (?,?,?,?,?,?,?)`,
      [
        rfqId,
        client_request_revision_item_id,
        next_line,
        requestedQty,
        uom,
        resolvedOem,
        nz(req.body.note),
      ]
    )

    const [[created]] = await db.execute('SELECT * FROM rfq_items WHERE id = ?', [result.insertId])
    const [itemRows] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.id = ?`,
      [result.insertId]
    )
    if (itemRows.length) {
      await ensureStrategiesAndComponents(db, itemRows)
    }
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /rfqs/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items/bulk', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[rfq]] = await db.execute(
      'SELECT client_request_revision_id FROM rfqs WHERE id = ?',
      [rfqId]
    )
    if (!rfq) return res.status(404).json({ message: 'RFQ не найден' })

    const [[{ max_line }]] = await db.execute(
      'SELECT COALESCE(MAX(line_number), 0) AS max_line FROM rfq_items WHERE rfq_id = ?',
      [rfqId]
    )

    const [result] = await db.execute(
      `
      INSERT INTO rfq_items
        (rfq_id, client_request_revision_item_id, line_number, requested_qty, uom, oem_only, note)
      SELECT
        ?, ri.id, ? + ROW_NUMBER() OVER (ORDER BY ri.line_number),
        ri.requested_qty, ri.uom, ri.oem_only, NULL
      FROM client_request_revision_items ri
      WHERE ri.client_request_revision_id = ?
        AND ri.id NOT IN (
          SELECT client_request_revision_item_id FROM rfq_items WHERE rfq_id = ?
        )
      `,
      [rfqId, max_line, rfq.client_request_revision_id, rfqId]
    )

    const [itemRows] = await db.execute(
      `SELECT ri.id AS rfq_item_id,
              ri.requested_qty,
              cri.original_part_id,
              cri.client_part_number,
              op.cat_number AS original_cat_number,
              op.description_ru AS original_description_ru,
              op.description_en AS original_description_en
         FROM rfq_items ri
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.rfq_id = ?`,
      [rfqId]
    )
    if (itemRows.length) {
      await ensureStrategiesAndComponents(db, itemRows)
    }

    res.json({ success: true, inserted: result.affectedRows || 0 })
  } catch (e) {
    console.error('POST /rfqs/:id/items/bulk error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/suppliers', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `SELECT rs.*,
              ps.name AS supplier_name,
              ps.default_pickup_location,
              sc.name AS contact_person,
              sc.email AS contact_email,
              sc.phone AS contact_phone,
              rsl.response_id,
              rsr.status AS response_status
       FROM rfq_suppliers rs
       JOIN part_suppliers ps ON ps.id = rs.supplier_id
       LEFT JOIN (
         SELECT sc1.*,
                ROW_NUMBER() OVER (
                  PARTITION BY supplier_id
                  ORDER BY is_primary DESC, created_at DESC, id DESC
                ) AS rn
         FROM supplier_contacts sc1
       ) sc ON sc.supplier_id = ps.id AND sc.rn = 1
       LEFT JOIN (
         SELECT rfq_supplier_id, MAX(id) AS response_id
         FROM rfq_supplier_responses
         GROUP BY rfq_supplier_id
       ) rsl ON rsl.rfq_supplier_id = rs.id
       LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rsl.response_id
       WHERE rs.rfq_id = ?
       ORDER BY rs.id DESC`,
      [rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/suppliers error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/suppliers/:supplierId/line-selections', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const rfqSupplierId = toId(req.params.supplierId)
    if (!rfqId || !rfqSupplierId) {
      return res.status(400).json({ message: 'Некорректный идентификатор' })
    }

    const [[supplierRow]] = await db.execute(
      'SELECT id FROM rfq_suppliers WHERE id = ? AND rfq_id = ?',
      [rfqSupplierId, rfqId]
    )
    if (!supplierRow) {
      return res.status(404).json({ message: 'Поставщик RFQ не найден' })
    }

    const [rows] = await db.execute(
      `SELECT id,
              rfq_supplier_id,
              selection_key,
              rfq_item_id,
              line_type,
              original_part_id,
              alt_original_part_id,
              bundle_id,
              bundle_item_id,
              line_label,
              line_description,
              qty,
              uom,
              use_existing_price
         FROM rfq_supplier_line_selections
        WHERE rfq_supplier_id = ?
        ORDER BY id ASC`,
      [rfqSupplierId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/suppliers/:supplierId/line-selections error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/suppliers/:supplierId/line-selections', async (req, res) => {
  const rfqId = toId(req.params.id)
  const rfqSupplierId = toId(req.params.supplierId)
  if (!rfqId || !rfqSupplierId) {
    return res.status(400).json({ message: 'Некорректный идентификатор' })
  }

  const selections = Array.isArray(req.body?.selections) ? req.body.selections : []
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[supplierRow]] = await conn.execute(
      'SELECT id FROM rfq_suppliers WHERE id = ? AND rfq_id = ?',
      [rfqSupplierId, rfqId]
    )
    if (!supplierRow) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик RFQ не найден' })
    }

    const [itemRows] = await conn.execute(
      'SELECT id FROM rfq_items WHERE rfq_id = ?',
      [rfqId]
    )
    const validItemIds = new Set(itemRows.map((row) => row.id))

    await conn.execute(
      'DELETE FROM rfq_supplier_line_selections WHERE rfq_supplier_id = ?',
      [rfqSupplierId]
    )

    const insertValues = []
    const placeholders = []

    selections.forEach((row) => {
      const rfqItemId = toId(row.rfq_item_id)
      if (!rfqItemId || !validItemIds.has(rfqItemId)) return
      const lineType = String(row.line_type || '').trim().toUpperCase()
      if (!['DEMAND', 'BOM_COMPONENT', 'KIT_ROLE'].includes(lineType)) return

      const originalPartId = toId(row.original_part_id)
      const altOriginalPartId =
        lineType === 'KIT_ROLE' ? null : toId(row.alt_original_part_id)
      const bundleId = toId(row.bundle_id)
      const bundleItemId = toId(row.bundle_item_id)

      placeholders.push('(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      insertValues.push(
        rfqSupplierId,
        nz(row.selection_key),
        rfqItemId,
        lineType,
        originalPartId,
        altOriginalPartId,
        bundleId,
        bundleItemId,
        row.line_label || null,
        row.line_description || null,
        row.qty ?? null,
        row.uom || null,
        Number(row.use_existing_price) === 1 ? 1 : 0
      )
    })

    if (placeholders.length) {
      await conn.execute(
        `
        INSERT INTO rfq_supplier_line_selections
          (rfq_supplier_id, selection_key, rfq_item_id, line_type, original_part_id, alt_original_part_id, bundle_id, bundle_item_id,
           line_label, line_description, qty, uom, use_existing_price)
        VALUES ${placeholders.join(',')}
        `,
        insertValues
      )
    }

    await conn.commit()
    res.json({ success: true, inserted: placeholders.length })
  } catch (e) {
    await conn.rollback()
    console.error('PUT /rfqs/:id/suppliers/:supplierId/line-selections error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.get('/:id/suggested-suppliers', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const structure = await buildRfqMasterStructure(db, rfqId)
    const rows = await buildSuggestedSupplierRows(db, structure)
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/suggested-suppliers error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/supplier-hints', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const supplierId = toId(req.query.supplier_id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    if (!supplierId) {
      return res.status(400).json({ message: 'Не выбран поставщик' })
    }

    const [[rfq]] = await db.execute(
      'SELECT id, client_request_revision_id FROM rfqs WHERE id = ? LIMIT 1',
      [rfqId]
    )
    if (!rfq) return res.status(404).json({ message: 'RFQ не найден' })

    const structure = await buildRfqMasterStructure(db, rfqId)
    const excelRows = buildRfqExcelRows(structure)

    const originalIds = [...new Set(
      excelRows
        .map((row) => row.original_part_id)
        .filter((id) => Number.isInteger(id) && id > 0)
    )]
    const bundleItemIds = [...new Set(
      excelRows
        .map((row) => row.bundle_item_id)
        .filter((id) => Number.isInteger(id) && id > 0)
    )]

    const originals = {}
    const bundle_items = {}
    const supplierPartIds = new Set()

    if (originalIds.length) {
      const placeholders = originalIds.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT spo.original_part_id,
               sp.id AS supplier_part_id,
               sp.supplier_part_number,
               sp.description_ru,
               sp.description_en,
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
               lp.price AS latest_price,
               lp.currency AS latest_currency,
               lp.date AS latest_price_date,
               lp.source_type AS latest_price_source_type,
               lp.source_subtype AS latest_price_source_subtype,
               rfl.entry_source AS latest_price_entry_source,
               lp.validity_days AS latest_price_validity_days,
               rfq.id AS latest_price_rfq_id,
               rfq.rfq_number AS latest_price_rfq_number,
               rr.rev_number AS latest_price_rfq_rev_number,
               spl.id AS latest_price_price_list_id,
               spl.list_code AS latest_price_price_list_code,
               spl.list_name AS latest_price_price_list_name,
               spl.valid_from AS latest_price_price_list_valid_from,
               spl.valid_to AS latest_price_price_list_valid_to
          FROM supplier_part_originals spo
          JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
          LEFT JOIN (
            SELECT spp1.*
            FROM supplier_part_prices spp1
            JOIN (
              SELECT supplier_part_id, MAX(id) AS max_id
              FROM supplier_part_prices
              GROUP BY supplier_part_id
            ) latest ON latest.max_id = spp1.id
          ) lp ON lp.supplier_part_id = sp.id
          LEFT JOIN rfq_response_lines rfl
            ON rfl.id = lp.source_id
           AND lp.source_type IN ('RFQ', 'RFQ_RESPONSE')
          LEFT JOIN rfq_response_revisions rr ON rr.id = rfl.rfq_response_revision_id
          LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
          LEFT JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
          LEFT JOIN rfqs rfq ON rfq.id = rs.rfq_id
          LEFT JOIN supplier_price_list_lines spll
            ON spll.id = lp.source_id
           AND lp.source_type = 'PRICE_LIST'
          LEFT JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
         WHERE spo.original_part_id IN (${placeholders})
           AND sp.supplier_id = ?
        `,
        [...originalIds, supplierId]
      )

      rows.forEach((row) => {
        if (
          String(row.latest_price_source_type || '').toUpperCase() === 'RFQ_RESPONSE' &&
          !row.latest_price_source_subtype
        ) {
          row.latest_price_source_subtype = row.latest_price_entry_source || null
        }
        const key = String(row.original_part_id)
        if (!originals[key]) originals[key] = []
        originals[key].push(row)
        if (row.supplier_part_id) supplierPartIds.add(Number(row.supplier_part_id))
      })
    }

    if (bundleItemIds.length) {
      const placeholders = bundleItemIds.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT sbl.item_id AS bundle_item_id,
               sp.id AS supplier_part_id,
               sp.supplier_part_number,
               sp.description_ru,
               sp.description_en,
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
               lp.price AS latest_price,
               lp.currency AS latest_currency,
               lp.date AS latest_price_date,
               lp.source_type AS latest_price_source_type,
               lp.source_subtype AS latest_price_source_subtype,
               rfl.entry_source AS latest_price_entry_source,
               lp.validity_days AS latest_price_validity_days,
               rfq.id AS latest_price_rfq_id,
               rfq.rfq_number AS latest_price_rfq_number,
               rr.rev_number AS latest_price_rfq_rev_number,
               spl.id AS latest_price_price_list_id,
               spl.list_code AS latest_price_price_list_code,
               spl.list_name AS latest_price_price_list_name,
               spl.valid_from AS latest_price_price_list_valid_from,
               spl.valid_to AS latest_price_price_list_valid_to
          FROM supplier_bundle_item_links sbl
          JOIN supplier_parts sp ON sp.id = sbl.supplier_part_id
          LEFT JOIN (
            SELECT spp1.*
            FROM supplier_part_prices spp1
            JOIN (
              SELECT supplier_part_id, MAX(id) AS max_id
              FROM supplier_part_prices
              GROUP BY supplier_part_id
            ) latest ON latest.max_id = spp1.id
          ) lp ON lp.supplier_part_id = sp.id
          LEFT JOIN rfq_response_lines rfl
            ON rfl.id = lp.source_id
           AND lp.source_type IN ('RFQ', 'RFQ_RESPONSE')
          LEFT JOIN rfq_response_revisions rr ON rr.id = rfl.rfq_response_revision_id
          LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
          LEFT JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
          LEFT JOIN rfqs rfq ON rfq.id = rs.rfq_id
          LEFT JOIN supplier_price_list_lines spll
            ON spll.id = lp.source_id
           AND lp.source_type = 'PRICE_LIST'
          LEFT JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
         WHERE sbl.item_id IN (${placeholders})
           AND sp.supplier_id = ?
        `,
        [...bundleItemIds, supplierId]
      )

      rows.forEach((row) => {
        if (
          String(row.latest_price_source_type || '').toUpperCase() === 'RFQ_RESPONSE' &&
          !row.latest_price_source_subtype
        ) {
          row.latest_price_source_subtype = row.latest_price_entry_source || null
        }
        const key = String(row.bundle_item_id)
        if (!bundle_items[key]) bundle_items[key] = []
        bundle_items[key].push(row)
        if (row.supplier_part_id) supplierPartIds.add(Number(row.supplier_part_id))
      })
    }

    const partIds = [...supplierPartIds].filter((id) => Number.isInteger(id) && id > 0)
    const priceHistoryByPartId = {}
    if (partIds.length) {
      const placeholders = partIds.map(() => '?').join(',')
      const [priceRows] = await db.execute(
        `
        SELECT
          spp.supplier_part_id,
          spp.id AS price_id,
          spp.price,
          spp.currency,
          spp.date,
          spp.comment,
          spp.offer_type,
          spp.lead_time_days,
          spp.min_order_qty,
          spp.packaging,
          spp.validity_days,
          spp.source_type,
          spp.source_subtype,
          spp.source_id,
          rfl.entry_source AS response_entry_source,
          rfi.rfq_id,
          rfq.rfq_number,
          rr.rev_number AS rfq_response_rev_number,
          spl.id AS price_list_id,
          spl.list_code AS price_list_code,
          spl.list_name AS price_list_name,
          spl.valid_from AS price_list_valid_from,
          spl.valid_to AS price_list_valid_to
        FROM supplier_part_prices spp
        LEFT JOIN rfq_response_lines rfl
          ON rfl.id = spp.source_id
         AND spp.source_type IN ('RFQ', 'RFQ_RESPONSE')
        LEFT JOIN rfq_response_revisions rr ON rr.id = rfl.rfq_response_revision_id
        LEFT JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
        LEFT JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
        LEFT JOIN rfq_items rfi ON rfi.id = rfl.rfq_item_id
        LEFT JOIN rfqs rfq ON rfq.id = COALESCE(rfi.rfq_id, rs.rfq_id)
        LEFT JOIN supplier_price_list_lines spll
          ON spll.id = spp.source_id
         AND spp.source_type = 'PRICE_LIST'
        LEFT JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
        WHERE spp.supplier_part_id IN (${placeholders})
        ORDER BY spp.supplier_part_id ASC, spp.date DESC, spp.id DESC
        `,
        partIds
      )

      priceRows.forEach((row) => {
        const partId = Number(row.supplier_part_id)
        if (!partId) return
        if (!priceHistoryByPartId[partId]) priceHistoryByPartId[partId] = []
        priceHistoryByPartId[partId].push({
          ...row,
          source_subtype:
            row.source_subtype ||
            (String(row.source_type || '').toUpperCase() === 'RFQ_RESPONSE'
              ? row.response_entry_source || null
              : null),
        })
      })
    }

    const enrichWithPriceHistory = (rowsByKey) => {
      Object.values(rowsByKey).forEach((list) => {
        ;(Array.isArray(list) ? list : []).forEach((row) => {
          const partId = Number(row.supplier_part_id || 0)
          row.price_history = partId ? priceHistoryByPartId[partId] || [] : []
        })
      })
    }
    enrichWithPriceHistory(originals)
    enrichWithPriceHistory(bundle_items)

    res.json({ supplier_id: supplierId, originals, bundle_items })
  } catch (e) {
    console.error('GET /rfqs/:id/supplier-hints error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

  router.post('/:id/suppliers', async (req, res) => {
    try {
      const rfqId = toId(req.params.id)
      const supplier_id = toId(req.body.supplier_id)
      if (!rfqId || !supplier_id) return res.status(400).json({ message: 'Нужно указать RFQ и поставщика' })

      const status = nz(req.body.status) || 'invited'
      const invited_at = nz(req.body.invited_at)
      const note = nz(req.body.note)
      const language = (nz(req.body.language) || 'ru').toLowerCase()
      const rfq_format = normalizeRfqFormat(req.body.rfq_format)

      const [result] = await db.execute(
      `INSERT INTO rfq_suppliers (rfq_id, supplier_id, status, invited_at, note, language, rfq_format)
       VALUES (?,?,?,?,?,?,?)`,
      [rfqId, supplier_id, status, invited_at, note, language, rfq_format]
      )

    const [[created]] = await db.execute('SELECT * FROM rfq_suppliers WHERE id = ?', [result.insertId])
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /rfqs/:id/suppliers error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.patch('/:id/suppliers/:supplierId', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const rfqSupplierId = toId(req.params.supplierId)
    if (!rfqId || !rfqSupplierId) {
      return res.status(400).json({ message: 'Некорректный идентификатор' })
    }

    const updates = []
    const params = []

    if (req.body.language !== undefined) {
      const language = (nz(req.body.language) || '').toLowerCase()
      if (!['ru', 'en'].includes(language)) {
        return res.status(400).json({ message: 'Некорректный язык' })
      }
      updates.push('language = ?')
      params.push(language)
    }

    if (req.body.rfq_format !== undefined) {
      const rfqFormat = normalizeRfqFormat(req.body.rfq_format)
      updates.push('rfq_format = ?')
      params.push(rfqFormat)
    }

    if (!updates.length) {
      return res.status(400).json({ message: 'Нет данных для обновления' })
    }

    params.push(rfqSupplierId, rfqId)

    await db.execute(
      `UPDATE rfq_suppliers
          SET ${updates.join(', ')}
        WHERE id = ? AND rfq_id = ?`,
      params
    )

    const [[row]] = await db.execute(
      'SELECT * FROM rfq_suppliers WHERE id = ?',
      [rfqSupplierId]
    )
    res.json(row || { id: rfqSupplierId, language })
  } catch (e) {
    console.error('PATCH /rfqs/:id/suppliers/:supplierId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const requestId = await fetchRequestIdByRfqId(conn, id)

    await conn.execute(
      `DELETE FROM notifications
       WHERE entity_type = 'rfq' AND entity_id = ?`,
      [id]
    )

    await conn.execute(
      `DELETE cc FROM client_contracts cc
       JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE l FROM sales_quote_lines l
       JOIN sales_quote_revisions r ON r.id = l.sales_quote_revision_id
       JOIN sales_quotes sq ON sq.id = r.sales_quote_id
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE r FROM sales_quote_revisions r
       JOIN sales_quotes sq ON sq.id = r.sales_quote_id
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sq FROM sales_quotes sq
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE pol FROM supplier_purchase_order_lines pol
       JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
       JOIN selections s ON s.id = po.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE po FROM supplier_purchase_orders po
       JOIN selections s ON s.id = po.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE sl FROM selection_lines sl
       JOIN selections s ON s.id = sl.selection_id
       WHERE s.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM selections WHERE rfq_id = ?', [id])
    await conn.execute(
      `DELETE sgi FROM shipment_group_items sgi
       JOIN shipment_groups sg ON sg.id = sgi.shipment_group_id
       WHERE sg.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE es FROM economic_scenarios es
       JOIN shipment_groups sg ON sg.id = es.shipment_group_id
       WHERE sg.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM shipment_groups WHERE rfq_id = ?', [id])
    await conn.execute('DELETE FROM landed_cost_snapshots WHERE rfq_id = ?', [id])
    await conn.execute(
      `DELETE lsi FROM rfq_line_scorecard_items lsi
       JOIN rfq_line_scorecards lsc ON lsc.id = lsi.rfq_line_scorecard_id
       JOIN rfq_response_lines rl ON rl.id = lsc.rfq_response_line_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE lsc FROM rfq_line_scorecards lsc
       JOIN rfq_response_lines rl ON rl.id = lsc.rfq_response_line_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE ssi FROM rfq_supplier_scorecard_items ssi
       JOIN rfq_supplier_scorecards ssc ON ssc.id = ssi.rfq_supplier_scorecard_id
       WHERE ssc.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM rfq_supplier_scorecards WHERE rfq_id = ?', [id])
    await conn.execute(
      `
      DELETE FROM supplier_part_prices
       WHERE source_type = 'RFQ_RESPONSE'
         AND (
           source_id = ?
           OR EXISTS (
             SELECT 1
               FROM rfq_response_lines rl
               JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
               JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
               JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
              WHERE rl.id = supplier_part_prices.source_id
                AND rs.rfq_id = ?
           )
           OR EXISTS (
             SELECT 1
               FROM rfq_response_revisions rr
               JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
               JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
              WHERE rr.id = supplier_part_prices.source_id
                AND rs.rfq_id = ?
           )
           OR EXISTS (
             SELECT 1
               FROM rfq_supplier_responses rsr
               JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
              WHERE rsr.id = supplier_part_prices.source_id
                AND rs.rfq_id = ?
           )
           OR EXISTS (
             SELECT 1
               FROM rfq_suppliers rs
              WHERE rs.id = supplier_part_prices.source_id
                AND rs.rfq_id = ?
           )
         )
      `,
      [id, id, id, id, id]
    )
    await conn.execute(
      `
      DELETE FROM supplier_part_prices
       WHERE source_type = 'RFQ'
         AND (
           source_id = ?
           OR EXISTS (
             SELECT 1
               FROM rfq_revisions rv
              WHERE rv.id = supplier_part_prices.source_id
                AND rv.rfq_id = ?
           )
           OR EXISTS (
             SELECT 1
               FROM rfq_suppliers rs
              WHERE rs.id = supplier_part_prices.source_id
                AND rs.rfq_id = ?
           )
           OR EXISTS (
             SELECT 1
               FROM rfq_items ri
              WHERE ri.id = supplier_part_prices.source_id
                AND ri.rfq_id = ?
           )
         )
      `,
      [id, id, id, id]
    )
    await conn.execute(
      `DELETE rl FROM rfq_response_lines rl
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rr FROM rfq_response_revisions rr
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute(
      `DELETE rsr FROM rfq_supplier_responses rsr
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM rfq_suppliers WHERE rfq_id = ?', [id])
    try {
      await conn.execute(
        `DELETE ric FROM rfq_item_components ric
         JOIN rfq_items ri ON ri.id = ric.rfq_item_id
         WHERE ri.rfq_id = ?`,
        [id]
      )
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e
    }
    await conn.execute(
      `DELETE ris FROM rfq_item_strategies ris
       JOIN rfq_items ri ON ri.id = ris.rfq_item_id
       WHERE ri.rfq_id = ?`,
      [id]
    )
    await conn.execute('DELETE FROM rfq_items WHERE rfq_id = ?', [id])
    await conn.execute('DELETE FROM rfqs WHERE id = ?', [id])

    if (requestId) {
      await updateRequestStatus(conn, requestId)
    }

    await conn.commit()
    res.json({ success: true })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /rfqs/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.post('/:id/suppliers/bulk', async (req, res) => {
  const rfqId = toId(req.params.id)
  if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const supplierIds = Array.isArray(req.body?.supplier_ids)
    ? req.body.supplier_ids.map(toId).filter(Boolean)
    : []
  if (!supplierIds.length) {
    return res.status(400).json({ message: 'Нужно выбрать хотя бы одного поставщика' })
  }

  const status = nz(req.body.status) || 'invited'
  const invited_at = nz(req.body.invited_at)
  const note = nz(req.body.note)
  const language = (nz(req.body.language) || 'ru').toLowerCase()
  const rfq_format = normalizeRfqFormat(req.body.rfq_format)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    let inserted = 0

    for (const supplier_id of supplierIds) {
      const [result] = await conn.execute(
        `INSERT IGNORE INTO rfq_suppliers (rfq_id, supplier_id, status, invited_at, note, language, rfq_format)
         VALUES (?,?,?,?,?,?,?)`,
        [rfqId, supplier_id, status, invited_at, note, language, rfq_format]
      )
      inserted += result.affectedRows || 0
    }

    await conn.commit()
    res.json({ success: true, inserted })
  } catch (e) {
    await conn.rollback()
    console.error('POST /rfqs/:id/suppliers/bulk error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.get('/:id/documents', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `
      SELECT * FROM (
        SELECT d.*,
               rs.supplier_id,
               ps.name AS supplier_name,
               ROW_NUMBER() OVER (
                 PARTITION BY d.rfq_supplier_id, d.document_type
                 ORDER BY d.created_at DESC, d.id DESC
               ) AS rn
          FROM rfq_documents d
          LEFT JOIN rfq_suppliers rs ON rs.id = d.rfq_supplier_id
          LEFT JOIN part_suppliers ps ON ps.id = rs.supplier_id
         WHERE d.rfq_id = ?
      ) t
      WHERE t.rn = 1
      ORDER BY t.created_at DESC, t.id DESC
      `,
      [rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/documents error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/send', async (req, res) => {
  try {
    logger.debug('POST /rfqs/:id/send', {
      rfqId: req.params.id,
      userId: req.user?.id || null,
    })
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const storageAvailable = !!(bucket && bucketName)

    const [[rfq]] = await db.execute(
      `SELECT r.*,
              cr.rev_number,
              req.client_id,
              c.company_name AS client_name
         FROM rfqs r
         JOIN client_request_revisions cr ON cr.id = r.client_request_revision_id
         JOIN client_requests req ON req.id = cr.client_request_id
         JOIN clients c ON c.id = req.client_id
        WHERE r.id = ?`,
      [rfqId]
    )
    if (!rfq) return res.status(404).json({ message: 'RFQ не найден' })

    const structure = await buildRfqMasterStructure(db, rfqId)
    const items = Array.isArray(structure?.items) ? structure.items : []
    if (!items.length) {
      return res.status(400).json({ message: 'В RFQ нет строк для отправки' })
    }
    {
      const conn = await db.getConnection()
      try {
        await syncLineStatusesForRfq(conn, rfqId)
      } finally {
        conn.release()
      }
    }

    const excelRows = buildRfqExcelRows(structure)
    const currentLines = await fetchClientRevisionLines(rfq.client_request_revision_id)
    const mode =
      String(req.body?.mode || 'full')
        .trim()
        .toLowerCase() === 'delta'
        ? 'delta'
        : 'full'
    const includePriced = !!req.body?.include_priced

    const supplierIds = Array.isArray(req.body?.supplier_ids)
      ? req.body.supplier_ids.map(toId).filter(Boolean)
      : []

    const [supplierRows] = await db.execute(
      `SELECT rs.*,
              ps.name AS supplier_name,
              ps.default_pickup_location,
              ps.payment_terms,
              sc.name AS contact_person,
              sc.email AS contact_email,
              sc.phone AS contact_phone
         FROM rfq_suppliers rs
         JOIN part_suppliers ps ON ps.id = rs.supplier_id
         LEFT JOIN (
           SELECT sc1.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY supplier_id
                    ORDER BY is_primary DESC, created_at DESC, id DESC
                  ) AS rn
           FROM supplier_contacts sc1
         ) sc ON sc.supplier_id = ps.id AND sc.rn = 1
        WHERE rs.rfq_id = ?
        ORDER BY rs.id ASC`,
      [rfqId]
    )

    const selectedSuppliers = supplierIds.length
      ? supplierRows.filter((s) => supplierIds.includes(s.supplier_id))
      : supplierRows

    if (!selectedSuppliers.length) {
      return res.status(400).json({ message: 'Не выбраны поставщики для отправки' })
    }

    // last sent revision per supplier (rfq_supplier_revision_state)
    const supplierStateMap = new Map()
    if (selectedSuppliers.length) {
      const ids = selectedSuppliers.map((s) => s.id)
      const placeholders = ids.map(() => '?').join(',')
      const [stateRows] = await db.execute(
        `SELECT rfq_supplier_id, last_sent_rfq_revision_id
           FROM rfq_supplier_revision_state
          WHERE rfq_supplier_id IN (${placeholders})`,
        ids
      )
      stateRows.forEach((row) => supplierStateMap.set(row.rfq_supplier_id, row))
    }

    // preload metadata for previous revisions
    const prevRevisionIds = [
      ...new Set(
        selectedSuppliers
          .map((s) => supplierStateMap.get(s.id)?.last_sent_rfq_revision_id)
          .filter(Boolean)
      ),
    ]
    const revisionMeta = new Map()
    if (prevRevisionIds.length) {
      const placeholders = prevRevisionIds.map(() => '?').join(',')
      const [rows] = await db.execute(
        `SELECT id, client_request_revision_id, rev_number
           FROM rfq_revisions
          WHERE id IN (${placeholders})`,
        prevRevisionIds
      )
      rows.forEach((row) => revisionMeta.set(row.id, row))
    }

    const prevLinesByClientRev = new Map()
    const getPrevLines = async (clientRevId) => {
      if (!clientRevId) return []
      if (prevLinesByClientRev.has(clientRevId)) return prevLinesByClientRev.get(clientRevId)
      const rows = await fetchClientRevisionLines(clientRevId)
      prevLinesByClientRev.set(clientRevId, rows)
      return rows
    }

    const itemMap = new Map(items.map((i) => [Number(i.rfq_item_id), i]))

    const supplierIdList = [...new Set(selectedSuppliers.map((s) => s.supplier_id))]
    const originalIds = excelRows
      .map((row) => row.original_part_id)
      .filter((id) => Number.isInteger(id) && id > 0)
    const bundleItemIds = excelRows
      .map((row) => row.bundle_item_id)
      .filter((id) => Number.isInteger(id) && id > 0)

    const linksBySupplier = new Map()
    const bundleLinksBySupplier = new Map()

    if (originalIds.length && supplierIdList.length) {
      const uniqueOriginalIds = [...new Set(originalIds)]
      const placeholdersOrig = uniqueOriginalIds.map(() => '?').join(',')
      const placeholdersSup = supplierIdList.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT spo.original_part_id,
               sp.supplier_id,
               sp.supplier_part_number,
               sp.description_ru,
               sp.description_en,
               sp.part_type,
               sp.weight_kg,
               sp.length_cm,
               sp.width_cm,
               sp.height_cm,
               sp.is_overweight,
               sp.is_oversize
          FROM supplier_part_originals spo
          JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
         WHERE spo.original_part_id IN (${placeholdersOrig})
           AND sp.supplier_id IN (${placeholdersSup})
        `,
        [...uniqueOriginalIds, ...supplierIdList]
      )
      rows.forEach((row) => {
        const key = `${row.supplier_id}:${row.original_part_id}`
        if (!linksBySupplier.has(key)) linksBySupplier.set(key, [])
        linksBySupplier.get(key).push(row)
      })
    }

    if (bundleItemIds.length && supplierIdList.length) {
      const uniqueBundleIds = [...new Set(bundleItemIds)]
      const placeholdersItems = uniqueBundleIds.map(() => '?').join(',')
      const placeholdersSup = supplierIdList.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT sbl.item_id AS bundle_item_id,
               sp.supplier_id,
               sp.supplier_part_number,
               sp.description_ru,
               sp.description_en,
               sp.part_type,
               sp.weight_kg,
               sp.length_cm,
               sp.width_cm,
               sp.height_cm,
               sp.is_overweight,
               sp.is_oversize
          FROM supplier_bundle_item_links sbl
          JOIN supplier_parts sp ON sp.id = sbl.supplier_part_id
         WHERE sbl.item_id IN (${placeholdersItems})
           AND sp.supplier_id IN (${placeholdersSup})
        `,
        [...uniqueBundleIds, ...supplierIdList]
      )
      rows.forEach((row) => {
        const key = `${row.supplier_id}:${row.bundle_item_id}`
        if (!bundleLinksBySupplier.has(key)) bundleLinksBySupplier.set(key, [])
        bundleLinksBySupplier.get(key).push(row)
      })
    }

    const selectionsBySupplier = new Map()
    if (selectedSuppliers.length) {
      const supplierKeys = selectedSuppliers.map((s) => s.id)
      const placeholders = supplierKeys.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT *
          FROM rfq_supplier_line_selections
         WHERE rfq_supplier_id IN (${placeholders})
         ORDER BY id ASC
        `,
        supplierKeys
      )
      rows.forEach((row) => {
        const list = selectionsBySupplier.get(row.rfq_supplier_id) || []
        list.push(row)
        selectionsBySupplier.set(row.rfq_supplier_id, list)
      })
    }

    const lineStatusBySupplier = new Map()
    const activeItemIds = [...new Set(items.map((item) => Number(item.rfq_item_id)).filter(Boolean))]
    if (selectedSuppliers.length && activeItemIds.length) {
      const supplierKeys = selectedSuppliers.map((s) => s.id)
      const placeholdersSup = supplierKeys.map(() => '?').join(',')
      const placeholdersItems = activeItemIds.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT rfq_supplier_id, rfq_item_id, status
          FROM rfq_supplier_line_status
         WHERE rfq_supplier_id IN (${placeholdersSup})
           AND rfq_item_id IN (${placeholdersItems})
        `,
        [...supplierKeys, ...activeItemIds]
      )
      rows.forEach((row) => {
        const key = `${row.rfq_supplier_id}:${row.rfq_item_id}`
        lineStatusBySupplier.set(key, String(row.status || 'REQUEST').toUpperCase())
      })
    }

    const documents = []
    const dispatches = []
    const errors = []
    const created_by_user_id = toId(req.user?.id)

    for (const supplier of selectedSuppliers) {
      try {
        const supplierSelectionsAll = selectionsBySupplier.get(supplier.id) || []
        const supplierSelections = supplierSelectionsAll.filter(
          (sel) => Number(sel.use_existing_price) !== 1
        )
        const lastSentRevisionId =
          supplierStateMap.get(supplier.id)?.last_sent_rfq_revision_id || null
        const prevClientRevId = lastSentRevisionId
          ? revisionMeta.get(lastSentRevisionId)?.client_request_revision_id || null
          : null
        const prevLines = prevClientRevId ? await getPrevLines(prevClientRevId) : []
        const lineStatuses = lastSentRevisionId
          ? diffRevisionLines(currentLines, prevLines)
          : new Map(currentLines.map((row) => [Number(row.line_number), 'NEW']))

        const deltaLineSet = new Set(lineStatuses.keys())

        const pricedLines = includePriced
          ? new Set()
          : await fetchPricedLineNumbers(rfq.id, supplier.supplier_id)
        let requestItems = []
        if (mode === 'delta') {
          const deltaItems = items.filter((item) =>
            deltaLineSet.has(Number(item.line_number))
          )

          if (supplierSelectionsAll.length) {
            const selectedItemIds = new Set(
              supplierSelections
                .map((sel) => Number(sel.rfq_item_id))
                .filter((id) => Number.isFinite(id) && id > 0)
            )
            const selectedAllItemIds = new Set(
              supplierSelectionsAll
                .map((sel) => Number(sel.rfq_item_id))
                .filter((id) => Number.isFinite(id) && id > 0)
            )

            requestItems = deltaItems.filter((item) => {
              const itemId = Number(item.rfq_item_id)
              if (selectedItemIds.has(itemId)) return true
              // Если по новой строке еще не сохраняли структуру, отправляем ее по умолчанию.
              if (!selectedAllItemIds.has(itemId)) return true
              return false
            })
          } else {
            requestItems = deltaItems.filter((item) => {
              const status =
                lineStatusBySupplier.get(`${supplier.id}:${item.rfq_item_id}`) || 'REQUEST'
              return status === 'REQUEST'
            })
          }
        } else if (supplierSelectionsAll.length) {
          const selectedItemIds = new Set(
            supplierSelections
              .map((sel) => Number(sel.rfq_item_id))
              .filter((id) => Number.isFinite(id) && id > 0)
          )
          requestItems = items.filter((item) => selectedItemIds.has(Number(item.rfq_item_id)))
        } else {
          requestItems = items.filter((item) => {
            const status =
              lineStatusBySupplier.get(`${supplier.id}:${item.rfq_item_id}`) || 'REQUEST'
            return status === 'REQUEST'
          })
        }
        requestItems = requestItems.filter((item) => {
          // Если есть явный выбор строк у поставщика, use_existing_price уже отфильтрован
          // на уровне line-selections. В этом режиме нельзя отбрасывать целую позицию
          // по line_number, иначе теряются "смешанные" случаи (часть строк принять ценой,
          // часть отправить в запрос).
          if (!supplierSelectionsAll.length && !includePriced && pricedLines.has(Number(item.line_number))) {
            return false
          }
          return true
        })
        const requestLineNumbers = new Set(requestItems.map((i) => Number(i.line_number)))

        const effectiveExcelRows = excelRows.filter((row) =>
          requestLineNumbers.has(Number(row.line_number))
        )

        if (!effectiveExcelRows.length) {
          errors.push({
            supplier_id: supplier.supplier_id,
            supplier_name: supplier.supplier_name,
            message:
              mode === 'delta'
                ? 'Нет новых или изменённых позиций для отправки'
                : 'Нет строк со статусом "В запрос" для отправки',
          })
          continue
        }

        const itemsToUse = requestItems
        const itemMapLocal = new Map(itemsToUse.map((i) => [Number(i.rfq_item_id), i]))

        const lang = (supplier.language || 'ru').toLowerCase()
        const langSuffix = lang === 'en' ? 'EN' : 'RU'
        const format = normalizeRfqFormat(supplier.rfq_format)
        const labels =
          lang === 'en'
            ? {
                note:
                  'Note: options (supply as whole / BOM / kit) are alternatives. Fill prices only for selected options.',
                header: [
                  'Line',
                  'Part No.',
                  'Description',
                  'Qty',
                  'UoM',
                  'Supplier PN',
                  'Supplier Description',
                  'Offer type (OEM/ANALOG)',
                  'Reply status',
                  'Price',
                  'Currency',
                  'Lead time (days)',
                  'Weight, kg',
                  'Length, cm',
                  'Width, cm',
                  'Height, cm',
                  'Heavy',
                  'Oversize',
                  'MOQ',
                  'Pack',
                  'Incoterms',
                  'Payment terms',
                  'Price validity (days)',
                  'Comment',
                ],
                role: 'Role',
                kit: 'Supply as kit',
                bom: 'Supply as BOM',
              }
            : {
                note:
                  'Примечание: варианты (поставка целиком / по составу / комплектом) — альтернативы. Заполняйте цены только для выбранных вариантов.',
                header: [
                  'Строка',
                  'Кат. номер',
                  'Описание',
                  'Кол-во',
                  'Ед.',
                  'Деталь поставщика (PN)',
                  'Описание поставщика',
                  'Тип предложения (OEM/ANALOG)',
                  'Статус ответа',
                  'Цена',
                  'Валюта',
                  'Срок (дн.)',
                  'Вес, кг',
                  'Длина, см',
                  'Ширина, см',
                  'Высота, см',
                  'Тяжелая',
                  'Негабарит',
                  'MOQ',
                  'Упаковка',
                  'Incoterms',
                  'Условия оплаты',
                  'Срок действия цены (дн.)',
                  'Комментарий',
                ],
                role: 'Роль',
                kit: 'Поставка комплектом',
                bom: 'Поставка по составу',
              }

        if (supplierSelections.length) {
          labels.note =
            lang === 'en'
              ? 'Fill prices only for selected lines.'
              : 'Заполняйте цены только для выбранных строк.'
        }

        const pickDesc = (row) => {
          if (!row) return ''
          if (lang === 'en') {
            return row.description_en || row.description || row.description_ru || ''
          }
          return row.description_ru || row.description || row.description_en || ''
        }

        const workbook = new ExcelJS.Workbook()
        const sheet = workbook.addWorksheet('RFQ')

        const headerLabels =
          lang === 'en'
            ? {
                rfq: 'RFQ',
                revision: 'Revision',
                date: 'Date',
                supplier: 'Supplier',
                contact: 'Contact',
                company: 'Our company',
                email: 'Email',
                phone: 'Phone',
                website: 'Website',
                address: 'Address',
              }
            : {
                rfq: 'RFQ',
                revision: 'Ревизия',
                date: 'Дата',
                supplier: 'Поставщик',
                contact: 'Контакт',
                company: 'Наша компания',
                email: 'Email',
                phone: 'Телефон',
                website: 'Сайт',
                address: 'Адрес',
              }

        const headerRows = [
          [headerLabels.rfq, rfq.rfq_number || `RFQ-${rfq.id}`],
          [headerLabels.revision, rfq.rev_number || ''],
          [headerLabels.date, fmtDate(new Date())],
          [headerLabels.supplier, supplier.supplier_name || ''],
        ]

        if (supplier.contact_person || supplier.contact_email || supplier.contact_phone) {
          const contactLine = [
            supplier.contact_person || '',
            supplier.contact_email || '',
            supplier.contact_phone || '',
          ]
            .filter(Boolean)
            .join(' / ')
          headerRows.push([headerLabels.contact, contactLine])
        }

        if (COMPANY_INFO.name) headerRows.push([headerLabels.company, COMPANY_INFO.name])
        if (COMPANY_INFO.email) headerRows.push([headerLabels.email, COMPANY_INFO.email])
        if (COMPANY_INFO.phone) headerRows.push([headerLabels.phone, COMPANY_INFO.phone])
        if (COMPANY_INFO.website) headerRows.push([headerLabels.website, COMPANY_INFO.website])
        if (COMPANY_INFO.address) headerRows.push([headerLabels.address, COMPANY_INFO.address])

        headerRows.forEach((row) => sheet.addRow(row))
        sheet.addRow([])

        const noteRow = sheet.addRow([labels.note])
        noteRow.font = { italic: true }
        noteRow.alignment = { wrapText: true }
        sheet.mergeCells(noteRow.number, 1, noteRow.number, labels.header.length)
        const validationHintRow = sheet.addRow([
          lang === 'en'
            ? 'Required fields for quoted rows: Line (already prefilled), Price, Currency. If no price is available, set Reply status (Out of stock / Discontinued / Needs clarification / No response) and leave Price/Currency empty.'
            : 'Для строки с ценой обязательны: Строка (уже заполнена), Цена, Валюта. Если цену дать нельзя — выберите Статус ответа (Нет в наличии / Снят с производства / Требует уточнения / Без ответа) и оставьте Цена/Валюта пустыми.',
        ])
        validationHintRow.font = { italic: true, color: { argb: 'FF666666' } }
        validationHintRow.alignment = { wrapText: true }
        sheet.mergeCells(validationHintRow.number, 1, validationHintRow.number, labels.header.length)
        sheet.addRow([])

        sheet.addRow(labels.header)
        const tableHeaderRowNumber = sheet.lastRow.number
        const tableHeaderRow = sheet.getRow(tableHeaderRowNumber)
        tableHeaderRow.height = 24
        for (let col = 1; col <= labels.header.length; col += 1) {
          const cell = tableHeaderRow.getCell(col)
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E4E8C' },
          }
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        }
        const firstDataRow = tableHeaderRowNumber + 1
        sheet.views = [{ state: 'frozen', ySplit: tableHeaderRowNumber }]
        sheet.autoFilter = {
          from: { row: tableHeaderRowNumber, column: 1 },
          to: { row: tableHeaderRowNumber, column: labels.header.length },
        }

        const pickHintValue = (hints, field) => {
          const values = hints
            .map((hint) => hint[field])
            .filter((value) => value !== null && value !== undefined && value !== '')
          if (!values.length) return ''
          const uniq = [...new Set(values.map((value) => String(value)))]
          if (uniq.length === 1) return values[0]
          return ''
        }

        const displayUom = (value) => {
          if (!value) return ''
          const normalized = String(value).trim().toLowerCase()
          if (lang === 'ru' && normalized === 'pcs') return 'шт'
          return value
        }

        let lineCounter = 0
        const defaultPaymentTerms = supplier.payment_terms || ''
        const isPositionRow = (row) =>
          ['DEMAND', 'BOM_COMPONENT', 'KIT_ROLE'].includes(String(row.type || '').toUpperCase())
        const displayBoolFlag = (value) => {
          const normalized = parseFlagTinyint(value)
          if (normalized === 1) return lang === 'en' ? 'Yes' : 'Да'
          if (normalized === 0) return lang === 'en' ? 'No' : 'Нет'
          return ''
        }
        const addOptionRow = (row, hints) => {
          const hintNumbers = hints
            .map((h) => h.supplier_part_number)
            .filter(Boolean)
            .join(', ')
          const hintDescriptions = hints
            .map((h) =>
              lang === 'en'
                ? h.description_en || h.description_ru
                : h.description_ru || h.description_en
            )
            .filter(Boolean)
            .join(', ')

          const weightKg = pickHintValue(hints, 'weight_kg')
          const lengthCm = pickHintValue(hints, 'length_cm')
          const widthCm = pickHintValue(hints, 'width_cm')
          const heightCm = pickHintValue(hints, 'height_cm')
          const heavyFlag = displayBoolFlag(pickHintValue(hints, 'is_overweight'))
          const oversizeFlag = displayBoolFlag(pickHintValue(hints, 'is_oversize'))

          const displayDescription = row.description || row.role_label || ''

          const addedRow = sheet.addRow([
            isPositionRow(row) ? ++lineCounter : '',
            row.cat_number || '',
            displayDescription,
            row.qty ?? '',
            displayUom(row.uom || ''),
            hintNumbers,
            hintDescriptions,
            '',
            '',
            '',
            '',
            '',
            weightKg,
            lengthCm,
            widthCm,
            heightCm,
            heavyFlag,
            oversizeFlag,
            '',
            '',
            '',
            defaultPaymentTerms,
            '',
            '',
          ])

          if (row.type === 'DEMAND') {
            addedRow.font = { bold: true }
            addedRow.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF3F6FF' },
            }
          } else if (row.indent === 1) {
            addedRow.font = { italic: true }
            addedRow.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF7F7F7' },
            }
          }
        }

    if (supplierSelections.length) {
      const altIds = [
        ...new Set(
          supplierSelections
            .map((sel) => toId(sel.alt_original_part_id))
            .filter(Boolean)
        ),
      ]
      const altInfoMap = new Map()
      if (altIds.length) {
        const placeholders = altIds.map(() => '?').join(',')
        const [altRows] = await db.execute(
          `
            SELECT id, cat_number, description_ru, description_en
              FROM original_parts
             WHERE id IN (${placeholders})
          `,
          altIds
        )
        altRows.forEach((row) => {
          altInfoMap.set(row.id, {
            cat_number: row.cat_number || '',
            description_ru: row.description_ru || '',
            description_en: row.description_en || '',
          })
        })
      }

      const nonDemandByItem = new Map()
      const selectedBomByItem = new Map()
      const altSelectedByKey = new Set()
      supplierSelections.forEach((sel) => {
        const type = String(sel.line_type || '').toUpperCase()
        if (type !== 'DEMAND' && sel.rfq_item_id) {
          nonDemandByItem.set(sel.rfq_item_id, true)
        }
        if (sel.alt_original_part_id && sel.rfq_item_id) {
          const originalId = toId(sel.original_part_id)
          if (originalId) {
            altSelectedByKey.add(`${sel.rfq_item_id}:${type}:${originalId}`)
          }
        }
        if (type === 'BOM_COMPONENT' && sel.rfq_item_id) {
          const partId = toId(sel.original_part_id)
          if (partId) {
            const set = selectedBomByItem.get(sel.rfq_item_id) || new Set()
            set.add(partId)
            selectedBomByItem.set(sel.rfq_item_id, set)
          }
        }
      })

      const descendantsByItem = new Map()
      itemsToUse.forEach((item) => {
        const bomOpt = (item.options || []).find((opt) => opt.type === 'BOM')
        const rootNodes = Array.isArray(bomOpt?.children) ? bomOpt.children : []
        const partMap = new Map()
        const dfs = (node) => {
          const id = toId(node?.original_part_id)
          if (!id) return new Set()
          const descendants = new Set()
          ;(node.children || []).forEach((child) => {
            const childId = toId(child?.original_part_id)
            if (childId) descendants.add(childId)
            const childDesc = dfs(child)
            childDesc.forEach((d) => descendants.add(d))
          })
          partMap.set(id, descendants)
          return descendants
        }
        rootNodes.forEach((node) => dfs(node))
        descendantsByItem.set(item.rfq_item_id, partMap)
      })

      const explicitSelectionLineNumbers = new Set()
      supplierSelectionsAll.forEach((sel) => {
        const selectedItem = itemMapLocal.get(Number(sel.rfq_item_id))
        if (!selectedItem) return
        explicitSelectionLineNumbers.add(Number(selectedItem.line_number))
      })

      supplierSelections.forEach((sel) => {
        const selectedItem = itemMapLocal.get(Number(sel.rfq_item_id))
        if (!selectedItem) return
        if (!requestLineNumbers.has(Number(selectedItem.line_number))) {
          return
        }
        const type = String(sel.line_type || '').toUpperCase()
        const originalId = toId(sel.original_part_id)
        if (
          type === 'DEMAND' &&
          (nonDemandByItem.get(sel.rfq_item_id) ||
            (originalId && altSelectedByKey.has(`${sel.rfq_item_id}:${type}:${originalId}`)))
        ) {
          return
        }
        if (!sel.alt_original_part_id && originalId) {
          const altKey = `${sel.rfq_item_id}:${type}:${originalId}`
          if (altSelectedByKey.has(altKey)) {
            return
          }
        }
        if (type === 'BOM_COMPONENT') {
          const partId = originalId
          if (partId) {
            const partMap = descendantsByItem.get(sel.rfq_item_id)
            const descendants = partMap?.get(partId)
            if (descendants && descendants.size) {
              const selectedSet = selectedBomByItem.get(sel.rfq_item_id)
              if (selectedSet) {
                for (const d of descendants) {
                  if (selectedSet.has(d)) {
                    return
                  }
                }
              }
            }
          }
        }
        const item = itemMapLocal.get(Number(sel.rfq_item_id)) || {}
        const effectivePartId = toId(sel.alt_original_part_id) || toId(sel.original_part_id)
        const altInfo = effectivePartId ? altInfoMap.get(effectivePartId) : null
        const lineLabel =
          sel.line_label ||
          (sel.line_type === 'DEMAND'
            ? item.original_cat_number || item.client_part_number || ''
            : '')
        const description =
          sel.line_description ||
          (sel.line_type === 'DEMAND' ? pickDesc(item) : '') ||
          ''
        const row = {
          type: sel.line_type,
          cat_number:
            sel.line_type === 'KIT_ROLE'
              ? ''
              : (altInfo?.cat_number || lineLabel),
          role_label: sel.line_type === 'KIT_ROLE' ? lineLabel : '',
          description:
            sel.line_type === 'KIT_ROLE'
              ? description
              : altInfo
              ? pickDesc({
                  description_ru: altInfo.description_ru,
                  description_en: altInfo.description_en,
                })
              : description,
          qty: sel.qty ?? '',
          uom: sel.uom || item.uom || '',
          original_part_id: effectivePartId || null,
          bundle_item_id: sel.bundle_item_id || null,
          indent: 0,
        }
        let hints = []
        if (row.original_part_id) {
              const key = `${supplier.supplier_id}:${row.original_part_id}`
              hints = linksBySupplier.get(key) || []
            } else if (row.bundle_item_id) {
              const key = `${supplier.supplier_id}:${row.bundle_item_id}`
              hints = bundleLinksBySupplier.get(key) || []
            }
            addOptionRow(row, hints)
          })

      const missingSelectionLines = [...requestLineNumbers].filter(
        (line) => !explicitSelectionLineNumbers.has(Number(line))
      )
      if (missingSelectionLines.length) {
        const missingSet = new Set(missingSelectionLines.map((line) => Number(line)))
        effectiveExcelRows.forEach((row) => {
          const lineNumber = Number(row.line_number)
          if (!missingSet.has(lineNumber)) return
          if (!isPositionRow(row)) return
          let hints = []
          if (toId(row.original_part_id)) {
            const key = `${supplier.supplier_id}:${toId(row.original_part_id)}`
            hints = linksBySupplier.get(key) || []
          } else if (toId(row.bundle_item_id)) {
            const key = `${supplier.supplier_id}:${toId(row.bundle_item_id)}`
            hints = bundleLinksBySupplier.get(key) || []
          }
          addOptionRow(
            {
              ...row,
              cat_number: row.label || row.cat_number || '',
              role_label: row.type === 'KIT_ROLE' ? row.label || '' : '',
              description: row.description || '',
              indent: 0,
            },
            hints
          )
        })
      }
        } else {
          let kitLineNumber = format === 'kit' ? 1 : null

          for (const item of itemsToUse) {
            const options = Array.isArray(item.options) ? item.options : []
            const bomOption = options.find((opt) => opt.type === 'BOM')
            const kitOption = options.find((opt) => opt.type === 'KIT')
            const bomAvailable = !!(bomOption && bomOption.available)
            const kitAvailable = (item.bundle_count || 0) > 0
            const hasBOM =
              format === 'bom'
                ? bomAvailable
                : format === 'auto'
                ? bomAvailable && bomOption.enabled
                : false
            const hasKIT =
              format === 'kit'
                ? kitAvailable
                : format === 'auto'
                ? kitAvailable && (kitOption.enabled || item.selected_bundle_id)
                : false

            if (format === 'kit' && hasKIT) {
              const bundleId =
                toId(item.selected_bundle_id) ||
                (Array.isArray(item.bundle_ids) && item.bundle_ids.length === 1
                  ? item.bundle_ids[0]
                  : null)
              if (bundleId) {
                const [roleRows] = await db.execute(
                  `
                  SELECT id, role_label, qty
                    FROM supplier_bundle_items
                   WHERE bundle_id = ?
                   ORDER BY sort_order, id
                  `,
                  [bundleId]
                )
                roleRows.forEach((role) => {
                  const lineNumber = kitLineNumber ?? item.line_number
                  if (kitLineNumber !== null) kitLineNumber += 1
                  const row = {
                    line_number: lineNumber,
                    type: 'KIT_ROLE',
                    cat_number: '',
                    role_label: role.role_label || '',
                    description: role.role_label || '',
                    qty: role.qty ? numOr(role.qty, 1) * numOr(item.requested_qty, 1) : item.requested_qty ?? '',
                    uom: item.uom || '',
                    original_part_id: null,
                    bundle_item_id: role.id || null,
                    indent: 0,
                  }
                  addOptionRow(row, [])
                })
                continue
              }
            }

            sheet.addRow([])
            const itemHeaderValues = Array(labels.header.length).fill('')
            itemHeaderValues[0] = ++lineCounter
            itemHeaderValues[1] = `${item.original_cat_number || item.client_part_number || ''}`
            itemHeaderValues[2] = pickDesc(item)
            itemHeaderValues[3] = item.requested_qty ?? ''
            itemHeaderValues[4] = displayUom(item.uom || '')
            const itemHeader = sheet.addRow(itemHeaderValues)
            itemHeader.font = { bold: true }
            itemHeader.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF3F6FF' },
            }

            if (hasBOM) {
              addOptionRow(
                {
                  line_number: item.line_number,
                  type: 'VARIANT',
                  cat_number: '',
                  role_label: labels.bom,
                  description: '',
                  qty: '',
                  uom: '',
                  original_part_id: null,
                  bundle_item_id: null,
                  indent: 1,
                },
                []
              )

              const opt = bomOption
              if (opt?.children?.length) {
                const addBomRows = (nodes, depth = 1) => {
                  if (!Array.isArray(nodes)) return
                  nodes.forEach((node) => {
                    const row = {
                      line_number: item.line_number,
                      type: 'BOM_COMPONENT',
                      cat_number: node.cat_number || '',
                      role_label: '',
                      description: pickDesc(node) || '',
                      qty: node.required_qty ?? '',
                      uom: node.uom || item.uom || '',
                      original_part_id: node.original_part_id || null,
                      bundle_item_id: null,
                      indent: depth + 1,
                    }

                    let hints = []
                    if (row.original_part_id) {
                      const key = `${supplier.supplier_id}:${row.original_part_id}`
                      hints = linksBySupplier.get(key) || []
                    }

                    addOptionRow(row, hints)
                    if (node.children?.length) addBomRows(node.children, depth + 1)
                  })
                }
                addBomRows(opt.children || [])
              }
            }

            if (hasKIT) {
              addOptionRow(
                {
                  line_number: item.line_number,
                  type: 'VARIANT',
                  cat_number: '',
                  role_label: labels.kit,
                  description: '',
                  qty: '',
                  uom: '',
                  original_part_id: null,
                  bundle_item_id: null,
                  indent: 1,
                },
                []
              )

              const opt = kitOption
              ;(opt?.children || []).forEach((role) => {
                const row = {
                  line_number: item.line_number,
                  type: 'KIT_ROLE',
                  cat_number: '',
                  role_label: role.role_label || '',
                  description: role.role_label
                    ? `${labels.role}: ${role.role_label}`
                    : '',
                  qty: role.required_qty ?? '',
                  uom: role.uom || item.uom || '',
                  original_part_id: null,
                  bundle_item_id: role.bundle_item_id || null,
                  indent: 2,
                }

                let hints = []
                if (row.bundle_item_id) {
                  const key = `${supplier.supplier_id}:${row.bundle_item_id}`
                  hints = bundleLinksBySupplier.get(key) || []
                }

                addOptionRow(row, hints)
              })
            }
          }
        }

        sheet.columns = [
          { width: 8 },
          { width: 22 },
          { width: 44 },
          { width: 8 },
          { width: 8 },
          { width: 24 },
          { width: 30 },
          { width: 18 },
          { width: 20 },
          { width: 12 },
          { width: 10 },
          { width: 12 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 14 },
          { width: 14 },
          { width: 22 },
          { width: 12 },
          { width: 30 },
        ]

        const lastDataRow = Math.max(sheet.lastRow.number, firstDataRow)
        const offerTypeList = '"OEM,ANALOG,UNKNOWN"'
        const replyStatusList =
          lang === 'en'
            ? '"Price provided,Out of stock,Discontinued,Needs clarification,No response"'
            : '"Цена предоставлена,Нет в наличии,Снят с производства,Требует уточнения,Без ответа"'
        const currencyList = '"EUR,USD,CNY,RUB,TRY,AED"'
        const incotermsList = '"EXW,FCA,FAS,FOB,CFR,CIF,CPT,CIP,DAP,DPU,DDP"'
        const boolList = lang === 'en' ? '"Yes,No"' : '"Да,Нет"'
        const paymentTermsList =
          lang === 'en'
            ? '"100% prepayment,30% prepayment / 70% before shipment,50% prepayment / 50% before shipment,Payment upon shipment,NET 30,NET 45,Letter of Credit,By agreement"'
            : '"100% предоплата,30% предоплата / 70% перед отгрузкой,50% предоплата / 50% перед отгрузкой,Оплата по факту отгрузки,NET 30,NET 45,Аккредитив,По договоренности"'

        const applyListValidation = (columnNumber, formula, label) => {
          for (let rowNumber = firstDataRow; rowNumber <= lastDataRow; rowNumber += 1) {
            const cell = sheet.getCell(rowNumber, columnNumber)
            cell.dataValidation = {
              type: 'list',
              allowBlank: true,
              showErrorMessage: true,
              errorTitle: lang === 'en' ? 'Invalid value' : 'Недопустимое значение',
              error:
                lang === 'en'
                  ? `Choose ${label} from the list.`
                  : `Выберите ${label} из выпадающего списка.`,
              formulae: [formula],
            }
          }
        }

        applyListValidation(8, offerTypeList, lang === 'en' ? 'offer type' : 'тип предложения')
        applyListValidation(9, replyStatusList, lang === 'en' ? 'reply status' : 'статус ответа')
        applyListValidation(11, currencyList, lang === 'en' ? 'currency' : 'валюту')
        applyListValidation(21, incotermsList, 'Incoterms')
        applyListValidation(22, paymentTermsList, lang === 'en' ? 'payment terms' : 'условия оплаты')
        applyListValidation(17, boolList, lang === 'en' ? 'heavy flag' : 'флаг "Тяжелая"')
        applyListValidation(18, boolList, lang === 'en' ? 'oversize flag' : 'флаг "Негабарит"')

        for (let rowNumber = tableHeaderRowNumber; rowNumber <= lastDataRow; rowNumber += 1) {
          for (let col = 1; col <= labels.header.length; col += 1) {
            const cell = sheet.getCell(rowNumber, col)
            cell.border = {
              top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
              left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
              bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
              right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
            }
            if (rowNumber > tableHeaderRowNumber) {
              cell.alignment = { vertical: 'top', wrapText: true }
            }
          }
        }

        const buffer = await workbook.xlsx.writeBuffer()
        const safeSupplier = safeSegment(supplier.supplier_name) || `supplier_${supplier.supplier_id}`
        const revLabel = `Rev${rfq.rev_number || rfq.current_rfq_revision_id || 'X'}`
        const modeLabel = mode === 'delta' ? 'Delta' : 'Full'
        const fileName = `rfq_${rfq.rfq_number || rfq.id}_${revLabel}_${safeSupplier}_${modeLabel}_${fmtDate(new Date())}_${langSuffix}.xlsx`
        const objectFileName = `${safeSegment(fileName.replace(/\.xlsx$/i, '')) || 'rfq_export'}.xlsx`
        let fileUrl = null

        if (storageAvailable) {
          const objectPath = [
            'rfqs',
            String(rfq.id),
            'suppliers',
            String(supplier.supplier_id),
            String(Date.now()),
            objectFileName
          ]
            .map((seg) => encodeURIComponent(seg))
            .join('/')

          await bucket.file(objectPath).save(buffer, {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          })

          fileUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
        }

        const payload = {
          rfq_id: rfq.id,
          supplier_id: supplier.supplier_id,
          supplier_format: format,
          generated_at: new Date().toISOString(),
          items: itemsToUse.map((i) => ({
            line_number: i.line_number,
            original_part_id: i.original_part_id,
            original_cat_number: i.original_cat_number,
            client_part_number: i.client_part_number,
            description: i.description,
            requested_qty: i.requested_qty,
            uom: i.uom,
            bundle_count: i.bundle_count,
            selected_bundle_id: i.selected_bundle_id,
          })),
          structure_rows: effectiveExcelRows,
        }

        const [docIns] = await db.execute(
          `
          INSERT INTO rfq_documents
            (rfq_id, rfq_supplier_id, document_type, file_name, file_type, file_size,
             file_url, template_version, payload_hash, payload_json, created_by_user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `,
          [
            rfq.id,
            supplier.id,
            'rfq',
            fileName,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer.length,
            fileUrl,
            storageAvailable ? 'rfq-structure-v2' : 'rfq-structure-v2-local',
            hashPayload(payload),
            JSON.stringify(payload),
            created_by_user_id,
          ]
        )

        await db.execute(
          `UPDATE rfq_suppliers
              SET status = 'sent',
                  invited_at = COALESCE(invited_at, NOW())
            WHERE id = ?`,
          [supplier.id]
        )

        const [[docRow]] = await db.execute(
          'SELECT * FROM rfq_documents WHERE id = ?',
          [docIns.insertId]
        )
        documents.push(docRow)
        dispatches.push({
          supplier_id: supplier.supplier_id,
          supplier_name: supplier.supplier_name,
          document: docRow,
        })

        await db.execute(
          `INSERT INTO rfq_supplier_dispatches
            (rfq_id, rfq_revision_id, rfq_supplier_id, dispatch_type, document_id, payload_hash, note, sent_by_user_id)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            rfq.id,
            rfq.current_rfq_revision_id || rfq.rfq_revision_id || 0,
            supplier.id,
            mode === 'delta' ? 'DELTA' : 'FULL',
            docIns.insertId,
            hashPayload(payload),
            JSON.stringify({
              rows_total: lineCounter,
              rows_changed: mode === 'delta' ? lineStatuses.size : null,
              mode,
              prev_rfq_revision_id: lastSentRevisionId,
            }),
            created_by_user_id,
          ]
        )

        await db.execute(
          `INSERT INTO rfq_supplier_revision_state
             (rfq_supplier_id, last_sent_rfq_revision_id, state)
           VALUES (?,?, 'sent')
           ON DUPLICATE KEY UPDATE
             last_sent_rfq_revision_id = VALUES(last_sent_rfq_revision_id),
             updated_at = NOW()`,
          [supplier.id, rfq.current_rfq_revision_id || rfq.rfq_revision_id || null]
        )

        const lastRequestRevisionId = rfq.current_rfq_revision_id || rfq.rfq_revision_id || null
        for (const item of itemsToUse) {
          await upsertLineStatus(db, {
            rfqSupplierId: supplier.id,
            rfqItemId: item.rfq_item_id,
            status: 'REQUEST',
            sourceType: null,
            sourceRef: null,
            lastRequestRfqRevisionId: lastRequestRevisionId,
            lastResponseRevisionId: null,
            note: null,
          })
        }
      } catch (err) {
        errors.push({
          supplier_id: supplier.supplier_id,
          supplier_name: supplier.supplier_name,
          message: err?.message || 'Ошибка генерации документа',
        })
      }
    }

    if (documents.length) {
      await db.execute(
        `UPDATE rfqs
            SET status = 'sent',
                sent_at = NOW(),
                sent_by_user_id = ?
          WHERE id = ?`,
        [created_by_user_id, rfqId]
      )
    }

    const requestId = await fetchRequestIdByRfqId(db, rfqId)
    if (requestId) {
      await updateRequestStatus(db, requestId)
    }

    res.json({ success: errors.length === 0, documents, dispatches, errors })
  } catch (e) {
    console.error('POST /rfqs/:id/send error:', e)
    res.status(500).json({ message: 'Ошибка отправки RFQ' })
  }
})

router.get('/:id/dispatches', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const supplierId = toId(req.query.supplier_id)

    const where = ['d.rfq_id = ?']
    const params = [rfqId]
    if (supplierId) {
      where.push('rs.supplier_id = ?')
      params.push(supplierId)
    }

    const [rows] = await db.execute(
      `
      SELECT d.*, rs.supplier_id, ps.name AS supplier_name,
             rr.rev_number,
             doc.file_name, doc.file_url
        FROM rfq_supplier_dispatches d
        JOIN rfq_suppliers rs ON rs.id = d.rfq_supplier_id
        JOIN part_suppliers ps ON ps.id = rs.supplier_id
        LEFT JOIN rfq_revisions rr ON rr.id = d.rfq_revision_id
        LEFT JOIN rfq_documents doc ON doc.id = d.document_id
       WHERE ${where.join(' AND ')}
       ORDER BY d.sent_at DESC, d.id DESC
      `,
      params
    )

    const result = rows.map((row) => {
      let note = {}
      try {
        note = row.note ? JSON.parse(row.note) : {}
      } catch {
        note = {}
      }
      return {
        id: row.id,
        rfq_id: row.rfq_id,
        rfq_supplier_id: row.rfq_supplier_id,
        supplier_id: row.supplier_id,
        supplier_name: row.supplier_name,
        rfq_revision_id: row.rfq_revision_id,
        rfq_revision_number: row.rev_number,
        dispatch_type: row.dispatch_type,
        rows_total: note.rows_total ?? null,
        rows_changed: note.rows_changed ?? null,
        mode: note.mode || row.dispatch_type?.toLowerCase() || 'full',
        prev_rfq_revision_id: note.prev_rfq_revision_id || null,
        document_id: row.document_id,
        file_name: row.file_name,
        file_url: row.file_url,
        sent_by_user_id: row.sent_by_user_id,
        sent_at: row.sent_at,
      }
    })

    res.json(result)
  } catch (e) {
    console.error('GET /rfqs/:id/dispatches error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/dispatch-summary', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[rfq]] = await db.execute(
      `SELECT id, client_request_revision_id, current_rfq_revision_id
         FROM rfqs
        WHERE id = ?`,
      [rfqId]
    )
    if (!rfq) return res.status(404).json({ message: 'RFQ не найден' })

    const currentLines = await fetchClientRevisionLines(rfq.client_request_revision_id)

    const [suppliers] = await db.execute(
      `SELECT rs.*, ps.name AS supplier_name
         FROM rfq_suppliers rs
         JOIN part_suppliers ps ON ps.id = rs.supplier_id
        WHERE rs.rfq_id = ?`,
      [rfqId]
    )

    const supplierIds = suppliers.map((s) => s.id)
    const stateMap = new Map()
    if (supplierIds.length) {
      const placeholders = supplierIds.map(() => '?').join(',')
      const [stateRows] = await db.execute(
        `SELECT * FROM rfq_supplier_revision_state WHERE rfq_supplier_id IN (${placeholders})`,
        supplierIds
      )
      stateRows.forEach((row) => stateMap.set(row.rfq_supplier_id, row))
    }

    const prevRevisionIds = [
      ...new Set(
        suppliers
          .map((s) => stateMap.get(s.id)?.last_sent_rfq_revision_id)
          .filter(Boolean)
      ),
    ]
    const revisionMeta = new Map()
    if (prevRevisionIds.length) {
      const placeholders = prevRevisionIds.map(() => '?').join(',')
      const [rows] = await db.execute(
        `SELECT id, client_request_revision_id, rev_number
           FROM rfq_revisions
          WHERE id IN (${placeholders})`,
        prevRevisionIds
      )
      rows.forEach((row) => revisionMeta.set(row.id, row))
    }

    const prevLinesByClientRev = new Map()
    const getPrevLines = async (clientRevId) => {
      if (!clientRevId) return []
      if (prevLinesByClientRev.has(clientRevId)) return prevLinesByClientRev.get(clientRevId)
      const rows = await fetchClientRevisionLines(clientRevId)
      prevLinesByClientRev.set(clientRevId, rows)
      return rows
    }

    // latest dispatch times
    const lastSentAt = new Map()
    if (supplierIds.length) {
      const placeholders = supplierIds.map(() => '?').join(',')
      const [dispatchRows] = await db.execute(
        `
        SELECT *
        FROM (
          SELECT d.rfq_supplier_id, d.sent_at,
                 ROW_NUMBER() OVER (PARTITION BY d.rfq_supplier_id ORDER BY d.sent_at DESC, d.id DESC) AS rn
            FROM rfq_supplier_dispatches d
           WHERE d.rfq_supplier_id IN (${placeholders})
        ) t
        WHERE t.rn = 1
        `,
        supplierIds
      )
      dispatchRows.forEach((row) => lastSentAt.set(row.rfq_supplier_id, row.sent_at))
    }

    const result = []
    for (const s of suppliers) {
      const state = stateMap.get(s.id)
      const lastSentRevisionId = state?.last_sent_rfq_revision_id || null
      const prevClientRevId = lastSentRevisionId
        ? revisionMeta.get(lastSentRevisionId)?.client_request_revision_id || null
        : null
      const prevLines = prevClientRevId ? await getPrevLines(prevClientRevId) : []
      const statuses = lastSentRevisionId
        ? diffRevisionLines(currentLines, prevLines)
        : new Map(currentLines.map((row) => [Number(row.line_number), 'NEW']))

      const newLinesCount = statuses.size
      const newLineNumbers = Array.from(statuses.keys())
      const revNumber = lastSentRevisionId
        ? revisionMeta.get(lastSentRevisionId)?.rev_number || null
        : null

      result.push({
        rfq_supplier_id: s.id,
        supplier_id: s.supplier_id,
        supplier_name: s.supplier_name,
        last_sent_rfq_revision_id: lastSentRevisionId,
        last_sent_rfq_revision_number: revNumber,
        last_sent_at: lastSentAt.get(s.id) || state?.updated_at || null,
        new_lines_count: newLinesCount,
        new_line_numbers: newLineNumbers,
        has_delta: newLinesCount > 0,
        status: s.status,
        invited_at: s.invited_at,
      })
    }

    res.json(result)
  } catch (e) {
    console.error('GET /rfqs/:id/dispatch-summary error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/suppliers/:supplierId/accept-price', async (req, res) => {
  const rfqId = toId(req.params.id)
  const supplierId = toId(req.params.supplierId)
  const rfqItemId = toId(req.body.rfq_item_id)
  if (!rfqId || !supplierId || !rfqItemId) {
    return res.status(400).json({ message: 'Нужно указать RFQ, поставщика и строку RFQ' })
  }

  const price = Number(req.body.price ?? NaN)
  const currency = nz(req.body.currency)?.toUpperCase()
  const offerTypeRaw = nz(req.body.offer_type)?.toUpperCase()
  const offerType =
    offerTypeRaw === 'OEM' || offerTypeRaw === 'ANALOG' || offerTypeRaw === 'UNKNOWN'
      ? offerTypeRaw
      : 'UNKNOWN'
  const leadTimeDays = toId(req.body.lead_time_days)
  const validityDays = toId(req.body.validity_days)
  const paymentTerms = nz(req.body.payment_terms)
  const incoterms = normalizeIncoterms(req.body.incoterms)
  const note = nz(req.body.note)
  const supplierPartId = toId(req.body.supplier_part_id)
  const originalPartId = toId(req.body.original_part_id)
  const requestedOriginalPartId = toId(req.body.requested_original_part_id)
  const bundleId = toId(req.body.bundle_id)
  const rfqItemComponentId = toId(req.body.rfq_item_component_id)
  const selectionKey = nz(req.body.selection_key)
  const sourceType = nz(req.body.source_type) || null
  const sourceSubtype = nz(req.body.source_subtype) || null
  const sourceRef = nz(req.body.source_ref) || null
  const changeReason = nz(req.body.change_reason) || 'Принята существующая цена'
  const created_by_user_id = toId(req.user?.id)
  const newRevision = req.body?.new_revision === true

  if (!Number.isFinite(price) || !currency) {
    return res.status(400).json({ message: 'Нужны price и currency' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[rfqSupplier]] = await conn.execute(
      `SELECT rs.id
         FROM rfq_suppliers rs
        WHERE rs.rfq_id = ? AND rs.supplier_id = ?`,
      [rfqId, supplierId]
    )
    if (!rfqSupplier?.id) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не привязан к RFQ' })
    }

    const { revisionId } = newRevision
      ? await createSupplierResponseRevision(conn, rfqSupplier.id, {
          userId: created_by_user_id,
          status: 'received',
          note,
        })
      : await ensureSupplierResponseRevision(conn, rfqSupplier.id, {
          userId: created_by_user_id,
          status: 'received',
          note,
        })

    let selectionMeta = null
    if (selectionKey) {
      const [[sel]] = await conn.execute(
        `
        SELECT original_part_id, alt_original_part_id, bundle_id
          FROM rfq_supplier_line_selections
         WHERE rfq_supplier_id = ?
           AND rfq_item_id = ?
           AND selection_key = ?
         LIMIT 1
        `,
        [rfqSupplier.id, rfqItemId, selectionKey]
      )
      selectionMeta = sel || null
    }

    const selectionOriginalPartId = toId(selectionMeta?.original_part_id)
    const selectionAltOriginalPartId = toId(selectionMeta?.alt_original_part_id)
    const resolvedRequestedOriginalPartId =
      requestedOriginalPartId || selectionOriginalPartId || originalPartId || null
    const resolvedOriginalPartId =
      originalPartId || selectionAltOriginalPartId || resolvedRequestedOriginalPartId || null
    const resolvedBundleId = bundleId || toId(selectionMeta?.bundle_id)

    const [ins] = await conn.execute(
      `INSERT INTO rfq_response_lines
        (rfq_response_revision_id, rfq_item_id, selection_key, rfq_item_component_id, supplier_part_id, original_part_id, requested_original_part_id, bundle_id,
         offer_type, supplier_reply_status, offered_qty, moq, packaging, lead_time_days, price, currency, validity_days, payment_terms, incoterms, note, entry_source, change_reason)
       SELECT ?, i.id, ?, ?, ?, COALESCE(?, cri.original_part_id), COALESCE(?, cri.original_part_id), ?,
              ?, 'QUOTED', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED_EXISTING', ?
         FROM rfq_items i
         JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
        WHERE i.id = ? AND i.rfq_id = ?`,
      [
        revisionId,
        selectionKey,
        rfqItemComponentId,
        supplierPartId,
        resolvedOriginalPartId,
        resolvedRequestedOriginalPartId,
        resolvedBundleId,
        offerType,
        leadTimeDays,
        price,
        currency,
        validityDays,
        paymentTerms,
        incoterms,
        note ||
          (sourceType
            ? `Источник: ${sourceType}${sourceSubtype ? `/${sourceSubtype}` : ''}${
                sourceRef ? ` ${sourceRef}` : ''
              }`
            : null),
        changeReason,
        rfqItemId,
        rfqId,
      ]
    )
    if (!Number(ins?.affectedRows || 0)) {
      await conn.rollback()
      return res.status(400).json({ message: 'Строка RFQ не найдена в активной ревизии' })
    }

    const [[created]] = await conn.execute(
      'SELECT * FROM rfq_response_lines WHERE id = ?',
      [ins.insertId]
    )

    await writeResponseLineAction(conn, {
      responseLineId: created.id,
      actionType: 'CREATE',
        payload: {
          source: 'ACCEPTED_EXISTING',
          selection_key: created.selection_key,
          rfq_item_id: created.rfq_item_id,
        original_part_id: resolvedOriginalPartId || created.original_part_id,
        requested_original_part_id:
          resolvedRequestedOriginalPartId || created.requested_original_part_id,
        bundle_id: resolvedBundleId || created.bundle_id,
        supplier_part_id: created.supplier_part_id,
          price: created.price,
          currency: created.currency,
          offer_type: created.offer_type,
          supplier_reply_status: created.supplier_reply_status || 'QUOTED',
          payment_terms: created.payment_terms,
          incoterms: created.incoterms,
        source_type: sourceType,
        source_subtype: sourceSubtype,
        source_ref: sourceRef,
      },
      reason: changeReason,
      createdByUserId: created_by_user_id,
    })

    // фиксируем статус строки
    await upsertLineStatus(conn, {
      rfqSupplierId: rfqSupplier.id,
      rfqItemId,
      status: 'ACCEPTED_EXISTING',
      sourceType,
      sourceRef,
      lastResponseRevisionId: revisionId,
      note,
    })

    // ACCEPTED_EXISTING не должен дублировать цену в карточке детали поставщика:
    // здесь мы фиксируем только факт принятия уже существующей цены в рамках RFQ.

    await conn.execute(
      `UPDATE rfq_suppliers SET status = 'responded', responded_at = COALESCE(responded_at, NOW())
        WHERE id = ?`,
      [rfqSupplier.id]
    )

    await conn.commit()
    res.status(201).json(created)
  } catch (e) {
    await conn.rollback()
    console.error('POST /rfqs/:id/suppliers/:supplierId/accept-price error:', e)
    res.status(500).json({ message: 'Ошибка сохранения цены' })
  } finally {
    conn.release()
  }
})

// Импорт ответов из подготовленного JSON (например после парсинга Excel на фронте)
router.post('/:id/responses/import', async (req, res) => {
  const rfqId = toId(req.params.id)
  const supplierId = toId(req.body.supplier_id)
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  const previewMode = req.body?.preview === true
  if (!rfqId || !supplierId || !rows.length) {
    return res.status(400).json({ message: 'Нужно выбрать поставщика и передать строки для импорта' })
  }
  const created_by_user_id = toId(req.user?.id)
  const note = nz(req.body.note)
  const newRevision = req.body?.new_revision === true

  const conn = await db.getConnection()
  try {
    if (!previewMode) {
      await conn.beginTransaction()
    }
    const [[rfqSupplier]] = await conn.execute(
      `SELECT id FROM rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?`,
      [rfqId, supplierId]
    )
    if (!rfqSupplier?.id) {
      if (!previewMode) {
        await conn.rollback()
      }
      return res.status(404).json({ message: 'Поставщик не привязан к RFQ' })
    }

    let revisionId = null
    if (!previewMode) {
      const revisionData = newRevision
        ? await createSupplierResponseRevision(conn, rfqSupplier.id, {
            userId: created_by_user_id,
            status: 'received',
            note,
          })
        : await ensureSupplierResponseRevision(conn, rfqSupplier.id, {
            userId: created_by_user_id,
            status: 'received',
            note,
          })
      revisionId = revisionData?.revisionId || null
    }

    const [activeItems] = await conn.execute(
      `
      SELECT ri.id, ri.line_number, cri.original_part_id, cri.client_description
        FROM rfq_items ri
        JOIN rfqs r ON r.id = ri.rfq_id
        JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
       WHERE ri.rfq_id = ?
         AND cri.client_request_revision_id = r.client_request_revision_id
      `,
      [rfqId]
    )
    const activeItemIds = new Set(activeItems.map((row) => Number(row.id)))
    const activeItemById = new Map()
    const lineToItem = new Map()
    activeItems.forEach((row) => {
      const mapped = {
        id: Number(row.id),
        line_number: Number(row.line_number),
        original_part_id: toId(row.original_part_id),
        client_description: nz(row.client_description),
      }
      activeItemById.set(mapped.id, mapped)
      const line = Number(row.line_number)
      if (!Number.isFinite(line) || line <= 0) return
      if (!lineToItem.has(line)) {
        lineToItem.set(line, mapped)
      }
    })

    let inserted = 0
    let previewValid = 0
    let previewErrors = 0
    let previewWouldCreateSupplierParts = 0
    let previewWouldReuseSupplierParts = 0
    const previewRows = []

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]
      const rowNumber = rowIndex + 1
      try {
      const explicitItemId = toId(row.rfq_item_id)
      const lineNumber = toId(
        row.line_number ??
          row.rfq_line_number ??
          row.line ??
          row.row_number ??
          row.rfq_item_id
      )
      let selectedItem = null
      if (explicitItemId && activeItemIds.has(Number(explicitItemId))) {
        selectedItem = activeItemById.get(Number(explicitItemId)) || null
      } else if (lineNumber) {
        selectedItem = lineToItem.get(Number(lineNumber)) || null
      }
      const rfqItemId = selectedItem?.id || null
      if (!rfqItemId) {
        throw Object.assign(
          new Error(`Строка ${lineNumber || rowNumber}: не найдена активная строка RFQ для импорта`),
          { statusCode: 400 }
        )
      }
      const supplierReplyStatus = normalizeSupplierReplyStatus(row.supplier_reply_status, 'QUOTED')
      const requiresPrice = supplierReplyStatusRequiresPrice(supplierReplyStatus)
      const rawPrice = numOrNull(row.price)
      const rawCurrency = nz(row.currency)?.toUpperCase() || null
      if (requiresPrice && (rawPrice === null || !rawCurrency)) {
        throw Object.assign(
          new Error(`Строка ${lineNumber || rowNumber}: обязательны Цена и Валюта для статуса "Цена предоставлена"`),
          { statusCode: 400 }
        )
      }
      if (!requiresPrice && (rawPrice !== null || rawCurrency)) {
        throw Object.assign(
          new Error(
            `Строка ${lineNumber || rowNumber}: при статусе "${supplierReplyStatus}" поля Цена/Валюта должны быть пустыми`
          ),
          { statusCode: 400 }
        )
      }
      const price = requiresPrice ? rawPrice : null
      const currency = requiresPrice ? rawCurrency : null

      const offerType = normalizeOfferType(row.offer_type)
      const leadTime = toId(row.lead_time_days)
      const validityDays = toId(row.validity_days)
      const offeredQty = numOrNull(row.offered_qty)
      const weightKg = numOrNull(row.weight_kg)
      const lengthCm = numOrNull(row.length_cm)
      const widthCm = numOrNull(row.width_cm)
      const heightCm = numOrNull(row.height_cm)
      const isOverweight = parseFlagTinyint(row.is_overweight)
      const isOversize = parseFlagTinyint(row.is_oversize)
      let selectionKey = nz(row.selection_key)
      let selectionMeta = null
      let selectionRows = []
      if (selectionKey) {
        const [[selected]] = await conn.execute(
          `
          SELECT selection_key,
                 line_type,
                 original_part_id,
                 alt_original_part_id,
                 bundle_id,
                 bundle_item_id
            FROM rfq_supplier_line_selections
           WHERE rfq_supplier_id = ?
             AND rfq_item_id = ?
             AND selection_key = ?
           LIMIT 1
          `,
          [rfqSupplier.id, rfqItemId, selectionKey]
        )
        if (!selected) {
          throw Object.assign(new Error(`Строка ${lineNumber || rowNumber}: selection_key не найден`), {
            statusCode: 400,
          })
        }
        selectionMeta = selected
      } else {
        const [rowsByItem] = await conn.execute(
          `
          SELECT selection_key,
                 line_type,
                 original_part_id,
                 alt_original_part_id,
                 bundle_id,
                 bundle_item_id
            FROM rfq_supplier_line_selections
           WHERE rfq_supplier_id = ?
             AND rfq_item_id = ?
           ORDER BY id ASC
          `,
          [rfqSupplier.id, rfqItemId]
        )
        selectionRows = rowsByItem
        if (selectionRows.length === 1) {
          selectionMeta = selectionRows[0]
          selectionKey = nz(selectionMeta.selection_key)
        } else if (selectionRows.length > 1) {
          throw Object.assign(
            new Error(
              `Строка ${lineNumber || rowNumber}: для позиции выбрано несколько компонентов/ролей. Укажите selection_key или импортируйте ответ вручную из вкладки «Ответы».`
            ),
            { statusCode: 400 }
          )
        }
      }

      const selectionOriginalPartId = toId(selectionMeta?.original_part_id)
      const selectionAltOriginalPartId = toId(selectionMeta?.alt_original_part_id)
      const selectionBundleId = toId(selectionMeta?.bundle_id)
      const selectionBundleItemId = toId(selectionMeta?.bundle_item_id)
      const selectionLineType = String(selectionMeta?.line_type || '').trim().toUpperCase()
      const isKitRole = selectionLineType === 'KIT_ROLE'

      const requestedOriginalPartId =
        toId(row.requested_original_part_id) ||
        (isKitRole ? selectionOriginalPartId : selectionOriginalPartId || selectedItem?.original_part_id) ||
        null
      const responseOriginalPartId =
        toId(row.original_part_id) ||
        selectionAltOriginalPartId ||
        selectionOriginalPartId ||
        (!isKitRole ? requestedOriginalPartId : null) ||
        null
      const moq = toId(row.moq)
      const packaging = nz(row.packaging)
      const supplierPartResolution = await resolveOrCreateSupplierPartForImport(conn, {
        supplierId,
        supplierPartId: toId(row.supplier_part_id),
        supplierPartNumber:
          row.supplier_part_number || row.supplier_pn || row.part_number || row.pn || null,
        descriptionRu: row.supplier_description || row.supplier_description_ru || selectedItem?.client_description,
        descriptionEn: row.supplier_description_en || null,
        partType: offerType,
        leadTimeDays: leadTime,
        minOrderQty: moq,
        packaging,
        weightKg,
        lengthCm,
        widthCm,
        heightCm,
        isOverweight,
        isOversize,
        requestedOriginalPartId,
        createdByUserId: created_by_user_id,
        createIfMissing: !previewMode,
      })
      const supplierPartId = supplierPartResolution?.partId || null
      const noteLine = nz(row.note)
      const paymentTerms = nz(row.payment_terms)
      const incoterms = normalizeIncoterms(row.incoterms)
      if (previewMode) {
        const partAction = supplierPartResolution?.created
          ? 'create'
          : supplierPartResolution?.wouldCreate
            ? 'create'
            : supplierPartId
              ? 'reuse'
              : 'none'
        if (partAction === 'create') previewWouldCreateSupplierParts += 1
        if (partAction === 'reuse') previewWouldReuseSupplierParts += 1
        previewValid += 1
        previewRows.push({
          row_index: rowNumber,
          line_number: lineNumber || null,
          rfq_item_id: rfqItemId,
          selection_key: selectionKey || null,
          status: 'ok',
          message: 'Будет импортировано',
          supplier_reply_status: supplierReplyStatus,
          supplier_part_action: partAction,
          supplier_part_id: supplierPartId,
          supplier_part_number:
            supplierPartResolution?.supplierPartNumber ||
            nz(row.supplier_part_number) ||
            nz(row.supplier_pn) ||
            nz(row.part_number) ||
            nz(row.pn) ||
            null,
        })
        continue
      }

      const [insLine] = await conn.execute(
        `INSERT INTO rfq_response_lines
          (rfq_response_revision_id, rfq_item_id, selection_key, supplier_part_id, original_part_id, requested_original_part_id, bundle_id,
           offer_type, supplier_reply_status, offered_qty, moq, packaging, lead_time_days, price, currency, validity_days, payment_terms, incoterms, note, entry_source, change_reason)
         SELECT ?, i.id, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUPPLIER_FILE', NULL
           FROM rfq_items i
           JOIN client_request_revision_items cri ON cri.id = i.client_request_revision_item_id
          WHERE i.id = ? AND i.rfq_id = ?`,
        [
          revisionId,
          selectionKey,
          supplierPartId,
          responseOriginalPartId,
          requestedOriginalPartId,
          selectionBundleId,
          offerType,
          supplierReplyStatus,
          offeredQty,
          moq,
          packaging,
          leadTime,
          price,
          currency,
          validityDays,
          paymentTerms,
          incoterms,
          noteLine,
          rfqItemId,
          rfqId,
        ]
      )
      if (!Number(insLine?.affectedRows || 0)) continue
      inserted += Number(insLine.affectedRows || 0)

      if (supplierPartId && selectionLineType === 'KIT_ROLE' && selectionBundleItemId) {
        await conn.execute(
          `
          INSERT IGNORE INTO supplier_bundle_item_links
            (item_id, supplier_part_id, is_default, note, default_one)
          VALUES (?,?,?,?,NULL)
          `,
          [selectionBundleItemId, supplierPartId, 0, 'Связь создана из ответа RFQ (импорт)']
        )
      }

      await writeResponseLineAction(conn, {
        responseLineId: insLine.insertId,
        actionType: 'CREATE',
        payload: {
          source: 'SUPPLIER_FILE',
          rfq_item_id: rfqItemId,
          line_number: lineNumber,
          selection_key: selectionKey,
            price,
            currency,
            offered_qty: offeredQty,
            offer_type: offerType,
            supplier_reply_status: supplierReplyStatus,
            lead_time_days: leadTime,
          moq,
          packaging,
          payment_terms: paymentTerms,
          incoterms,
          supplier_part_number:
            row.supplier_part_number || row.supplier_pn || row.part_number || row.pn || null,
          supplier_part_id: supplierPartId,
        },
        reason: noteLine,
        createdByUserId: created_by_user_id,
      })

      await upsertLineStatus(conn, {
        rfqSupplierId: rfqSupplier.id,
        rfqItemId,
        status: 'NONE',
        sourceType: 'RFQ_RESPONSE',
        sourceRef: null,
        lastRequestRfqRevisionId: null,
        lastResponseRevisionId: revisionId,
        note: noteLine,
      })

      if (supplierPartId) {
        await conn.execute(
          `INSERT INTO supplier_part_prices
             (supplier_part_id, material_id, price, currency, date, comment,
              offer_type, lead_time_days, min_order_qty, packaging, validity_days,
              source_type, source_subtype, source_id, created_by_user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            supplierPartId,
            null,
            price,
            currency,
            new Date(),
            noteLine,
            offerType,
            leadTime,
            moq,
            packaging,
            validityDays,
            'RFQ_RESPONSE',
            'SUPPLIER_FILE',
            insLine.insertId,
            created_by_user_id,
          ]
        )
      }
      } catch (rowError) {
        if (!previewMode) throw rowError
        previewErrors += 1
        previewRows.push({
          row_index: rowNumber,
          line_number: toId(row?.line_number) || null,
          rfq_item_id: toId(row?.rfq_item_id) || null,
          status: 'error',
          message: rowError?.message || 'Ошибка проверки строки',
          supplier_part_action: 'none',
          supplier_part_id: null,
          supplier_part_number:
            nz(row?.supplier_part_number) || nz(row?.supplier_pn) || nz(row?.part_number) || nz(row?.pn) || null,
        })
      }
    }

    if (previewMode) {
      return res.json({
        success: true,
        preview: true,
        summary: {
          total: rows.length,
          valid: previewValid,
          errors: previewErrors,
          would_create_supplier_parts: previewWouldCreateSupplierParts,
          would_reuse_supplier_parts: previewWouldReuseSupplierParts,
        },
        rows: previewRows,
      })
    }

    await conn.execute(
      `UPDATE rfq_suppliers SET status = 'responded', responded_at = COALESCE(responded_at, NOW())
        WHERE id = ?`,
      [rfqSupplier.id]
    )

    await conn.commit()
    res.json({ success: true, inserted })
  } catch (e) {
    if (!previewMode) {
      await conn.rollback()
    }
    console.error('POST /rfqs/:id/responses/import error:', e)
    const statusCode = toId(e?.statusCode) || 500
    res.status(statusCode).json({ message: e?.message || 'Ошибка импорта ответов' })
  } finally {
    conn.release()
  }
})

// Линейные статусы (запрос/принята цена) по поставщику
router.get('/:id/suppliers/:supplierId/line-status', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    const supplierId = toId(req.params.supplierId)
    if (!rfqId || !supplierId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `
      SELECT
        COALESCE(rsl.id, NULL) AS id,
        rs.id AS rfq_supplier_id,
        ri.id AS rfq_item_id,
        COALESCE(rsl.status, 'REQUEST') AS status,
        rsl.source_type,
        rsl.source_ref,
        rsl.last_request_rfq_revision_id,
        rsl.last_response_revision_id,
        rsl.note,
        COALESCE(rsl.updated_at, NOW()) AS updated_at
      FROM rfq_suppliers rs
      JOIN rfq_items ri ON ri.rfq_id = rs.rfq_id
      JOIN rfqs r ON r.id = ri.rfq_id
      JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
      LEFT JOIN rfq_supplier_line_status rsl
             ON rsl.rfq_supplier_id = rs.id
            AND rsl.rfq_item_id = ri.id
      WHERE rs.rfq_id = ?
        AND rs.supplier_id = ?
        AND cri.client_request_revision_id = r.client_request_revision_id
      ORDER BY ri.line_number, ri.id
      `,
      [rfqId, supplierId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/suppliers/:supplierId/line-status error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/suppliers/:supplierId/line-status', async (req, res) => {
  const rfqId = toId(req.params.id)
  const supplierId = toId(req.params.supplierId)
  if (!rfqId || !supplierId) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const rows = Array.isArray(req.body?.lines) ? req.body.lines : []
  if (!rows.length) return res.json({ updated: 0 })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [[rsRow]] = await conn.execute(
      'SELECT id FROM rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?',
      [rfqId, supplierId]
    )
    if (!rsRow?.id) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден в RFQ' })
    }
    const rfqSupplierId = rsRow.id
    const [activeItems] = await conn.execute(
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
    const activeItemIds = new Set(activeItems.map((row) => Number(row.id)))
    let updated = 0
    for (const row of rows) {
      const rfqItemId = toId(row.rfq_item_id)
      const status = String(row.status || '').toUpperCase() || 'NONE'
      const sourceType = nz(row.source_type) || null
      const sourceRef = nz(row.source_ref) || null
      if (!rfqItemId || !activeItemIds.has(Number(rfqItemId))) continue
      await upsertLineStatus(conn, {
        rfqSupplierId,
        rfqItemId,
        status,
        sourceType,
        sourceRef,
        lastRequestRfqRevisionId: null,
        lastResponseRevisionId: null,
        note: nz(row.note) || null,
      })
      updated += 1
    }
    await conn.commit()
    res.json({ updated })
  } catch (e) {
    await conn.rollback()
    console.error('PUT /rfqs/:id/suppliers/:supplierId/line-status error:', e)
    res.status(500).json({ message: 'Ошибка сохранения' })
  } finally {
    conn.release()
  }
})

module.exports = router
