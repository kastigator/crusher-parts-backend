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

const fetchRevisionItems = async (db, revisionId) => {
  const [items] = await db.execute(
    `SELECT ri.id AS revision_item_id,
            ri.line_number,
            ri.requested_qty,
            ri.uom,
            ri.oem_only,
            ri.client_part_number,
            ri.client_description,
            ri.original_part_id,
            op.cat_number AS original_cat_number,
            op.description_ru AS original_description_ru,
            op.description_en AS original_description_en
       FROM client_request_revision_items ri
       LEFT JOIN original_parts op ON op.id = ri.original_part_id
      WHERE ri.client_request_revision_id = ?
      ORDER BY ri.line_number ASC`,
    [revisionId]
  )

  return items
}

const fetchBomMap = async (db, parentIds) => {
  const bomByParent = new Map()
  if (!parentIds.length) return { bomByParent }

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
  })

  return { bomByParent }
}

const fetchStrategies = async (db, revisionItemIds) => {
  const strategyMap = new Map()
  if (!revisionItemIds.length) return strategyMap

  const [rows] = await db.execute(
    `SELECT * FROM client_request_revision_item_strategies WHERE client_request_revision_item_id IN (?)`,
    [revisionItemIds]
  )
  rows.forEach((row) => {
    strategyMap.set(row.client_request_revision_item_id, row)
  })

  return strategyMap
}

const fetchComponents = async (db, revisionItemIds) => {
  const componentsByItem = new Map()
  if (!revisionItemIds.length) return componentsByItem

  const [rows] = await db.execute(
    `
      SELECT c.*, op.cat_number, op.description_ru, op.description_en
        FROM client_request_revision_item_components c
        JOIN original_parts op ON op.id = c.original_part_id
       WHERE c.client_request_revision_item_id IN (?)
       ORDER BY c.client_request_revision_item_id, c.id
    `,
    [revisionItemIds]
  )

  rows.forEach((row) => {
    const list = componentsByItem.get(row.client_request_revision_item_id) || []
    list.push({
      component_id: row.id,
      original_part_id: row.original_part_id,
      cat_number: row.cat_number || null,
      description: row.description_ru || row.description_en || null,
      component_qty: numOr(row.component_qty, 1),
      required_qty: numOr(row.required_qty, 1),
      source_type: row.source_type || 'BOM',
      note: row.note || null,
    })
    componentsByItem.set(row.client_request_revision_item_id, list)
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

const ensureStrategiesAndComponents = async (db, revisionItems) => {
  if (!revisionItems.length) return
  const uniqueItems = new Map()
  revisionItems.forEach((item) => {
    if (!item?.revision_item_id) return
    if (!uniqueItems.has(item.revision_item_id)) {
      uniqueItems.set(item.revision_item_id, item)
    }
  })
  const itemsList = Array.from(uniqueItems.values())
  if (!itemsList.length) return
  const itemIds = itemsList.map((i) => i.revision_item_id)
  const originalIds = itemsList
    .map((i) => toId(i.original_part_id))
    .filter((v) => v !== null)

  const { bomByParent } = await fetchBomMap(db, originalIds)
  const strategyMap = await fetchStrategies(db, itemIds)

  const strategyInserts = []
  const strategyValues = []

  itemsList.forEach((item) => {
    if (strategyMap.has(item.revision_item_id)) return
    const originalPartId = toId(item.original_part_id)
    const hasBom = originalPartId ? (bomByParent.get(originalPartId) || []).length > 0 : false
    const mode = hasBom ? 'BOM' : 'SINGLE'
    strategyInserts.push('(?,?,?,?,?,?,?)')
    strategyValues.push(
      item.revision_item_id,
      mode,
      1,
      1,
      1,
      hasBom ? 1 : 0,
      null
    )
  })

  if (strategyInserts.length) {
    await db.execute(
      `INSERT IGNORE INTO client_request_revision_item_strategies
         (client_request_revision_item_id, mode, allow_oem, allow_analog, allow_kit, allow_partial, note)
       VALUES ${strategyInserts.join(',')}`,
      strategyValues
    )
  }

  const [componentRows] = await db.execute(
    `SELECT client_request_revision_item_id AS item_id, COUNT(*) AS cnt
       FROM client_request_revision_item_components
      WHERE client_request_revision_item_id IN (?)
      GROUP BY client_request_revision_item_id`,
    [itemIds]
  )
  const hasComponents = new Map(componentRows.map((row) => [row.item_id, row.cnt]))

  for (const item of itemsList) {
    if (hasComponents.get(item.revision_item_id)) continue
    const strategy = strategyMap.get(item.revision_item_id)
    const mode = normalizeStrategyMode(strategy?.mode, 'SINGLE')
    await rebuildComponentsForItem(db, item, mode, bomByParent)
  }
}

const rebuildComponentsForItem = async (db, item, mode, bomByParentOverride) => {
  const itemId = toId(item.revision_item_id)
  if (!itemId) return []

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

  await db.execute(
    'DELETE FROM client_request_revision_item_components WHERE client_request_revision_item_id = ?',
    [itemId]
  )

  if (!components.length) return []

  const placeholders = components.map(() => '(?,?,?,?,?,?)').join(',')
  const values = []
  components.forEach((comp) => {
    values.push(
      itemId,
      comp.original_part_id,
      numOr(comp.component_qty, 1),
      numOr(comp.required_qty, 1),
      comp.source_type || 'BOM',
      null
    )
  })

  await db.execute(
    `INSERT INTO client_request_revision_item_components
       (client_request_revision_item_id, original_part_id, component_qty, required_qty, source_type, note)
     VALUES ${placeholders}`,
    values
  )

  return components
}

const buildRevisionStructure = async (db, revisionId) => {
  const id = toId(revisionId)
  if (!id) return { revision_id: null, items: [] }

  const items = await fetchRevisionItems(db, id)
  if (!items.length) return { revision_id: id, items: [] }

  const itemIds = items.map((i) => i.revision_item_id)
  const originalIds = items
    .map((i) => toId(i.original_part_id))
    .filter((v) => v !== null)

  const { bomByParent } = await fetchBomMap(db, originalIds)
  const strategyMap = await fetchStrategies(db, itemIds)
  const componentsByItem = await fetchComponents(db, itemIds)

  const structureItems = items.map((item) => {
    const originalPartId = toId(item.original_part_id)
    const requestedQty = numOr(item.requested_qty, 1)
    const bomItems = originalPartId ? bomByParent.get(originalPartId) || [] : []
    const hasBom = bomItems.length > 0
    const existingComponents = componentsByItem.get(item.revision_item_id) || []
    const defaultMode = hasBom ? 'BOM' : 'SINGLE'
    const strategyRow = strategyMap.get(item.revision_item_id)
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
          includeSelfFallback: true,
        })

    components = components.map((comp) => ({
      ...comp,
      required_qty: numOr(comp.component_qty, 1) * requestedQty,
    }))

    return {
      revision_item_id: item.revision_item_id,
      line_number: item.line_number,
      original_part_id: originalPartId,
      original_cat_number: item.original_cat_number || null,
      client_part_number: item.client_part_number || null,
      description: pickDescription(item),
      client_description: item.client_description || null,
      requested_qty: requestedQty,
      uom: item.uom || null,
      has_bom: hasBom,
      components,
      strategy,
      unresolved: !originalPartId,
    }
  })

  return { revision_id: id, items: structureItems }
}

module.exports = {
  fetchRevisionItems,
  ensureStrategiesAndComponents,
  rebuildComponentsForItem,
  buildRevisionStructure,
}
