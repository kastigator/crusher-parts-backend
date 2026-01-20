const STRATEGY_MODES = new Set(['SINGLE', 'BOM', 'MIXED'])

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const numOr = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const boolToTinyint = (v, fallback = 1) => {
  if (v === undefined || v === null) return fallback
  return v ? 1 : 0
}

const normalizeStrategyMode = (value, fallback = 'SINGLE') =>
  STRATEGY_MODES.has(value) ? value : fallback

const pickDescription = (row) =>
  row?.description_ru ||
  row?.description_en ||
  row?.original_description_ru ||
  row?.original_description_en ||
  null

const fetchRfqItems = async (db, rfqId) => {
  const [items] = await db.execute(
    `SELECT ri.id AS rfq_item_id,
            ri.line_number,
            ri.requested_qty,
            ri.uom,
            ri.oem_only,
            ri.note,
            cri.client_description,
            cri.client_part_number,
            cri.original_part_id,
            op.cat_number AS original_cat_number,
            op.description_ru AS original_description_ru,
            op.description_en AS original_description_en
       FROM rfq_items ri
       JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
       LEFT JOIN original_parts op ON op.id = cri.original_part_id
      WHERE ri.rfq_id = ?
      ORDER BY ri.line_number ASC`,
    [rfqId]
  )

  return items
}

const fetchBomMap = async (db, parentIds) => {
  const bomByParent = new Map()
  const childIds = new Set()
  if (!parentIds.length) return { bomByParent, childIds }

  const placeholders = parentIds.map(() => '?').join(',')
  const [bomRows] = await db.execute(
    `
      SELECT b.parent_part_id,
             b.child_part_id,
             b.quantity,
             op.cat_number,
             op.description_ru,
             op.description_en
        FROM original_part_bom b
        JOIN original_parts op ON op.id = b.child_part_id
       WHERE b.parent_part_id IN (${placeholders})
       ORDER BY b.parent_part_id, b.child_part_id
    `,
    parentIds
  )

  bomRows.forEach((row) => {
    const parentId = toId(row.parent_part_id)
    if (!parentId) return
    const list = bomByParent.get(parentId) || []
    const componentQty = numOr(row.quantity, 1)
    list.push({
      original_part_id: row.child_part_id,
      cat_number: row.cat_number || null,
      description: row.description_ru || row.description_en || null,
      component_qty: componentQty,
      required_qty: componentQty,
      source_type: 'BOM',
    })
    bomByParent.set(parentId, list)
    if (toId(row.child_part_id)) childIds.add(row.child_part_id)
  })

  return { bomByParent, childIds }
}

const fetchBundleMap = async (db, partIds) => {
  const bundleIdsByPart = new Map()
  if (!partIds.length) return bundleIdsByPart

  const placeholders = partIds.map(() => '?').join(',')
  const [bundleRows] = await db.execute(
    `
      SELECT id, original_part_id
        FROM supplier_bundles
       WHERE original_part_id IN (${placeholders})
       ORDER BY id DESC
    `,
    partIds
  )

  bundleRows.forEach((row) => {
    const partId = toId(row.original_part_id)
    if (!partId) return
    const list = bundleIdsByPart.get(partId) || []
    list.push(row.id)
    bundleIdsByPart.set(partId, list)
  })

  return bundleIdsByPart
}

const fetchStrategies = async (db, rfqItemIds) => {
  const strategyMap = new Map()
  if (!rfqItemIds.length) return strategyMap

  const [rows] = await db.execute(
    `SELECT * FROM rfq_item_strategies WHERE rfq_item_id IN (?)`,
    [rfqItemIds]
  )
  rows.forEach((row) => {
    strategyMap.set(row.rfq_item_id, row)
  })

  return strategyMap
}

