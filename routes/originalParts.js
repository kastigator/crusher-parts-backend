// routes/originalParts.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const { normalizeUom: normalizeUomFromUtils } = require('../utils/uom')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')
const { buildTrashPreview, MODE: TRASH_MODE } = require('../utils/trashPreview')

// ------------------------------
// helpers
// ------------------------------
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v); return Number.isFinite(n) ? n : null
}
const boolToTinyint = (v, def = 0) => {
  if (v === undefined || v === null || v === '') return def
  const s = String(v).trim().toLowerCase()
  if (s === '1' || s === 'true' || s === 'yes' || s === 'да') return 1
  if (s === '0' || s === 'false' || s === 'no' || s === 'нет') return 0
  return def
}
const normalizePartNumber = (v) =>
  String(v || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-.]/g, '')
const NORM_CAT_SQL =
  "UPPER(REPLACE(REPLACE(REPLACE(TRIM(cat_number), ' ', ''), '-', ''), '.', ''))"

// Guard against stale runtime/module cache mismatches:
// if helper import is unavailable, keep endpoint operational with local fallback.
const normalizeUom =
  typeof normalizeUomFromUtils === 'function'
    ? normalizeUomFromUtils
    : (value, { allowEmpty = true } = {}) => {
        if (value === undefined || value === null || String(value).trim() === '') {
          return { uom: allowEmpty ? null : undefined, error: null }
        }
        const key = String(value).trim().toLowerCase()
        const map = {
          pcs: 'pcs', piece: 'pcs', pc: 'pcs', шт: 'pcs', 'штук': 'pcs', 'шт.': 'pcs',
          kg: 'kg', kilogram: 'kg', kilo: 'kg', кг: 'kg', 'кг.': 'kg',
          set: 'set', комплект: 'set', компл: 'set', 'компл.': 'set',
        }
        const mapped = map[key]
        if (mapped) return { uom: mapped, error: null }
        return { uom: null, error: `Некорректная единица измерения: ${value}` }
      }

// tnved helper: по id или по текстовому коду
async function resolveTnvedId(dbConn, tnved_code_id, tnved_code) {
  if (tnved_code_id !== undefined && tnved_code_id !== null) {
    const id = Number(tnved_code_id)
    if (Number.isFinite(id)) return id
  }
  const code = nz(tnved_code)
  if (!code) return null
  const [rows] = await dbConn.execute('SELECT id FROM tnved_codes WHERE code = ?', [code])
  if (!rows.length) throw new Error('TNVED_NOT_FOUND')
  return rows[0].id
}

function isMissingOemTablesError(e) {
  return (
    e?.code === 'ER_NO_SUCH_TABLE' ||
    e?.code === 'ER_BAD_FIELD_ERROR' ||
    e?.code === 'ER_BAD_TABLE_ERROR'
  )
}

async function getModelWithManufacturer(dbConn, equipment_model_id) {
  const [[row]] = await dbConn.execute(
    `
    SELECT m.id AS model_id, m.model_name, m.manufacturer_id, mf.name AS manufacturer_name
      FROM equipment_models m
      JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
     WHERE m.id = ?
    `,
    [equipment_model_id]
  )
  return row || null
}

async function createOemRootTrashEntry(conn, req, partId, beforePart) {
  const [fitments] = await conn.execute(
    'SELECT * FROM oem_part_model_fitments WHERE oem_part_id = ? ORDER BY equipment_model_id ASC, id ASC',
    [partId]
  )
  const [unitOverrides] = await conn.execute(
    'SELECT * FROM oem_part_unit_overrides WHERE oem_part_id = ? ORDER BY client_equipment_unit_id ASC, id ASC',
    [partId]
  )
  const [materialOverrides] = await conn.execute(
    'SELECT * FROM oem_part_unit_material_overrides WHERE oem_part_id = ? ORDER BY client_equipment_unit_id ASC, material_id ASC',
    [partId]
  )
  const [materialSpecs] = await conn.execute(
    'SELECT * FROM oem_part_unit_material_specs WHERE oem_part_id = ? ORDER BY client_equipment_unit_id ASC, material_id ASC',
    [partId]
  )

  const trashEntryId = await createTrashEntry({
    executor: conn,
    req,
    entityType: 'oem_parts',
    entityId: partId,
    rootEntityType: 'oem_parts',
    rootEntityId: partId,
    title: beforePart.part_number || `OEM деталь #${partId}`,
    subtitle: 'OEM part',
    snapshot: beforePart,
    context: {
      child_counts: {
        oem_part_model_fitments: fitments.length,
        oem_part_unit_overrides: unitOverrides.length,
        oem_part_unit_material_overrides: materialOverrides.length,
        oem_part_unit_material_specs: materialSpecs.length,
      },
    },
  })

  let sortOrder = 0
  for (const row of fitments) {
    await createTrashEntryItem({
      executor: conn,
      trashEntryId,
      itemType: 'oem_part_model_fitments',
      itemId: row.id || null,
      itemRole: 'fitment',
      title: `Fitment ${row.oem_part_id}:${row.equipment_model_id}`,
      snapshot: row,
      sortOrder: sortOrder++,
    })
  }
  for (const row of unitOverrides) {
    await createTrashEntryItem({
      executor: conn,
      trashEntryId,
      itemType: 'oem_part_unit_overrides',
      itemId: row.id || null,
      itemRole: 'unit_override',
      title: `Unit override ${row.client_equipment_unit_id}:${row.oem_part_id}`,
      snapshot: row,
      sortOrder: sortOrder++,
    })
  }
  for (const row of materialOverrides) {
    await createTrashEntryItem({
      executor: conn,
      trashEntryId,
      itemType: 'oem_part_unit_material_overrides',
      itemId: null,
      itemRole: 'unit_material_override',
      title: `Unit material override ${row.client_equipment_unit_id}:${row.oem_part_id}:${row.material_id}`,
      snapshot: row,
      sortOrder: sortOrder++,
    })
  }
  for (const row of materialSpecs) {
    await createTrashEntryItem({
      executor: conn,
      trashEntryId,
      itemType: 'oem_part_unit_material_specs',
      itemId: null,
      itemRole: 'unit_material_specs',
      title: `Unit material specs ${row.client_equipment_unit_id}:${row.oem_part_id}:${row.material_id}`,
      snapshot: row,
      sortOrder: sortOrder++,
    })
  }

  return {
    trashEntryId,
    fitments,
  }
}

