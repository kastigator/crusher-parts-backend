const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const DOC_TYPES = {
  receipt: { label: 'Приход', prefix: 'WH-RC' },
  transfer: { label: 'Перемещение', prefix: 'WH-TR' },
  writeoff: { label: 'Списание', prefix: 'WH-WO' },
  reserve: { label: 'Резерв', prefix: 'WH-RS' },
  unreserve: { label: 'Снятие резерва', prefix: 'WH-UR' },
}

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const boolValue = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === 1 || v === '1' || v === 'true'
}

const mysqlDateTimeOrNow = (value) => {
  const s = nz(value)
  if (!s) return new Date()
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

const toMysqlDateTime = (value) => {
  const d = value instanceof Date ? value : mysqlDateTimeOrNow(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const formatQuantity = (value) => {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n : 0
}

const supplierPartLabel = (row) =>
  row?.supplier_part_number || row?.canonical_part_number || `детали поставщика #${row?.id || row?.supplier_part_id || ''}`

const supplierPartCatalogContextSql = `
  SELECT
    spcp.supplier_part_id,
    MIN(spcp.catalog_position_id) AS catalog_position_id
  FROM supplier_part_catalog_positions spcp
  JOIN (
    SELECT
      supplier_part_id,
      MAX(COALESCE(is_preferred, 0)) AS preferred_rank
    FROM supplier_part_catalog_positions
    GROUP BY supplier_part_id
  ) pref
    ON pref.supplier_part_id = spcp.supplier_part_id
   AND pref.preferred_rank = COALESCE(spcp.is_preferred, 0)
  GROUP BY spcp.supplier_part_id
`

const supplierPartCatalogLinksSql = `
  SELECT
    spcp.supplier_part_id,
    GROUP_CONCAT(
      DISTINCT COALESCE(cp.manufacturer_part_number, cp.position_code, cp.display_name)
      ORDER BY COALESCE(cp.manufacturer_part_number, cp.position_code, cp.display_name)
      SEPARATOR ', '
    ) AS catalog_position_numbers,
    GROUP_CONCAT(
      DISTINCT COALESCE(cp.display_name, cp.display_name_en, cp.display_name_ru)
      ORDER BY COALESCE(cp.display_name, cp.display_name_en, cp.display_name_ru)
      SEPARATOR ', '
    ) AS catalog_position_names
  FROM supplier_part_catalog_positions spcp
  JOIN catalog_positions cp ON cp.id = spcp.catalog_position_id
  WHERE cp.is_active = 1
  GROUP BY spcp.supplier_part_id
`

const stockSelectSql = ({ warehouseId = null, catalogPositionId = null, search = null, limit = 300 } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 300, 50), 1000)
  const innerWhere = ['m.supplier_part_id IS NOT NULL']
  const params = []
  if (warehouseId) {
    innerWhere.push('m.warehouse_id = ?')
    params.push(warehouseId)
  }
  if (catalogPositionId) {
    innerWhere.push(`
      (
        m.catalog_position_id = ?
        OR EXISTS (
          SELECT 1
          FROM supplier_part_catalog_positions spcpf
          WHERE spcpf.supplier_part_id = m.supplier_part_id
            AND spcpf.catalog_position_id = ?
        )
      )
    `)
    params.push(catalogPositionId, catalogPositionId)
  }

  const outerWhere = []
  if (search) {
    outerWhere.push(`
      (
        sp.supplier_part_number LIKE ?
        OR sp.canonical_part_number LIKE ?
        OR sp.description_ru LIKE ?
        OR sp.description_en LIKE ?
        OR ps.name LIKE ?
        OR cp.display_name LIKE ?
        OR cp.display_name_en LIKE ?
        OR cp.display_name_ru LIKE ?
        OR cp.position_code LIKE ?
        OR cp.manufacturer_part_number LIKE ?
        OR cp.description LIKE ?
        OR catalog_links.catalog_position_numbers LIKE ?
        OR catalog_links.catalog_position_names LIKE ?
        OR place.code LIKE ?
      )
    `)
    const like = `%${search}%`
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like)
  }

  return {
    sql: `
      SELECT
        stock.supplier_part_id,
        stock.catalog_position_id,
        stock.warehouse_id,
        stock.storage_place_id,
        stock.actual_qty,
        stock.reserved_qty,
        stock.actual_qty - stock.reserved_qty AS free_qty,
        stock.last_receipt_at,
        stock.last_out_at,
        wl.name AS warehouse_name,
        wl.code AS warehouse_code,
        wl.location_type AS warehouse_type,
        place.code AS storage_place_code,
        sp.supplier_id,
        ps.name AS supplier_name,
        ps.country AS supplier_country,
        sp.supplier_part_number,
        sp.canonical_part_number,
        sp.description_ru AS supplier_description_ru,
        sp.description_en AS supplier_description_en,
        COALESCE(sp.description_ru, sp.description_en) AS supplier_part_description,
        sp.uom AS supplier_uom,
        catalog_links.catalog_position_numbers,
        catalog_links.catalog_position_names,
        cp.position_code,
        cp.manufacturer_part_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        COALESCE(sp.uom, cp.uom) AS uom,
        cp.uom AS catalog_position_uom,
        cp.description,
        mf.name AS manufacturer_name,
        em.model_name
      FROM (
        SELECT
          m.supplier_part_id,
          COALESCE(MAX(m.catalog_position_id), MAX(catalog_link.catalog_position_id)) AS catalog_position_id,
          m.warehouse_id,
          m.storage_place_id,
          SUM(m.quantity_delta) AS actual_qty,
          SUM(m.reserved_delta) AS reserved_qty,
          MAX(CASE WHEN m.quantity_delta > 0 THEN m.occurred_at END) AS last_receipt_at,
          MAX(CASE WHEN m.quantity_delta < 0 THEN m.occurred_at END) AS last_out_at
        FROM warehouse_stock_movements m
        LEFT JOIN (${supplierPartCatalogContextSql}) catalog_link
          ON catalog_link.supplier_part_id = m.supplier_part_id
        ${innerWhere.length ? `WHERE ${innerWhere.join(' AND ')}` : ''}
        GROUP BY m.supplier_part_id, m.warehouse_id, m.storage_place_id
        HAVING actual_qty <> 0 OR reserved_qty <> 0
      ) stock
      JOIN warehouse_locations wl ON wl.id = stock.warehouse_id
      LEFT JOIN warehouse_storage_places place ON place.id = stock.storage_place_id
      JOIN supplier_parts sp ON sp.id = stock.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN (${supplierPartCatalogLinksSql}) catalog_links
        ON catalog_links.supplier_part_id = stock.supplier_part_id
      LEFT JOIN catalog_positions cp ON cp.id = stock.catalog_position_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      ${outerWhere.length ? `WHERE ${outerWhere.join(' AND ')}` : ''}
      ORDER BY wl.name, place.code, ps.name, sp.supplier_part_number, cp.manufacturer_part_number
      LIMIT ${safeLimit}
    `,
    params,
  }
}