const fetchComponents = async (db, rfqItemIds) => {
  const componentsByItem = new Map()
  if (!rfqItemIds.length) return componentsByItem

  const [rows] = await db.execute(
    `
      SELECT c.*, op.cat_number, op.description_ru, op.description_en
        FROM rfq_item_components c
        JOIN original_parts op ON op.id = c.original_part_id
       WHERE c.rfq_item_id IN (?)
       ORDER BY c.rfq_item_id, c.id
    `,
    [rfqItemIds]
  )

  rows.forEach((row) => {
    const list = componentsByItem.get(row.rfq_item_id) || []
    list.push({
      rfq_item_component_id: row.id,
      original_part_id: row.original_part_id,
      cat_number: row.cat_number || null,
      description: row.description_ru || row.description_en || null,
      component_qty: numOr(row.component_qty, 1),
      required_qty: numOr(row.required_qty, 1),
      source_type: row.source_type || 'BOM',
      note: row.note || null,
    })
    componentsByItem.set(row.rfq_item_id, list)
  })

  return componentsByItem
}

const buildComponentsFromStrategy = ({
  item,
  mode,
  bomByParent,
  includeSelfFallback,
}) => {
  const originalPartId = toId(item.original_part_id)
  const requestedQty = numOr(item.requested_qty, 1)
  const bomItems = originalPartId ? bomByParent.get(originalPartId) || [] : []
  const hasBom = bomItems.length > 0

  const components = []

  const addSelf = () => {
    if (!originalPartId) return
    components.push({
      original_part_id: originalPartId,
      cat_number: item.original_cat_number || item.client_part_number || null,
      description: pickDescription(item),
      component_qty: 1,
      required_qty: requestedQty,
      source_type: 'SELF',
    })
  }

  if (mode === 'BOM') {
    if (hasBom) {
      bomItems.forEach((c) => {
        components.push({
          ...c,
          required_qty: numOr(c.component_qty, 1) * requestedQty,
          source_type: 'BOM',
        })
      })
    } else if (includeSelfFallback) {
      addSelf()
    }
  } else if (mode === 'MIXED') {
    if (hasBom) {
      bomItems.forEach((c) => {
        components.push({
          ...c,
          required_qty: numOr(c.component_qty, 1) * requestedQty,
          source_type: 'BOM',
        })
      })
    }
    addSelf()
  } else {
    addSelf()
  }

  return components
}

const ensureStrategiesAndComponents = async (db, rfqItems) => {
  if (!rfqItems.length) return
  const rfqItemIds = rfqItems.map((i) => i.rfq_item_id)
  const originalIds = rfqItems
    .map((i) => toId(i.original_part_id))
    .filter((v) => v !== null)

  const { bomByParent } = await fetchBomMap(db, originalIds)
  const strategyMap = await fetchStrategies(db, rfqItemIds)

  const strategyInserts = []
  const strategyValues = []

  rfqItems.forEach((item) => {
    if (strategyMap.has(item.rfq_item_id)) return
    const originalPartId = toId(item.original_part_id)
    const hasBom = originalPartId ? (bomByParent.get(originalPartId) || []).length > 0 : false
    const mode = hasBom ? 'BOM' : 'SINGLE'
    strategyInserts.push('(?,?,?,?,?,?,?,?)')
    strategyValues.push(
      item.rfq_item_id,
      mode,
      1,
      1,
      1,
      hasBom ? 1 : 0,
      null,
      null
    )
  })

  if (strategyInserts.length) {
    await db.execute(
      `INSERT INTO rfq_item_strategies
         (rfq_item_id, mode, allow_oem, allow_analog, allow_kit, allow_partial, note, created_at)
       VALUES ${strategyInserts.join(',')}`,
      strategyValues
    )
  }

  const [componentRows] = await db.execute(
    'SELECT rfq_item_id, COUNT(*) AS cnt FROM rfq_item_components WHERE rfq_item_id IN (?) GROUP BY rfq_item_id',
    [rfqItemIds]
  )
  const hasComponents = new Map(componentRows.map((row) => [row.rfq_item_id, row.cnt]))

  for (const item of rfqItems) {
    if (hasComponents.get(item.rfq_item_id)) continue

    const strategy = strategyMap.get(item.rfq_item_id)
    const mode = normalizeStrategyMode(strategy?.mode, 'SINGLE')
    await rebuildComponentsForItem(db, item, mode, bomByParent)
  }
}