async function createOemFitmentTrashEntry(conn, req, partId, targetModelId, partNumber) {
  const [[fitmentRow]] = await conn.execute(
    'SELECT * FROM oem_part_model_fitments WHERE oem_part_id = ? AND equipment_model_id = ? FOR UPDATE',
    [partId, targetModelId]
  )
  if (!fitmentRow) {
    const err = new Error('FITMENT_NOT_FOUND')
    err.status = 404
    throw err
  }

  const model = await getModelWithManufacturer(conn, targetModelId)
  const [unitOverrides] = await conn.execute(
    `
    SELECT opuo.*
      FROM oem_part_unit_overrides opuo
      JOIN client_equipment_units cu ON cu.id = opuo.client_equipment_unit_id
     WHERE opuo.oem_part_id = ?
       AND cu.equipment_model_id = ?
     ORDER BY opuo.client_equipment_unit_id ASC, opuo.id ASC
    `,
    [partId, targetModelId]
  )
  const [materialOverrides] = await conn.execute(
    `
    SELECT opumo.*
      FROM oem_part_unit_material_overrides opumo
      JOIN client_equipment_units cu ON cu.id = opumo.client_equipment_unit_id
     WHERE opumo.oem_part_id = ?
       AND cu.equipment_model_id = ?
     ORDER BY opumo.client_equipment_unit_id ASC, opumo.material_id ASC
    `,
    [partId, targetModelId]
  )
  const [materialSpecs] = await conn.execute(
    `
    SELECT opums.*
      FROM oem_part_unit_material_specs opums
      JOIN client_equipment_units cu ON cu.id = opums.client_equipment_unit_id
     WHERE opums.oem_part_id = ?
       AND cu.equipment_model_id = ?
     ORDER BY opums.client_equipment_unit_id ASC, opums.material_id ASC
    `,
    [partId, targetModelId]
  )

  const trashEntryId = await createTrashEntry({
    executor: conn,
    req,
    entityType: 'oem_part_model_fitments',
    entityId: partId,
    rootEntityType: 'oem_parts',
    rootEntityId: partId,
    deleteMode: 'relation_delete',
    title: `${partNumber || `OEM деталь #${partId}`} / ${model?.model_name || `Модель #${targetModelId}`}`,
    subtitle: 'OEM fitment',
    snapshot: fitmentRow,
    context: {
      equipment_model_id: targetModelId,
      model_name: model?.model_name || null,
      manufacturer_name: model?.manufacturer_name || null,
      child_counts: {
        oem_part_unit_overrides: unitOverrides.length,
        oem_part_unit_material_overrides: materialOverrides.length,
        oem_part_unit_material_specs: materialSpecs.length,
      },
    },
  })

  let sortOrder = 0
  for (const row of unitOverrides) {
    await createTrashEntryItem({
      executor: conn,
      trashEntryId,
      itemType: 'oem_part_unit_overrides',
      itemId: row.id || null,
      itemRole: 'unit_override',
      title: `Unit override ${row.client_equipment_unit_id}:${row.oem_part_id}`,
      snapshot: row,
      sortOrder: sortOrder++,
    })
  }
  for (const row of materialOverrides) {
    await createTrashEntryItem({
      executor: conn,
      trashEntryId,
      itemType: 'oem_part_unit_material_overrides',
      itemId: null,
      itemRole: 'unit_material_override',
      title: `Unit material override ${row.client_equipment_unit_id}:${row.oem_part_id}:${row.material_id}`,
      snapshot: row,
      sortOrder: sortOrder++,
    })
  }
  for (const row of materialSpecs) {
    await createTrashEntryItem({
      executor: conn,
      trashEntryId,
      itemType: 'oem_part_unit_material_specs',
      itemId: null,
      itemRole: 'unit_material_specs',
      title: `Unit material specs ${row.client_equipment_unit_id}:${row.oem_part_id}:${row.material_id}`,
      snapshot: row,
      sortOrder: sortOrder++,
    })
  }

  return {
    trashEntryId,
    modelName: model?.model_name || null,
  }
}

// Legacy original->OEM migration helpers were retired after the schema cleanup.
// Keep this router OEM-native only to avoid reviving the removed original_parts layer.

