// routes/originalParts.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

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
      SELECT p.*,
             m.model_name,
             mf.name AS manufacturer_name,
             tc.code AS tnved_code_text
        FROM original_parts p
        JOIN equipment_models m         ON m.id = p.equipment_model_id
        JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
        LEFT JOIN tnved_codes tc        ON tc.id = p.tnved_code_id
       WHERE p.cat_number = ?
       ${emid ? 'AND p.equipment_model_id = ?' : ''}
      `,
      emid ? [cat, emid] : [cat]
    )

    if (!rows.length) return res.status(404).json({ message: 'Не найдено' })
    if (rows.length > 1 && emid === undefined) {
      return res.status(400).json({
        message: 'Найдено несколько моделей с таким номером — укажите equipment_model_id',
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
      SELECT p.*,
             m.model_name,
             mf.name AS manufacturer_name
        FROM original_parts p
        JOIN equipment_models m         ON m.id = p.equipment_model_id
        JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
       WHERE p.cat_number IN (${catNumbers.map(() => '?').join(', ')})
    `
    if (emid) {
      sql += ' AND p.equipment_model_id = ?'
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
    const where = ['ri.original_part_id IS NOT NULL']
    if (clientId) {
      where.push('cr.client_id = ?')
      params.push(clientId)
    }

    const [rows] = await db.execute(
      `
      SELECT p.id,
             p.cat_number,
             p.description_ru,
             p.description_en,
             p.equipment_model_id,
             m.model_name,
             mf.name AS manufacturer_name,
             COUNT(*) AS usage_count
        FROM client_request_revision_items ri
        JOIN client_request_revisions rr ON rr.id = ri.client_request_revision_id
        JOIN client_requests cr ON cr.id = rr.client_request_id
        JOIN original_parts p ON p.id = ri.original_part_id
        JOIN equipment_models m ON m.id = p.equipment_model_id
        JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
       WHERE ${where.join(' AND ')}
       GROUP BY p.id, p.cat_number, p.description_ru, p.description_en, p.equipment_model_id, m.model_name, mf.name
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
    const midRaw = req.query.manufacturer_id
    const emidRaw = req.query.equipment_model_id
    const groupIdRaw = req.query.group_id
    const q = nz(req.query.q)
    const only_assemblies = ('' + (req.query.only_assemblies ?? '')).toLowerCase()
    const only_parts = ('' + (req.query.only_parts ?? '')).toLowerCase()
    const excludeRaw = req.query.exclude_id

    const params = []
    const where = []

    let sql = `
      SELECT
        p.*,
        m.model_name,
        mf.name AS manufacturer_name,
        tc.code        AS tnved_code_text,
        tc.description AS tnved_description,
        COALESCE(ch.cnt, 0)  AS children_count,
        COALESCE(pr.cnt, 0)  AS parent_count,
        (COALESCE(ch.cnt, 0) > 0) AS is_assembly,
        g.name AS group_name
      FROM original_parts p
      JOIN equipment_models m         ON m.id  = p.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
      LEFT JOIN tnved_codes tc        ON tc.id = p.tnved_code_id
      LEFT JOIN original_part_groups g ON g.id = p.group_id
      LEFT JOIN (
        SELECT parent_part_id, COUNT(*) cnt
          FROM original_part_bom
         GROUP BY parent_part_id
      ) ch ON ch.parent_part_id = p.id
      LEFT JOIN (
        SELECT child_part_id, COUNT(*) cnt
          FROM original_part_bom
         GROUP BY child_part_id
      ) pr ON pr.child_part_id = p.id
    `

    if (midRaw !== undefined) {
      const mid = toId(midRaw)
      if (!mid) return res.status(400).json({ message: 'manufacturer_id должен быть числом' })
      where.push('mf.id = ?')
      params.push(mid)
    }
    if (emidRaw !== undefined) {
      const emid = toId(emidRaw)
      if (!emid) return res.status(400).json({ message: 'equipment_model_id должен быть числом' })
      where.push('m.id = ?')
      params.push(emid)
    }
    if (groupIdRaw !== undefined) {
      const gid = toId(groupIdRaw)
      if (!gid) return res.status(400).json({ message: 'group_id должен быть числом' })
      where.push('p.group_id = ?')
      params.push(gid)
    }
    if (q) {
      const like = `%${q}%`
      where.push('(p.cat_number LIKE ? OR p.description_en LIKE ? OR p.description_ru LIKE ? OR p.tech_description LIKE ? OR tc.code LIKE ?)')
      params.push(like, like, like, like, like)
    }
    if (only_assemblies === '1' || only_assemblies === 'true') where.push('COALESCE(ch.cnt,0) > 0')
    if (only_parts === '1' || only_parts === 'true') where.push('COALESCE(ch.cnt,0) = 0')

    if (excludeRaw !== undefined) {
      const ex = toId(excludeRaw)
      if (ex) {
        where.push('p.id <> ?')
        params.push(ex)
      }
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY p.id DESC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
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
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      SELECT p.*,
             m.model_name,
             mf.name AS manufacturer_name,
             tc.code AS tnved_code_text
        FROM original_parts p
        JOIN equipment_models m         ON m.id = p.equipment_model_id
        JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
        LEFT JOIN tnved_codes tc        ON tc.id = p.tnved_code_id
       WHERE p.id = ?
      `,
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Деталь не найдена' })
    res.json(rows[0])
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
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      SELECT
        p.*,
        m.model_name,
        mf.id   AS manufacturer_id,
        mf.name AS manufacturer_name,
        tc.code AS tnved_code,
        tc.description AS tnved_description,
        COALESCE(ch.cnt, 0) AS children_count,
        COALESCE(pr.cnt, 0) AS parent_count
      FROM original_parts p
      JOIN equipment_models m         ON m.id  = p.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
      LEFT JOIN tnved_codes tc        ON tc.id = p.tnved_code_id
      LEFT JOIN (
        SELECT parent_part_id, COUNT(*) cnt FROM original_part_bom GROUP BY parent_part_id
      ) ch ON ch.parent_part_id = p.id
      LEFT JOIN (
        SELECT child_part_id, COUNT(*) cnt FROM original_part_bom GROUP BY child_part_id
      ) pr ON pr.child_part_id = p.id
      WHERE p.id = ?
      `,
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Деталь не найдена' })
    res.json(rows[0])
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
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

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
    const cat_number = nz(req.body.cat_number)
    if (!cat_number) return res.status(400).json({ message: 'cat_number обязателен' })

    const equipment_model_id = toId(req.body.equipment_model_id)
    if (!equipment_model_id) {
      return res.status(400).json({ message: 'equipment_model_id обязателен и должен быть числом' })
    }

    const [[modelExists]] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [equipment_model_id])
    if (!modelExists) return res.status(400).json({ message: 'Указанная модель не найдена' })

    const description_en   = nz(req.body.description_en)
    const description_ru   = nz(req.body.description_ru)
    const tech_description = nz(req.body.tech_description)
    const weight_kg        = numOrNull(req.body.weight_kg)
    const uom              = nz(req.body.uom)
    const uomNormalized    = uom ? uom.toLowerCase() : null

    // новые поля
    const length_cm = numOrNull(req.body.length_cm)
    const width_cm  = numOrNull(req.body.width_cm)
    const height_cm = numOrNull(req.body.height_cm)
    const is_overweight = req.body.is_overweight === undefined ? null : boolToTinyint(req.body.is_overweight, 0)
    const is_oversize = req.body.is_oversize === undefined ? null : boolToTinyint(req.body.is_oversize, 0)
    const has_drawing = boolToTinyint(req.body.has_drawing, 0)

    // group_id (если прислали — проверим)
    let groupIdParam = null
    if (req.body.group_id !== undefined && req.body.group_id !== null) {
      const gid = toId(req.body.group_id)
      if (!gid) return res.status(400).json({ message: 'group_id должен быть числом' })
      const [[g]] = await db.execute('SELECT id FROM original_part_groups WHERE id = ?', [gid])
      if (!g) return res.status(400).json({ message: 'Указанная группа не найдена' })
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

    try {
      const [ins] = await db.execute(
        `INSERT INTO original_parts
           (equipment_model_id, cat_number,
            description_en, description_ru, tech_description,
            weight_kg, uom, tnved_code_id,
            group_id, length_cm, width_cm, height_cm,
            is_overweight, is_oversize, has_drawing)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          equipment_model_id,
          cat_number,
          description_en,
          description_ru,
          tech_description,
          weight_kg,
          uomNormalized || 'pcs',
          tnvedId,
          groupIdParam,
          length_cm,
          width_cm,
          height_cm,
          is_overweight,
          is_oversize,
          has_drawing
        ]
      )
      const [rows] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [ins.insertId])

      await logActivity({
        req,
        action: 'create',
        entity_type: 'original_parts',
        entity_id: ins.insertId,
        comment: `Создана деталь: ${rows[0].cat_number}`,
      })

      return res.status(201).json(rows[0])
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          type: 'duplicate',
          fields: ['equipment_model_id', 'cat_number'],
          message: 'Такой номер уже есть в этой модели',
        })
      }
      throw e
    }
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
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [oldRows] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])
    if (!oldRows.length) return res.status(404).json({ message: 'Деталь не найдена' })

    const cat_number       = nz(req.body.cat_number)
    const description_en   = nz(req.body.description_en)
    const description_ru   = nz(req.body.description_ru)
    const tech_description = nz(req.body.tech_description)
    const weight_kg        = numOrNull(req.body.weight_kg)
    const uom              = nz(req.body.uom)
    const uomNormalized    = uom ? uom.toLowerCase() : null

    const length_cm = numOrNull(req.body.length_cm)
    const width_cm  = numOrNull(req.body.width_cm)
    const height_cm = numOrNull(req.body.height_cm)
    const is_overweight = req.body.is_overweight === undefined ? null : boolToTinyint(req.body.is_overweight, 0)
    const is_oversize = req.body.is_oversize === undefined ? null : boolToTinyint(req.body.is_oversize, 0)

    let hasDrawingParam = null
    if (req.body.has_drawing !== undefined) {
      hasDrawingParam = boolToTinyint(req.body.has_drawing, 0)
    }

    // смена модели (опционально)
    let modelIdParam = null
    if (req.body.equipment_model_id !== undefined) {
      const maybe = toId(req.body.equipment_model_id)
      if (!maybe) return res.status(400).json({ message: 'equipment_model_id должен быть числом' })
      const [[m]] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [maybe])
      if (!m) return res.status(400).json({ message: 'Указанная модель не найдена' })
      modelIdParam = maybe
    }

    // смена группы (опционально)
    let groupIdParam = null
    if (req.body.group_id !== undefined) {
      const gid = toId(req.body.group_id)
      if (!gid) return res.status(400).json({ message: 'group_id должен быть числом' })
      const [[g]] = await db.execute('SELECT id FROM original_part_groups WHERE id = ?', [gid])
      if (!g) return res.status(400).json({ message: 'Указанная группа не найдена' })
      groupIdParam = gid
    }

    // смена ТН ВЭД (опционально)
    let tnvedIdParam = null
    if (req.body.tnved_code_id !== undefined || req.body.tnved_code !== undefined) {
      try {
        tnvedIdParam = await resolveTnvedId(db, req.body.tnved_code_id, req.body.tnved_code)
      } catch (e) {
        if (e.message === 'TNVED_NOT_FOUND') {
          return res.status(400).json({ message: 'Код ТН ВЭД не найден в справочнике' })
        }
        throw e
      }
    } else {
      tnvedIdParam = null // COALESCE(NULL, tnved_code_id) → не менять
    }

    try {
      await db.execute(
        `UPDATE original_parts
            SET cat_number         = COALESCE(?, cat_number),
                equipment_model_id = COALESCE(?, equipment_model_id),
                description_en     = COALESCE(?, description_en),
                description_ru     = COALESCE(?, description_ru),
                tech_description   = COALESCE(?, tech_description),
                weight_kg          = COALESCE(?, weight_kg),
                uom                = COALESCE(?, uom),
                tnved_code_id      = COALESCE(?, tnved_code_id),
                group_id           = COALESCE(?, group_id),
                length_cm          = COALESCE(?, length_cm),
                width_cm           = COALESCE(?, width_cm),
                height_cm          = COALESCE(?, height_cm),
                is_overweight      = COALESCE(?, is_overweight),
                is_oversize        = COALESCE(?, is_oversize),
                has_drawing        = COALESCE(?, has_drawing)
          WHERE id = ?`,
        [
          cat_number,
          modelIdParam,
          description_en,
          description_ru,
          tech_description,
          weight_kg,
          uomNormalized,
          tnvedIdParam,
          groupIdParam,
          length_cm,
          width_cm,
          height_cm,
          is_overweight,
          is_oversize,
          hasDrawingParam,
          id,
        ]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          type: 'duplicate',
          fields: ['equipment_model_id', 'cat_number'],
          message: 'Такой номер уже есть в этой модели',
        })
      }
      if (e && (e.errno === 1451 || e.errno === 1452)) {
        return res.status(409).json({
          type: 'fk_constraint',
          message: 'Нельзя изменить модель: существуют связи в BOM/заменах',
        })
      }
      throw e
    }

    const [fresh] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])

    // человекочитаемые логи для смены ТН ВЭД
    let oldDataForLog = { ...oldRows[0] }
    let newDataForLog = { ...fresh[0] }
    if (oldRows[0].tnved_code_id !== fresh[0].tnved_code_id) {
      const oldId = oldRows[0].tnved_code_id
      const newId = fresh[0].tnved_code_id
      const [codes] = await db.execute(
        'SELECT id, code FROM tnved_codes WHERE id IN (?,?)',
        [oldId || 0, newId || 0]
      )
      const map = new Map(codes.map((r) => [r.id, r.code]))
      oldDataForLog.tnved_code_id = oldId ? map.get(oldId) || String(oldId) : null
      newDataForLog.tnved_code_id = newId ? map.get(newId) || String(newId) : null
    }

    await logFieldDiffs({
      req,
      oldData: oldDataForLog,
      newData: newDataForLog,
      entity_type: 'original_parts',
      entity_id: id,
    })

    res.json(fresh[0])
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
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

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
        .json({ message: 'Укажите tnved_code_id или tnved_code (или null, чтобы снять)' })
    }

    const [beforeRows] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])
    if (!beforeRows.length) return res.status(404).json({ message: 'Деталь не найдена' })
    const before = beforeRows[0]

    await db.execute('UPDATE original_parts SET tnved_code_id = ? WHERE id = ?', [tnvedId, id])

    const [afterRows] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])
    const after = afterRows[0]

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
      entity_type: 'original_parts',
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
   DELETE
