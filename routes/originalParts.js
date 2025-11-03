// routes/originalParts.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v); return Number.isFinite(n) ? n : null
}

// helper: резолвим tnved_code_id (по id или строковому коду)
async function resolveTnvedId(db, tnved_code_id, tnved_code) {
  if (tnved_code_id !== undefined && tnved_code_id !== null) {
    const id = Number(tnved_code_id)
    if (Number.isFinite(id)) return id
  }
  const code = nz(tnved_code)
  if (!code) return null
  const [rows] = await db.execute('SELECT id FROM tnved_codes WHERE code = ?', [code])
  if (!rows.length) throw new Error('TNVED_NOT_FOUND')
  return rows[0].id
}

/* ================================================================
   LOOKUP
================================================================ */
router.get('/lookup', auth, async (req, res) => {
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
        message: 'Найдено несколько моделей с таким номером — укажите equipment_model_id'
      })
    }

    res.json(rows[0])
  } catch (e) {
    console.error('GET /original-parts/lookup error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   LIST
================================================================ */
router.get('/', auth, async (req, res) => {
  try {
    const midRaw = req.query.manufacturer_id
    const emidRaw = req.query.equipment_model_id
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
        (COALESCE(ch.cnt, 0) > 0) AS is_assembly
      FROM original_parts p
      JOIN equipment_models m         ON m.id  = p.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
      LEFT JOIN tnved_codes tc        ON tc.id = p.tnved_code_id
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
    if (q) {
      const like = `%${q}%`
      // 🔧 убрал p.tnved_code — такого поля нет; ищем по tc.code
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
router.get('/:id', auth, async (req, res) => {
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
   FULL CARD
================================================================ */
router.get('/:id/full', auth, async (req, res) => {
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
   CREATE
================================================================ */
router.post('/', auth, adminOnly, async (req, res) => {
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
           (equipment_model_id, cat_number, description_en, description_ru, tech_description, weight_kg, tnved_code_id)
         VALUES (?,?,?,?,?,?,?)`,
        [equipment_model_id, cat_number, description_en, description_ru, tech_description, weight_kg, tnvedId]
      )
      const [row] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [ins.insertId])

      await logActivity({
        req,
        action: 'create',
        entity_type: 'original_parts',
        entity_id: ins.insertId,
        comment: `Создана деталь: ${row[0].cat_number}`
      })

      return res.status(201).json(row[0])
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ type: 'duplicate', fields: ['equipment_model_id','cat_number'], message: 'Такой номер уже есть в этой модели' })
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
router.put('/:id', auth, adminOnly, async (req, res) => {
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

    // equipment_model_id: допускаем смену, но валидируем FK
    let modelIdParam = null
    if (req.body.equipment_model_id !== undefined) {
      const maybe = toId(req.body.equipment_model_id)
      if (!maybe) return res.status(400).json({ message: 'equipment_model_id должен быть числом' })
      const [[m]] = await db.execute('SELECT id FROM equipment_models WHERE id = ?', [maybe])
      if (!m) return res.status(400).json({ message: 'Указанная модель не найдена' })
      modelIdParam = maybe
    }

    // tnved_code: меняем только если пришёл id/код
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
                tnved_code_id      = COALESCE(?, tnved_code_id)
          WHERE id = ?`,
        [cat_number, modelIdParam, description_en, description_ru, tech_description, weight_kg, tnvedIdParam, id]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ type: 'duplicate', fields: ['equipment_model_id','cat_number'], message: 'Такой номер уже есть в этой модели' })
      }
      if (e && (e.errno === 1451 || e.errno === 1452)) {
        return res.status(409).json({ type: 'fk_constraint', message: 'Нельзя изменить модель: существуют связи в BOM/заменах' })
      }
      throw e
    }

    const [fresh] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])

    // --- человекочитаемые логи для смены ТН ВЭД
    let oldDataForLog = { ...oldRows[0] }
    let newDataForLog = { ...fresh[0] }
    if (oldRows[0].tnved_code_id !== fresh[0].tnved_code_id) {
      const oldId = oldRows[0].tnved_code_id
      const newId = fresh[0].tnved_code_id
      const [codes] = await db.execute(
        'SELECT id, code FROM tnved_codes WHERE id IN (?,?)',
        [oldId || 0, newId || 0]
      )
      const map = new Map(codes.map(r => [r.id, r.code]))
      oldDataForLog.tnved_code_id = oldId ? (map.get(oldId) || String(oldId)) : null
      newDataForLog.tnved_code_id = newId ? (map.get(newId) || String(newId)) : null
    }

    await logFieldDiffs({
      req,
      oldData: oldDataForLog,
      newData: newDataForLog,
      entity_type: 'original_parts',
      entity_id: id
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
router.patch('/:id/tnved', auth, adminOnly, async (req, res) => {
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
      return res.status(400).json({ message: 'Укажите tnved_code_id или tnved_code (или null, чтобы снять)' })
    }

    const [beforeRows] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])
    if (!beforeRows.length) return res.status(404).json({ message: 'Деталь не найдена' })
    const before = beforeRows[0]

    await db.execute('UPDATE original_parts SET tnved_code_id = ? WHERE id = ?', [tnvedId, id])

    const [afterRows] = await db.execute('SELECT * FROM original_parts WHERE id = ?', [id])
    const after = afterRows[0]

    const [codes] = await db.execute(
      'SELECT id, code FROM tnved_codes WHERE id IN (?,?)',
      [before.tnved_code_id || 0, after.tnved_code_id || 0]
    )
    const map = new Map(codes.map(r => [r.id, r.code]))

    const oldDataForLog = {
      ...before,
      tnved_code_id: before.tnved_code_id ? (map.get(before.tnved_code_id) || String(before.tnved_code_id)) : null
    }
    const newDataForLog = {
      ...after,
      tnved_code_id: after.tnved_code_id ? (map.get(after.tnved_code_id) || String(after.tnved_code_id)) : null
    }

    await logFieldDiffs({
      req,
      oldData: oldDataForLog,
      newData: newDataForLog,
      entity_type: 'original_parts',
      entity_id: id,
      comment: 'Привязка ТН ВЭД'
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
router.delete('/:id', auth, adminOnly, async (req, res) => {
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
          message: 'Удаление невозможно: есть связанные записи (BOM/замены/и т.п.)'
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
      comment: `Удалена деталь: ${exists[0].cat_number}`
    })

    res.json({ message: 'Деталь удалена' })
  } catch (err) {
    console.error('DELETE /original-parts/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   PROCUREMENT OPTIONS
================================================================ */
router.get('/:id/options', auth, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const qty = Number(req.query.qty ?? 1)
    if (!(qty > 0)) return res.status(400).json({ message: 'qty должен быть > 0' })

    const [[op]] = await db.execute('SELECT id, cat_number FROM original_parts WHERE id=?', [id])
    if (!op) return res.status(404).json({ message: 'Деталь не найдена' })

    const [direct] = await db.execute(`
      SELECT
        sp.id AS supplier_part_id,
        sp.supplier_id,
        ps.name AS supplier_name,
        sp.supplier_part_number,
        sp.description,
        sp.lead_time_days,
        sp.min_order_qty,
        sp.packaging,
        (SELECT price    FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id ORDER BY p.date DESC LIMIT 1) AS latest_price,
        (SELECT currency FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id ORDER BY p.date DESC LIMIT 1) AS latest_currency,
        (SELECT date     FROM supplier_part_prices p WHERE p.supplier_part_id = sp.id ORDER BY p.date DESC LIMIT 1) AS latest_price_date
      FROM supplier_part_originals spo
      JOIN supplier_parts sp      ON sp.id = spo.supplier_part_id
      LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
      WHERE spo.original_part_id = ?
      ORDER BY sp.id DESC
    `, [id])

    const [groups] = await db.execute(`
      SELECT s.id, s.name, s.mode
      FROM original_part_substitutions s
      WHERE s.original_part_id = ?
      ORDER BY s.id DESC
    `, [id])

    let groupItems = []
    if (groups.length) {
      const gIds = groups.map(g => g.id)
      const placeholders = gIds.map(() => '?').join(',')
      const [rows] = await db.execute(`
        SELECT 
          i.substitution_id,
          i.supplier_part_id,
          i.quantity,
          sp.supplier_id,
          ps.name AS supplier_name,
          sp.supplier_part_number,
          sp.description,
          sp.lead_time_days,
          sp.min_order_qty,
          sp.packaging
        FROM original_part_substitution_items i
        JOIN supplier_parts sp      ON sp.id = i.supplier_part_id
        LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
        WHERE i.substitution_id IN (${placeholders})
        ORDER BY i.substitution_id, i.supplier_part_id
      `, gIds)
      groupItems = rows
    }

    const idsSet = new Set()
    direct.forEach(r => idsSet.add(r.supplier_part_id))
    groupItems.forEach(r => idsSet.add(r.supplier_part_id))
    const allIds = Array.from(idsSet)

    const priceMap = new Map()
    if (allIds.length) {
      const placeholders = allIds.map(() => '?').join(',')
      const [prices] = await db.execute(`
        SELECT t.*
          FROM (
            SELECT 
              id,
              supplier_part_id,
              price,
              currency,
              date,
              ROW_NUMBER() OVER (PARTITION BY supplier_part_id ORDER BY date DESC, id DESC) AS rn
            FROM supplier_part_prices
            WHERE supplier_part_id IN (${placeholders})
          ) t
         WHERE t.rn = 1
      `, allIds)
      prices.forEach(p => priceMap.set(p.supplier_part_id, p))
    }

    const computeBuyQty = (required, moq) => {
      const req = Number(required) || 0
      const m = Number(moq)
      if (!m || m <= 0) return req
      return req <= m ? m : req
    }

    const toItem = (r, required_qty) => {
      const priceRow = priceMap.get(r.supplier_part_id)
      const latest_price      = priceRow?.price     ?? r.latest_price ?? null
      const latest_currency   = priceRow?.currency  ?? r.latest_currency ?? null
      const latest_price_date = priceRow?.date      ?? r.latest_price_date ?? null

      const buy_qty = computeBuyQty(required_qty, r.min_order_qty)
      const subtotal = latest_price != null && buy_qty != null
        ? Number(latest_price) * Number(buy_qty)
        : null

      const notes = []
      if (r.min_order_qty && buy_qty > required_qty) notes.push(`MOQ ${r.min_order_qty}`)
      if (latest_price == null) notes.push('нет цены')

      return {
        supplier_part_id: r.supplier_part_id,
        supplier_id: r.supplier_id,
        supplier_name: r.supplier_name || null,
        supplier_part_number: r.supplier_part_number,
        description: r.description,
        lead_time_days: r.lead_time_days ?? null,
        min_order_qty: r.min_order_qty ?? null,
        packaging: r.packaging ?? null,

        latest_price: latest_price != null ? Number(latest_price) : null,
        latest_currency: latest_currency || null,
        latest_price_date: latest_price_date || null,

        required_qty: Number(required_qty),
        buy_qty,
        subtotal: subtotal != null ? Number(subtotal) : null,
        notes
      }
    }

    const options = []

    for (const r of direct) {
      const item = toItem(r, qty)
      options.push({
        type: 'DIRECT',
        label: r.supplier_name ? `Прямой: ${r.supplier_name}` : 'Прямой аналог',
        items: [item],
        total_cost: item.subtotal != null ? item.subtotal : null,
        notes: item.notes.length ? [...item.notes] : []
      })
    }

    const itemsByGroup = new Map()
    groupItems.forEach(r => {
      if (!itemsByGroup.has(r.substitution_id)) itemsByGroup.set(r.substitution_id, [])
      itemsByGroup.get(r.substitution_id).push(r)
    })

    for (const g of groups) {
      const gi = itemsByGroup.get(g.id) || []
      if (!gi.length) continue

      if (g.mode === 'ALL') {
        const items = gi.map(r => toItem(r, qty * Number(r.quantity || 1)))
        const total_cost = items.every(i => i.subtotal != null)
          ? items.reduce((s, i) => s + i.subtotal, 0)
          : null
        options.push({
          type: 'GROUP_ALL',
          group_id: g.id,
          group_name: g.name || null,
          items,
          total_cost,
          notes: []
        })
      } else {
        for (const r of gi) {
          const item = toItem(r, qty * Number(r.quantity || 1))
          options.push({
            type: 'GROUP_ANY',
            group_id: g.id,
            group_name: g.name || null,
            items: [item],
            total_cost: item.subtotal != null ? item.subtotal : null,
            notes: item.notes.length ? [...item.notes] : []
          })
        }
      }
    }

    options.sort((a, b) => {
      if (a.total_cost == null && b.total_cost == null) return 0
      if (a.total_cost == null) return 1
      if (b.total_cost == null) return -1
      return a.total_cost - b.total_cost
    })

    res.json({
      original_part: { id: op.id, cat_number: op.cat_number },
      qty_requested: qty,
      options
    })
  } catch (e) {
    console.error('GET /original-parts/:id/options error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