const reservationsSelectSql = ({ warehouseId = null, catalogPositionId = null, limit = 120 } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 20), 500)
  const where = ["m.movement_type IN ('reserve', 'unreserve')", 'm.supplier_part_id IS NOT NULL']
  const params = []

  if (warehouseId) {
    where.push('m.warehouse_id = ?')
    params.push(warehouseId)
  }
  if (catalogPositionId) {
    where.push(`
      (
        m.catalog_position_id = ?
        OR EXISTS (
          SELECT 1
          FROM supplier_part_catalog_positions spcpf
          WHERE spcpf.supplier_part_id = m.supplier_part_id
            AND spcpf.catalog_position_id = ?
        )
      )
    `)
    params.push(catalogPositionId, catalogPositionId)
  }

  return {
    sql: `
      SELECT
        SHA2(CONCAT_WS('|',
          reserve.source_type,
          reserve.source_id,
          reserve.source_line_id,
          reserve.supplier_part_id,
          reserve.catalog_position_id,
          reserve.warehouse_id,
          COALESCE(reserve.storage_place_id, 0)
        ), 256) AS reservation_key,
        reserve.supplier_part_id,
        reserve.catalog_position_id,
        reserve.warehouse_id,
        reserve.storage_place_id,
        reserve.source_type,
        NULLIF(reserve.source_id, '') AS source_id,
        NULLIF(reserve.source_line_id, '') AS source_line_id,
        reserve.source_label,
        reserve.reserved_qty,
        reserve.last_reserved_at,
        wl.name AS warehouse_name,
        wl.code AS warehouse_code,
        place.code AS storage_place_code,
        sp.supplier_id,
        ps.name AS supplier_name,
        ps.country AS supplier_country,
        sp.supplier_part_number,
        sp.canonical_part_number,
        sp.description_ru AS supplier_description_ru,
        sp.description_en AS supplier_description_en,
        COALESCE(sp.description_ru, sp.description_en) AS supplier_part_description,
        sp.uom AS supplier_uom,
        catalog_links.catalog_position_numbers,
        catalog_links.catalog_position_names,
        cp.position_code,
        cp.manufacturer_part_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        COALESCE(sp.uom, cp.uom) AS uom,
        cp.uom AS catalog_position_uom,
        mf.name AS manufacturer_name,
        em.model_name
      FROM (
        SELECT
          m.supplier_part_id,
          COALESCE(MAX(m.catalog_position_id), MAX(catalog_link.catalog_position_id)) AS catalog_position_id,
          m.warehouse_id,
          m.storage_place_id,
          COALESCE(doc.source_type, 'manual') AS source_type,
          COALESCE(doc.source_id, '') AS source_id,
          COALESCE(doc.source_line_id, '') AS source_line_id,
          MAX(doc.source_label) AS source_label,
          SUM(m.reserved_delta) AS reserved_qty,
          MAX(m.occurred_at) AS last_reserved_at
        FROM warehouse_stock_movements m
        JOIN warehouse_documents doc ON doc.id = m.document_id
        LEFT JOIN (${supplierPartCatalogContextSql}) catalog_link
          ON catalog_link.supplier_part_id = m.supplier_part_id
        WHERE ${where.join(' AND ')}
        GROUP BY
          COALESCE(doc.source_type, 'manual'),
          COALESCE(doc.source_id, ''),
          COALESCE(doc.source_line_id, ''),
          m.supplier_part_id,
          m.warehouse_id,
          m.storage_place_id
        HAVING reserved_qty > 0
      ) reserve
      JOIN warehouse_locations wl ON wl.id = reserve.warehouse_id
      LEFT JOIN warehouse_storage_places place ON place.id = reserve.storage_place_id
      JOIN supplier_parts sp ON sp.id = reserve.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN (${supplierPartCatalogLinksSql}) catalog_links
        ON catalog_links.supplier_part_id = reserve.supplier_part_id
      LEFT JOIN catalog_positions cp ON cp.id = reserve.catalog_position_id
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      ORDER BY reserve.last_reserved_at DESC
      LIMIT ${safeLimit}
    `,
    params,
  }
}

const currentStock = async (conn, { warehouseId, storagePlaceId, supplierPartId }) => {
  const [[row]] = await conn.execute(
    `
    SELECT
      COALESCE(SUM(quantity_delta), 0) AS actual_qty,
      COALESCE(SUM(reserved_delta), 0) AS reserved_qty
    FROM warehouse_stock_movements
    WHERE warehouse_id = ?
      AND storage_place_id <=> ?
      AND supplier_part_id = ?
    `,
    [warehouseId, storagePlaceId || null, supplierPartId]
  )
  const actual = formatQuantity(row?.actual_qty)
  const reserved = formatQuantity(row?.reserved_qty)
  return { actual, reserved, free: actual - reserved }
}

