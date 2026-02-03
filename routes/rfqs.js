const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const ExcelJS = require('exceljs')
const crypto = require('crypto')
const { bucket, bucketName } = require('../utils/gcsClient')
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

  const ensureSupplier = (supplier_id, supplier_name) => {
    if (!supplierMap.has(supplier_id)) {
      supplierMap.set(supplier_id, {
        supplier_id,
        supplier_name,
        match_types: new Set(),
        match_keys: new Set(),
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
               sp.id AS supplier_part_id
          FROM supplier_part_originals spo
          JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
         WHERE spo.original_part_id IN (${placeholders})
      `,
      originalIds
    )

    rows.forEach((row) => {
      const supplier = ensureSupplier(row.supplier_id, row.supplier_name)
      const types = originalTypeMap.get(row.original_part_id) || new Set()
      types.forEach((type) => {
        supplier.match_types.add(type)
        supplier.match_keys.add(`${type}:${row.original_part_id}`)
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
               ps.name AS supplier_name
          FROM supplier_bundle_item_links sbl
          JOIN supplier_parts sp ON sp.id = sbl.supplier_part_id
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
         WHERE sbl.item_id IN (${placeholders})
      `,
      bundleIds
    )

    rows.forEach((row) => {
      const supplier = ensureSupplier(row.supplier_id, row.supplier_name)
      supplier.match_types.add('KIT')
      supplier.match_keys.add(`KIT:${row.bundle_item_id}`)
    })
  }

  return [...supplierMap.values()]
    .map((row) => ({
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      parts_count: row.match_keys.size,
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
    if (!id) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!client_request_revision_id) return res.status(400).json({ message: 'client_request_revision_id обязателен' })

    const created_by_user_id = toId(req.user?.id)
    const assigned_to_user_id = toId(req.body.assigned_to_user_id) || created_by_user_id
    const status = nz(req.body.status) || 'draft'
    const note = nz(req.body.note)
    const [[requestRow]] = await db.execute(
      `SELECT req.id AS client_request_id,
              req.internal_number AS request_number,
              req.is_locked_after_release,
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
    if (!(requestRow.is_locked_after_release && requestRow.released_to_procurement_at)) {
      return res.status(409).json({ message: 'Создать RFQ можно только после отправки релиза заявки' })
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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

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
         JOIN client_request_revision_items cri ON cri.id = ri.client_request_revision_item_id
         LEFT JOIN original_parts op ON op.id = cri.original_part_id
        WHERE ri.rfq_id = ?
        ORDER BY ri.line_number ASC`,
      [rfqId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /rfqs/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/structure', async (req, res) => {
  try {
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId || !itemId) return res.status(400).json({ message: 'Некорректный ID' })

    const original_part_id = toId(req.body.original_part_id)
    if (!original_part_id) return res.status(400).json({ message: 'original_part_id обязателен' })

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
    if (!rfqId || !itemId || !componentId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId || !itemId || !componentId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const client_request_revision_item_id = toId(req.body.client_request_revision_item_id)
    if (!client_request_revision_item_id) {
      return res.status(400).json({ message: 'client_request_revision_item_id обязателен' })
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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    const [rows] = await db.execute(
      `SELECT rs.*,
              ps.name AS supplier_name,
              ps.default_incoterms,
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
      return res.status(400).json({ message: 'Некорректный ID' })
    }

    const [[supplierRow]] = await db.execute(
      'SELECT id FROM rfq_suppliers WHERE id = ? AND rfq_id = ?',
      [rfqSupplierId, rfqId]
    )
    if (!supplierRow) {
      return res.status(404).json({ message: 'Поставщик RFQ не найден' })
    }

    const [rows] = await db.execute(
      `SELECT *
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
    return res.status(400).json({ message: 'Некорректный ID' })
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

      placeholders.push('(?,?,?,?,?,?,?,?,?,?,?)')
      insertValues.push(
        rfqSupplierId,
        rfqItemId,
        lineType,
        originalPartId,
        altOriginalPartId,
        bundleId,
        bundleItemId,
        row.line_label || null,
        row.line_description || null,
        row.qty ?? null,
        row.uom || null
      )
    })

    if (placeholders.length) {
      await conn.execute(
        `
        INSERT INTO rfq_supplier_line_selections
          (rfq_supplier_id, rfq_item_id, line_type, original_part_id, alt_original_part_id, bundle_id, bundle_item_id,
           line_label, line_description, qty, uom)
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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })
    if (!supplierId) {
      return res.status(400).json({ message: 'supplier_id обязателен' })
    }

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
               sp.height_cm
          FROM supplier_part_originals spo
          JOIN supplier_parts sp ON sp.id = spo.supplier_part_id
         WHERE spo.original_part_id IN (${placeholders})
           AND sp.supplier_id = ?
        `,
        [...originalIds, supplierId]
      )

      rows.forEach((row) => {
        const key = String(row.original_part_id)
        if (!originals[key]) originals[key] = []
        originals[key].push(row)
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
               sp.height_cm
          FROM supplier_bundle_item_links sbl
          JOIN supplier_parts sp ON sp.id = sbl.supplier_part_id
         WHERE sbl.item_id IN (${placeholders})
           AND sp.supplier_id = ?
        `,
        [...bundleItemIds, supplierId]
      )

      rows.forEach((row) => {
        const key = String(row.bundle_item_id)
        if (!bundle_items[key]) bundle_items[key] = []
        bundle_items[key].push(row)
      })
    }

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
      if (!rfqId || !supplier_id) return res.status(400).json({ message: 'rfq_id и supplier_id обязательны' })

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
      return res.status(400).json({ message: 'Некорректный ID' })
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
  if (!id) return res.status(400).json({ message: 'Некорректный ID' })

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
      `DELETE spp FROM supplier_part_prices spp
       JOIN rfq_response_lines rl ON rl.id = spp.source_id
       JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
       JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
       JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
       WHERE rs.rfq_id = ?
         AND spp.source_type = 'RFQ'`,
      [id]
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
  if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

  const supplierIds = Array.isArray(req.body?.supplier_ids)
    ? req.body.supplier_ids.map(toId).filter(Boolean)
    : []
  if (!supplierIds.length) {
    return res.status(400).json({ message: 'supplier_ids обязателен' })
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
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

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
    const rfqId = toId(req.params.id)
    if (!rfqId) return res.status(400).json({ message: 'Некорректный ID' })

    if (!bucket || !bucketName) {
      return res.status(500).json({ message: 'GCS бакет не настроен на сервере' })
    }

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

    const excelRows = buildRfqExcelRows(structure)

    const supplierIds = Array.isArray(req.body?.supplier_ids)
      ? req.body.supplier_ids.map(toId).filter(Boolean)
      : []

    const [supplierRows] = await db.execute(
      `SELECT rs.*,
              ps.name AS supplier_name,
              ps.default_incoterms,
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
               sp.height_cm
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
               sp.height_cm
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

    const documents = []
    const errors = []
    const created_by_user_id = toId(req.user?.id)

    for (const supplier of selectedSuppliers) {
      try {
        const lang = (supplier.language || 'ru').toLowerCase()
        const langSuffix = lang === 'en' ? 'EN' : 'RU'
        const format = normalizeRfqFormat(supplier.rfq_format)
        const supplierSelections = selectionsBySupplier.get(supplier.id) || []
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
                  'Price',
                  'Currency',
                  'Lead time (days)',
                  'Weight, kg',
                  'Length, cm',
                  'Width, cm',
                  'Height, cm',
                  'MOQ',
                  'Pack',
                  'Incoterms',
                  'Payment terms',
                  'Validity (days)',
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
                  'Цена',
                  'Валюта',
                  'Срок (дн.)',
                  'Вес, кг',
                  'Длина, см',
                  'Ширина, см',
                  'Высота, см',
                  'MOQ',
                  'Упаковка',
                  'Incoterms',
                  'Условия оплаты',
                  'Validity (дн.)',
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
        sheet.mergeCells(noteRow.number, 1, noteRow.number, labels.header.length)
        sheet.addRow([])

        sheet.addRow(labels.header)
        sheet.getRow(sheet.lastRow.number).font = { bold: true }

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
        const isPositionRow = (row) =>
          ['DEMAND', 'BOM_COMPONENT', 'KIT_ROLE'].includes(String(row.type || '').toUpperCase())
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
            weightKg,
            lengthCm,
            widthCm,
            heightCm,
            '',
            '',
            supplier.default_incoterms || '',
            '',
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
      items.forEach((item) => {
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

      supplierSelections.forEach((sel) => {
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
        const item = itemMap.get(Number(sel.rfq_item_id)) || {}
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
        } else {
          let kitLineNumber = format === 'kit' ? 1 : null

          for (const item of items) {
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
            const itemHeader = sheet.addRow([
              ++lineCounter,
              `${item.original_cat_number || item.client_part_number || ''}`,
              pickDesc(item),
              item.requested_qty ?? '',
              displayUom(item.uom || ''),
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
            ])
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
          { width: 10 },
          { width: 8 },
          { width: 22 },
          { width: 34 },
          { width: 18 },
          { width: 12 },
          { width: 10 },
          { width: 12 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 10 },
          { width: 14 },
          { width: 12 },
          { width: 18 },
          { width: 12 },
          { width: 28 },
        ]

        const buffer = await workbook.xlsx.writeBuffer()
        const safeSupplier = safeSegment(supplier.supplier_name) || `supplier_${supplier.supplier_id}`
        const fileName = `rfq_${rfq.rfq_number || rfq.id}_${safeSupplier}_${fmtDate(new Date())}_${langSuffix}.xlsx`
        const objectPath = [
          'rfqs',
          String(rfq.id),
          'suppliers',
          String(supplier.supplier_id),
          `${Date.now()}_${safeSegment(fileName)}`
        ]
          .map((seg) => encodeURIComponent(seg))
          .join('/')

        await bucket.file(objectPath).save(buffer, {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })

        const fileUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`
        const payload = {
          rfq_id: rfq.id,
          supplier_id: supplier.supplier_id,
          supplier_format: format,
          generated_at: new Date().toISOString(),
          items: items.map((i) => ({
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
          structure_rows: excelRows,
        }

        await db.execute(
          `DELETE FROM rfq_documents
            WHERE rfq_id = ? AND rfq_supplier_id = ? AND document_type = 'rfq'`,
          [rfq.id, supplier.id]
        )

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
            'rfq-structure-v2',
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

    res.json({ success: errors.length === 0, documents, errors })
  } catch (e) {
    console.error('POST /rfqs/:id/send error:', e)
    res.status(500).json({ message: 'Ошибка отправки RFQ' })
  }
})

module.exports = router