const rebuildComponentsForItem = async (db, item, mode, bomByParentOverride) => {
  const rfqItemId = toId(item.rfq_item_id)
  if (!rfqItemId) return []

  const originalPartId = toId(item.original_part_id)
  if (!originalPartId) return []

  const bomByParent = bomByParentOverride
    ? bomByParentOverride
    : (await fetchBomMap(db, [originalPartId])).bomByParent

  const components = buildComponentsFromStrategy({
    item,
    mode: normalizeStrategyMode(mode, 'SINGLE'),
    bomByParent,
    includeSelfFallback: true,
  })

  await db.execute('DELETE FROM rfq_item_components WHERE rfq_item_id = ?', [rfqItemId])

  if (!components.length) return []

  const placeholders = components.map(() => '(?,?,?,?,?,?)').join(',')
  const values = []
  components.forEach((comp) => {
    values.push(
      rfqItemId,
      comp.original_part_id,
      numOr(comp.component_qty, 1),
      numOr(comp.required_qty, 1),
      comp.source_type || 'BOM',
      null
    )
  })

  await db.execute(
    `INSERT INTO rfq_item_components
       (rfq_item_id, original_part_id, component_qty, required_qty, source_type, note)
     VALUES ${placeholders}`,
    values
  )

  return components
}