const assertWarehouse = async (conn, id, label = 'Склад') => {
  const [[row]] = await conn.execute(
    'SELECT * FROM warehouse_locations WHERE id = ? AND is_active = 1',
    [id]
  )
  if (!row) throw Object.assign(new Error(`${label} не найден`), { status: 400 })
  return row
}

const assertPlace = async (conn, id, warehouseId, label = 'Место хранения') => {
  if (!id) return null
  const [[row]] = await conn.execute(
    'SELECT * FROM warehouse_storage_places WHERE id = ? AND warehouse_id = ? AND is_active = 1',
    [id, warehouseId]
  )
  if (!row) throw Object.assign(new Error(`${label} не найдено на выбранном складе`), { status: 400 })
  return row
}

const requireLinePlace = async (conn, line, warehouseId, label = 'Место хранения') => {
  const placeId = toId(line.storage_place_id)
  if (!placeId) throw Object.assign(new Error(`${label} обязательно`), { status: 400 })
  await assertPlace(conn, placeId, warehouseId, label)
  return placeId
}

const assertSupplierPart = async (conn, id) => {
  const [[row]] = await conn.execute(
    `
    SELECT
      sp.id,
      sp.supplier_id,
      sp.supplier_part_number,
      sp.canonical_part_number,
      sp.description_ru,
      sp.description_en,
      sp.uom,
      ps.name AS supplier_name
    FROM supplier_parts sp
    JOIN part_suppliers ps ON ps.id = sp.supplier_id
    WHERE sp.id = ?
      AND COALESCE(sp.active, 1) = 1
    `,
    [id]
  )
  if (!row) throw Object.assign(new Error('Деталь поставщика не найдена'), { status: 400 })
  return row
}

const resolveCatalogPositionForSupplierPart = async (conn, supplierPartId, catalogPositionId = null) => {
  const requestedId = toId(catalogPositionId)
  if (requestedId) {
    const [[row]] = await conn.execute(
      `
      SELECT cp.id, cp.uom
      FROM supplier_part_catalog_positions spcp
      JOIN catalog_positions cp ON cp.id = spcp.catalog_position_id
      WHERE spcp.supplier_part_id = ?
        AND spcp.catalog_position_id = ?
        AND cp.is_active = 1
      LIMIT 1
      `,
      [supplierPartId, requestedId]
    )
    if (!row) {
      throw Object.assign(new Error('Деталь поставщика не связана с выбранной карточкой позиции'), { status: 400 })
    }
    return row
  }

  const [[row]] = await conn.execute(
    `
    SELECT cp.id, cp.uom
    FROM supplier_part_catalog_positions spcp
    JOIN catalog_positions cp ON cp.id = spcp.catalog_position_id
    WHERE spcp.supplier_part_id = ?
      AND cp.is_active = 1
    ORDER BY spcp.is_preferred DESC, spcp.priority_rank IS NULL, spcp.priority_rank, cp.id
    LIMIT 1
    `,
    [supplierPartId]
  )
  return row || null
}

const normalizeLines = (rawLines) => {
  const input = Array.isArray(rawLines) ? rawLines : []
  const lines = []
  for (const raw of input) {
    const supplierPartId = toId(raw?.supplier_part_id)
    const catalogPositionId = toId(raw?.catalog_position_id)
    const quantity = numOrNull(raw?.quantity)
    if (!supplierPartId || quantity === null || quantity <= 0) continue
    lines.push({
      supplier_part_id: supplierPartId,
      catalog_position_id: catalogPositionId,
      storage_place_id: toId(raw?.storage_place_id),
      target_storage_place_id: toId(raw?.target_storage_place_id),
      quantity,
      unit_code: nz(raw?.unit_code),
      reason: nz(raw?.reason),
      notes: nz(raw?.notes),
      source_type: nz(raw?.source_type),
      source_id: nz(raw?.source_id),
      source_line_id: nz(raw?.source_line_id),
      source_label: nz(raw?.source_label),
    })
  }
  return lines
}

const withDocumentSourceFallback = (line, docSource, inheritDocumentLineId = false) => ({
  ...line,
  source_type: line.source_type || docSource.source_type || null,
  source_id: line.source_id || docSource.source_id || null,
  source_line_id: line.source_line_id || (inheritDocumentLineId ? docSource.source_line_id : null) || null,
  source_label: line.source_label || docSource.source_label || null,
})

const resolveLineSku = async (conn, line) => {
  const supplierPartId = toId(line?.supplier_part_id)
  if (!supplierPartId) {
    throw Object.assign(new Error('В строке документа выберите деталь поставщика'), { status: 400 })
  }
  const supplierPart = await assertSupplierPart(conn, supplierPartId)
  const catalogPosition = await resolveCatalogPositionForSupplierPart(conn, supplierPartId, line.catalog_position_id)
  line.catalog_position_id = catalogPosition?.id || null
  return {
    supplierPart,
    catalogPosition,
    catalogPositionId: catalogPosition?.id || null,
  }
}