================================================================ */
router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Деталь не найдена' })

    try {
      await db.execute('DELETE FROM original_parts WHERE id = ?', [id])
    } catch (fkErr) {
      if (fkErr && fkErr.errno === 1451) {
        return res.status(409).json({
          type: 'fk_constraint',
          message: 'Удаление невозможно: есть связанные записи (BOM/замены/и т.п.)',
        })
      }
      console.error('DELETE /original-parts fk error:', fkErr)
      return res.status(500).json({ message: 'Ошибка при удалении' })
    }

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'original_parts',
      entity_id: id,
      comment: `Удалена деталь: ${exists[0].cat_number}`,
    })

    res.json({ message: 'Деталь удалена' })
  } catch (err) {
    console.error('DELETE /original-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   PROCUREMENT OPTIONS (подбор опций закупки)
================================================================ */

router.get('/:id/options', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const qty = Number(req.query.qty ?? 1)
    if (!(qty > 0)) return res.status(400).json({ message: 'qty должен быть > 0' })

    const [[op]] = await db.execute('SELECT id, cat_number FROM original_parts WHERE id=?', [id])
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
      FROM supplier_part_originals spo
      JOIN supplier_parts sp      ON sp.id = spo.supplier_part_id
      LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
      WHERE spo.original_part_id = ?
      ORDER BY sp.id DESC
    `,
      [id]
    )

    const [groups] = await db.execute(
      `
      SELECT s.id, s.name, s.mode
      FROM original_part_substitutions s
      WHERE s.original_part_id = ?
      ORDER BY s.id DESC
    `,
      [id]
    )

    let groupItems = []
    if (groups.length) {
      const gIds = groups.map((g) => g.id)
      const placeholders = gIds.map(() => '?').join(',')
      const [rows] = await db.execute(
        `
        SELECT 
          i.substitution_id,
          i.supplier_part_id,
          i.quantity,
          sp.supplier_id,
          ps.name AS supplier_name,
          sp.supplier_part_number,
          sp.description_ru,
          sp.description_en,
          COALESCE(sp.description_ru, sp.description_en) AS description,
          sp.lead_time_days,
          sp.min_order_qty,
          sp.packaging
        FROM original_part_substitution_items i
        JOIN supplier_parts sp      ON sp.id = i.supplier_part_id
        LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
        WHERE i.substitution_id IN (${placeholders})
        ORDER BY i.substitution_id, i.supplier_part_id
      `,
        gIds
      )
      groupItems = rows
    }

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

    const itemsByGroup = new Map()
    groupItems.forEach((r) => {
      if (!itemsByGroup.has(r.substitution_id)) itemsByGroup.set(r.substitution_id, [])
      itemsByGroup.get(r.substitution_id).push(r)
    })

    for (const g of groups) {
      const gi = itemsByGroup.get(g.id) || []
      if (!gi.length) continue

      if (g.mode === 'ALL') {
        const items = gi.map((r) => toItem(r, qty * Number(r.quantity || 1)))
        options.push({
          type: 'GROUP_ALL',
          group_id: g.id,
          group_name: g.name || null,
          items,
          total_cost: null,
          notes: [],
        })
      } else {
        for (const r of gi) {
          const item = toItem(r, qty * Number(r.quantity || 1))
          options.push({
            type: 'GROUP_ANY',
            group_id: g.id,
            group_name: g.name || null,
            items: [item],
            total_cost: null,
            notes: item.notes.length ? [...item.notes] : [],
          })
        }
      }
    }

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