const buildRfqStructure = async (db, rfqId, opts = {}) => {
  const id = toId(rfqId)
  if (!id) return { rfq_id: null, items: [] }

  const includeSuppliers = !!opts.includeSuppliers
  const includeResponses = !!opts.includeResponses
  const includeSelfFallback = opts.includeSelf !== undefined ? !!opts.includeSelf : true

  const items = await fetchRfqItems(db, id)
  if (!items.length) return { rfq_id: id, items: [] }

  const rfqItemIds = items.map((i) => i.rfq_item_id)
  const originalIds = items
    .map((i) => toId(i.original_part_id))
    .filter((v) => v !== null)

  const { bomByParent, childIds } = await fetchBomMap(db, originalIds)
  const strategyMap = await fetchStrategies(db, rfqItemIds)
  const componentsByItem = await fetchComponents(db, rfqItemIds)

  const bundleTargetIds = [...new Set([...originalIds, ...childIds])]
  const bundleIdsByPart = await fetchBundleMap(db, bundleTargetIds)

  const structureItems = items.map((item) => {
    const originalPartId = toId(item.original_part_id)
    const requestedQty = numOr(item.requested_qty, 1)
    const bomItems = originalPartId ? bomByParent.get(originalPartId) || [] : []
    const hasBom = bomItems.length > 0
    const bundleIds = originalPartId ? bundleIdsByPart.get(originalPartId) || [] : []

    const existingComponents = componentsByItem.get(item.rfq_item_id) || []
    const defaultMode = hasBom ? 'BOM' : 'SINGLE'
    const strategyRow = strategyMap.get(item.rfq_item_id)
    const mode = normalizeStrategyMode(strategyRow?.mode, defaultMode)

    const strategy = {
      mode,
      allow_oem: boolToTinyint(strategyRow?.allow_oem, 1),
      allow_analog: boolToTinyint(strategyRow?.allow_analog, 1),
      allow_kit: boolToTinyint(strategyRow?.allow_kit, 1),
      allow_partial: boolToTinyint(strategyRow?.allow_partial, hasBom ? 1 : 0),
      note: strategyRow?.note || null,
      is_initialized: !!strategyRow,
    }

    let components = existingComponents.length
      ? existingComponents
      : buildComponentsFromStrategy({
          item,
          mode,
          bomByParent,
          includeSelfFallback,
        })

    components = components.map((comp) => {
      const requiredQty = numOr(comp.component_qty, 1) * requestedQty
      const compBundleIds = bundleIdsByPart.get(comp.original_part_id) || []
      return {
        ...comp,
        required_qty: requiredQty,
        bundle_ids: compBundleIds,
        bundle_count: compBundleIds.length,
      }
    })

    return {
      rfq_item_id: item.rfq_item_id,
      line_number: item.line_number,
      original_part_id: originalPartId,
      original_cat_number: item.original_cat_number || null,
      client_part_number: item.client_part_number || null,
      description: pickDescription(item),
      client_description: item.client_description || null,
      requested_qty: requestedQty,
      uom: item.uom || null,
      has_bom: hasBom,
      bundle_ids: bundleIds,
      bundle_count: bundleIds.length,
      components,
      strategy,
      unresolved: !originalPartId,
    }
  })

  if (!includeSuppliers && !includeResponses) {
    return { rfq_id: id, items: structureItems }
  }

  const componentIds = new Set()
  structureItems.forEach((item) => {
    item.components.forEach((comp) => {
      if (toId(comp.original_part_id)) componentIds.add(comp.original_part_id)
    })
  })

  const suppliersByPart = new Map()
  if (includeSuppliers && componentIds.size) {
    const ids = [...componentIds]
    const placeholders = ids.map(() => '?').join(',')
    const [rows] = await db.execute(
      `
      SELECT spo.original_part_id,
             sp.supplier_id,
             sp.supplier_part_number,
             ps.name AS supplier_name
        FROM supplier_part_originals spo
        JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
       WHERE spo.original_part_id IN (${placeholders})
       ORDER BY ps.name ASC, sp.supplier_part_number ASC
      `,
      ids
    )

    rows.forEach((row) => {
      const partId = toId(row.original_part_id)
      if (!partId) return
      const suppliers = suppliersByPart.get(partId) || new Map()
      const supplierId = toId(row.supplier_id)
      if (!supplierId) return
      const entry = suppliers.get(supplierId) || {
        supplier_id: supplierId,
        supplier_name: row.supplier_name || null,
        part_numbers: [],
      }
      if (row.supplier_part_number) entry.part_numbers.push(row.supplier_part_number)
      suppliers.set(supplierId, entry)
      suppliersByPart.set(partId, suppliers)
    })
  }

  let responseRows = []
  if (includeResponses) {
    const [rows] = await db.execute(
      `
      SELECT rl.*, rs.supplier_id, ps.name AS supplier_name,
             sp.supplier_part_number,
             sp.description_ru AS supplier_part_description_ru,
             sp.description_en AS supplier_part_description_en
        FROM rfq_response_lines rl
        JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
        JOIN rfq_supplier_responses r ON r.id = rr.rfq_supplier_response_id
        JOIN rfq_suppliers rs ON rs.id = r.rfq_supplier_id
        JOIN part_suppliers ps ON ps.id = rs.supplier_id
        LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
       WHERE rs.rfq_id = ?
       ORDER BY rl.id DESC
      `,
      [id]
    )
    responseRows = rows
  }

  structureItems.forEach((item) => {
    item.components = item.components.map((comp) => {
      const suppliers = suppliersByPart.get(comp.original_part_id) || new Map()
      const list = Array.from(suppliers.values()).map((s) => ({
        supplier_id: s.supplier_id,
        supplier_name: s.supplier_name,
        parts_count: s.part_numbers.length,
        part_numbers: s.part_numbers.slice(0, 3),
      }))

      const responses = []
      if (includeResponses && responseRows.length) {
        responseRows.forEach((row) => {
          if (row.rfq_item_component_id) {
            if (row.rfq_item_component_id !== comp.rfq_item_component_id) return
          } else if (toId(row.original_part_id)) {
            if (toId(row.original_part_id) !== toId(comp.original_part_id)) return
            if (toId(row.rfq_item_id) !== toId(item.rfq_item_id)) return
          } else {
            if (toId(row.rfq_item_id) !== toId(item.rfq_item_id)) return
          }

          responses.push({
            rfq_response_line_id: row.id,
            supplier_id: row.supplier_id,
            supplier_name: row.supplier_name,
            supplier_part_number: row.supplier_part_number || null,
            supplier_part_description:
              row.supplier_part_description_ru ||
              row.supplier_part_description_en ||
              null,
            offer_type: row.offer_type,
            price: row.price,
            currency: row.currency,
            lead_time_days: row.lead_time_days,
            moq: row.moq,
            bundle_id: row.bundle_id,
          })
        })
      }

      return {
        ...comp,
        suppliers: includeSuppliers ? list : undefined,
        suppliers_count: includeSuppliers ? list.length : undefined,
        responses: includeResponses ? responses : undefined,
      }
    })
  })

  return { rfq_id: id, items: structureItems }
}

module.exports = {
  buildRfqStructure,
  ensureStrategiesAndComponents,
  rebuildComponentsForItem,
  normalizeStrategyMode,
}