const validatePurchaseOrderReceiptLine = async (conn, line) => {
  if (line.source_type !== 'purchase_order') return
  const purchaseOrderId = toId(line.source_id)
  const purchaseOrderLineId = toId(line.source_line_id)
  if (!purchaseOrderId || !purchaseOrderLineId) {
    throw Object.assign(new Error('Для прихода по PO нужна точная строка заказа поставщику'), { status: 400 })
  }

  const [[poLine]] = await conn.execute(
    `
    SELECT
      pol.id,
      pol.qty,
      po.status,
      po.supplier_reference,
      rl.supplier_part_id
    FROM supplier_purchase_order_lines pol
    JOIN supplier_purchase_orders po ON po.id = pol.supplier_purchase_order_id
    LEFT JOIN rfq_response_lines rl ON rl.id = pol.rfq_response_line_id
    WHERE pol.id = ?
      AND pol.supplier_purchase_order_id = ?
    LIMIT 1
    `,
    [purchaseOrderLineId, purchaseOrderId]
  )
  if (!poLine) throw Object.assign(new Error('Строка заказа поставщику для прихода не найдена'), { status: 400 })
  if (!['sent', 'confirmed'].includes(String(poLine.status || ''))) {
    throw Object.assign(new Error('Приход можно оформлять только по отправленному или подтвержденному PO'), { status: 409 })
  }
  if (toId(poLine.supplier_part_id) !== toId(line.supplier_part_id)) {
    throw Object.assign(new Error('Деталь поставщика в приходе не совпадает со строкой PO'), { status: 409 })
  }

  const [[received]] = await conn.execute(
    `
    SELECT COALESCE(SUM(wdl.quantity), 0) AS qty
    FROM warehouse_document_lines wdl
    JOIN warehouse_documents wd ON wd.id = wdl.document_id
    WHERE wd.doc_type = 'receipt'
      AND wd.status IN ('draft', 'posted')
      AND COALESCE(wdl.source_type, wd.source_type) = 'purchase_order'
      AND COALESCE(wdl.source_id, wd.source_id) = ?
      AND wdl.source_line_id = ?
    `,
    [String(purchaseOrderId), String(purchaseOrderLineId)]
  )
  const orderedQty = Number(poLine.qty || 0)
  const alreadyQty = Number(received?.qty || 0)
  const nextQty = Number(line.quantity || 0)
  if (alreadyQty + nextQty > orderedQty + 0.0005) {
    throw Object.assign(
      new Error(`По строке PO уже принято/подготовлено ${alreadyQty}. Нельзя принять больше ${orderedQty}.`),
      { status: 409 }
    )
  }
}

const insertStockMovement = async (
  conn,
  { doc, line, warehouseId, storagePlaceId, movementType, quantityDelta = 0, reservedDelta = 0 }
) => {
  await conn.execute(
    `
    INSERT INTO warehouse_stock_movements
      (document_id, document_line_id, supplier_part_id, catalog_position_id, warehouse_id, storage_place_id, movement_type, quantity_delta, reserved_delta, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      doc.id,
      line.id,
      line.supplier_part_id,
      line.catalog_position_id || null,
      warehouseId,
      storagePlaceId || null,
      movementType,
      quantityDelta,
      reservedDelta,
      doc.document_date,
    ]
  )
}

const postDocument = async (conn, documentId, userId = null) => {
  const [[doc]] = await conn.execute('SELECT * FROM warehouse_documents WHERE id = ? FOR UPDATE', [documentId])
  if (!doc) throw Object.assign(new Error('Документ склада не найден'), { status: 404 })
  if (doc.status === 'posted') return doc
  if (doc.status !== 'draft') {
    throw Object.assign(new Error('Провести можно только черновик'), { status: 400 })
  }
  if (!DOC_TYPES[doc.doc_type]) {
    throw Object.assign(new Error('Этот тип складского документа пока не проводится'), { status: 400 })
  }

  const [lines] = await conn.execute(
    'SELECT * FROM warehouse_document_lines WHERE document_id = ? ORDER BY id',
    [documentId]
  )
  if (!lines.length) {
    throw Object.assign(new Error('В документе нет строк'), { status: 400 })
  }

  if (doc.doc_type === 'receipt') {
    const warehouseId = toId(doc.warehouse_id)
    await assertWarehouse(conn, warehouseId, 'Склад прихода')
    for (const line of lines) {
      await resolveLineSku(conn, line)
      await assertPlace(conn, line.storage_place_id, warehouseId)
      await insertStockMovement(conn, {
        doc,
        line,
        warehouseId,
        storagePlaceId: line.storage_place_id,
        movementType: 'receipt',
        quantityDelta: Number(line.quantity),
      })
    }
  }

  if (doc.doc_type === 'writeoff') {
    const warehouseId = toId(doc.warehouse_id)
    await assertWarehouse(conn, warehouseId, 'Склад списания')
    for (const line of lines) {
      const { supplierPart } = await resolveLineSku(conn, line)
      await assertPlace(conn, line.storage_place_id, warehouseId)
      const stock = await currentStock(conn, {
        warehouseId,
        storagePlaceId: line.storage_place_id,
        supplierPartId: line.supplier_part_id,
      })
      if (stock.free < Number(line.quantity)) {
        throw Object.assign(new Error(`Отрицательный остаток по ${supplierPartLabel(supplierPart)}. Измените количество.`), {
          status: 400,
        })
      }
      await insertStockMovement(conn, {
        doc,
        line,
        warehouseId,
        storagePlaceId: line.storage_place_id,
        movementType: 'writeoff',
        quantityDelta: -Number(line.quantity),
      })
    }
  }

  if (doc.doc_type === 'reserve') {
    const warehouseId = toId(doc.warehouse_id)
    await assertWarehouse(conn, warehouseId, 'Склад резерва')
    for (const line of lines) {
      const { supplierPart } = await resolveLineSku(conn, line)
      const placeId = await requireLinePlace(conn, line, warehouseId, 'Место резерва')
      const stock = await currentStock(conn, {
        warehouseId,
        storagePlaceId: placeId,
        supplierPartId: line.supplier_part_id,
      })
      if (stock.free < Number(line.quantity)) {
        throw Object.assign(new Error(`Недостаточно свободного остатка по ${supplierPartLabel(supplierPart)}`), {
          status: 400,
        })
      }
      await insertStockMovement(conn, {
        doc,
        line,
        warehouseId,
        storagePlaceId: placeId,
        movementType: 'reserve',
        reservedDelta: Number(line.quantity),
      })
    }
  }

  if (doc.doc_type === 'unreserve') {
    const warehouseId = toId(doc.warehouse_id)
    await assertWarehouse(conn, warehouseId, 'Склад снятия резерва')
    for (const line of lines) {
      const { supplierPart } = await resolveLineSku(conn, line)
      const placeId = await requireLinePlace(conn, line, warehouseId, 'Место резерва')
      const stock = await currentStock(conn, {
        warehouseId,
        storagePlaceId: placeId,
        supplierPartId: line.supplier_part_id,
      })
      if (stock.reserved < Number(line.quantity)) {
        throw Object.assign(new Error(`Резерв по ${supplierPartLabel(supplierPart)} меньше указанного количества`), {
          status: 400,
        })
      }
      await insertStockMovement(conn, {
        doc,
        line,
        warehouseId,
        storagePlaceId: placeId,
        movementType: 'unreserve',
        reservedDelta: -Number(line.quantity),
      })
    }
  }

  if (doc.doc_type === 'transfer') {
    const sourceWarehouseId = toId(doc.source_warehouse_id)
    const targetWarehouseId = toId(doc.target_warehouse_id)
    await assertWarehouse(conn, sourceWarehouseId, 'Склад отправления')
    await assertWarehouse(conn, targetWarehouseId, 'Склад получения')
    for (const line of lines) {
      const { supplierPart } = await resolveLineSku(conn, line)
      await assertPlace(conn, line.storage_place_id, sourceWarehouseId, 'Место отправления')
      await assertPlace(conn, line.target_storage_place_id, targetWarehouseId, 'Место получения')
      const stock = await currentStock(conn, {
        warehouseId: sourceWarehouseId,
        storagePlaceId: line.storage_place_id,
        supplierPartId: line.supplier_part_id,
      })
      if (stock.free < Number(line.quantity)) {
        throw Object.assign(new Error(`Отрицательный остаток по ${supplierPartLabel(supplierPart)}. Измените количество.`), {
          status: 400,
        })
      }
      await insertStockMovement(conn, {
        doc,
        line,
        warehouseId: sourceWarehouseId,
        storagePlaceId: line.storage_place_id,
        movementType: 'transfer_out',
        quantityDelta: -Number(line.quantity),
      })
      await insertStockMovement(conn, {
        doc,
        line,
        warehouseId: targetWarehouseId,
        storagePlaceId: line.target_storage_place_id,
        movementType: 'transfer_in',
        quantityDelta: Number(line.quantity),
      })
    }
  }

  await conn.execute(
    `
    UPDATE warehouse_documents
    SET status = 'posted', posted_by = ?, posted_at = NOW(), updated_at = NOW()
    WHERE id = ?
    `,
    [userId, doc.id]
  )

  const [[fresh]] = await conn.execute('SELECT * FROM warehouse_documents WHERE id = ?', [doc.id])
  return fresh
}

router.get('/document-types', (_req, res) => {
  res.json(Object.entries(DOC_TYPES).map(([value, meta]) => ({ value, ...meta })))
})

router.get('/locations', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM warehouse_locations WHERE is_active = 1 ORDER BY location_type = 'transit', name"
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /warehouse/locations error:', err)
    res.status(500).json({ message: 'Ошибка загрузки складов' })
  }
})

router.post('/locations', async (req, res) => {
  const code = nz(req.body?.code)?.toLowerCase()
  const name = nz(req.body?.name)
  if (!code || !name) return res.status(400).json({ message: 'Код и название склада обязательны' })
  try {
    const [ins] = await db.execute(
      `
      INSERT INTO warehouse_locations (code, name, location_type, country, city, address, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        code,
        name,
        nz(req.body?.location_type) || 'physical',
        nz(req.body?.country),
        nz(req.body?.city),
        nz(req.body?.address),
        nz(req.body?.notes),
      ]
    )
    const [[fresh]] = await db.execute('SELECT * FROM warehouse_locations WHERE id = ?', [ins.insertId])
    res.status(201).json(fresh)
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ type: 'duplicate_key', message: 'Склад с таким кодом уже существует' })
    }
    console.error('POST /warehouse/locations error:', err)
    res.status(500).json({ message: 'Ошибка создания склада' })
  }
})