/* ================================================================
   LOOKUP (по каталожному номеру + опционально модель)
================================================================ */
router.get('/lookup', async (req, res) => {
  try {
    const cat = (req.query.cat_number || '').trim()
    if (!cat) return res.status(400).json({ message: 'cat_number обязателен' })
    const emid =
      req.query.equipment_model_id !== undefined ? toId(req.query.equipment_model_id) : undefined

    const [rows] = await db.execute(
      `
      SELECT
        p.id,
        fit.primary_equipment_model_id AS equipment_model_id,
        p.part_number AS cat_number,
        p.description_en,
        p.description_ru,
        p.tech_description,
        NULL AS weight_kg,
        p.uom,
        p.tnved_code_id,
        p.group_id,
        NULL AS length_cm,
        NULL AS width_cm,
        NULL AS height_cm,
        p.is_overweight,
        p.is_oversize,
        p.has_drawing,
        fit.primary_model_name AS model_name,
        mf.id AS manufacturer_id,
        mf.name AS manufacturer_name,
        tc.code AS tnved_code_text
      FROM oem_parts p
      JOIN equipment_manufacturers mf ON mf.id = p.manufacturer_id
      LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
      LEFT JOIN (
        SELECT
          f.oem_part_id,
          MIN(f.equipment_model_id) AS primary_equipment_model_id,
          SUBSTRING_INDEX(GROUP_CONCAT(em.model_name ORDER BY em.model_name SEPARATOR '||'), '||', 1) AS primary_model_name
        FROM oem_part_model_fitments f
        LEFT JOIN equipment_models em ON em.id = f.equipment_model_id
        GROUP BY f.oem_part_id
      ) fit ON fit.oem_part_id = p.id
      WHERE p.part_number = ?
      ${emid ? 'AND EXISTS (SELECT 1 FROM oem_part_model_fitments fx WHERE fx.oem_part_id = p.id AND fx.equipment_model_id = ?)' : ''}
      `,
      emid ? [cat, emid] : [cat]
    )

    if (!rows.length) return res.status(404).json({ message: 'Не найдено' })
    if (rows.length > 1 && emid === undefined) {
      return res.status(400).json({
        message: 'Найдено несколько моделей с таким номером — уточните модель техники',
      })
    }

    res.json(rows[0])
  } catch (e) {
    console.error('GET /original-parts/lookup error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   BULK LOOKUP (по списку каталожных номеров)
   POST /original-parts/bulk-lookup
   body: { cat_numbers: [..], equipment_model_id? }
================================================================ */
router.post('/bulk-lookup', async (req, res) => {
  try {
    const list = Array.isArray(req.body?.cat_numbers) ? req.body.cat_numbers : []
    const catNumbers = list
      .map((v) => String(v || '').trim())
      .filter((v) => v.length > 0)

    if (!catNumbers.length) {
      return res.status(400).json({ message: 'cat_numbers обязателен' })
    }

    const emid =
      req.body?.equipment_model_id !== undefined
        ? toId(req.body.equipment_model_id)
        : undefined

    const params = [...catNumbers]
    let sql = `
      SELECT
        p.id,
        fit.primary_equipment_model_id AS equipment_model_id,
        p.part_number AS cat_number,
        p.description_en,
        p.description_ru,
        p.tech_description,
        NULL AS weight_kg,
        p.uom,
        p.tnved_code_id,
        p.group_id,
        NULL AS length_cm,
        NULL AS width_cm,
        NULL AS height_cm,
        p.is_overweight,
        p.is_oversize,
        p.has_drawing,
        fit.primary_model_name AS model_name,
        mf.id AS manufacturer_id,
        mf.name AS manufacturer_name
      FROM oem_parts p
      JOIN equipment_manufacturers mf ON mf.id = p.manufacturer_id
      LEFT JOIN (
        SELECT
          f.oem_part_id,
          MIN(f.equipment_model_id) AS primary_equipment_model_id,
          SUBSTRING_INDEX(GROUP_CONCAT(em.model_name ORDER BY em.model_name SEPARATOR '||'), '||', 1) AS primary_model_name
        FROM oem_part_model_fitments f
        LEFT JOIN equipment_models em ON em.id = f.equipment_model_id
        GROUP BY f.oem_part_id
      ) fit ON fit.oem_part_id = p.id
      WHERE p.part_number IN (${catNumbers.map(() => '?').join(', ')})
    `
    if (emid) {
      sql += ' AND EXISTS (SELECT 1 FROM oem_part_model_fitments fx WHERE fx.oem_part_id = p.id AND fx.equipment_model_id = ?)'
      params.push(emid)
    }

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('POST /original-parts/bulk-lookup error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   FREQUENT (часто используемые детали)
   GET /original-parts/frequent?client_id=..&limit=10
================================================================ */
router.get('/frequent', async (req, res) => {
  try {
    const clientId = req.query.client_id ? toId(req.query.client_id) : null
    const limitRaw = Number(req.query.limit || 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10

    const params = []
    const where = ['ri.oem_part_id IS NOT NULL']
    if (clientId) {
      where.push('cr.client_id = ?')
      params.push(clientId)
    }

    const [rows] = await db.execute(
      `
      SELECT
             p.id,
             p.id AS original_part_id,
             p.part_number AS cat_number,
             p.description_ru,
             p.description_en,
             fit.primary_equipment_model_id AS equipment_model_id,
             fit.primary_model_name AS model_name,
             mf.name AS manufacturer_name,
             COUNT(*) AS usage_count
        FROM client_request_revision_items ri
        JOIN client_request_revisions rr ON rr.id = ri.client_request_revision_id
        JOIN client_requests cr ON cr.id = rr.client_request_id
        JOIN oem_parts p ON p.id = ri.oem_part_id
        JOIN equipment_manufacturers mf ON mf.id = p.manufacturer_id
        LEFT JOIN (
          SELECT
            f.oem_part_id,
            MIN(f.equipment_model_id) AS primary_equipment_model_id,
            SUBSTRING_INDEX(GROUP_CONCAT(em.model_name ORDER BY em.model_name SEPARATOR '||'), '||', 1) AS primary_model_name
          FROM oem_part_model_fitments f
          LEFT JOIN equipment_models em ON em.id = f.equipment_model_id
          GROUP BY f.oem_part_id
        ) fit ON fit.oem_part_id = p.id
       WHERE ${where.join(' AND ')}
       GROUP BY
             p.id,
             p.part_number,
             p.description_ru,
             p.description_en,
             fit.primary_equipment_model_id,
             fit.primary_model_name,
             mf.name
       ORDER BY usage_count DESC
       LIMIT ${limit}
      `,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /original-parts/frequent error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   LIST (фильтры: manufacturer_id, equipment_model_id, group_id, q)
   флаги: only_assemblies, only_parts, exclude_id
================================================================ */
router.get('/', async (req, res) => {
  try {
    try {
      const manufacturerId =
        req.query.manufacturer_id !== undefined ? toId(req.query.manufacturer_id) : null
      const equipmentModelId =
        req.query.equipment_model_id !== undefined ? toId(req.query.equipment_model_id) : null
      const groupId = req.query.group_id !== undefined ? toId(req.query.group_id) : null
      const classifierNodeId =
        req.query.classifier_node_id !== undefined ? toId(req.query.classifier_node_id) : null
      const excludeId = req.query.exclude_id !== undefined ? toId(req.query.exclude_id) : null
      const q = nz(req.query.q)
      const onlyAssemblies = ('' + (req.query.only_assemblies ?? '')).toLowerCase()
      const onlyParts = ('' + (req.query.only_parts ?? '')).toLowerCase()

      const where = []
      const params = []

      if (req.query.manufacturer_id !== undefined && !manufacturerId) {
        return res.status(400).json({ message: 'Некорректный производитель' })
      }
      if (req.query.equipment_model_id !== undefined && !equipmentModelId) {
        return res.status(400).json({ message: 'Некорректная модель техники' })
      }
      if (req.query.group_id !== undefined && !groupId) {
        return res.status(400).json({ message: 'Некорректная группа' })
      }
      if (req.query.classifier_node_id !== undefined && !classifierNodeId) {
        return res.status(400).json({ message: 'Некорректный узел классификатора' })
      }

      if (manufacturerId) {
        where.push('p.manufacturer_id = ?')
        params.push(manufacturerId)
      }
      if (equipmentModelId) {
        where.push('EXISTS (SELECT 1 FROM oem_part_model_fitments fx WHERE fx.oem_part_id = p.id AND fx.equipment_model_id = ?)')
        params.push(equipmentModelId)
      }
      if (classifierNodeId) {
        where.push(`
          EXISTS (
            SELECT 1
            FROM oem_part_model_fitments fx
            JOIN equipment_models emx ON emx.id = fx.equipment_model_id
            WHERE fx.oem_part_id = p.id
              AND emx.classifier_node_id = ?
          )
        `)
        params.push(classifierNodeId)
      }
      if (groupId) {
        where.push('p.group_id = ?')
        params.push(groupId)
      }
      if (excludeId) {
        where.push('p.id <> ?')
        params.push(excludeId)
      }
      if (q) {
        const like = `%${q}%`
        where.push('(p.part_number LIKE ? OR p.description_en LIKE ? OR p.description_ru LIKE ? OR p.tech_description LIKE ? OR tc.code LIKE ?)')
        params.push(like, like, like, like, like)
      }
      if (onlyAssemblies === '1' || onlyAssemblies === 'true') {
        where.push('EXISTS (SELECT 1 FROM oem_part_model_bom b WHERE b.parent_oem_part_id = p.id)')
      }
      if (onlyParts === '1' || onlyParts === 'true') {
        where.push('NOT EXISTS (SELECT 1 FROM oem_part_model_bom b WHERE b.parent_oem_part_id = p.id)')
      }

      let sql = `
        SELECT
          p.id,
          fit.primary_equipment_model_id AS equipment_model_id,
          p.part_number AS cat_number,
          p.description_en,
          p.description_ru,
          p.tech_description,
          NULL AS weight_kg,
          p.uom,
          p.tnved_code_id,
          p.group_id,
          NULL AS length_cm,
          NULL AS width_cm,
          NULL AS height_cm,
          p.is_overweight,
          p.is_oversize,
          p.has_drawing,
          fit.primary_model_name AS model_name,
          mf.name AS manufacturer_name,
          tc.code AS tnved_code_text,
          tc.description AS tnved_description,
          g.name AS group_name,
          COALESCE(ch.cnt, 0) AS children_count,
          COALESCE(pr.cnt, 0) AS parent_count,
          CASE WHEN COALESCE(ch.cnt, 0) > 0 THEN 1 ELSE 0 END AS is_assembly,
          fit.fitments_count AS application_models_count,
          COALESCE(cu.client_units_count, 0) AS client_units_count,
          COALESCE(cu.clients_count, 0) AS clients_count,
          cu.client_names AS client_names,
          cu.client_machine_refs AS client_machine_refs
        FROM oem_parts p
        JOIN equipment_manufacturers mf ON mf.id = p.manufacturer_id
        LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
        LEFT JOIN original_part_groups g ON g.id = p.group_id
        LEFT JOIN (
          SELECT
            f.oem_part_id,
            MIN(f.equipment_model_id) AS primary_equipment_model_id,
            SUBSTRING_INDEX(GROUP_CONCAT(em.model_name ORDER BY em.model_name SEPARATOR '||'), '||', 1) AS primary_model_name,
            COUNT(DISTINCT f.equipment_model_id) AS fitments_count
          FROM oem_part_model_fitments f
          LEFT JOIN equipment_models em ON em.id = f.equipment_model_id
          GROUP BY f.oem_part_id
        ) fit ON fit.oem_part_id = p.id
        LEFT JOIN (
          SELECT parent_oem_part_id, COUNT(*) cnt
          FROM oem_part_model_bom
          GROUP BY parent_oem_part_id
        ) ch ON ch.parent_oem_part_id = p.id
        LEFT JOIN (
          SELECT child_oem_part_id, COUNT(*) cnt
          FROM oem_part_model_bom
          GROUP BY child_oem_part_id
        ) pr ON pr.child_oem_part_id = p.id
        LEFT JOIN (
          SELECT
            f.oem_part_id,
            COUNT(DISTINCT cu.id) AS client_units_count,
            COUNT(DISTINCT c.id) AS clients_count,
            GROUP_CONCAT(DISTINCT c.company_name ORDER BY c.company_name SEPARATOR ' | ') AS client_names,
            GROUP_CONCAT(
              DISTINCT CONCAT(
                c.company_name,
                ' / ',
                COALESCE(NULLIF(TRIM(cu.serial_number), ''), 'без серийника')
              )
              ORDER BY c.company_name, cu.serial_number
              SEPARATOR ' | '
            ) AS client_machine_refs
          FROM oem_part_model_fitments f
          JOIN client_equipment_units cu ON cu.equipment_model_id = f.equipment_model_id
          JOIN clients c ON c.id = cu.client_id
          GROUP BY f.oem_part_id
        ) cu ON cu.oem_part_id = p.id
      `

      if (where.length) sql += ` WHERE ${where.join(' AND ')}`
      sql += ' ORDER BY p.id DESC'

      const [rows] = await db.execute(sql, params)
      return res.json(rows)
    } catch (compatErr) {
      if (!isMissingOemTablesError(compatErr)) throw compatErr
    }

    return res.status(500).json({
      message:
        'OEM-режим недоступен: обязательные таблицы новой схемы отсутствуют. Legacy list fallback отключён.',
    })
  } catch (err) {
    console.error('GET /original-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   READ ONE
================================================================ */
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    try {
      const [rowsCompat] = await db.execute(
        `
        SELECT
          p.id,
          fit.primary_equipment_model_id AS equipment_model_id,
          p.part_number AS cat_number,
          p.description_en,
          p.description_ru,
          p.tech_description,
          NULL AS weight_kg,
          p.uom,
          p.tnved_code_id,
          p.group_id,
          NULL AS length_cm,
          NULL AS width_cm,
          NULL AS height_cm,
          p.is_overweight,
          p.is_oversize,
          p.has_drawing,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM oem_part_model_bom b
              WHERE b.parent_oem_part_id = p.id
            ) THEN 1
            ELSE 0
          END AS is_assembly,
          fit.primary_model_name AS model_name,
          mf.id AS manufacturer_id,
          mf.name AS manufacturer_name,
          tc.code AS tnved_code_text
        FROM oem_parts p
        JOIN equipment_manufacturers mf ON mf.id = p.manufacturer_id
        LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
        LEFT JOIN (
          SELECT
            f.oem_part_id,
            MIN(f.equipment_model_id) AS primary_equipment_model_id,
            SUBSTRING_INDEX(GROUP_CONCAT(em.model_name ORDER BY em.model_name SEPARATOR '||'), '||', 1) AS primary_model_name
          FROM oem_part_model_fitments f
          LEFT JOIN equipment_models em ON em.id = f.equipment_model_id
          GROUP BY f.oem_part_id
        ) fit ON fit.oem_part_id = p.id
        WHERE p.id = ?
        `,
        [id]
      )
      if (rowsCompat.length) return res.json(rowsCompat[0])
    } catch (compatErr) {
      if (!isMissingOemTablesError(compatErr)) throw compatErr
    }

    return res.status(404).json({ message: 'Деталь не найдена' })
  } catch (e) {
    console.error('GET /original-parts/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   FULL CARD (расширенная карточка)
================================================================ */
router.get('/:id/full', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    try {
      const [rowsCompat] = await db.execute(
        `
        SELECT
          p.id,
          fit.primary_equipment_model_id AS equipment_model_id,
          p.part_number AS cat_number,
          p.description_en,
          p.description_ru,
          p.tech_description,
          NULL AS weight_kg,
          p.uom,
          p.tnved_code_id,
          p.group_id,
          NULL AS length_cm,
          NULL AS width_cm,
          NULL AS height_cm,
          p.is_overweight,
          p.is_oversize,
          p.has_drawing,
          fit.primary_model_name AS model_name,
          mf.id AS manufacturer_id,
          mf.name AS manufacturer_name,
          tc.code AS tnved_code,
          tc.description AS tnved_description,
          COALESCE(ch.cnt, 0) AS children_count,
          COALESCE(pr.cnt, 0) AS parent_count
        FROM oem_parts p
        JOIN equipment_manufacturers mf ON mf.id = p.manufacturer_id
        LEFT JOIN tnved_codes tc ON tc.id = p.tnved_code_id
        LEFT JOIN (
          SELECT
            f.oem_part_id,
            MIN(f.equipment_model_id) AS primary_equipment_model_id,
            SUBSTRING_INDEX(GROUP_CONCAT(em.model_name ORDER BY em.model_name SEPARATOR '||'), '||', 1) AS primary_model_name
          FROM oem_part_model_fitments f
          LEFT JOIN equipment_models em ON em.id = f.equipment_model_id
          GROUP BY f.oem_part_id
        ) fit ON fit.oem_part_id = p.id
        LEFT JOIN (
          SELECT parent_oem_part_id, COUNT(*) cnt FROM oem_part_model_bom GROUP BY parent_oem_part_id
        ) ch ON ch.parent_oem_part_id = p.id
        LEFT JOIN (
          SELECT child_oem_part_id, COUNT(*) cnt FROM oem_part_model_bom GROUP BY child_oem_part_id
        ) pr ON pr.child_oem_part_id = p.id
        WHERE p.id = ?
        `,
        [id]
      )
      if (rowsCompat.length) {
        const part = rowsCompat[0]
        const [fitments] = await db.execute(
          `
          SELECT DISTINCT
            em.id AS equipment_model_id,
            em.model_name
          FROM oem_part_model_fitments f
          JOIN equipment_models em ON em.id = f.equipment_model_id
          WHERE f.oem_part_id = ?
          ORDER BY em.model_name ASC
          `,
          [id]
        )

        return res.json({
          ...part,
          application_models: Array.isArray(fitments) ? fitments : [],
        })
      }
    } catch (compatErr) {
      if (!isMissingOemTablesError(compatErr)) throw compatErr
    }

    return res.status(500).json({
      message:
        'OEM-режим недоступен: обязательные таблицы новой схемы отсутствуют. Legacy full-card fallback отключён.',
    })
  } catch (e) {
    console.error('GET /original-parts/:id/full error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   SUPPLIER OFFERS (view v_original_part_supplier_offers)
================================================================ */
router.get('/:id/supplier-offers', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `SELECT
         original_part_id,
         supplier_part_id,
         supplier_id,
         supplier_name,
         supplier_part_number,
         description,
         last_price,
         last_currency,
         last_price_date
       FROM v_original_part_supplier_offers
       WHERE original_part_id = ?
       ORDER BY supplier_name ASC, supplier_part_number ASC`,
      [id]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /original-parts/:id/supplier-offers error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   CREATE
================================================================ */
router.post('/', async (req, res) => {
  try {
    try {
      const cat_number = nz(req.body.cat_number)
      const equipment_model_id = toId(req.body.equipment_model_id)
      if (!cat_number) return res.status(400).json({ message: 'cat_number обязателен' })
      if (!equipment_model_id) {
        return res.status(400).json({ message: 'Нужно выбрать модель техники' })
      }

      const [[model]] = await db.execute(
        `
        SELECT m.id, m.model_name, m.manufacturer_id, mf.name AS manufacturer_name
        FROM equipment_models m
        JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
        WHERE m.id = ?
        `,
        [equipment_model_id]
      )
      if (!model) return res.status(400).json({ message: 'Указанная модель не найдена' })

      const description_en = nz(req.body.description_en)
      const description_ru = nz(req.body.description_ru)
      const tech_description = nz(req.body.tech_description)
      const { uom: uomNormalized, error: uomError } = normalizeUom(req.body.uom || '', { allowEmpty: true })
      if (uomError) return res.status(400).json({ message: uomError })
      const has_drawing = boolToTinyint(req.body.has_drawing, 0)
      const is_overweight = req.body.is_overweight === undefined ? 0 : boolToTinyint(req.body.is_overweight, 0)
      const is_oversize = req.body.is_oversize === undefined ? 0 : boolToTinyint(req.body.is_oversize, 0)

      let groupIdParam = null
      if (req.body.group_id !== undefined && req.body.group_id !== null) {
        const gid = toId(req.body.group_id)
        if (!gid) return res.status(400).json({ message: 'Некорректная группа' })
        groupIdParam = gid
      }

      let tnvedId = null
      try {
        tnvedId = await resolveTnvedId(db, req.body.tnved_code_id, req.body.tnved_code)
      } catch (e) {
        if (e.message === 'TNVED_NOT_FOUND') {
          return res.status(400).json({ message: 'Код ТН ВЭД не найден в справочнике' })
        }
        throw e
      }

      const [existing] = await db.execute(
        `
        SELECT id
        FROM oem_parts
        WHERE manufacturer_id = ? AND part_number = ?
        LIMIT 1
        `,
        [model.manufacturer_id, cat_number]
      )

      let oemPartId = existing[0]?.id ? Number(existing[0].id) : null
      if (!oemPartId) {
        const [ins] = await db.execute(
          `
          INSERT INTO oem_parts
            (
              manufacturer_id, part_number, description_en, description_ru, tech_description,
              uom, tnved_code_id, group_id, has_drawing, is_overweight, is_oversize
            )
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `,
          [
            model.manufacturer_id,
            cat_number,
            description_en,
            description_ru,
            tech_description,
            uomNormalized || 'pcs',
            tnvedId,
            groupIdParam,
            has_drawing,
            is_overweight,
            is_oversize,
          ]
        )
        oemPartId = Number(ins.insertId)
      } else {
        await db.execute(
          `
          UPDATE oem_parts
             SET description_en = COALESCE(?, description_en),
                 description_ru = COALESCE(?, description_ru),
                 tech_description = COALESCE(?, tech_description),
                 uom = COALESCE(?, uom),
                 tnved_code_id = COALESCE(?, tnved_code_id),
                 group_id = COALESCE(?, group_id),
                 has_drawing = COALESCE(?, has_drawing),
                 is_overweight = COALESCE(?, is_overweight),
                 is_oversize = COALESCE(?, is_oversize)
           WHERE id = ?
          `,
          [
            description_en,
            description_ru,
            tech_description,
            uomNormalized,
            tnvedId,
            groupIdParam,
            has_drawing,
            is_overweight,
            is_oversize,
            oemPartId,
          ]
        )
      }

      await db.execute(
        `INSERT IGNORE INTO oem_part_model_fitments (oem_part_id, equipment_model_id) VALUES (?, ?)`,
        [oemPartId, equipment_model_id]
      )

      return res.status(201).json({
        id: oemPartId,
        equipment_model_id,
        cat_number,
        description_en,
        description_ru,
        tech_description,
        uom: uomNormalized || 'pcs',
        tnved_code_id: tnvedId,
        group_id: groupIdParam,
        has_drawing,
        is_overweight,
        is_oversize,
        manufacturer_name: model.manufacturer_name,
        model_name: model.model_name,
      })
    } catch (compatErr) {
      if (!isMissingOemTablesError(compatErr)) throw compatErr
    }

    return res.status(500).json({
      message:
        'OEM-режим недоступен: обязательные таблицы новой схемы отсутствуют. Legacy create отключён.',
    })
  } catch (err) {
    console.error('POST /original-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   UPDATE
================================================================ */
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    try {
      const [[before]] = await db.execute(
        `
        SELECT
          p.*,
          fit.primary_equipment_model_id AS equipment_model_id
        FROM oem_parts p
        LEFT JOIN (
          SELECT oem_part_id, MIN(equipment_model_id) AS primary_equipment_model_id
          FROM oem_part_model_fitments
          GROUP BY oem_part_id
        ) fit ON fit.oem_part_id = p.id
        WHERE p.id = ?
        `,
        [id]
      )
      if (before) {
        const cat_number = nz(req.body.cat_number)
        const description_en = nz(req.body.description_en)
        const description_ru = nz(req.body.description_ru)
        const tech_description = nz(req.body.tech_description)
        const { uom: uomNormalized, error: uomError } = normalizeUom(req.body.uom || '', { allowEmpty: true })
        if (uomError) return res.status(400).json({ message: uomError })

        let tnvedIdParam = undefined
        if (req.body.tnved_code_id !== undefined || req.body.tnved_code !== undefined) {
          try {
            tnvedIdParam = await resolveTnvedId(db, req.body.tnved_code_id, req.body.tnved_code)
          } catch (e) {
            if (e.message === 'TNVED_NOT_FOUND') {
              return res.status(400).json({ message: 'Код ТН ВЭД не найден в справочнике' })
            }
            throw e
          }
        }

        let groupIdParam = undefined
        if (req.body.group_id !== undefined) {
          groupIdParam =
            req.body.group_id === null || String(req.body.group_id).trim() === ''
              ? null
              : toId(req.body.group_id)
        }

        await db.execute(
          `
          UPDATE oem_parts
             SET part_number = COALESCE(?, part_number),
                 description_en = COALESCE(?, description_en),
                 description_ru = COALESCE(?, description_ru),
                 tech_description = COALESCE(?, tech_description),
                 uom = COALESCE(?, uom),
                 tnved_code_id = ?,
                 group_id = ?,
                 has_drawing = COALESCE(?, has_drawing),
                 is_overweight = COALESCE(?, is_overweight),
                 is_oversize = COALESCE(?, is_oversize)
           WHERE id = ?
          `,
          [
            cat_number,
            description_en,
            description_ru,
            tech_description,
            uomNormalized,
            tnvedIdParam === undefined ? before.tnved_code_id : tnvedIdParam,
            groupIdParam === undefined ? before.group_id : groupIdParam,
            req.body.has_drawing === undefined ? null : boolToTinyint(req.body.has_drawing, 0),
            req.body.is_overweight === undefined ? null : boolToTinyint(req.body.is_overweight, 0),
            req.body.is_oversize === undefined ? null : boolToTinyint(req.body.is_oversize, 0),
            id,
          ]
        )

        const modelIdParam = req.body.equipment_model_id !== undefined ? toId(req.body.equipment_model_id) : null
        if (modelIdParam) {
          await db.execute(
            `INSERT IGNORE INTO oem_part_model_fitments (oem_part_id, equipment_model_id) VALUES (?, ?)`,
            [id, modelIdParam]
          )
        }

        const [[after]] = await db.execute(
          `
          SELECT
            p.id,
            fit.primary_equipment_model_id AS equipment_model_id,
            p.part_number AS cat_number,
            p.description_en,
            p.description_ru,
            p.tech_description,
            p.uom,
            p.tnved_code_id,
            p.group_id,
            p.has_drawing,
            p.is_overweight,
            p.is_oversize
          FROM oem_parts p
          LEFT JOIN (
            SELECT oem_part_id, MIN(equipment_model_id) AS primary_equipment_model_id
            FROM oem_part_model_fitments
            GROUP BY oem_part_id
          ) fit ON fit.oem_part_id = p.id
          WHERE p.id = ?
          `,
          [id]
        )
        return res.json(after)
      }
    } catch (compatErr) {
      if (!isMissingOemTablesError(compatErr)) throw compatErr
    }

    return res.status(500).json({
      message:
        'OEM-режим недоступен: обязательные таблицы новой схемы отсутствуют. Legacy update отключён.',
    })
  } catch (err) {
    console.error('PUT /original-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   PATCH: привязать/снять ТН ВЭД у детали
================================================================ */
router.patch('/:id/tnved', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const { tnved_code_id, tnved_code } = req.body

    let tnvedId = null
    if (tnved_code_id === null || tnved_code === null) {
      tnvedId = null // снять привязку
    } else if (tnved_code_id !== undefined || tnved_code !== undefined) {
      tnvedId = await resolveTnvedId(db, tnved_code_id, tnved_code)
      if (tnvedId == null) return res.status(400).json({ message: 'Код ТН ВЭД не указан' })
    } else {
      return res
        .status(400)
        .json({ message: 'Укажите код ТН ВЭД или очистите значение' })
    }

    const [[before]] = await db.execute(
      `
      SELECT id, part_number, tnved_code_id
      FROM oem_parts
      WHERE id = ?
      `,
      [id]
    )
    if (!before) return res.status(404).json({ message: 'Деталь не найдена' })

    await db.execute('UPDATE oem_parts SET tnved_code_id = ? WHERE id = ?', [tnvedId, id])

    const [[after]] = await db.execute(
      `
      SELECT id, part_number, tnved_code_id
      FROM oem_parts
      WHERE id = ?
      `,
      [id]
    )

    const [codes] = await db.execute('SELECT id, code FROM tnved_codes WHERE id IN (?,?)', [
      before.tnved_code_id || 0,
      after.tnved_code_id || 0,
    ])
    const map = new Map(codes.map((r) => [r.id, r.code]))

    const oldDataForLog = {
      ...before,
      tnved_code_id: before.tnved_code_id
        ? map.get(before.tnved_code_id) || String(before.tnved_code_id)
        : null,
    }
    const newDataForLog = {
      ...after,
      tnved_code_id: after.tnved_code_id
        ? map.get(after.tnved_code_id) || String(after.tnved_code_id)
        : null,
    }

    await logFieldDiffs({
      req,
      oldData: oldDataForLog,
      newData: newDataForLog,
      entity_type: 'oem_parts',
      entity_id: id,
      comment: 'Привязка ТН ВЭД',
    })

    res.json(after)
  } catch (e) {
    if (e.message === 'TNVED_NOT_FOUND') {
      return res.status(400).json({ message: 'Указанный код ТН ВЭД не найден в справочнике' })
    }
    console.error('PATCH /original-parts/:id/tnved error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   DELETE ALL MODELS (same manufacturer + same normalized cat number)
================================================================ */
router.post('/:id/delete-all', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    const preview = await buildTrashPreview('oem_parts', id)
    if (!preview) return res.status(404).json({ message: 'Деталь не найдена' })
    if (preview.mode !== TRASH_MODE.TRASH) {
      return res.status(409).json({
        message: preview.summary?.message || 'Полное удаление недоступно',
        preview,
      })
    }

    await conn.beginTransaction()
    const [[before]] = await conn.execute('SELECT * FROM oem_parts WHERE id = ? FOR UPDATE', [id])
    if (!before) {
      await conn.rollback()
      return res.status(404).json({ message: 'Деталь не найдена' })
    }

    const { trashEntryId, fitments } = await createOemRootTrashEntry(conn, req, id, before)

    await conn.execute('DELETE FROM oem_parts WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'oem_parts',
      entity_id: id,
      old_value: String(trashEntryId),
      comment: `OEM деталь ${before.part_number} перемещена в корзину`,
    })

    await conn.commit()

    return res.json({
      success: true,
      message: 'OEM деталь перемещена в корзину',
      trash_entry_id: trashEntryId,
      deleted_count: fitments.length,
    })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {
      // ignore rollback errors
    }
    console.error('POST /original-parts/:id/delete-all error:', err)
    return res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

/* ================================================================
   DELETE
================================================================ */
router.delete('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const modelIdFromReq =
      req.body?.equipment_model_id !== undefined
        ? toId(req.body.equipment_model_id)
        : req.query.equipment_model_id !== undefined
          ? toId(req.query.equipment_model_id)
          : null

    const [[exists]] = await conn.execute(
      `
      SELECT
        p.id,
        p.part_number AS cat_number
      FROM oem_parts p
      WHERE p.id = ?
      `,
      [id]
    )
    if (!exists) return res.status(404).json({ message: 'Деталь не найдена' })

    const [fitments] = await conn.execute(
      `
      SELECT equipment_model_id
      FROM oem_part_model_fitments
      WHERE oem_part_id = ?
      ORDER BY equipment_model_id ASC
      `,
      [id]
    )
    const fitmentIds = fitments.map((row) => Number(row.equipment_model_id)).filter((n) => Number.isInteger(n) && n > 0)
    if (!fitmentIds.length) {
      const preview = await buildTrashPreview('oem_parts', id)
      if (!preview) return res.status(404).json({ message: 'Деталь не найдена' })
      if (preview.mode !== TRASH_MODE.TRASH) {
        return res.status(409).json({
          message: preview.summary?.message || 'Удаление недоступно',
          preview,
        })
      }

      await conn.beginTransaction()
      const [[before]] = await conn.execute('SELECT * FROM oem_parts WHERE id = ? FOR UPDATE', [id])
      const { trashEntryId } = await createOemRootTrashEntry(conn, req, id, before)
      await conn.execute('DELETE FROM oem_parts WHERE id = ?', [id])

      await logActivity({
        req,
        action: 'delete',
        entity_type: 'oem_parts',
        entity_id: id,
        old_value: String(trashEntryId),
        comment: `OEM деталь ${exists.cat_number} перемещена в корзину`,
      })
      await conn.commit()

      return res.json({ message: 'OEM деталь перемещена в корзину', trash_entry_id: trashEntryId })
    }

    const targetModelId = modelIdFromReq || fitmentIds[0]
    if (!fitmentIds.includes(targetModelId)) {
      return res.status(400).json({ message: 'Указанная модель применения не найдена у этой OEM детали' })
    }

    if (fitmentIds.length === 1) {
      const preview = await buildTrashPreview('oem_parts', id)
      if (!preview) return res.status(404).json({ message: 'Деталь не найдена' })
      if (preview.mode !== TRASH_MODE.TRASH) {
        return res.status(409).json({
          message: preview.summary?.message || 'Удаление недоступно',
          preview,
        })
      }

      await conn.beginTransaction()
      const [[before]] = await conn.execute('SELECT * FROM oem_parts WHERE id = ? FOR UPDATE', [id])
      const { trashEntryId } = await createOemRootTrashEntry(conn, req, id, before)
      await conn.execute('DELETE FROM oem_parts WHERE id = ?', [id])
      await logActivity({
        req,
        action: 'delete',
        entity_type: 'oem_parts',
        entity_id: id,
        old_value: String(trashEntryId),
        comment: `OEM деталь ${exists.cat_number} перемещена в корзину`,
      })
      await conn.commit()
      return res.json({ message: 'OEM деталь перемещена в корзину', trash_entry_id: trashEntryId })
    }

    const preview = await buildTrashPreview('oem_part_model_fitments', id, {
      equipment_model_id: targetModelId,
    })
    if (!preview) return res.status(404).json({ message: 'Связь применения не найдена' })
    if (preview.mode !== TRASH_MODE.RELATION_DELETE) {
      return res.status(409).json({
        message: preview.summary?.message || 'Удаление недоступно',
        preview,
      })
    }

    await conn.beginTransaction()
    const { trashEntryId, modelName } = await createOemFitmentTrashEntry(
      conn,
      req,
      id,
      targetModelId,
      exists.cat_number
    )
    await conn.execute(
      `
      DELETE opums
      FROM oem_part_unit_material_specs opums
      JOIN client_equipment_units cu ON cu.id = opums.client_equipment_unit_id
      WHERE opums.oem_part_id = ?
        AND cu.equipment_model_id = ?
      `,
      [id, targetModelId]
    )
    await conn.execute(
      `
      DELETE opumo
      FROM oem_part_unit_material_overrides opumo
      JOIN client_equipment_units cu ON cu.id = opumo.client_equipment_unit_id
      WHERE opumo.oem_part_id = ?
        AND cu.equipment_model_id = ?
      `,
      [id, targetModelId]
    )
    await conn.execute(
      `
      DELETE opuo
      FROM oem_part_unit_overrides opuo
      JOIN client_equipment_units cu ON cu.id = opuo.client_equipment_unit_id
      WHERE opuo.oem_part_id = ?
        AND cu.equipment_model_id = ?
      `,
      [id, targetModelId]
    )
    await conn.execute(
      'DELETE FROM oem_part_model_fitments WHERE oem_part_id = ? AND equipment_model_id = ?',
      [id, targetModelId]
    )

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'oem_parts',
      entity_id: id,
      old_value: String(trashEntryId),
      comment: `OEM деталь ${exists.cat_number} снята с модели ${modelName || targetModelId} и перемещена в корзину как связь`,
    })
    await conn.commit()

    res.json({
      message: 'OEM деталь удалена из выбранной модели',
      trash_entry_id: trashEntryId,
    })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    if (err?.message === 'FITMENT_NOT_FOUND') {
      return res.status(err.status || 404).json({ message: 'Связь применения не найдена' })
    }
    console.error('DELETE /original-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

/* ================================================================
   PROCUREMENT OPTIONS (подбор опций закупки)
================================================================ */

router.get('/:id/options', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const qty = Number(req.query.qty ?? 1)
    if (!(qty > 0)) return res.status(400).json({ message: 'qty должен быть > 0' })

    const [[op]] = await db.execute('SELECT id, part_number AS cat_number FROM oem_parts WHERE id=?', [id])
    if (!op) return res.status(404).json({ message: 'Деталь не найдена' })

    const [direct] = await db.execute(
      `
      SELECT
        sp.id AS supplier_part_id,
        sp.supplier_id,
        ps.name AS supplier_name,
        sp.supplier_part_number,
        sp.description_ru,
        sp.description_en,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        sp.lead_time_days,
        sp.min_order_qty,
        sp.packaging
      FROM supplier_part_oem_parts spo
      JOIN supplier_parts sp      ON sp.id = spo.supplier_part_id
      LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
      WHERE spo.oem_part_id = ?
      ORDER BY sp.id DESC
    `,
      [id]
    )

    const computeBuyQty = (required, moq) => {
      const req = Number(required) || 0
      const m = Number(moq)
      if (!m || m <= 0) return req
      return req <= m ? m : req
    }

    const toItem = (r, requiredQty) => {
      const buy_qty = computeBuyQty(requiredQty, r.min_order_qty)
      const notes = []
      if (r.min_order_qty && buy_qty > requiredQty) {
        notes.push(`MOQ ${r.min_order_qty}, закупка ${buy_qty}`)
      }

      return {
        supplier_part_id: r.supplier_part_id,
        supplier_id: r.supplier_id,
        supplier_name: r.supplier_name,
        supplier_part_number: r.supplier_part_number,
        description: r.description,
        lead_time_days: r.lead_time_days,
        min_order_qty: r.min_order_qty,
        packaging: r.packaging,
        required_qty: requiredQty,
        buy_qty,
        latest_price: null,
        latest_currency: null,
        latest_price_date: null,
        subtotal: null,
        notes,
      }
    }

    const options = []

    direct.forEach((r) => {
      const item = toItem(r, qty)
      options.push({
        type: 'DIRECT',
        group_id: null,
        group_name: null,
        items: [item],
        total_cost: null,
        notes: item.notes.length ? [...item.notes] : [],
      })
    })

    res.json({
      original_part: { id: op.id, cat_number: op.cat_number },
      qty_requested: qty,
      options,
    })
  } catch (e) {
    console.error('GET /original-parts/:id/options error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