router.get('/storage-places', async (req, res) => {
  const warehouseId = toId(req.query.warehouse_id)
  try {
    const params = []
    const where = ['place.is_active = 1']
    if (warehouseId) {
      where.push('place.warehouse_id = ?')
      params.push(warehouseId)
    }
    const [rows] = await db.execute(
      `
      SELECT place.*, wl.name AS warehouse_name
      FROM warehouse_storage_places place
      JOIN warehouse_locations wl ON wl.id = place.warehouse_id
      WHERE ${where.join(' AND ')}
      ORDER BY wl.name, place.code
      `,
      params
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /warehouse/storage-places error:', err)
    res.status(500).json({ message: 'Ошибка загрузки мест хранения' })
  }
})

router.post('/storage-places', async (req, res) => {
  const warehouseId = toId(req.body?.warehouse_id)
  const code = nz(req.body?.code)
  if (!warehouseId || !code) return res.status(400).json({ message: 'Склад и код места обязательны' })
  try {
    await assertWarehouse(db, warehouseId)
    const [ins] = await db.execute(
      `
      INSERT INTO warehouse_storage_places (warehouse_id, code, zone, rack, section, tier, bin, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        warehouseId,
        code,
        nz(req.body?.zone),
        nz(req.body?.rack),
        nz(req.body?.section),
        nz(req.body?.tier),
        nz(req.body?.bin),
        nz(req.body?.notes),
      ]
    )
    const [[fresh]] = await db.execute('SELECT * FROM warehouse_storage_places WHERE id = ?', [ins.insertId])
    res.status(201).json(fresh)
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ message: err.message })
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ type: 'duplicate_key', message: 'Такое место уже есть на складе' })
    }
    console.error('POST /warehouse/storage-places error:', err)
    res.status(500).json({ message: 'Ошибка создания места хранения' })
  }
})

router.get('/supplier-parts', async (req, res) => {
  const q = nz(req.query.q)
  const catalogPositionId = toId(req.query.catalog_position_id)
  if ((!q || q.length < 2) && !catalogPositionId) return res.json([])

  const params = []
  const selectedLinkJoin = catalogPositionId
    ? 'LEFT JOIN supplier_part_catalog_positions selected_link ON selected_link.supplier_part_id = sp.id AND selected_link.catalog_position_id = ?'
    : 'LEFT JOIN supplier_part_catalog_positions selected_link ON 1 = 0'
  if (catalogPositionId) params.push(catalogPositionId)

  const where = ['COALESCE(sp.active, 1) = 1']
  if (catalogPositionId) {
    where.push(`
      EXISTS (
        SELECT 1
        FROM supplier_part_catalog_positions spcpf
        WHERE spcpf.supplier_part_id = sp.id
          AND spcpf.catalog_position_id = ?
      )
    `)
    params.push(catalogPositionId)
  }
  if (q && q.length >= 2) {
    const like = `%${q}%`
    where.push(`
      (
        sp.supplier_part_number LIKE ?
        OR sp.canonical_part_number LIKE ?
        OR sp.description_ru LIKE ?
        OR sp.description_en LIKE ?
        OR ps.name LIKE ?
        OR catalog_links.catalog_position_numbers LIKE ?
        OR catalog_links.catalog_position_names LIKE ?
      )
    `)
    params.push(like, like, like, like, like, like, like)
  }

  try {
    const [rows] = await db.execute(
      `
      SELECT
        sp.id,
        sp.id AS supplier_part_id,
        sp.supplier_id,
        ps.name AS supplier_name,
        ps.country AS supplier_country,
        sp.supplier_part_number,
        sp.canonical_part_number,
        sp.description_ru,
        sp.description_en,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        sp.uom,
        sp.part_type,
        sp.lead_time_days,
        sp.min_order_qty,
        COALESCE(selected_link.catalog_position_id, catalog_link.catalog_position_id) AS catalog_position_id,
        cp.position_code,
        cp.manufacturer_part_number,
        COALESCE(cp.manufacturer_part_number, cp.position_code) AS catalog_position_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.uom AS catalog_position_uom,
        mf.name AS manufacturer_name,
        em.model_name,
        catalog_links.catalog_position_numbers,
        catalog_links.catalog_position_names,
        latest_price.price,
        latest_price.currency
      FROM supplier_parts sp
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      ${selectedLinkJoin}
      LEFT JOIN (${supplierPartCatalogContextSql}) catalog_link
        ON catalog_link.supplier_part_id = sp.id
      LEFT JOIN catalog_positions cp
        ON cp.id = COALESCE(selected_link.catalog_position_id, catalog_link.catalog_position_id)
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      LEFT JOIN (${supplierPartCatalogLinksSql}) catalog_links
        ON catalog_links.supplier_part_id = sp.id
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
      ) latest_price ON latest_price.supplier_part_id = sp.id
      WHERE ${where.join(' AND ')}
      ORDER BY selected_link.catalog_position_id IS NULL, ps.name, sp.supplier_part_number
      LIMIT 50
      `,
      params
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /warehouse/supplier-parts error:', err)
    res.status(500).json({ message: 'Ошибка поиска деталей поставщиков' })
  }
})

router.get('/catalog-positions', async (req, res) => {
  const q = nz(req.query.q)
  if (!q || q.length < 2) return res.json([])
  try {
    const like = `%${q}%`
    const [rows] = await db.execute(
      `
      SELECT
        cp.id,
        cp.position_code,
        cp.manufacturer_part_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.uom,
        mf.name AS manufacturer_name,
        em.model_name
      FROM catalog_positions cp
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      WHERE cp.is_active = 1
        AND (
          cp.display_name LIKE ?
          OR cp.display_name_en LIKE ?
          OR cp.display_name_ru LIKE ?
          OR cp.position_code LIKE ?
          OR cp.manufacturer_part_number LIKE ?
          OR cp.description LIKE ?
        )
      ORDER BY mf.name, em.model_name, cp.manufacturer_part_number, cp.display_name
      LIMIT 50
      `,
      [like, like, like, like, like, like]
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /warehouse/catalog-positions error:', err)
    res.status(500).json({ message: 'Ошибка поиска карточек позиций' })
  }
})

router.get('/overview', async (req, res) => {
  const warehouseId = toId(req.query.warehouse_id)
  const catalogPositionId = toId(req.query.catalog_position_id)
  const search = nz(req.query.q)
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 50), 1000)

  try {
    const { sql, params } = stockSelectSql({ warehouseId, catalogPositionId, search, limit })
    const [stock] = await db.execute(sql, params)
    const { sql: reservationsSql, params: reservationsParams } = reservationsSelectSql({
      warehouseId,
      catalogPositionId,
      limit: 120,
    })
    const [reservations] = await db.execute(reservationsSql, reservationsParams)
    const documentWhere = []
    const documentParams = []
    if (warehouseId) {
      documentWhere.push('(doc.warehouse_id = ? OR doc.source_warehouse_id = ? OR doc.target_warehouse_id = ?)')
      documentParams.push(warehouseId, warehouseId, warehouseId)
    }
    if (catalogPositionId) {
      documentWhere.push(`
        (
          line.catalog_position_id = ?
          OR EXISTS (
            SELECT 1
            FROM supplier_part_catalog_positions spcpf
            WHERE spcpf.supplier_part_id = line.supplier_part_id
              AND spcpf.catalog_position_id = ?
          )
        )
      `)
      documentParams.push(catalogPositionId, catalogPositionId)
    }
    const [documents] = await db.execute(
      `
      SELECT
        doc.*,
        wl.name AS warehouse_name,
        sw.name AS source_warehouse_name,
        tw.name AS target_warehouse_name,
        creator.full_name AS created_by_name,
        COUNT(line.id) AS line_count,
        COALESCE(SUM(line.quantity), 0) AS total_line_qty
      FROM warehouse_documents doc
      LEFT JOIN warehouse_locations wl ON wl.id = doc.warehouse_id
      LEFT JOIN warehouse_locations sw ON sw.id = doc.source_warehouse_id
      LEFT JOIN warehouse_locations tw ON tw.id = doc.target_warehouse_id
      LEFT JOIN users creator ON creator.id = doc.created_by
      LEFT JOIN warehouse_document_lines line ON line.document_id = doc.id
      ${documentWhere.length ? `WHERE ${documentWhere.join(' AND ')}` : ''}
      GROUP BY doc.id
      ORDER BY doc.document_date DESC, doc.id DESC
      LIMIT 80
      `,
      documentParams
    )

    const stats = stock.reduce(
      (acc, row) => {
        acc.positions_count += 1
        acc.actual_qty += formatQuantity(row.actual_qty)
        acc.reserved_qty += formatQuantity(row.reserved_qty)
        acc.free_qty += formatQuantity(row.free_qty)
        return acc
      },
      { positions_count: 0, actual_qty: 0, reserved_qty: 0, free_qty: 0 }
    )

    res.json({ stats, stock, documents, reservations })
  } catch (err) {
    console.error('GET /warehouse/overview error:', err)
    res.status(500).json({ message: 'Ошибка загрузки склада' })
  }
})

router.get('/positions/:id', async (req, res) => {
  const catalogPositionId = toId(req.params.id)
  if (!catalogPositionId) return res.status(400).json({ message: 'Некорректный идентификатор карточки позиции' })

  try {
    const [[position]] = await db.execute(
      `
      SELECT
        cp.id,
        cp.position_code,
        cp.manufacturer_part_number,
        cp.display_name,
        cp.display_name_en,
        cp.display_name_ru,
        cp.uom,
        cp.description,
        cp.position_kind,
        cp.source_kind,
        mf.name AS manufacturer_name,
        em.model_name
      FROM catalog_positions cp
      LEFT JOIN equipment_models em ON em.id = cp.equipment_model_id
      LEFT JOIN equipment_manufacturers mf ON mf.id = COALESCE(cp.manufacturer_id, em.manufacturer_id)
      WHERE cp.id = ?
        AND cp.is_active = 1
      `,
      [catalogPositionId]
    )
    if (!position) return res.status(404).json({ message: 'Карточка позиции не найдена' })

    const { sql: stockSql, params: stockParams } = stockSelectSql({
      catalogPositionId,
      limit: 200,
    })
    const [stock] = await db.execute(stockSql, stockParams)

    const { sql: reservationsSql, params: reservationsParams } = reservationsSelectSql({
      catalogPositionId,
      limit: 120,
    })
    const [reservations] = await db.execute(reservationsSql, reservationsParams)

    const [movements] = await db.execute(
      `
      SELECT
        m.id,
        m.document_id,
        m.document_line_id,
        m.supplier_part_id,
        m.catalog_position_id,
        m.warehouse_id,
        m.storage_place_id,
        m.movement_type,
        m.quantity_delta,
        m.reserved_delta,
        m.occurred_at,
        doc.document_no,
        doc.doc_type,
        doc.status AS document_status,
        doc.basis_document,
        doc.source_type,
        doc.source_id,
        doc.source_line_id,
        doc.source_label,
        wl.name AS warehouse_name,
        wl.code AS warehouse_code,
        place.code AS storage_place_code,
        sp.supplier_id,
        ps.name AS supplier_name,
        sp.supplier_part_number,
        sp.canonical_part_number,
        COALESCE(sp.description_ru, sp.description_en) AS supplier_part_description
      FROM warehouse_stock_movements m
      JOIN warehouse_documents doc ON doc.id = m.document_id
      JOIN warehouse_locations wl ON wl.id = m.warehouse_id
      JOIN supplier_parts sp ON sp.id = m.supplier_part_id
      JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN warehouse_storage_places place ON place.id = m.storage_place_id
      WHERE m.supplier_part_id IS NOT NULL
        AND (
          m.catalog_position_id = ?
          OR EXISTS (
            SELECT 1
            FROM supplier_part_catalog_positions spcpf
            WHERE spcpf.supplier_part_id = m.supplier_part_id
              AND spcpf.catalog_position_id = ?
          )
        )
      ORDER BY m.occurred_at DESC, m.id DESC
      LIMIT 120
      `,
      [catalogPositionId, catalogPositionId]
    )

    const stats = stock.reduce(
      (acc, row) => {
        acc.positions_count += 1
        acc.actual_qty += formatQuantity(row.actual_qty)
        acc.reserved_qty += formatQuantity(row.reserved_qty)
        acc.free_qty += formatQuantity(row.free_qty)
        return acc
      },
      { positions_count: 0, actual_qty: 0, reserved_qty: 0, free_qty: 0 }
    )

    res.json({ position, stats, stock, reservations, movements })
  } catch (err) {
    console.error('GET /warehouse/positions/:id error:', err)
    res.status(500).json({ message: 'Ошибка загрузки складских данных карточки позиции' })
  }
})

router.get('/documents/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор документа' })
  try {
    const [[document]] = await db.execute(
      `
      SELECT
        doc.*,
        wl.name AS warehouse_name,
        sw.name AS source_warehouse_name,
        tw.name AS target_warehouse_name,
        creator.full_name AS created_by_name,
        poster.full_name AS posted_by_name
      FROM warehouse_documents doc
      LEFT JOIN warehouse_locations wl ON wl.id = doc.warehouse_id
      LEFT JOIN warehouse_locations sw ON sw.id = doc.source_warehouse_id
      LEFT JOIN warehouse_locations tw ON tw.id = doc.target_warehouse_id
      LEFT JOIN users creator ON creator.id = doc.created_by
      LEFT JOIN users poster ON poster.id = doc.posted_by
      WHERE doc.id = ?
      `,
      [id]
    )
    if (!document) return res.status(404).json({ message: 'Документ склада не найден' })
    const [lines] = await db.execute(
      `
      SELECT
        line.*,
        sp.supplier_id,
        ps.name AS supplier_name,
        sp.supplier_part_number,
        sp.canonical_part_number,
        sp.description_ru AS supplier_description_ru,
        sp.description_en AS supplier_description_en,
        COALESCE(sp.description_ru, sp.description_en) AS supplier_part_description,
        cp.display_name,
        cp.manufacturer_part_number,
        cp.position_code,
        place.code AS storage_place_code,
        target_place.code AS target_storage_place_code
      FROM warehouse_document_lines line
      LEFT JOIN supplier_parts sp ON sp.id = line.supplier_part_id
      LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
      LEFT JOIN catalog_positions cp ON cp.id = line.catalog_position_id
      LEFT JOIN warehouse_storage_places place ON place.id = line.storage_place_id
      LEFT JOIN warehouse_storage_places target_place ON target_place.id = line.target_storage_place_id
      WHERE line.document_id = ?
      ORDER BY line.id
      `,
      [id]
    )
    res.json({ document, lines })
  } catch (err) {
    console.error('GET /warehouse/documents/:id error:', err)
    res.status(500).json({ message: 'Ошибка загрузки документа склада' })
  }
})

router.post('/documents', async (req, res) => {
  const docType = nz(req.body?.doc_type)
  if (!DOC_TYPES[docType]) return res.status(400).json({ message: 'Некорректный тип документа' })

  const lines = normalizeLines(req.body?.lines)
  if (!lines.length) return res.status(400).json({ message: 'Добавьте хотя бы одну строку документа' })

  const warehouseId = toId(req.body?.warehouse_id)
  const sourceWarehouseId = toId(req.body?.source_warehouse_id)
  const targetWarehouseId = toId(req.body?.target_warehouse_id)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    if (docType === 'receipt' || docType === 'writeoff' || docType === 'reserve' || docType === 'unreserve') {
      await assertWarehouse(conn, warehouseId)
    }
    if (docType === 'transfer') {
      await assertWarehouse(conn, sourceWarehouseId, 'Склад отправления')
      await assertWarehouse(conn, targetWarehouseId, 'Склад получения')
      if (sourceWarehouseId === targetWarehouseId) {
        throw Object.assign(new Error('Для перемещения между складами выберите разные склады'), { status: 400 })
      }
    }

    const [ins] = await conn.execute(
      `
      INSERT INTO warehouse_documents
        (doc_type, status, document_date, warehouse_id, source_warehouse_id, target_warehouse_id, basis_document, client_reference, source_type, source_id, source_line_id, source_label, notes, created_by)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        docType,
        toMysqlDateTime(req.body?.document_date),
        docType === 'transfer' ? null : warehouseId,
        sourceWarehouseId,
        targetWarehouseId,
        nz(req.body?.basis_document),
        nz(req.body?.client_reference),
        nz(req.body?.source_type),
        nz(req.body?.source_id),
        nz(req.body?.source_line_id),
        nz(req.body?.source_label),
        nz(req.body?.notes),
        toId(req.user?.id),
      ]
    )

    const documentId = ins.insertId
    const documentNo = `${DOC_TYPES[docType].prefix}-${String(documentId).padStart(6, '0')}`
    await conn.execute('UPDATE warehouse_documents SET document_no = ? WHERE id = ?', [documentNo, documentId])

    const documentSource = {
      source_type: nz(req.body?.source_type),
      source_id: nz(req.body?.source_id),
      source_line_id: nz(req.body?.source_line_id),
      source_label: nz(req.body?.source_label),
    }

    for (const rawLine of lines) {
      const line = withDocumentSourceFallback(rawLine, documentSource, lines.length === 1)
      const { supplierPart, catalogPosition, catalogPositionId } = await resolveLineSku(conn, line)
      if (docType === 'receipt') {
        await validatePurchaseOrderReceiptLine(conn, line)
      }
      const effectiveUnit = line.unit_code || supplierPart.uom || catalogPosition?.uom || 'шт'
      await conn.execute(
        `
        INSERT INTO warehouse_document_lines
          (
            document_id,
            supplier_part_id,
            catalog_position_id,
            storage_place_id,
            target_storage_place_id,
            quantity,
            unit_code,
            reason,
            notes,
            source_type,
            source_id,
            source_line_id,
            source_label
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          documentId,
          line.supplier_part_id,
          catalogPositionId,
          line.storage_place_id,
          line.target_storage_place_id,
          line.quantity,
          effectiveUnit,
          line.reason,
          line.notes,
          line.source_type,
          line.source_id,
          line.source_line_id,
          line.source_label,
        ]
      )
    }

    let posted = null
    if (boolValue(req.body?.post, true)) {
      posted = await postDocument(conn, documentId, toId(req.user?.id))
    }

    await conn.commit()
    const [[fresh]] = await db.execute('SELECT * FROM warehouse_documents WHERE id = ?', [documentId])
    res.status(201).json({ document: posted || fresh })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    if (err?.status) return res.status(err.status).json({ message: err.message })
    if (err?.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ message: 'Проверьте склад, место хранения, единицу измерения и карточку позиции' })
    }
    console.error('POST /warehouse/documents error:', err)
    res.status(500).json({ message: 'Ошибка создания складского документа' })
  } finally {
    conn.release()
  }
})

router.post('/documents/:id/post', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор документа' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const document = await postDocument(conn, id, toId(req.user?.id))
    await conn.commit()
    res.json({ document })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    if (err?.status) return res.status(err.status).json({ message: err.message })
    console.error('POST /warehouse/documents/:id/post error:', err)
    res.status(500).json({ message: 'Ошибка проведения складского документа' })
  } finally {
    conn.release()
  }
})

module.exports = router
